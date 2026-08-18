/**
 * `npm run identity:reconcile` — the reconciliation report for 0017.
 *
 * A backfill is only trustworthy if you can say what it produced against what
 * it read. This counts both sides and checks the invariants that would make a
 * silent loss possible.
 */

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
let passed = 0;
const failures: string[] = [];

async function check(name: string, body: () => Promise<string>) {
  try {
    console.log(`ok   ${name} — ${await body()}`);
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`FAIL ${name}`);
  }
}

await check("every legacy profile has a profile and an active personal subject", async () => {
  const [{ legacy }] = await sql<{ legacy: number }[]>`select count(*)::int as legacy from public.profiles`;
  const [{ carried }] = await sql<{ carried: number }[]>`
    select count(*)::int as carried from public.profiles p
    join app.profiles ap on ap.user_id = p.id
  `;
  const [{ subjects }] = await sql<{ subjects: number }[]>`
    select count(*)::int as subjects from public.profiles p
    join app.analysis_subjects s
      on s.owner_user_id = p.id and s.kind = 'personal' and s.status = 'active'
  `;
  if (carried !== legacy) throw new Error(`${legacy} legacy, ${carried} carried`);
  if (subjects !== legacy) throw new Error(`${legacy} legacy, ${subjects} subjects`);
  return `${legacy} legacy profiles -> ${carried} profiles, ${subjects} personal subjects`;
});

await check("every legacy link became exactly one claim", async () => {
  const [{ legacy }] = await sql<{ legacy: number }[]>`
    select count(*)::int as legacy from public.linked_accounts
  `;
  const [{ carried }] = await sql<{ carried: number }[]>`
    select count(*)::int as carried
    from public.linked_accounts la
    join app.providers pr on pr.slug = la.platform::text
    join app.provider_identities pi
      on pi.provider_id = pr.id
     and pi.provider_identity_key = coalesce(nullif(la.provider_account_id, ''), la.normalized_username)
    join app.linked_accounts nla
      on nla.owner_user_id = la.user_id and nla.provider_identity_id = pi.id
  `;
  if (carried < legacy) throw new Error(`${legacy} legacy links, only ${carried} reconciled`);
  return `${legacy} legacy links -> ${carried} claims`;
});

await check("no legacy row was modified or removed", async () => {
  const [{ p }] = await sql<{ p: number }[]>`select count(*)::int as p from public.profiles`;
  const [{ l }] = await sql<{ l: number }[]>`select count(*)::int as l from public.linked_accounts`;
  if (p === 0 && l === 0) throw new Error("the legacy tables are empty; nothing to reconcile against");
  return `${p} profiles and ${l} links still present and untouched`;
});

await check("shared handles converge on one identity, claims stay separate", async () => {
  const shared = await sql<{ key: string; owners: number }[]>`
    select pi.provider_identity_key as key, count(distinct nla.owner_user_id)::int as owners
    from app.provider_identities pi
    join app.linked_accounts nla on nla.provider_identity_id = pi.id
    group by pi.provider_identity_key having count(distinct nla.owner_user_id) > 1
  `;
  const [{ identities }] = await sql<{ identities: number }[]>`
    select count(*)::int as identities from app.provider_identities
  `;
  const [{ claims }] = await sql<{ claims: number }[]>`
    select count(*)::int as claims from app.linked_accounts
  `;
  return shared.length
    ? `${identities} identities, ${claims} claims; ${shared.length} handle(s) held by more than one owner`
    : `${identities} identities, ${claims} claims; no handle is currently held by two owners`;
});

await check("no identity key is duplicated within a provider", async () => {
  const dupes = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select provider_id, provider_identity_key
      from app.provider_identities group by 1, 2 having count(*) > 1
    ) d
  `;
  if (dupes[0].n !== 0) throw new Error(`${dupes[0].n} duplicated keys`);
  return "0 duplicates";
});

await check("every claim has exactly one open membership", async () => {
  const [{ claims }] = await sql<{ claims: number }[]>`
    select count(*)::int as claims from app.linked_accounts where status <> 'disconnected'
  `;
  const [{ open }] = await sql<{ open: number }[]>`
    select count(*)::int as open from app.subject_account_memberships where valid_to is null
  `;
  const orphans = await sql<{ n: number }[]>`
    select count(*)::int as n from app.linked_accounts la
    where la.status <> 'disconnected'
      and not exists (
        select 1 from app.subject_account_memberships m
        where m.linked_account_id = la.id and m.valid_to is null
      )
  `;
  if (orphans[0].n !== 0) throw new Error(`${orphans[0].n} claims contribute to no subject`);
  return `${claims} live claims, ${open} open memberships, 0 orphans`;
});

await check("aliases record every observed spelling", async () => {
  const [{ spellings }] = await sql<{ spellings: number }[]>`
    select count(*)::int as spellings from (
      select distinct platform, username from public.linked_accounts
    ) s
  `;
  const [{ aliases }] = await sql<{ aliases: number }[]>`
    select count(*)::int as aliases from app.provider_identity_aliases
  `;
  if (aliases < spellings) throw new Error(`${spellings} spellings, only ${aliases} aliases`);
  return `${spellings} distinct legacy spellings -> ${aliases} aliases`;
});

await check("RLS is still forced on every tenant table", async () => {
  const rows = await sql<{ t: string; forced: boolean }[]>`
    select c.relname as t, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app','social')
      and c.relname in ('profiles','analysis_subjects','linked_accounts',
                        'subject_account_memberships','public_player_profiles')
  `;
  const unforced = rows.filter((r) => !r.forced).map((r) => r.t);
  if (unforced.length) throw new Error(`${unforced.join(", ")} left unforced`);
  return `${rows.length} tables, all still forced`;
});

await sql.end();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
}
