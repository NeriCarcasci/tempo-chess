# E19 — entitlements, the usage ledger, and billing lifecycle

This replaces a mutable `plan` enum on a user row. Four properties are why that
was not good enough.

## Four properties

**An entitlement is an effective-dated grant with a named source.** "Why can
this person do that" always has an answer with a date on it. A boolean column
cannot say whether access came from a subscription, a trial, a promotion, or
somebody in support being kind — and it cannot say when it stops.

**Usage is an append-only ledger with an idempotency key.** The counters the
product shows are projections over it. A retried unit of work cannot charge
twice, and a number nobody can audit is not a number. A grant is *closed* by
setting `valid_to` and usage is *released* by state; neither can be deleted,
because a record that can vanish is a bill nobody can check.

**A billing event is unique by provider and external id, and its effect is
resolved from the provider's own object version rather than arrival order.**
Webhooks arrive twice and out of sequence. A system that trusts order will
eventually downgrade somebody who has just paid.

**A grant changes what is shown and never what is true.** Nothing in this epic
is read by an estimator, a finding or a report as a fact. A free reader and a
paying reader see the same evidence and the same uncertainty; what differs is
depth, continuity, and how much compute the product spends on their behalf.

## Resolution

Deterministic by grants and time, never by insertion order — a user who reloads
a page and sees a different limit has been told the product is guessing. A unit
test resolves the same grants forwards and backwards and asserts the answers
match.

Precedence: `admin` > `editorial` > `promotion` > `trial` > `subscription`.
Admin is at the top because it is the deliberate act of a named person fixing
something, and it should not be silently overridden by a tier changing
underneath them. **An explicit zero from a higher source is a denial and
survives the subscription beneath it** — that is usually support handling abuse.

Ties between equal sources go to the **more generous** limit. Being stingy on a
tie is invisible in code review and infuriating in support.

**`past_due` still entitles**, for a fourteen-day dunning window. Somebody whose
card expired has not stopped being a customer, and cutting access the hour a
renewal fails is how a product loses a person it had already convinced. A
subscription set to cancel at period end is entitled *until* that end — they
paid for the month.

## The free plan

Not a demo with the lights off. Thirty analysed games a month, ten drills a day,
six plies of explorer, one export. The limits are on volume and depth, never on
honesty: a unit test asserts that no paid entitlement is *more restrictive* than
the free default, and that the volume defaults are non-zero.

## Quota

Two-phase reservation rather than a counter, because work fails. A person whose
analysis crashed should not have paid for it out of their monthly allowance, and
a counter incremented at the start cannot give it back without a compensating
write somebody has to remember. A stranded reservation from a dead worker is
released by a sweep after thirty minutes.

A limit of zero is `feature_unavailable`, not `quota_exhausted`: "you have used
all ten" and "this is not part of your plan" are different messages leading to
different next actions. Neither ever claims the underlying fact is different —
the refusal text is checked in a test for exactly that.

## Webhooks

Three properties, each of which has burned somebody:

1. **The signature is checked against the raw body.** Parsing first and
   re-serializing changes bytes; a signature that passes over re-serialized JSON
   proves nothing. A test signs one byte-sequence and verifies against a
   semantically identical, byte-different one, and asserts it fails.
2. **Redelivery is harmless**, via the unique constraint.
3. **Arrival order is not truth.** A stale event is `ignore`d and recorded as
   processed, not failed: it was handled correctly, and what it described was
   older than what we knew. Equal versions count as stale, so two same-stamped
   events cannot ping-pong the record.

A captured request cannot be replayed later — timestamps outside a five-minute
tolerance are rejected even with a genuine signature.

Payload logging is an **allowlist** of five fields. A Stripe event body carries
the last four digits of a card, a billing address and an email; an allowlist is
the only version of this rule that survives somebody adding a debug line at 2am.

Reconciliation runs daily and **reports drift without fixing it**. Applying a
correction is a decision with a person's money attached and belongs in a handler
that can log it. A missed `active` locking a paying customer out is the worse of
the two failure directions and the one nobody notices until they complain.

## Allowlists

A client sends `"pro_monthly"`, never a Stripe price id — an identifier arriving
from a browser is one nobody approved. Return destinations are **path suffixes
on our own origin** resolved server-side; an open redirect on a billing return
is one of the more effective phishing primitives a payment flow can hand out.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `entitlements:unit` | 42 offline invariants: order-independent resolution, quota refusals, signature and ordering, the allowlists | anywhere |
| `entitlements:migration` | 0032 from empty and from 0031, twice; the auditability constraints attempted against a real database | CI (needs Postgres) |

## Migration

`0032_e19_entitlements_billing` — five tables in `app`. Additive and
forward-only. Applied to the live project; ledger at 33, all five tables
present and the API role verified as unable to grant itself an entitlement.

## What a human has to do before this bills anybody

Nothing in this repository touches a payment provider, and that is deliberate.
Going live needs a person to:

1. Create or open the Stripe account and create the two prices.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the price ids for
   `pro_monthly` and `pro_yearly` in Secret Manager.
3. Point the Stripe webhook endpoint at the `forma-ops` deployment and confirm
   the signing secret matches.
4. Seed `app.feature_catalogue` from `DEFAULT_LIMITS`.

None of that was done here. Creating accounts and handling payment credentials
is a human step by design, not an oversight.

## Known limitations

- **No API surface.** Contract §13's plans, subscription, checkout, portal and
  webhook endpoints are not mounted. The verification, ordering, resolution and
  quota logic they would call is implemented and tested.
- **No webhook handler.** `verifySignature`, `decideEvent` and `reconcile` are
  pure and tested; the `forma-ops` route that receives a POST, stores the event
  and applies the decision does not exist.
- **The legacy `src/billing/` scaffold is still present and unused by this
  epic.** It holds a plan enum and a checkout stub. It should be deleted once
  the routes here exist, and deleting it now would break the pricing page that
  currently reads it.
- **`app.feature_catalogue` is unseeded.** `DEFAULT_LIMITS` is the intended
  content and the resolver falls back to it, so nothing is broken; the table is
  simply empty until somebody seeds it.
- **No integration, security or performance gate.**
