/**
 * Putting the catalogue in the database.
 *
 * Idempotent, and safe to run on every deploy: a concept is matched by slug and
 * a version by `(concept_id, version_no)`, so re-running changes nothing.
 *
 * Deliberately not an insert that runs at worker startup. Registering a concept
 * is a claim about what Forma measures, and it belongs with the other claims --
 * engine identity, recipe promotion -- in an operator command that a person
 * runs on purpose, not in a code path that fires whenever a container happens
 * to boot.
 *
 * ## What happens when a definition changes
 *
 * Nothing here, on purpose. `conceptVersionHash` covers the rule rather than
 * the wording, so a reworded human definition writes the same hash and the same
 * version. A changed *rule* produces a different hash, and this refuses to
 * overwrite the existing version row -- a version is what a season of evidence
 * points at, and rewriting it in place would silently redefine every
 * observation already recorded against it. Changing a rule means bumping that
 * concept's own `versionNo`, which makes a new row and leaves the old evidence
 * attached to the definition it was actually collected under.
 *
 * ## One concept at a time
 *
 * The version number used to be one constant for the whole catalogue, so
 * correcting a single rule minted a new version of all six concepts. Five of
 * them would have described a rule nobody changed, and evidence would have been
 * split across two versions for a reason no later reader could reconstruct.
 * Each definition now carries its own (FOR-122), and `registerCatalogue`
 * reports what it did per concept so an operator can see that bumping one
 * bumped one.
 */

import type { Sql } from "postgres";
import { jsonParam } from "../../db/json.js";
import {
  CONCEPT_CATALOGUE,
  conceptVersionHash,
  type ConceptDefinition,
} from "./catalogue.js";

/** What registering one concept did. */
export type RegistrationOutcome =
  /** The version row did not exist and now does. */
  | "created"
  /** The version row existed and agrees with this build. */
  | "existing"
  /**
   * The version row existed and describes a *different* rule under the same
   * number. Nothing is written. Someone changed a detector contract without
   * bumping that concept's `versionNo`, and the stored version is what existing
   * evidence points at.
   */
  | "conflicting";

export interface RegisteredConcept {
  readonly slug: string;
  readonly versionNo: number;
  readonly conceptId: string;
  readonly conceptVersionId: string;
  readonly outcome: RegistrationOutcome;
  readonly created: boolean;
  /** Set when the stored rule differs from the one in this build. */
  readonly hashMismatch: boolean;
}

async function registerOne(sql: Sql, definition: ConceptDefinition): Promise<RegisteredConcept> {
  const [concept] = await sql<{ id: string }[]>`
    insert into analysis.concepts (slug, family, category, display_name)
    values (${definition.slug}, ${definition.family}, ${definition.category}, ${definition.displayName})
    on conflict (slug) do update set display_name = excluded.display_name,
                                     family = excluded.family,
                                     category = excluded.category
    returning id
  `;
  if (!concept) throw new Error(`the concept ${definition.slug} did not register`);

  const hash = conceptVersionHash(definition);
  // Let the unique constraint arbitrate creation. A select followed by a bare
  // insert races when two deploy jobs register the same catalogue together:
  // both observe no row and one aborts on the unique constraint. `do nothing`
  // makes the loser continue to the comparison below instead.
  const [created] = await sql<{ id: string }[]>`
    insert into analysis.concept_versions (
      concept_id, version_no, human_definition, detector_contract, supported_roles,
      rubric_contract, version_hash, promoted_at
    ) values (
      ${concept.id}, ${definition.versionNo}, ${definition.humanDefinition},
      ${jsonParam(definition.detectorContract)}::jsonb, ${definition.supportedRoles as string[]},
      null, ${hash}, now()
    )
    on conflict (concept_id, version_no) do nothing
    returning id
  `;
  if (created) {
    return {
      slug: definition.slug,
      versionNo: definition.versionNo,
      conceptId: concept.id,
      conceptVersionId: created.id,
      outcome: "created",
      created: true,
      hashMismatch: false,
    };
  }

  // Under READ COMMITTED this statement sees the row whose conflicting insert
  // committed while ours waited. It also handles the ordinary repeat case.
  const [existing] = await sql<{ id: string; version_hash: string }[]>`
    select id, version_hash from analysis.concept_versions
    where concept_id = ${concept.id} and version_no = ${definition.versionNo}
  `;
  if (!existing) throw new Error(`the concept version for ${definition.slug} did not register`);
  const mismatch = existing.version_hash !== hash;
  return {
    slug: definition.slug,
    versionNo: definition.versionNo,
    conceptId: concept.id,
    conceptVersionId: existing.id,
    outcome: mismatch ? "conflicting" : "existing",
    created: false,
    hashMismatch: mismatch,
  };
}

export interface RegistrationSummary {
  readonly concepts: readonly RegisteredConcept[];
  readonly created: number;
  readonly existing: number;
  readonly conflicting: number;
}

export function summarizeRegistration(
  concepts: readonly RegisteredConcept[],
): RegistrationSummary {
  return {
    concepts,
    created: concepts.filter((concept) => concept.outcome === "created").length,
    existing: concepts.filter((concept) => concept.outcome === "existing").length,
    conflicting: concepts.filter((concept) => concept.outcome === "conflicting").length,
  };
}

/** Register every concept in the catalogue. Returns one row per concept. */
export async function registerCatalogue(sql: Sql): Promise<RegisteredConcept[]> {
  const registered: RegisteredConcept[] = [];
  for (const definition of CONCEPT_CATALOGUE) {
    registered.push(await registerOne(sql, definition));
  }
  return registered;
}

/**
 * Slug to concept version id, for the detector.
 *
 * Reads rather than registers: a worker must not be able to invent a concept.
 * A slug with no row is left out of the map and the caller decides -- which is
 * a detector running ahead of its catalogue, an operator problem, not a reason
 * to write an unregistered concept into a player's evidence.
 *
 * Resolved per slug against the version *this build declares*, rather than
 * against one number for everything. Two consequences worth stating. A concept
 * still at v1 keeps resolving to its v1 row while a corrected neighbour
 * resolves to v2, so one correction does not strand the rest. And a version row
 * that exists but was never promoted is not returned at all -- an unpromoted
 * definition is a draft, and evidence must not be recorded against a draft.
 */
export async function conceptVersionIds(sql: Sql): Promise<Map<string, string>> {
  const slugs = CONCEPT_CATALOGUE.map((concept) => concept.slug);
  const versionNos = CONCEPT_CATALOGUE.map((concept) => concept.versionNo);
  const rows = await sql<{ slug: string; id: string }[]>`
    select c.slug, cv.id
    from analysis.concepts c
    join analysis.concept_versions cv on cv.concept_id = c.id
    join unnest(${slugs}::text[], ${versionNos}::int[]) as wanted(slug, version_no)
      on wanted.slug = c.slug and wanted.version_no = cv.version_no
    where cv.promoted_at is not null
  `;
  return new Map(rows.map((row) => [row.slug, row.id]));
}
