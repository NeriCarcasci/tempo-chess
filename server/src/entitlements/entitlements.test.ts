/**
 * `npm run entitlements:unit` — E19's invariants, offline.
 *
 * The load-bearing assertions: resolution is deterministic whatever order the
 * grants arrive in, a retry cannot charge twice, a failed job gives the quota
 * back, a replayed webhook is harmless, a stale one does not downgrade anybody,
 * and nothing here can change a fact.
 */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";

import {
  BILLING_POLICY,
  DEFAULT_LIMITS,
  ENTITLING_STATUSES,
  PRICE_ENTITLEMENTS,
  RETURN_PATHS,
  SOURCE_PRECEDENCE,
  isPriceKey,
  isReturnKey,
  type FeatureKey,
} from "./contract.js";
import {
  describeLimit,
  isActive,
  resolveAll,
  resolveFeature,
  subscriptionEntitles,
  type Grant,
} from "./resolve.js";
import {
  billingWindow,
  consumed,
  describeRefusal,
  expiredReservations,
  mayReserve,
  projectUsage,
  windowResetsAt,
  type LedgerEntry,
} from "./quota.js";
import { decideEvent, reconcile, sanitizeEvent, verifySignature } from "./webhook.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const NOW = new Date("2026-08-15T12:00:00Z");
const daysFrom = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function grant(over: Partial<Grant> = {}): Grant {
  return {
    featureKey: "analysis.monthly_games",
    source: "subscription",
    quantitativeLimit: 500,
    validFrom: daysFrom(-30),
    validTo: null,
    ...over,
  };
}

test("no grant resolves to the documented default", () => {
  const resolution = resolveFeature("analysis.monthly_games", [], NOW);
  assert.equal(resolution.limit, DEFAULT_LIMITS["analysis.monthly_games"]);
  assert.equal(resolution.source, null);
});

test("a free account is a usable product, not a demo with the lights off", () => {
  // The volume limits are real numbers, not zero. Only the paid-detail features
  // start at zero.
  assert.ok((DEFAULT_LIMITS["analysis.monthly_games"] ?? 0) > 0);
  assert.ok((DEFAULT_LIMITS["practice.daily_drills"] ?? 0) > 0);
  assert.ok((DEFAULT_LIMITS["explorer.depth"] ?? 0) > 0);
});

test("an expired grant does not apply", () => {
  const expired = grant({ validTo: daysFrom(-1) });
  assert.equal(isActive(expired, NOW), false);
  assert.equal(resolveFeature("analysis.monthly_games", [expired], NOW).source, null);
});

test("a future grant does not apply yet", () => {
  const future = grant({ validFrom: daysFrom(1) });
  assert.equal(isActive(future, NOW), false);
});

test("resolution does not depend on the order the grants came back", () => {
  const grants = [
    grant({ source: "subscription", quantitativeLimit: 500 }),
    grant({ source: "promotion", quantitativeLimit: 1000 }),
    grant({ source: "trial", quantitativeLimit: 200 }),
  ];
  const forward = resolveFeature("analysis.monthly_games", grants, NOW);
  const backward = resolveFeature("analysis.monthly_games", [...grants].reverse(), NOW);
  assert.deepEqual(forward, backward, "a page reload would show a different limit");
  assert.equal(forward.source, "promotion");
});

test("a higher-precedence source wins even when it is less generous", () => {
  const resolution = resolveFeature(
    "analysis.monthly_games",
    [
      grant({ source: "subscription", quantitativeLimit: 500 }),
      grant({ source: "admin", quantitativeLimit: 50 }),
    ],
    NOW,
  );
  assert.equal(resolution.source, "admin");
  assert.equal(resolution.limit, 50);
});

test("a deliberate admin denial survives the subscription underneath it", () => {
  const resolution = resolveFeature(
    "export.data",
    [
      grant({ featureKey: "export.data", source: "subscription", quantitativeLimit: null }),
      grant({ featureKey: "export.data", source: "admin", quantitativeLimit: 0 }),
    ],
    NOW,
  );
  assert.equal(resolution.limit, 0);
  assert.equal(resolution.source, "admin");
});

test("a tie between equal sources goes to the more generous limit", () => {
  const resolution = resolveFeature(
    "analysis.monthly_games",
    [
      grant({ source: "promotion", quantitativeLimit: 100 }),
      grant({ source: "promotion", quantitativeLimit: 900 }),
    ],
    NOW,
  );
  assert.equal(resolution.limit, 900, "being stingy on a tie is infuriating in support");
});

