/**
 * `npm run entitlements:migration` — 0032 from empty, from prior state, twice.
 *
 * The checks that matter are the ones that make a billing system auditable: a
 * grant cannot be deleted, usage cannot be deleted, a retry cannot charge
 * twice, a redelivered webhook is refused as a duplicate, and a manual grant
 * names the person who made it.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E19 entitlements migration gate");

const MIGRATION_TAG = "0032_e19_entitlements_billing";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0032(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      for (const statement of MIGRATION_SQL.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) await tx.unsafe(trimmed);
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const NEW_TABLES = [
  "billing_events",
  "entitlement_grants",
  "feature_catalogue",
  "subscription_records",
  "usage_ledger",
];

report.section("from an empty database");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("every table this epic claims exists", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = 'app' and table_name = any(${NEW_TABLES})
          order by table_name
        `;
        assert.deepEqual(rows.map((row) => row.table_name), NEW_TABLES);
      });

      const seeded = await seedBilling(sql);

      await report.check("a manual grant must name who made it and why", async () => {
        await assert.rejects(
          () => sql`
            insert into app.entitlement_grants (user_id, feature_key, source)
            values (${seeded.userId}, 'report.pro_detail', 'admin')
          `,
          /entitlement_grants_manual_is_attributed/,
        );
      });

      await report.check("an attributed manual grant is allowed", async () => {
        await sql`
          insert into app.entitlement_grants (
            user_id, feature_key, source, granted_by, note
          ) values (
            ${seeded.userId}, 'report.pro_detail', 'admin', ${seeded.userId},
            'goodwill after a support issue'
          )
        `;
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from app.entitlement_grants
          where user_id = ${seeded.userId}
        `;
        assert.equal(row?.count, "1");
      });

      await report.check("a subscription grant must point at its subscription", async () => {
        await assert.rejects(
          () => sql`
            insert into app.entitlement_grants (user_id, feature_key, source)
            values (${seeded.userId}, 'analysis.monthly_games', 'subscription')
          `,
          /entitlement_grants_subscription_is_traceable/,
        );
      });

      await report.check("a grant is closed rather than deleted", async () => {
        await assert.rejects(
          () => sql`delete from app.entitlement_grants where user_id = ${seeded.userId}`,
          /revoked by setting valid_to/,
        );
        await sql`
          update app.entitlement_grants set valid_to = now()
          where user_id = ${seeded.userId}
        `;
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from app.entitlement_grants
          where user_id = ${seeded.userId} and valid_to is not null
        `;
        assert.equal(row?.count, "1");
      });

      await report.check("a grant cannot end before it starts", async () => {
        await assert.rejects(
          () => sql`
            insert into app.entitlement_grants (
              user_id, feature_key, source, granted_by, note, valid_from, valid_to
            ) values (
              ${seeded.userId}, 'export.data', 'editorial', ${seeded.userId}, 'a note',
              now(), now() - interval '1 day'
            )
          `,
          /entitlement_grants_dates_ordered/,
        );
      });

      await report.check("a retried unit of work cannot charge twice", async () => {
        await sql`
          insert into app.usage_ledger (
            user_id, feature_key, quantity, unit, idempotency_key, billing_window
          ) values (
            ${seeded.userId}, 'analysis.monthly_games', 1, 'games', 'work:run-1:games',
            date_trunc('month', now())::date
          )
        `;
        await assert.rejects(
          () => sql`
            insert into app.usage_ledger (
              user_id, feature_key, quantity, unit, idempotency_key, billing_window
            ) values (
              ${seeded.userId}, 'analysis.monthly_games', 1, 'games', 'work:run-1:games',
              date_trunc('month', now())::date
            )
          `,
          /usage_ledger_idempotent/,
        );
      });

      await report.check("usage is released by state, never deleted", async () => {
        await assert.rejects(
          () => sql`delete from app.usage_ledger where user_id = ${seeded.userId}`,
          /released by state, never deleted/,
        );
      });

      await report.check("a release must say why", async () => {
        await assert.rejects(
          () => sql`
            update app.usage_ledger set state = 'released', released_at = now()
            where user_id = ${seeded.userId}
          `,
          /usage_ledger_released_shape/,
        );
        await sql`
          update app.usage_ledger
          set state = 'released', released_at = now(), release_reason = 'work_failed'
          where user_id = ${seeded.userId}
        `;
      });

      await report.check("a redelivered webhook is refused as a duplicate", async () => {
        await sql`
          insert into app.billing_events (
            billing_provider, external_event_id, event_type, provider_created_at,
            object_version, payload_sha256
          ) values (
            'stripe', 'evt_gate_1', 'customer.subscription.updated', now(), now(),
            ${"a".repeat(64)}
          )
        `;
        await assert.rejects(
          () => sql`
            insert into app.billing_events (
              billing_provider, external_event_id, event_type, provider_created_at,
              object_version, payload_sha256
            ) values (
              'stripe', 'evt_gate_1', 'invoice.paid', now(), now(), ${"b".repeat(64)}
            )
          `,
          /billing_events_unique/,
        );
      });

      await report.check("a failed event records a sanitized code, not a message", async () => {
        await assert.rejects(
          () => sql`
            update app.billing_events
            set processing_state = 'failed',
                error_code = 'Card ending 4242 was declined by the issuer'
            where external_event_id = 'evt_gate_1'
          `,
          /billing_events_error_shape/,
        );
        await sql`
          update app.billing_events
          set processing_state = 'failed', error_code = 'subscription_not_found'
          where external_event_id = 'evt_gate_1'
        `;
      });

      await report.check("a subscription's price is a key, not a provider id", async () => {
        await assert.rejects(
          () => sql`
            insert into app.subscription_records (
              user_id, billing_provider, external_customer_id, external_subscription_id,
              price_key, status, provider_object_version
            ) values (
              ${seeded.userId}, 'stripe', 'cus_1', 'sub_2', 'price_1AbCdEfGh', 'active', now()
            )
          `,
          /subscription_records_price_shape/,
        );
      });

      await report.check("no browser role reaches any of it", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.role_table_grants
          where table_schema = 'app' and table_name = any(${NEW_TABLES})
            and grantee in ('anon', 'authenticated', 'public', 'PUBLIC')
        `;
        assert.deepEqual([...rows], []);
      });

      await report.check("the API cannot grant itself an entitlement", async () => {
        const rows = await sql<{ privilege_type: string }[]>`
          select privilege_type from information_schema.role_table_grants
          where table_schema = 'app' and table_name = 'entitlement_grants'
            and grantee = 'forma_api' and privilege_type in ('INSERT', 'UPDATE')
        `;
        assert.deepEqual([...rows], [], "the API can grant itself access");
      });

      await report.check("the API cannot write a billing event", async () => {
        const rows = await sql<{ privilege_type: string }[]>`
          select privilege_type from information_schema.role_table_grants
          where table_schema = 'app' and table_name = 'billing_events'
            and grantee = 'forma_api'
        `;
        assert.deepEqual([...rows], [], "the API can fabricate a payment event");
      });

      await report.check("re-applying 0032 changes nothing", async () => {
        const before = await fingerprint(sql);
        await apply0032(db.adminUrl);
        assert.deepEqual(await fingerprint(sql), before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("from a database that stopped at 0031");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0031_e18_practice_transfer");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      let userId = "";
      await report.check("the prior state has profiles 0032 will hang grants off", async () => {
        const [profile] = await sql<{ user_id: string }[]>`
          insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
        `;
        userId = profile!.user_id;
        assert.ok(userId);
      });

      await report.check("0032 applies and leaves the profile alone", async () => {
        await apply0032(db.adminUrl);
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from app.profiles where user_id = ${userId}
        `;
        assert.equal(row?.count, "1");
        const [tables] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'app' and table_name = any(${NEW_TABLES})
        `;
        assert.equal(tables?.count, String(NEW_TABLES.length));
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.finish();

// ---------------------------------------------------------------------------

async function fingerprint(sql: postgres.Sql): Promise<unknown[]> {
  const rows = await sql<
    { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
  >`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'app' and table_name = any(${NEW_TABLES})
    order by table_name, column_name
  `;
  return [...rows];
}

async function seedBilling(sql: postgres.Sql): Promise<{ userId: string }> {
  const [profile] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  for (const [key, unit, limit] of [
    ["analysis.monthly_games", "games", 30],
    ["report.pro_detail", "none", 0],
    ["export.data", "reports", 1],
  ] as const) {
    await sql`
      insert into app.feature_catalogue (feature_key, display_name, metering_unit, default_limit, description)
      values (${key}, ${key}, ${unit}, ${limit}, 'A gate fixture feature description.')
      on conflict (feature_key) do nothing
    `;
  }
  await sql`
    insert into app.subscription_records (
      user_id, billing_provider, external_customer_id, external_subscription_id,
      price_key, status, provider_object_version
    ) values (
      ${profile!.user_id}, 'stripe', ${`cus_${randomUUID().slice(0, 8)}`},
      ${`sub_${randomUUID().slice(0, 8)}`}, 'pro_monthly', 'active', now()
    )
  `;
  return { userId: profile!.user_id };
}
