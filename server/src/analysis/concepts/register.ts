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
 * observation already recorded against it. Changing a rule means bumping
 * `CATALOGUE_VERSION_NO`, which makes a new row and leaves the old evidence
 * attached to the definition it was actually collected under.
 */

import type { Sql } from "postgres";
import { jsonParam } from "../../db/json.js";
import {
  CATALOGUE_VERSION_NO,
  CONCEPT_CATALOGUE,
  conceptVersionHash,
  type ConceptDefinition,
} from "./catalogue.js";

export interface RegisteredConcept {
  readonly slug: string;
  readonly conceptId: string;
  readonly conceptVersionId: string;
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
  const [existing] = await sql<{ id: string; version_hash: string }[]>`
    select id, version_hash from analysis.concept_versions
    where concept_id = ${concept.id} and version_no = ${CATALOGUE_VERSION_NO}
  `;
  if (existing) {
    return {
      slug: definition.slug,
      conceptId: concept.id,
      conceptVersionId: existing.id,
      created: false,
      hashMismatch: existing.version_hash !== hash,
    };
  }

  const [version] = await sql<{ id: string }[]>`
    insert into analysis.concept_versions (
      concept_id, version_no, human_definition, detector_contract, supported_roles,
      rubric_contract, version_hash, promoted_at
    ) values (
      ${concept.id}, ${CATALOGUE_VERSION_NO}, ${definition.humanDefinition},
      ${jsonParam(definition.detectorContract)}::jsonb, ${definition.supportedRoles as string[]},
      null, ${hash}, now()
    )
    returning id
  `;
  if (!version) throw new Error(`the concept version for ${definition.slug} did not register`);
  return {
    slug: definition.slug,
    conceptId: concept.id,
    conceptVersionId: version.id,
    created: true,
    hashMismatch: false,
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
 */
export async function conceptVersionIds(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ slug: string; id: string }[]>`
    select c.slug, cv.id
    from analysis.concepts c
    join analysis.concept_versions cv on cv.concept_id = c.id
    where cv.version_no = ${CATALOGUE_VERSION_NO}
  `;
  return new Map(rows.map((row) => [row.slug, row.id]));
}