test("unlimited beats any number", () => {
  const resolution = resolveFeature(
    "analysis.monthly_games",
    [
      grant({ source: "promotion", quantitativeLimit: 100 }),
      grant({ source: "promotion", quantitativeLimit: null }),
    ],
    NOW,
  );
  assert.equal(resolution.limit, null);
});

test("every feature resolves, so no page has a hole in it", () => {
  const all = resolveAll([grant()], NOW);
  for (const key of Object.keys(DEFAULT_LIMITS) as FeatureKey[]) {
    assert.ok(all[key] !== undefined, `${key} did not resolve`);
  }
});

test("the precedence order is total and has no ties", () => {
  const values = Object.values(SOURCE_PRECEDENCE);
  assert.equal(new Set(values).size, values.length);
});

// ---------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------

test("an active subscription entitles indefinitely", () => {
  const result = subscriptionEntitles(
    { status: "active", currentPeriodEnd: daysFrom(10), cancelAtPeriodEnd: false },
    NOW,
  );
  assert.equal(result.entitled, true);
  assert.equal(result.until, null);
});

test("a cancelled subscription is entitled until the end of the period they paid for", () => {
  const end = daysFrom(10);
  const result = subscriptionEntitles(
    { status: "active", currentPeriodEnd: end, cancelAtPeriodEnd: true },
    NOW,
  );
  assert.equal(result.entitled, true);
  assert.equal(result.until, end);
});

test("a failed payment keeps access while it is retried", () => {
  const result = subscriptionEntitles(
    { status: "past_due", currentPeriodEnd: daysFrom(-1), cancelAtPeriodEnd: false },
    NOW,
  );
  assert.equal(result.entitled, true, "access was cut the hour a renewal failed");
  assert.ok(result.reason.includes("retried"));
});

test("access ends once the retry window has passed", () => {
  const result = subscriptionEntitles(
    { status: "past_due", currentPeriodEnd: daysFrom(-40), cancelAtPeriodEnd: false },
    NOW,
  );
  assert.equal(result.entitled, false);
});

