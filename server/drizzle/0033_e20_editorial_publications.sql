-- 0033_e20_editorial_publications
--
-- E20 — deliberately sourced public projections: editorial sources, consent
-- records, editorial review, the public case-study pointer and its append-only
-- publication history.
--
-- Hand-written and reviewed. Additive and forward-only: five tables in the
-- `social` namespace. No existing object changes shape, no row is touched,
-- nothing is dropped or renamed. Re-running it is a no-op.
--
-- The thing this exists to prevent is the easy version of a public example: run
-- the analysis over a famous player's public games, put it on the marketing
-- site, and let "the games are public" stand in for permission. Public
-- availability is not permission, a provider handle is not consent, and neither
-- is a fact about anybody who has not been asked. So:
--
--   * Every public case study resolves an editorial source with a named
--     permission basis, a completed analysis run, and an approval by a named
--     person who ticked every box in the same row.
--   * A case study about an identifiable ordinary player needs a consent
--     record. Withdrawing consent takes the study off the public surface on the
--     next read, without an operator doing anything.
--   * Withdrawal moves a pointer. It never rewrites the analysis, the source,
--     the review or the history — the evidence for a claim we made in public is
--     exactly the evidence that has to survive us retracting it.
--   * Nothing here can point at a personal subject. A private account cannot be
--     published by editing a state column.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 26.4 — the editorial source
--
-- Where the material came from and on what basis we may republish it. One row
-- per source, reused across the case studies drawn from it.
--
-- `permission_basis` is the column that does the work. It is deliberately not
-- `licence text` — "CC BY-SA 4.0" in a free-text field is a note somebody wrote,
-- while a basis is a claim the constraints below can hold to account.
-- ---------------------------------------------------------------------------
create table if not exists social.editorial_sources (
  id uuid primary key default gen_random_uuid(),
  /* What kind of material this is, which decides what a reader must be told. */
  source_kind text not null,
  title text not null,
  publisher text,
  source_url text,
  retrieved_at timestamptz,
  /* Why we may republish it. Four bases and no fifth; "it was on the internet"
     is not one of them. */
  permission_basis text not null,
  licence_key text,
  licence_url text,
  /* The credit line a licence requires, rendered with the case study. */
  attribution_text text,
  note text,
  registered_by uuid references app.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint editorial_sources_kind_check check (source_kind in (
    'historic_archive', 'provider_public_profile', 'licensed_dataset', 'player_submission'
  )),
  constraint editorial_sources_basis_check check (permission_basis in (
    'public_domain', 'licence', 'consent', 'own_material'
  )),
  -- A licence basis names the licence and where to read it. A basis nobody can
  -- check is the same as no basis.
  constraint editorial_sources_licence_named check (
    permission_basis <> 'licence'
    or (licence_key is not null and licence_url is not null and attribution_text is not null)
  ),
  -- A player submission is somebody's own material handed to us, so it is
  -- consent or nothing. The alternative is a "they sent it in" defence for
  -- publishing a stranger's games.
  constraint editorial_sources_submission_is_consented check (
    source_kind <> 'player_submission' or permission_basis = 'consent'
  ),
  constraint editorial_sources_url_shape check (
    source_url is null or source_url ~ '^https://[^[:space:]]+$'
  ),
  constraint editorial_sources_licence_url_shape check (
    licence_url is null or licence_url ~ '^https://[^[:space:]]+$'
  ),
  -- Material we did not create is only citable if we say when we took it.
  constraint editorial_sources_retrieval_dated check (
    permission_basis in ('own_material', 'consent') or retrieved_at is not null
  )
)
--> statement-breakpoint
comment on table social.editorial_sources is 'Where public editorial material came from and on what basis it may be republished (database architecture 26.4). Public availability is not a permission basis: the four allowed values are public domain, a named licence, recorded consent, or our own material.'
--> statement-breakpoint
comment on column social.editorial_sources.attribution_text is 'The credit line rendered with every case study drawn from this source. Required for a licensed source, because most licences require attribution and a credit nobody stored is a credit nobody shows.'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 26.4 — consent, and its withdrawal
--
-- An ordinary player is identifiable in a case study about their own games, so
-- publishing one is something they agree to and can stop agreeing to.
--
-- The signed consent itself is a private artifact. The person's name, address
-- and message live inside it, not in a column that a public read could reach by
-- joining one table too many.
-- ---------------------------------------------------------------------------
create table if not exists social.editorial_consents (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  /* Set when the consenting person has a Forma account; null when they do not,
     which is the normal case for an invited case study. */
  consenting_user_id uuid references app.profiles(user_id) on delete set null,
  consent_artifact_id uuid references ops.artifacts(id) on delete restrict,
  /* What they agreed to. Publishing the analysis and publishing it under their
     provider handle are different agreements and are recorded as such. */
  scope text not null,
  granted_at timestamptz not null,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_note text,
  recorded_by uuid references app.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint editorial_consents_scope_check check (scope in (
    'publish_analysis', 'publish_analysis_with_handle'
  )),
  constraint editorial_consents_withdrawal_after_grant check (
    withdrawn_at is null or withdrawn_at >= granted_at
  ),
  constraint editorial_consents_expiry_after_grant check (
    expires_at is null or expires_at > granted_at
  ),
  -- A withdrawal is a thing that happened to a person, so it is dated and said
  -- out loud rather than expressed by a row disappearing.
  constraint editorial_consents_withdrawal_noted check (
    (withdrawn_at is null) = (withdrawal_note is null)
  )
)
--> statement-breakpoint
comment on table social.editorial_consents is 'Consent to publish a case study about an identifiable player, and its withdrawal (database architecture 26.4). The public read joins this row and filters on withdrawal and expiry, so withdrawing consent removes the study on the next request rather than when an operator gets to it.'
--> statement-breakpoint
comment on column social.editorial_consents.consent_artifact_id is 'The signed consent. A private artifact rather than columns, because it carries a name and contact details that must never be one join away from a public projection.'
--> statement-breakpoint
create index if not exists editorial_consents_subject on social.editorial_consents (subject_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Editorial review
--
-- A named person looked at the exact run that is about to be published and
-- confirmed the source, the licence, the consent and the redactions.
--
-- The checklist is stored as the boxes rather than as a decision, and an
-- approval that does not have every box ticked cannot be inserted. That is the
-- difference between a review record and a review.
-- ---------------------------------------------------------------------------
create table if not exists social.editorial_reviews (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  reviewer_user_id uuid not null references app.profiles(user_id) on delete restrict,
  decision text not null,
  checklist jsonb not null,
  /* The redaction policy the reviewer read the output under. A later policy
     version is a different projection and needs a fresh review. */
  redaction_policy_version text not null,
  note text,
  decided_at timestamptz not null default now(),
  constraint editorial_reviews_decision_check check (decision in (
    'approved', 'changes_requested', 'rejected'
  )),
  constraint editorial_reviews_checklist_object check (jsonb_typeof(checklist) = 'object'),
  -- Every box, in the same row as the approval.
  constraint editorial_reviews_approval_is_complete check (
    decision <> 'approved' or (
      coalesce((checklist ->> 'source_verified')::boolean, false)
      and coalesce((checklist ->> 'licence_verified')::boolean, false)
      and coalesce((checklist ->> 'consent_verified')::boolean, false)
      and coalesce((checklist ->> 'redactions_verified')::boolean, false)
      and coalesce((checklist ->> 'facts_unchanged')::boolean, false)
    )
  ),
  -- Refusing to publish something is the decision that needs a reason on it.
  constraint editorial_reviews_refusal_explained check (
    decision = 'approved' or note is not null
  ),
  constraint editorial_reviews_policy_shape check (
    redaction_policy_version ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  )
)
--> statement-breakpoint
comment on table social.editorial_reviews is 'One editorial decision on one analysis run by one named person (database architecture 26.4). An approval cannot be recorded unless the same row ticks source, licence, consent, redactions and facts-unchanged, so "reviewed" cannot degrade into a column somebody set.'
--> statement-breakpoint
comment on column social.editorial_reviews.checklist is 'The five named boxes. Stored rather than summarised, because an approval whose grounds were not written down is indistinguishable from one nobody made.'
--> statement-breakpoint
create index if not exists editorial_reviews_subject_run
  on social.editorial_reviews (subject_id, run_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 7.9 — the public case-study pointer
--
-- One deliberately public editorial projection, pinning the exact successful
-- run and the immutable publication that installed it. It never points at a
-- private live subject publication implicitly, because it cannot point at a
-- personal subject at all.
-- ---------------------------------------------------------------------------
create table if not exists social.case_study_publications (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  /* The history row that installed the pointer, so a cached public response is
     invalidated by the next switch rather than by a guessed TTL. */
  publication_id uuid not null
    references analysis.subject_live_publication_history(id) on delete restrict,
  source_id uuid not null references social.editorial_sources(id) on delete restrict,
  consent_id uuid references social.editorial_consents(id) on delete restrict,
  review_id uuid not null references social.editorial_reviews(id) on delete restrict,
  redaction_policy_version text not null,
  public_state text not null default 'draft',
  title text not null,
  summary text not null,
  /* What a reader has to be told about the limits of the claim. Not decoration:
     a public example of an estimate without its caveats is a stronger statement
     than the estimate. */
  caveats text[] not null default '{}',
  content_sha256 text not null,
  public_artifact_id uuid references ops.artifacts(id) on delete restrict,
  published_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  created_by uuid references app.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint case_studies_slug_shape check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80
  ),
  constraint case_studies_state_check check (public_state in ('draft', 'published', 'withdrawn')),
  -- A withdrawn study keeps the date it was published. Blanking it would turn a
  -- retraction into a claim we never said anything.
  constraint case_studies_state_timestamps check (
    case public_state
      when 'draft' then
        published_at is null and withdrawn_at is null and withdrawal_reason is null
      when 'published' then
        published_at is not null and withdrawn_at is null and withdrawal_reason is null
      else
        published_at is not null and withdrawn_at is not null and withdrawal_reason is not null
    end
  ),
  constraint case_studies_withdrawal_after_publication check (
    withdrawn_at is null or withdrawn_at >= published_at
  ),
  constraint case_studies_checksum_shape check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint case_studies_policy_shape check (
    redaction_policy_version ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  ),
  constraint case_studies_title_present check (length(btrim(title)) between 3 and 160),
  constraint case_studies_summary_present check (length(btrim(summary)) between 20 and 2000),
  constraint case_studies_caveats_bounded check (
    array_length(caveats, 1) is null or array_length(caveats, 1) <= 12
  )
)
--> statement-breakpoint
comment on table social.case_study_publications is 'One deliberately public editorial projection (database architecture 7.9). It pins the exact successful run, the immutable publication history row, the source, the consent where one is needed, and the approval. Withdrawing it moves this pointer and rewrites none of that.'
--> statement-breakpoint
comment on column social.case_study_publications.content_sha256 is 'Checksum of the public projection as reviewed. A public body that no longer hashes to it is not the thing that was approved.'
--> statement-breakpoint
create index if not exists case_studies_published
  on social.case_study_publications (published_at desc, id)
  where public_state = 'published'
--> statement-breakpoint
create index if not exists case_studies_subject on social.case_study_publications (subject_id)
--> statement-breakpoint
create index if not exists case_studies_source on social.case_study_publications (source_id)
--> statement-breakpoint
create index if not exists case_studies_consent on social.case_study_publications (consent_id)
--> statement-breakpoint
create index if not exists case_studies_review on social.case_study_publications (review_id)
--> statement-breakpoint
create index if not exists case_studies_run on social.case_study_publications (run_id)
--> statement-breakpoint
create index if not exists case_studies_publication
  on social.case_study_publications (publication_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Publication history
--
-- Append-only. Every time the public pointer moved, who moved it and why.
-- Rolling back a publication is inserting a withdrawal here and flipping the
-- state; it is never deleting the row that says we published it.
-- ---------------------------------------------------------------------------
create table if not exists social.case_study_publication_events (
  id bigserial primary key,
  case_study_id uuid not null
    references social.case_study_publications(id) on delete restrict,
  event_kind text not null,
  /* The checksum in force at the moment of the event, so the history says what
     was public and not merely that something was. */
  content_sha256 text not null,
  reason text,
  actor_user_id uuid references app.profiles(user_id) on delete set null,
  occurred_at timestamptz not null default now(),
  constraint case_study_events_kind_check check (event_kind in (
    'published', 'republished', 'revised', 'withdrawn'
  )),
  constraint case_study_events_checksum_shape check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint case_study_events_withdrawal_explained check (
    event_kind <> 'withdrawn' or reason is not null
  )
)
--> statement-breakpoint
comment on table social.case_study_publication_events is 'Append-only record of every move of a public case-study pointer (database architecture 7.9, 20). Update and delete are refused: a retraction is a row, and a retraction that erased the publication would leave nothing to retract.'
--> statement-breakpoint
create index if not exists case_study_events_by_study
  on social.case_study_publication_events (case_study_id, occurred_at desc)
--> statement-breakpoint
create or replace function social.refuse_mutation() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'social.% is append-only', tg_table_name
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
comment on function social.refuse_mutation() is 'Refuses update and delete on the append-only public publication history. Withdrawal is an inserted event plus a pointer state, never an erased one.'
--> statement-breakpoint
revoke all on function social.refuse_mutation() from public
--> statement-breakpoint
drop trigger if exists case_study_events_no_update on social.case_study_publication_events
--> statement-breakpoint
create trigger case_study_events_no_update
  before update or delete on social.case_study_publication_events
  for each row execute function social.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- The publication invariant
--
-- Everything a public claim needs, checked where it cannot be forgotten. A
-- reviewer, an operator and a route can each be wrong; this is the layer that
-- has to be right.
-- ---------------------------------------------------------------------------
-- Deliberately *not* `security definer`. The grounds for a publication have to
-- be visible to whoever is publishing: a writer that can insert a pointer to a
-- review it cannot read is a writer that can cite a review nobody checked. The
-- search path is still pinned, and every reference below is schema-qualified.
create or replace function social.enforce_case_study() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  subject_kind text;
  subject_owner uuid;
  run_status text;
  run_subject uuid;
  run_manifest text;
  history_subject uuid;
  history_run uuid;
  basis text;
  review_decision text;
  review_subject uuid;
  review_run uuid;
  review_policy text;
  consent_subject uuid;
  consent_withdrawn timestamptz;
  consent_expires timestamptz;
begin
  select kind, owner_user_id into subject_kind, subject_owner
  from app.analysis_subjects where id = new.subject_id;

  -- A personal subject is somebody's private account. There is no state column
  -- and no admin action that publishes one.
  if subject_kind is distinct from 'editorial' and subject_kind is distinct from 'case_study' then
    raise exception 'a case study may only publish an editorial or case_study subject'
      using errcode = 'restrict_violation';
  end if;
  if subject_owner is not null then
    raise exception 'a published subject cannot have an account owner'
      using errcode = 'restrict_violation';
  end if;

  select status, subject_id, output_manifest_hash
    into run_status, run_subject, run_manifest
  from analysis.runs where id = new.run_id;

  -- Publishing a failed or in-flight run would put a number in public that no
  -- integrity check ever passed.
  if run_status is distinct from 'succeeded' or run_manifest is null then
    raise exception 'a case study must pin a succeeded run with an output manifest'
      using errcode = 'restrict_violation';
  end if;
  if run_subject is distinct from new.subject_id then
    raise exception 'the pinned run belongs to a different subject'
      using errcode = 'restrict_violation';
  end if;

  select subject_id, run_id into history_subject, history_run
  from analysis.subject_live_publication_history where id = new.publication_id;

  if history_subject is distinct from new.subject_id or history_run is distinct from new.run_id then
    raise exception 'the publication history row does not match the pinned subject and run'
      using errcode = 'restrict_violation';
  end if;

  select decision, subject_id, run_id, redaction_policy_version
    into review_decision, review_subject, review_run, review_policy
  from social.editorial_reviews where id = new.review_id;

  if review_decision is distinct from 'approved' then
    raise exception 'the cited editorial review did not approve'
      using errcode = 'restrict_violation';
  end if;
  if review_subject is distinct from new.subject_id or review_run is distinct from new.run_id then
    raise exception 'the cited editorial review is for a different subject or run'
      using errcode = 'restrict_violation';
  end if;
  -- A different redaction policy is a different projection, and the reviewer
  -- read the one they read.
  if review_policy is distinct from new.redaction_policy_version then
    raise exception 'the cited review approved a different redaction policy version'
      using errcode = 'restrict_violation';
  end if;

  select permission_basis into basis from social.editorial_sources where id = new.source_id;

  if basis = 'consent' then
    if new.consent_id is null then
      raise exception 'a consent-based source requires a consent record'
        using errcode = 'restrict_violation';
    end if;
    select subject_id, withdrawn_at, expires_at
      into consent_subject, consent_withdrawn, consent_expires
    from social.editorial_consents where id = new.consent_id;
    if consent_subject is distinct from new.subject_id then
      raise exception 'the cited consent is for a different subject'
        using errcode = 'restrict_violation';
    end if;
    -- Withdrawal and expiry are checked at the moment of publishing as well as
    -- on every read, because a study that goes public an hour after somebody
    -- said no is not fixed by the read path catching it later.
    if new.public_state = 'published' then
      if consent_withdrawn is not null then
        raise exception 'consent for this subject has been withdrawn'
          using errcode = 'restrict_violation';
      end if;
      if consent_expires is not null and consent_expires <= now() then
        raise exception 'consent for this subject has expired'
          using errcode = 'restrict_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$
--> statement-breakpoint
comment on function social.enforce_case_study() is 'Everything a public editorial claim needs, checked in the database (database architecture 7.9, 26.4): an editorial subject with no account owner, a succeeded run with an output manifest, a matching publication history row, an approval of that exact run under that exact redaction policy, and unwithdrawn consent when the source is consent-based.'
--> statement-breakpoint
revoke all on function social.enforce_case_study() from public
--> statement-breakpoint
drop trigger if exists case_studies_are_publishable on social.case_study_publications
--> statement-breakpoint
create trigger case_studies_are_publishable
  before insert or update on social.case_study_publications
  for each row execute function social.enforce_case_study()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Editorial rows are not tenant rows.
--
-- E06 and E11 express row-level access as ownership: a subject is visible to
-- the account that owns it, and a run is visible through its subject. An
-- editorial subject has no owner by construction (7.2 requires it), so those
-- policies can never match one — which means that until now nothing but a
-- superuser could read an editorial subject or the runs underneath it.
--
-- That is the gap this epic has to close, and it closes it the narrow way: a
-- select-only policy scoped to ownerless editorial subjects. No role gains a
-- write, and nothing about a personal subject becomes visible. A case study is
-- material we intend to publish; the reason it is not tenant data is the same
-- reason it needed a licence, a consent and a review before it got here.
-- ---------------------------------------------------------------------------
drop policy if exists analysis_subjects_editorial on app.analysis_subjects
--> statement-breakpoint
create policy analysis_subjects_editorial on app.analysis_subjects
  for select using (owner_user_id is null and kind in ('editorial', 'case_study'))
--> statement-breakpoint
drop policy if exists runs_editorial on analysis.runs
--> statement-breakpoint
create policy runs_editorial on analysis.runs
  for select using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id is null
        and s.kind in ('editorial', 'case_study')
    )
  )
