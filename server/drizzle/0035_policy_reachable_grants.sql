-- 0035_policy_reachable_grants
--
-- Let the worker roles read the table a policy on `app.linked_accounts` reads.
--
-- Hand-written and reviewed. Two grants, no schema change, no row touched.
-- Re-running it is a no-op.
--
-- `app.linked_accounts` carries two permissive SELECT policies. The first is
-- the owner check. The second, `linked_accounts_published_handle`, exposes a
-- handle the player chose to publish, and its expression reads
-- `social.public_player_profiles`.
--
-- PostgreSQL evaluates *every* permissive policy for a command and ORs the
-- results, and a policy expression runs with the privileges of the role issuing
-- the query -- not the policy's author. So any role that selects
-- `app.linked_accounts` at all must also hold SELECT on
-- `social.public_player_profiles`, whether or not it cares about the public
-- directory, or the read fails with 42501.
--
-- `forma_api` had that grant, which is why the product surface worked and this
-- stayed hidden. `forma_ingestion` did not: the account sync's very first
-- statement -- resolving the provider handle for the account it was told to
-- sync -- was refused. 42501 is also what a missing table grant raises, so it
-- surfaced as `db_permission_denied` and read like a misconfigured role rather
-- than a policy reaching somewhere the role could not follow.
--
-- `forma_analysis` holds the same combination and would fail the same way the
-- first time it reads a linked account, so it is granted here too rather than
-- waiting for it to be discovered a second time.
--
-- `forma_ops` and `forma_stockfish` cannot read `app.linked_accounts` at all,
-- so they cannot reach the policy and are deliberately left alone.
--
-- The grant is SELECT only. Neither worker writes the public directory; they
-- only have to be able to evaluate a policy that mentions it.
--
-- `app.analysis_subjects` is the third, and the same shape once more: the
-- policies on `chess.subject_games`, `chess.subject_game_sources` and
-- `app.subject_account_memberships` all resolve ownership by selecting from it.
-- Every other worker role already held this grant; only `forma_ingestion` did
-- not, which is why writing a synced game failed at the last step after the
-- provider had already been read.
--
-- The general rule, worth stating because it will happen again: a role needs
-- SELECT on every table any policy on its tables *mentions*, not merely on the
-- tables it queries. `pg_policies` is the place to check when a 42501 names a
-- table the failing statement does not.
--
-- `app.subject_account_memberships` is the second gap, found the same way. The
-- sync reads it to collect every handle the subject owns, because two accounts
-- in one subject must not disagree about which side the player was -- so it has
-- to see the sibling accounts, not just the one it was handed. Read only: the
-- membership itself is written by the API when an account is linked.

set local role forma_migrator
--> statement-breakpoint
grant select on social.public_player_profiles to forma_ingestion
--> statement-breakpoint
grant select on social.public_player_profiles to forma_analysis
--> statement-breakpoint
grant select on app.subject_account_memberships to forma_ingestion
--> statement-breakpoint
grant select on app.analysis_subjects to forma_ingestion
--> statement-breakpoint
reset role