test("a cancelled or unpaid subscription entitles nothing", () => {
  for (const status of ["canceled", "unpaid", "incomplete_expired"] as const) {
    const result = subscriptionEntitles(
      { status, currentPeriodEnd: daysFrom(10), cancelAtPeriodEnd: false },
      NOW,
    );
    assert.equal(result.entitled, false, `${status} still entitled`);
  }
  assert.ok(!ENTITLING_STATUSES.includes("canceled"));
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { state: "settled", quantity: 1, occurredAt: NOW, ...over };
}

test("a released reservation does not count against anybody", () => {
  const entries = [entry(), entry({ state: "reserved" }), entry({ state: "released" })];
  assert.equal(consumed(entries), 2, "a failed job permanently cost somebody a game");
});

test("an unlimited feature always allows the reservation", () => {
  const decision = mayReserve({
    request: { featureKey: "analysis.deep_review", quantity: 1, idempotencyKey: "k1234567" },
    resolution: { featureKey: "analysis.deep_review", limit: null, source: "subscription", until: null },
    existing: Array.from({ length: 5_000 }, () => entry()),
    windowResetsAt: null,
  });
  assert.equal(decision.allowed, true);
});

test("a zero limit is unavailable, not exhausted", () => {
  const decision = mayReserve({
    request: { featureKey: "report.pro_detail", quantity: 1, idempotencyKey: "k1234567" },
    resolution: { featureKey: "report.pro_detail", limit: 0, source: null, until: null },
    existing: [],
    windowResetsAt: null,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, "feature_unavailable");
});

test("exhausting the quota says how much and when it resets", () => {
  const decision = mayReserve({
    request: { featureKey: "analysis.monthly_games", quantity: 1, idempotencyKey: "k1234567" },
    resolution: { featureKey: "analysis.monthly_games", limit: 30, source: null, until: null },
    existing: Array.from({ length: 30 }, () => entry()),
    windowResetsAt: windowResetsAt(NOW),
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.code, "quota_exhausted");
  const message = describeRefusal(decision);
  assert.ok(message !== null && message.includes("30"));
  assert.ok(message.includes("resets"), "a limit with no date is a dead end");
});

test("a refusal never claims the underlying fact is different", () => {
  const decision = mayReserve({
    request: { featureKey: "report.pro_detail", quantity: 1, idempotencyKey: "k1234567" },
    resolution: { featureKey: "report.pro_detail", limit: 0, source: null, until: null },
    existing: [],
    windowResetsAt: null,
  });
  const message = describeRefusal(decision);
  assert.ok(message !== null);
  assert.ok(!/could not|failed|unavailable analysis/i.test(message));
  assert.ok(message.includes("Nothing already in your account changes."));
});

test("a stranded reservation is released rather than held forever", () => {
  const stale = new Date(NOW.getTime() - (BILLING_POLICY.reservationTtlMinutes + 5) * 60_000);
  const expired = expiredReservations(
    [
      { id: "a", state: "reserved", quantity: 1, occurredAt: stale },
      { id: "b", state: "reserved", quantity: 1, occurredAt: NOW },
      { id: "c", state: "settled", quantity: 1, occurredAt: stale },
    ],
    NOW,
  );
  assert.deepEqual(expired, [{ id: "a", reason: "reservation_expired" }]);
});

test("the counter shown is derived from the ledger", () => {
  const projection = projectUsage({
    featureKey: "analysis.monthly_games",
    resolution: { featureKey: "analysis.monthly_games", limit: 30, source: null, until: null },
    entries: [entry(), entry(), entry({ state: "released" })],
    at: NOW,
  });
  assert.equal(projection.used, 2);
  assert.equal(projection.remaining, 28);
  assert.ok(projection.resetsAt !== null);
});

test("the billing window is the calendar month, in UTC", () => {
  assert.equal(billingWindow(new Date("2026-08-31T23:59:59Z")), "2026-08-01");
  assert.equal(billingWindow(new Date("2026-09-01T00:00:00Z")), "2026-09-01");
  assert.equal(windowResetsAt(NOW).toISOString(), "2026-09-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const SECRET = "whsec_gate_fixture";

function sign(body: string, at: Date, secret = SECRET): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

test("a genuine signature over the raw body verifies", () => {
  const body = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const check = verifySignature({ rawBody: body, header: sign(body, NOW), secret: SECRET, now: NOW });
  assert.equal(check.valid, true);
});

test("a signature over different bytes does not", () => {
  const body = '{"id":"evt_1"}';
  const header = sign(body, NOW);
  const check = verifySignature({
    // Re-serialized JSON: same meaning, different bytes. This is exactly what
    // parsing before verifying would produce.
    rawBody: '{ "id": "evt_1" }',
    header,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, "signature_mismatch");
});

test("the wrong secret does not verify", () => {
  const body = '{"id":"evt_1"}';
  const check = verifySignature({
    rawBody: body,
    header: sign(body, NOW, "whsec_someone_elses"),
    secret: SECRET,
    now: NOW,
  });
  assert.equal(check.valid, false);
});

test("a captured request cannot be replayed later", () => {
  const body = '{"id":"evt_1"}';
  const header = sign(body, new Date(NOW.getTime() - 86_400_000));
  const check = verifySignature({ rawBody: body, header, secret: SECRET, now: NOW });
  assert.equal(check.valid, false);
  assert.equal(check.reason, "timestamp_outside_tolerance");
});

test("a malformed header is rejected rather than crashing", () => {
  for (const header of ["", "nonsense", "t=abc,v1=def", "v1=only"]) {
    const check = verifySignature({ rawBody: "{}", header, secret: SECRET, now: NOW });
    assert.equal(check.valid, false, `"${header}" verified`);
    assert.ok(check.reason !== null);
  }
});

const EVENT = {
  externalEventId: "evt_1",
  eventType: "customer.subscription.updated",
  providerCreatedAt: NOW,
  objectVersion: NOW,
  externalSubscriptionId: "sub_1",
};

test("a redelivered event is recognised rather than reprocessed", () => {
  const decision = decideEvent({ event: EVENT, alreadySeen: true, current: null });
  assert.equal(decision.action, "duplicate");
});

test("a newer event is applied", () => {
  const decision = decideEvent({
    event: { ...EVENT, objectVersion: daysFrom(1) },
    alreadySeen: false,
    current: { externalSubscriptionId: "sub_1", providerObjectVersion: NOW },
  });
  assert.equal(decision.action, "apply");
});

test("a stale event does not downgrade somebody who has just paid", () => {
  const decision = decideEvent({
    event: { ...EVENT, objectVersion: daysFrom(-1) },
    alreadySeen: false,
    current: { externalSubscriptionId: "sub_1", providerObjectVersion: NOW },
  });
  assert.equal(decision.action, "ignore");
  assert.ok(decision.reason.includes("before what is already stored"));
});

test("an event with the same version is treated as stale, not newer", () => {
  const decision = decideEvent({
    event: EVENT,
    alreadySeen: false,
    current: { externalSubscriptionId: "sub_1", providerObjectVersion: NOW },
  });
  assert.equal(decision.action, "ignore", "two same-stamp events could ping-pong the record");
});

test("reconciliation names every kind of drift", () => {
  const drift = reconcile(
    [
      {
        externalSubscriptionId: "sub_1",
        status: "active",
        currentPeriodEnd: NOW,
        cancelAtPeriodEnd: false,
      },
    ],
    [
      {
        externalSubscriptionId: "sub_1",
        status: "canceled",
        currentPeriodEnd: daysFrom(5),
        cancelAtPeriodEnd: true,
      },
      {
        externalSubscriptionId: "sub_2",
        status: "active",
        currentPeriodEnd: NOW,
        cancelAtPeriodEnd: false,
      },
    ],
  );
  const fields = drift.map((row) => row.field);
  assert.ok(fields.includes("status"));
  assert.ok(fields.includes("cancel_at_period_end"));
  assert.ok(fields.includes("current_period_end"));
  assert.ok(fields.includes("missing_locally"));
});

test("agreement produces no drift", () => {
  const row = {
    externalSubscriptionId: "sub_1",
    status: "active",
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
  };
  assert.deepEqual(reconcile([row], [row]), []);
});

test("a webhook payload is stripped to fields that carry no payment data", () => {
  const sanitized = sanitizeEvent({
    id: "evt_1",
    type: "invoice.paid",
    created: 1,
    data: {
      object: {
        customer_email: "someone@example.com",
        payment_method_details: { card: { last4: "4242" } },
      },
    },
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["created", "id", "type"]);
  assert.equal(JSON.stringify(sanitized).includes("4242"), false);
  assert.equal(JSON.stringify(sanitized).includes("example.com"), false);
});

// ---------------------------------------------------------------------------
// The allowlists
// ---------------------------------------------------------------------------

test("only known price keys are accepted", () => {
  assert.equal(isPriceKey("pro_monthly"), true);
  assert.equal(isPriceKey("price_1AbCdEfGhIjKlMnO"), false, "a raw provider price id was accepted");
});

test("only known return keys are accepted, and they are paths not URLs", () => {
  assert.equal(isReturnKey("billing_success"), true);
  assert.equal(isReturnKey("https://evil.example.com"), false);
  for (const path of Object.values(RETURN_PATHS)) {
    assert.ok(path.startsWith("/"), `${path} is not a same-origin path`);
    assert.ok(!path.includes("//"), `${path} could resolve to another origin`);
  }
});

test("every price maps to concrete entitlements", () => {
  for (const [key, grants] of Object.entries(PRICE_ENTITLEMENTS)) {
    assert.ok(grants.length > 0, `${key} grants nothing`);
    for (const item of grants) {
      assert.ok(item.featureKey in DEFAULT_LIMITS, `${item.featureKey} is not a known feature`);
    }
  }
});

test("no entitlement is more restrictive than the free default", () => {
  for (const [key, grants] of Object.entries(PRICE_ENTITLEMENTS)) {
    for (const item of grants) {
      const base = DEFAULT_LIMITS[item.featureKey];
      if (item.limit === null || base === null) continue;
      assert.ok(item.limit >= base, `${key} gives less ${item.featureKey} than the free plan`);
    }
  }
});

test("the description of a limit is an offer, not a scold", () => {
  const message = describeLimit({
    featureKey: "report.pro_detail",
    limit: 0,
    source: null,
    until: null,
  });
  assert.ok(message !== null);
  assert.ok(message.includes("stays exactly as it is"));
});

test("the policy is frozen", () => {
  assert.equal(Object.isFrozen(BILLING_POLICY), true);
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`entitlements:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`entitlements:unit — ${passed}/${passed} passed`);
