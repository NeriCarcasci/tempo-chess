/**
 * Identity reads and writes.
 *
 * Every statement that touches a tenant table runs inside `withActorContext`,
 * so RLS is doing the enforcing and this file is not the last line of defence.
 * The pure rules live in `contract.ts`; what is here is the part that needs a
 * connection.
 */

import { client } from "../db/client.js";
import { DuplicateWorkError, insertWorkflow } from "../ops/ledger.js";
import { withActorContext } from "../v1/auth/context.js";
import {
  PROVIDER_IDS,
  isLiveLink,
  mayReplaceVerification,
  normalizeHandle,
  projectPublicProfile,
  type ConnectionKind,
  type LinkStatus,
  type ProviderSlug,
  type PublicProfileProjection,
  type VerificationStatus,
} from "./contract.js";

export interface LinkedAccountView {
  id: string;
  provider: ProviderSlug;
  handle: string | null;
  connectionKind: ConnectionKind;
  verificationStatus: VerificationStatus;
  status: LinkStatus;
  providerHandleDiscoverable: boolean;
  createdAt: string;
}

export interface MeView {
  profileId: string;
  locale: string | null;
  timezone: string | null;
  personalSubject: { id: string; displayLabel: string; status: string } | null;
  accounts: LinkedAccountView[];
}

/**
 * Timestamps come back as a Date on some paths and a string on others
 * depending on how the driver saw the column, and the difference only shows up
 * at runtime on whichever branch is less travelled. Normalise once.
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const PROVIDER_BY_ID: Readonly<Record<number, ProviderSlug>> = { 1: "chesscom", 2: "lichess" };

/**
 * Ensure the actor has a profile and an active personal subject.
 *
 * Both are `on conflict do nothing`, so two concurrent first requests produce
 * one profile and one subject rather than a duplicate-key error the client
 * would have to interpret.
 */
export async function ensureIdentity(actorId: string): Promise<string> {
  return withActorContext(actorId, async (tx) => {
    await tx`insert into app.profiles (user_id) values (${actorId}::uuid) on conflict do nothing`;
    await tx`
      insert into app.analysis_subjects (kind, owner_user_id, display_label)
      values ('personal', ${actorId}::uuid, 'My games')
      on conflict do nothing
    `;
    const rows = await tx<{ id: string }[]>`
      select id from app.analysis_subjects
      where owner_user_id = ${actorId}::uuid and kind = 'personal' and status = 'active'
    `;
    return rows[0]?.id ?? "";
  });
}


/**
 * Ask for the subject's estimates to be recomputed because its evidence changed.
 *
 * Enqueued inside the caller's transaction, so the workflow is committed with
 * the membership change or not at all: a link that exists without a
 * recalculation, or a recalculation for a link that rolled back, are both
 * states the ledger should never hold.
 *
 * The idempotency key is the membership row and the transition, which is stable
 * per side effect: retrying the same request enqueues nothing, while linking,
 * unlinking and relinking the same account are three genuinely different events
 * because each opens or closes a different membership row.
 */
async function requestRecalculation(
  tx: Parameters<typeof insertWorkflow>[0],
  ownerUserId: string,
  subjectId: string,
  membershipId: string,
  transition: "opened" | "closed",
): Promise<void> {
  try {
    await insertWorkflow(tx, {
      kind: "subject_estimation",
      ownerProfileId: ownerUserId,
      resource: { type: "analysis_subject", id: subjectId },
      items: [
        {
          taskType: "subject_recalculate",
          resourceClass: "aggregation",
          idempotencyKey: `subject_estimation:membership:${membershipId}:${transition}`,
          dispatchMode: "queue",
          queue: "analysis",
          // Identity and trace only. The worker reloads the evidence itself.
          payload: { subjectId, membershipId, transition },
        },
      ],
    });
  } catch (error) {
    // A duplicate means this exact transition was already enqueued, which is
    // the idempotent outcome rather than a failure to report.
    if (!(error instanceof DuplicateWorkError)) throw error;
  }
}