--> statement-breakpoint
drop policy if exists subject_live_history_editorial
  on analysis.subject_live_publication_history
--> statement-breakpoint
create policy subject_live_history_editorial
  on analysis.subject_live_publication_history
  for select using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id is null
        and s.kind in ('editorial', 'case_study')
    )
  )
--> statement-breakpoint
-- The directory's opt-in provider handle has the same shape of problem. A
-- linked account is visible to its owner and to nobody else, which is right for
-- every other purpose and wrong for the one case where its owner has asked for
-- the handle to be shown. The policy states both opt-ins itself rather than
-- trusting the query to remember them: the account's own flag, and the
-- profile's. An anonymous reader sees a handle only when both are set.
drop policy if exists linked_accounts_published_handle on app.linked_accounts
--> statement-breakpoint
create policy linked_accounts_published_handle on app.linked_accounts
  for select using (
    provider_handle_discoverable
    and status = 'active'
    and exists (
      select 1 from social.public_player_profiles p
      where p.user_id = owner_user_id and p.is_discoverable and p.show_provider_handles
    )
  )
--> statement-breakpoint
-- The editorial deployment resolves a candidate's grounds before it publishes,
-- and one of them is the subject's kind. Select only: `forma_ops` has no
-- business creating or renaming a subject.
grant select on app.analysis_subjects to forma_ops
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Row level security.
--
-- These tables hold editorial material rather than tenant rows, and the public
-- projection is the whole point of one of them. The policy that matters is the
-- one on the pointer: a reader may see a published study and nothing else, so a
-- draft or a withdrawn study is invisible even to a query that forgot to filter.
-- ---------------------------------------------------------------------------
alter table social.editorial_sources enable row level security
--> statement-breakpoint
alter table social.editorial_sources force row level security
--> statement-breakpoint
alter table social.editorial_consents enable row level security
--> statement-breakpoint
alter table social.editorial_consents force row level security
--> statement-breakpoint
alter table social.editorial_reviews enable row level security
--> statement-breakpoint
alter table social.editorial_reviews force row level security
--> statement-breakpoint
alter table social.case_study_publications enable row level security
--> statement-breakpoint
alter table social.case_study_publications force row level security
--> statement-breakpoint
alter table social.case_study_publication_events enable row level security
--> statement-breakpoint
alter table social.case_study_publication_events force row level security
--> statement-breakpoint
drop policy if exists case_studies_published_only on social.case_study_publications
--> statement-breakpoint
-- The API sees published studies and nothing else. A draft and a withdrawn
-- study are invisible to it even under a query that forgot to filter, which is
-- the point: the filter is the product rule, and product rules get edited.
create policy case_studies_published_only on social.case_study_publications
  for select to forma_api using (public_state = 'published')
