# E20 — case studies, the player directory, and the public statistic

Everything Forma says in public about a person, and what has to be true before
it may say it.

## The rule this epic exists to state

Public availability is not permission. A game being on a provider's website
means anybody may read it; it does not mean we may publish our analysis of it
next to somebody's name on a marketing page. Neither does a provider handle
being public mean the person behind it agreed to be an example.

So a public case study resolves four things before it exists:

- **A source** with a named permission basis — public domain, a licence,
  recorded consent, or our own material. Four, and no fifth. "It was on the
  internet" is not a basis.
- **A run** that succeeded and carries its output manifest, plus the publication
  history row that installed it. A public claim says which analysis produced it.
- **A review** by a named person who ticked five boxes in the same row: source,
  licence, consent, redactions, and facts unchanged. An approval that cannot
  show its grounds cannot be inserted.
- **Consent**, when the source rests on one — and a case study that names the
  player needs the consent that covers naming them, which is a different
  agreement from consenting to the analysis being published.

## Withdrawal

Two independent mechanisms, because they answer different questions.

**Withdrawing the study** moves the public pointer and writes an append-only
event. It rewrites nothing: the run, its manifest, the source, the consent and
the review all still resolve afterwards. The evidence for a claim we made in
public is exactly the evidence that has to survive us retracting it.

**Withdrawing consent** is what a person does, and it does not wait for us. The
public read joins the consent row and refuses a study whose consent has been
withdrawn or has expired, so the study is off the surface on the next request —
before any operator runs anything. Taking the pointer down afterwards is
tidiness, not the mechanism.

A withdrawn study answers exactly as a study that never existed: same status,
same body. A 410 would tell a reader there used to be something here about a
person who has since asked us to stop.

## The directory

Prefix search on the Forma handle. Nothing fuzzy, no search by email, no search
across provider identities — a fuzzy public search over identities is a way to
enumerate people whose names you cannot spell.

Three defaults do the privacy work and all three are off: `is_discoverable`,
the profile's `show_provider_handles`, and each linked account's own
`provider_handle_discoverable`. Being findable on Forma is not agreement to
publish which chess.com account is yours, so it takes both flags. A hidden
profile answers exactly like an unused handle.

Rate limited at thirty a minute per address and never cached by a shared cache:
the risk on this endpoint is enumeration, not load, and a CDN holding "who
matches `an`" is an enumeration cache in front of it.

## The public statistic

Two subtractions from `/v1/public/stats`.

**Small-cell suppression.** The player counts are segmented by platform and each
cell under ten is withheld. Withholding one cell is not enough — with the total
published, that cell is a subtraction away — so a second goes with it, and if a
breakdown collapses to a single withheld cell the total goes too. A suppressed
figure says `{"disclosure": "suppressed", "below": 10}` rather than `null`: we
know the number and have decided not to say it, which is not the same as not
knowing.

**The roster of handles is gone from this surface**, and named in the redaction
block rather than dropped silently. The accounts on it are real people whose
public archives we screened from public arena results; none of them opted into
being listed. §3's rule for the directory is that provider handles require
opt-in, and a statistic is not where that rule stops applying.

The legacy `/stats/reach` route is unchanged and still serves the roster to the
current landing page. **That is a decision for a person, not a silent one**: the
marketing page's "here are the accounts behind the number" component needs
either consent from those accounts or removal before launch. Nothing in this
epic changes it, and this paragraph exists so nobody discovers it later.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `public:unit` | 35 offline invariants: suppression arithmetic, readiness rules, projections, forbidden-field scanning | anywhere |
| `public:migration` | 0033 from empty and twice; every publication invariant attempted against a real database; least privilege by role | CI (needs Postgres) |
| `public:security` | forbidden fields in real HTTP bodies, hidden-is-hidden, enumeration limits, no handle in the log | CI (needs Postgres) |
| `public:integration` | publish → read → withdraw, consent withdrawal taking a study down on the next request, both directory opt-ins | CI (needs Postgres) |

## Migration

`0033_e20_editorial_publications` — five tables in `social`, plus four
select-only policies. Additive and forward-only. Applied to the live project;
ledger at 34, all five tables present, all five policies installed, and the API
role verified as unable to publish or to read the consent document.

Two of those policies close a gap this epic ran into rather than invented.
E06 and E11 express row-level access as ownership — a subject is visible to the
account that owns it, a run through its subject — and an editorial subject has
no owner by construction. Until now nothing but a superuser could read one. The
new policies are select-only and scoped to ownerless editorial subjects. A
third does the same for a linked account whose owner asked for its handle to be
shown, and states both opt-ins itself rather than trusting the query to
remember them.

## A trap worth knowing about

`drizzle(client)` mutates the shared postgres.js connection when
`server/src/db/client.ts` is imported, replacing the parsers for every date and
timestamp OID with a transparent one so drizzle can map them itself. **Every raw
query in this process gets a string back from a `timestamptz` column.** Code
that assumed a `Date` throws a TypeError three layers up and serves a 500.

This epic's reads normalise with a `toDate` that accepts either. Two already
merged route files — `v1/routes/goals.ts` and `v1/routes/onboarding.ts` — call
`.toISOString()` straight on a row value and will 500 when those endpoints are
first exercised against a database. Neither has a gate that runs them, which is
why nobody has noticed. Fixing them belongs with a gate that proves it, not
here.

## Publishing something

The workflow is a terminal, not a route. Nothing on `/v1` can publish or
withdraw: a route that could be made to publish is a route somebody will
eventually make publish. `forma_api` has select and nothing else on every table
here, and the migration gate proves it.

```
npm run editorial -- check    --file study.json
npm run editorial -- publish  --file study.json --actor <reviewer-user-id>
npm run editorial -- withdraw --slug the-immortal-game --reason "Restated in a later study."
npm run editorial -- consent-withdrawn --id <consent-id> --note "They asked us to stop."
```

`check` prints every blocker at once rather than the first. The database refuses
on the first thing it finds, which is right for a backstop and wrong for a
person: an editor who fixes the licence only to be told about the consent, then
about the review, learns to click until it works.

`study.json` names the slug, the subject, the run, the publication, the source,
the consent (when there is one), the review, the title, the summary, the caveats
and whether the study identifies the player publicly.

## What a human has to do before this publishes anything

1. Decide the marketing page's roster question, above.
2. Create the editorial subjects and run the analysis over them. Nothing here
   creates a subject or starts a run; publishing is the last step of a pipeline
   the earlier epics own.
3. Register the sources with their permission bases, and get the consent where
   the basis is consent. The consent document is stored as a private artifact,
   because it carries a name and contact details that must never be one join
   away from a public projection.
4. Review each candidate and record the approval.

## Known limitations

- **No case study exists.** This ships the machinery, the API and the workflow.
  Publishing the first study is an editorial act with real sources behind it and
  is deliberately not something a migration seeds.
- **No performance gate.** The public reads are single-row or keyset-paged with
  supporting indexes, and there is no production-shaped corpus to measure them
  against yet. Named rather than implied.
- **No CDN in front of the public routes.** The cache directives are set
  (`public, max-age=300` on case studies, `no-store` on the directory), so a
  withdrawal can be up to five minutes behind a shared cache when one is added.
  The consent check is on every origin request, so the bound is the CDN's, not
  ours.
- **Reviewer separation is not enforced.** The same person may register a source
  and approve the study drawn from it. On a one-operator product that is honest
  rather than lax; it becomes a real gap the day there is a second editor.
- **No independent review.** The review host has been unreachable.
