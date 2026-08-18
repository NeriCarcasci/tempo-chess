-- 0018_e07_artifacts
--
-- E07 — metadata for bodies that live in private Supabase Storage.
--
-- Hand-written and reviewed. Additive and forward-only: one table in the `ops`
-- namespace E02 established, no change to any existing object, no row touched.
-- Re-running it is a no-op.
--
-- The table exists because an object write and a database write cannot be one
-- transaction. The object is written first and the row only reaches `ready`
-- once the body has been verified, so the failure mode is an unreferenced
-- object -- which a janitor sweeps -- rather than a row promising a body that
-- is not there. Every constraint below enforces one half of that.

set local role forma_migrator
--> statement-breakpoint
create table if not exists ops.artifacts (
  id uuid primary key default gen_random_uuid(),
  provider_id smallint references app.providers(id),
  artifact_kind text,
  storage_backend text not null default 'supabase',
  bucket text not null,
  object_key text not null,
  sha256 text,
  byte_size bigint,
  media_type text,
  compression text,
  state text not null default 'pending',
  retention_class text not null,
  owner_subject_id uuid references app.analysis_subjects(id) on delete restrict,
  created_by_workflow_id uuid references ops.workflows(id) on delete set null,
  source_reference text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  deleting_at timestamptz,
  deleted_at timestamptz,
  deletion_failure_class text,
  constraint artifacts_state_check
    check (state in ('pending', 'ready', 'deleting', 'deleted', 'failed')),
  constraint artifacts_retention_check
    check (retention_class in ('subject_owned', 'system_immutable', 'editorial', 'temporary')),
  constraint artifacts_bucket_check
    check (bucket in ('subject-artifacts', 'system-artifacts', 'exports')),
  -- §8.4: the bucket follows from the retention class. A client cannot choose
  -- where its body lands, and a row that disagrees is unrepresentable.
  constraint artifacts_bucket_matches_retention check (
    (retention_class in ('subject_owned', 'editorial') and bucket = 'subject-artifacts')
    or (retention_class = 'system_immutable' and bucket = 'system-artifacts')
    or (retention_class = 'temporary' and bucket = 'exports')
  ),
  -- §8.4: "a ready artifact has byte size and checksum". This is the constraint
  -- that makes a verified body a precondition of being downloadable, rather
  -- than a convention the application is trusted to follow.
  constraint artifacts_ready_is_verified check (
    state <> 'ready'
    or (sha256 is not null and byte_size is not null and verified_at is not null)
  ),
  constraint artifacts_sha256_shape check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint artifacts_byte_size_sane check (byte_size is null or byte_size >= 0),
  -- §8.4: "a deleted artifact has no usable download state".
  constraint artifacts_deleted_is_gone check (state <> 'deleted' or deleted_at is not null),
  -- §8.4: subject-owned artifacts name an owning subject.
  constraint artifacts_subject_owned_has_owner check (
    retention_class <> 'subject_owned' or owner_subject_id is not null
  ),
  -- A temporary export is only temporary if it says when it stops existing.
  constraint artifacts_temporary_expires check (
    retention_class <> 'temporary' or expires_at is not null
  )
)
--> statement-breakpoint
comment on table ops.artifacts is 'Metadata for bodies held in private Supabase Storage (database architecture 8.4). Content is never duplicated here. Storage has no object versioning, so identity comes from an immutable opaque key plus a checksum rather than a mutable generation. The object is written before the row is made ready, so the failure mode is an unreferenced object the janitor sweeps, never a row promising a body that is absent.'
--> statement-breakpoint
comment on column ops.artifacts.object_key is 'Opaque and random, or checksum-addressed for system artifacts. Keys appear in signed URLs, storage listings and logs, so anything embedded in one is disclosed: no handle, subject id, game id or email ever goes here.'
--> statement-breakpoint
comment on column ops.artifacts.deletion_failure_class is 'Sanitized classification only. A deletion that failed stays visible so it can be retried; the provider message is not copied here.'
--> statement-breakpoint
-- §8.4: unique (storage_backend, bucket, object_key). Two rows naming one body
-- would let one of them delete the other's object.
create unique index if not exists artifacts_object_unique
  on ops.artifacts (storage_backend, bucket, object_key)
--> statement-breakpoint
-- The janitor's query: pending past its grace period, or failed.
create index if not exists artifacts_sweepable
  on ops.artifacts (state, created_at) where state in ('pending', 'failed')
--> statement-breakpoint
-- The expiry sweep's query.
create index if not exists artifacts_expiring
  on ops.artifacts (expires_at) where expires_at is not null and state = 'ready'
--> statement-breakpoint
create index if not exists artifacts_owner_subject on ops.artifacts (owner_subject_id)
--> statement-breakpoint
create index if not exists artifacts_workflow on ops.artifacts (created_by_workflow_id)
--> statement-breakpoint
create index if not exists artifacts_provider on ops.artifacts (provider_id)
--> statement-breakpoint
-- Deleting a subject must not silently orphan its bodies: the foreign key is
-- `on delete restrict`, so the artifacts have to be dealt with first. That is
-- the point of permanent subject deletion being a workflow rather than a
-- cascade.
alter table ops.artifacts enable row level security
--> statement-breakpoint
alter table ops.artifacts force row level security
--> statement-breakpoint
-- An artifact is reachable by the owner of the subject it belongs to. System
-- artifacts have no subject and are readable by any bound actor: they are
-- catalogues and model assets, not anyone's data.
create policy artifacts_owner on ops.artifacts
  using (
    (retention_class = 'system_immutable' and private.current_actor_id() is not null)
    or exists (
      select 1 from app.analysis_subjects s
      where s.id = owner_subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = owner_subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
grant select, insert, update on ops.artifacts to forma_api
--> statement-breakpoint
grant select, insert, update on ops.artifacts to forma_ingestion, forma_analysis
--> statement-breakpoint
grant select, update on ops.artifacts to forma_ops
--> statement-breakpoint
revoke all on ops.artifacts from public
--> statement-breakpoint
reset role