export async function getMe(actorId: string): Promise<MeView> {
  await ensureIdentity(actorId);
  return withActorContext(actorId, async (tx) => {
    const [profile] = await tx<{ user_id: string; locale: string | null; timezone: string | null }[]>`
      select user_id, locale, timezone from app.profiles where user_id = ${actorId}::uuid
    `;
    const [subject] = await tx<{ id: string; display_label: string; status: string }[]>`
      select id, display_label, status from app.analysis_subjects
      where owner_user_id = ${actorId}::uuid and kind = 'personal' and status = 'active'
    `;
    const accounts = await tx<
      {
        id: string;
        provider_id: number;
        handle: string | null;
        connection_kind: ConnectionKind;
        verification_status: VerificationStatus;
        status: LinkStatus;
        provider_handle_discoverable: boolean;
        created_at: Date | string;
      }[]
    >`
      select la.id, pi.provider_id, pi.current_display_username as handle,
             la.connection_kind, la.verification_status, la.status,
             la.provider_handle_discoverable, la.created_at
      from app.linked_accounts la
      join app.provider_identities pi on pi.id = la.provider_identity_id
      where la.owner_user_id = ${actorId}::uuid
      order by la.created_at
    `;
    return {
      profileId: profile?.user_id ?? actorId,
      locale: profile?.locale ?? null,
      timezone: profile?.timezone ?? null,
      personalSubject: subject
        ? { id: subject.id, displayLabel: subject.display_label, status: subject.status }
        : null,
      accounts: accounts.map((row) => ({
        id: row.id,
        provider: PROVIDER_BY_ID[row.provider_id],
        handle: row.handle,
        connectionKind: row.connection_kind,
        verificationStatus: row.verification_status,
        status: row.status,
        providerHandleDiscoverable: row.provider_handle_discoverable,
        createdAt: toIso(row.created_at),
      })),
    };
  });
}

export interface LinkOutcome {
  account: LinkedAccountView;
  /** True when the link already existed, so the caller can answer 200 not 201. */
  existed: boolean;
}

/**
 * Link a provider account to the actor.
 *
 * The provider identity is shared and deliberately not owned: two users linking
 * the same handle resolve to the same `app.provider_identities` row and get two
 * independent `app.linked_accounts` rows. Neither can see the other's.
 *
 * Re-linking is idempotent — the same owner asking twice gets the existing row
 * back rather than a duplicate-key error.
 */
export async function linkAccount(
  actorId: string,
  provider: ProviderSlug,
  rawHandle: string,
): Promise<LinkOutcome> {
  await ensureIdentity(actorId);
  const normalized = normalizeHandle(rawHandle);
  const providerId = PROVIDER_IDS[provider];

  // The shared identity row is not tenant data and is written outside the actor
  // context: it belongs to no user, and every linker converges on it.
  const [identity] = await client<{ id: string }[]>`
    insert into app.provider_identities
      (provider_id, provider_identity_key, key_basis, current_display_username, current_normalized_username)
    values (${providerId}, ${normalized}, 'username', ${rawHandle.trim()}, ${normalized})
    on conflict (provider_id, provider_identity_key) do update
      -- The display name is refreshed on every sighting, not written once and
      -- kept forever. The provider owns how a handle is spelled -- somebody who
      -- restyles theirs should see the new one -- and this row is shared by
      -- every linker, so a bad value written once outlives the account that
      -- caused it. One did: a security probe overwrote two display names in
      -- July and they survived a complete account deletion, because nothing
      -- here ever wrote the column a second time.
      set last_seen_at = now(),
          current_display_username = excluded.current_display_username
    returning id
  `;

  return withActorContext(actorId, async (tx) => {
    const existing = await tx<
      { id: string; status: LinkStatus; verification_status: VerificationStatus; connection_kind: ConnectionKind; provider_handle_discoverable: boolean; created_at: Date | string }[]
    >`
      select id, status, verification_status, connection_kind, provider_handle_discoverable, created_at
      from app.linked_accounts
      where owner_user_id = ${actorId}::uuid and provider_identity_id = ${identity.id}
      order by created_at desc limit 1
    `;

    const live = existing.find((row) => isLiveLink(row.status));
    if (live) {
      return {
        existed: true,
        account: {
          id: live.id,
          provider,
          handle: rawHandle.trim(),
          connectionKind: live.connection_kind,
          verificationStatus: live.verification_status,
          status: live.status,
          providerHandleDiscoverable: live.provider_handle_discoverable,
          createdAt: toIso(live.created_at),
        },
      };
    }

    const [created] = await tx<{ id: string; created_at: Date | string }[]>`
      insert into app.linked_accounts (owner_user_id, provider_identity_id)
      values (${actorId}::uuid, ${identity.id})
      returning id, created_at
    `;
    const [subject] = await tx<{ id: string }[]>`
      select id from app.analysis_subjects
      where owner_user_id = ${actorId}::uuid and kind = 'personal' and status = 'active'
    `;
    if (subject) {
      const [membership] = await tx<{ id: string }[]>`
        insert into app.subject_account_memberships (subject_id, linked_account_id, confirmation_method, confirmed_at)
        values (${subject.id}, ${created.id}, 'owner_declared', now())
        returning id
      `;
      await requestRecalculation(tx, actorId, subject.id, membership.id, "opened");
    }
    return {
      existed: false,
      account: {
        id: created.id,
        provider,
        handle: rawHandle.trim(),
        connectionKind: "public_lookup",
        verificationStatus: "unverified",
        status: "active",
        providerHandleDiscoverable: false,
        createdAt: toIso(created.created_at),
      },
    };
  });
}