--> statement-breakpoint
drop policy if exists case_studies_editorial on social.case_study_publications
--> statement-breakpoint
-- The editorial deployment stages, publishes and withdraws, so it sees every
-- state. What it may write is decided by the column grants below, not here.
create policy case_studies_editorial on social.case_study_publications
  for all to forma_ops using (true) with check (true)
--> statement-breakpoint
drop policy if exists editorial_sources_readable on social.editorial_sources
--> statement-breakpoint
-- A source is citable material and its credit line is rendered publicly, so the
-- row is readable. It carries no personal detail: the consent artifact does.
create policy editorial_sources_readable on social.editorial_sources
  for select to forma_api using (true)
--> statement-breakpoint
drop policy if exists editorial_sources_editorial on social.editorial_sources
--> statement-breakpoint
create policy editorial_sources_editorial on social.editorial_sources
  for all to forma_ops using (true) with check (true)
--> statement-breakpoint
drop policy if exists editorial_consents_state_only on social.editorial_consents
--> statement-breakpoint
-- The read path needs to know whether consent still stands. It does not need,
-- and by the column grants below cannot have, the artifact behind it.
create policy editorial_consents_state_only on social.editorial_consents
  for select to forma_api using (true)
--> statement-breakpoint
drop policy if exists editorial_consents_editorial on social.editorial_consents
--> statement-breakpoint
create policy editorial_consents_editorial on social.editorial_consents
  for all to forma_ops using (true) with check (true)
