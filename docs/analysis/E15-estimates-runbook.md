# E15 — estimators, trajectory, findings and the renderer boundary

This is the epic where evidence becomes a claim about a person. Most of what
follows is about the refusals, because that is where the honesty of a coaching
product actually lives.

## The estimator

`estimator_v1` is a discounted Beta evidence model. Three properties matter more
than accuracy:

- **A censored chance is not a failure.** An opportunity the opponent never gave
  the player a reply to is counted in coverage and excluded from the estimate.
  Folding it in as a zero would penalise a player for their opponent's choices.
  An estimate made only of censored evidence is `unavailable`, not zero.
- **Old evidence is weaker, not deleted.** Exponential half-life, 120 days.
  Year-old evidence still counts, counts less, and widens the interval.
- **Raw and effective sample are both published.** Raw says how much was seen;
  effective says what it is worth after time weighting. A reader given only one
  will draw the wrong conclusion from either. A check constraint enforces
  `effective ≤ raw` and that the four coverage counts sum to raw, so "we saw 40
  chances" and "you succeeded 12 times" cannot be about different sets.

The prior is Jeffreys, Beta(0.5, 0.5), chosen over uniform because a uniform
prior pulls a small sample hard toward 0.5 — which reads as "average at
everything" for exactly the players we have least evidence about.

Intervals are real Beta quantiles, computed with a Lanczos log-gamma, a Lentz
continued fraction and bisection, all in `beta.ts`. Not a normal approximation:
that is wrong precisely where the product cares most, on small skewed
posteriors, and can put a bound outside [0, 1].

**Improvement is hard to claim on purpose.** `established_improvement` needs
P(recent > baseline) ≥ 0.95 *and* an effective sample of 20; `early_improvement_signal`
needs 0.8 and an effective sample of 8. Platform spec 3.4 wants early positive
evidence surfaced, but "you are improving" is the claim a user is least able to
check and most likely to act on, so it does not come from six games.

## The trajectory

`trajectory_alignment_v1`. Each reached phase is normalised to 0–100%
independently and resampled into 20 bins; games are weighted equally, so a
200-move marathon does not outvote ten short games.

**An unreached phase produces no rows at all.** Not rows of zero — a row of
zeros is the most convincing possible way to impute an endgame nobody played. The
API names the unreached phases explicitly so a client cannot draw a line across
them, and every bin carries `phase_reach_rate` so a smooth endgame curve drawn
from a fifth of the games is visibly that.

There is no dynamic time warping. Unconstrained warping will align any two
curves, which makes the average a picture of the algorithm rather than of the
player.

Recovery is measured from the subject's own moves. An expected-score gain that
came from the opponent's errors is flagged `counterpartyDriven` rather than
being called the player's recovery, and the original adverse change is returned
untouched: a blunder that was later rebuilt is still a blunder.

## Findings

Candidates are derived per dimension — at most one verdict each, plus an
improvement claim when the comparison earns one — and then put through
Benjamini-Hochberg at q = 0.1, applied **per claim family**. Correcting "is this
a strength" against "did this improve" would make each family's threshold depend
on how many of the other kind were tested, which is not what the correction
means.

`insufficient_evidence` is a first-class finding type and is exempt from both
the correction and the display cap. It asserts nothing about the player, so it
cannot be a false discovery, and including it in the denominator would make
every real finding harder to publish the *less* evidence we had. It is also the
honest floor of a thin report: "we do not know yet, and here is what is missing"
beats a confident number from four observations.

Contradicting evidence is a role on the evidence link, not a deletion.

**A factual finding cannot be committed without supporting evidence.** The check
is a deferred constraint trigger, so a finding and its evidence land in one
transaction or not at all.

## The renderer boundary

Prose lives in its own table, pins the SHA-256 of the structured input it was
given, and is immutable. Changing wording cannot change a fact, and re-deriving
the hash from the finding proves the renderer had exactly those facts.

`checkRendering` scans the text for the two things prose can smuggle in:

- **Numbers.** Every numeric token must be supported by the structured input, in
  any rounding a writer would reach for (0.42, 42%, 0.4). Small integers up to
  ten are free, because "in 3 of your games" is ordinary English. An unsupported
  number puts the text in `held`: stored for an operator, never shown.
- **Improvement language.** Text that asserts a change over time when the
  finding does not claim one is `rejected`, not held. That is not a precision
  problem, it is a claim the renderer had no standing to make.

v1 renders from templates with no model in the publication path. That is not a
placeholder: it is the baseline a language model has to beat while passing the
same check.

## What the dashboard says about itself

`coverageWarnings` is not decoration. A user with thin evidence gets a useful
limited report and the exact missing evidence — how many areas are
insufficient, how many are limited, whether their rating sits outside the
calibrated band, and which phases their games did not reach.

There is deliberately **no combined ability number**. `subject_rating_scale_estimates`
has one row per pool and speed and no column that collapses them; the security
gate asserts that no such column exists. A client that wants a single "chess IQ"
has to invent it rather than read it.

## Running it

The step runs as `analysis_subject_report` on `aggregation`. It freezes nothing
itself: it reads the snapshot the run names, which is what makes a report
reproducible from the row that says which games it saw.

```
npm run estimates:unit
```

Publication is last and is refused unless the run's manifest covers
`skill_estimates`, `trajectory_bins` and `findings`, so a half-built report
cannot become the page a user sees. Rollback is E11's: move the subject live
pointer back. Nothing in this epic is ever rewritten in place — every table is
immutable by trigger.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `estimates:unit` | 56 offline invariants: the numerics against hand-derivable values, and every refusal | anywhere |
| `estimates:integration` | snapshot → report → publication → dashboard, including the commit-time evidence refusal | CI (needs Postgres) |
| `estimates:security` | grants, and that no log line assesses a named person | CI (needs Postgres) |
| `estimates:migration` | 0028 from empty, from a 0027 database with rows, and twice | CI (needs Postgres) |
| `estimates:performance` | dashboard query count asserted, wall-clock advisory | CI (needs Postgres) |

## Migration

`0028_e15_estimates_findings` — nine tables and one deferred constraint trigger,
additive and forward-only. Applied to the live project; ledger at 29, all nine
tables and the deferred evidence trigger verified there.

Four invariants are constraints rather than conventions: an estimate arrives
with its interval or not at all; coverage adds up; a factual finding cites
evidence; and an out-of-range rating produces a suppression reason rather than
an extrapolated number.

## Known limitations

- **Only two frames are measured.** `objective` and `personal_current`.
  `peer_current` and `peer_stretch` need rating-pool calibration from a cohort
  model that does not exist yet; publishing them from the same evidence under a
  different label would be one number wearing three hats.
- **`rating_pool_calibration_versions` and `subject_rating_scale_estimates` are
  built but unpopulated.** The tables and their suppression rule exist; nothing
  writes them until there is a calibrated pool mapping. The dashboard reports
  the rating profile as `unavailable` rather than showing a raw provider rating
  dressed up as a Forma scale.
- **`transfer` and `inconsistency` finding types are in the vocabulary and have
  no rule yet.** Transfer needs E17's practice evidence; inconsistency needs
  cross-strata heterogeneity, which needs more evidence per stratum than the
  current corpus has.