/**
 * Disconnect a link and close its membership.
 *
 * Nothing is deleted: §7.6 closes the membership and §7.7 retains history so an
 * old snapshot stays explainable. Returns false when the actor does not own the
 * account — RLS has already made it invisible, so this is the honest answer
 * rather than a second authorization check.
 */
export async function disconnectAccount(actorId: string, accountId: string): Promise<boolean> {
  return withActorContext(actorId, async (tx) => {
    const updated = await tx<{ id: string }[]>`
      update app.linked_accounts
      set status = 'disconnected', disconnected_at = now()
      where id = ${accountId}::uuid and status <> 'disconnected'
      returning id
    `;
    if (updated.length === 0) return false;
    const closed = await tx<{ id: string; subject_id: string }[]>`
      update app.subject_account_memberships
      set valid_to = now()
      where linked_account_id = ${accountId}::uuid and valid_to is null
      returning id, subject_id
    `;
    for (const membership of closed) {
      await requestRecalculation(tx, actorId, membership.subject_id, membership.id, "closed");
    }
    return true;
  });
}

/** Record a stronger verification observation, never a weaker one. */
export async function observeVerification(
  actorId: string,
  accountId: string,
  next: VerificationStatus,
): Promise<VerificationStatus | null> {
  return withActorContext(actorId, async (tx) => {
    const [row] = await tx<{ verification_status: VerificationStatus }[]>`
      select verification_status from app.linked_accounts where id = ${accountId}::uuid
    `;
    if (!row) return null;
    if (!mayReplaceVerification(row.verification_status, next)) return row.verification_status;
    const [updated] = await tx<{ verification_status: VerificationStatus }[]>`
      update app.linked_accounts set verification_status = ${next}
      where id = ${accountId}::uuid
      returning verification_status
    `;
    return updated.verification_status;
  });
}

/**
 * Public lookup by handle.
 *
 * Runs with no actor bound, so the only rows visible are the ones the
 * discoverable policy exposes. The projection then decides what of that row a
 * stranger may read.
 */
export async function lookupPublicProfile(
  rawHandle: string,
): Promise<PublicProfileProjection | null> {
  const handle = normalizeHandle(rawHandle);
  const [row] = await client<
    {
      user_id: string;
      personal_subject_id: string | null;
      handle: string;
      display_name: string | null;
      avatar_url: string | null;
      is_discoverable: boolean;
      show_provider_handles: boolean;
    }[]
  >`
    select user_id, personal_subject_id, handle, display_name, avatar_url,
           is_discoverable, show_provider_handles
    from social.public_player_profiles
    where lower(handle) = ${handle} and is_discoverable
  `;
  if (!row) return null;

  let providerHandles: { provider: ProviderSlug; handle: string }[] = [];
  if (row.show_provider_handles) {
    const handles = await client<{ provider_id: number; handle: string | null }[]>`
      select pi.provider_id, pi.current_display_username as handle
      from app.linked_accounts la
      join app.provider_identities pi on pi.id = la.provider_identity_id
      where la.owner_user_id = ${row.user_id}::uuid
        and la.status <> 'disconnected'
        and la.provider_handle_discoverable
    `;
    providerHandles = handles
      .filter((entry): entry is { provider_id: number; handle: string } => entry.handle !== null)
      .map((entry) => ({ provider: PROVIDER_BY_ID[entry.provider_id], handle: entry.handle }));
  }

  return projectPublicProfile({
    userId: row.user_id,
    personalSubjectId: row.personal_subject_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDiscoverable: row.is_discoverable,
    showProviderHandles: row.show_provider_handles,
    providerHandles,
  });
}