--> statement-breakpoint
drop policy if exists editorial_reviews_readable on social.editorial_reviews
--> statement-breakpoint
create policy editorial_reviews_readable on social.editorial_reviews
  for select to forma_api using (true)
--> statement-breakpoint
drop policy if exists editorial_reviews_editorial on social.editorial_reviews
--> statement-breakpoint
create policy editorial_reviews_editorial on social.editorial_reviews
  for all to forma_ops using (true) with check (true)
--> statement-breakpoint
drop policy if exists case_study_events_readable on social.case_study_publication_events
--> statement-breakpoint
create policy case_study_events_readable on social.case_study_publication_events
  for select to forma_api using (true)
--> statement-breakpoint
drop policy if exists case_study_events_editorial on social.case_study_publication_events
--> statement-breakpoint
create policy case_study_events_editorial on social.case_study_publication_events
  for all to forma_ops using (true) with check (true)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants.
--
-- The API serves the public surface and writes none of it. Publishing and
-- withdrawing are editorial acts performed by `forma_ops`, which is the
-- deployment an operator drives — a route that could publish is a route that
-- could be made to publish.
--
-- `forma_api` gets named columns on the consent table rather than the table,
-- because the artifact id is the pointer to a document with a person's contact
-- details in it and the public read only ever needs the dates.
-- ---------------------------------------------------------------------------
grant select on social.editorial_sources to forma_api
--> statement-breakpoint
grant select (id, subject_id, scope, granted_at, expires_at, withdrawn_at)
  on social.editorial_consents to forma_api
--> statement-breakpoint
grant select on social.editorial_reviews to forma_api
--> statement-breakpoint
grant select on social.case_study_publications to forma_api
--> statement-breakpoint
grant select on social.case_study_publication_events to forma_api
--> statement-breakpoint
grant select, insert on social.editorial_sources to forma_ops
--> statement-breakpoint
grant select, insert on social.editorial_consents to forma_ops
--> statement-breakpoint
-- Withdrawal is an update of exactly two columns. `forma_ops` cannot rewrite
-- when consent was given or what it covered.
grant update (withdrawn_at, withdrawal_note) on social.editorial_consents to forma_ops
--> statement-breakpoint
grant select, insert on social.editorial_reviews to forma_ops
--> statement-breakpoint
grant select, insert on social.case_study_publications to forma_ops
--> statement-breakpoint
-- The publishable surface of the pointer: its state, its dates, its reason and
-- the reviewed content it points at. The subject, run, publication, source,
-- consent and review it pins are fixed at insert.
grant update (
  public_state, published_at, withdrawn_at, withdrawal_reason,
  title, summary, caveats, content_sha256, public_artifact_id
) on social.case_study_publications to forma_ops
--> statement-breakpoint
grant select, insert on social.case_study_publication_events to forma_ops
--> statement-breakpoint
grant usage, select on sequence social.case_study_publication_events_id_seq to forma_ops
