# Explainable concepts — observable contract matrix

Authoritative for the Tactical MVP project. Frozen by FOR-121 before any
detector behaviour changed, so that FOR-124 and every M2 detector implements
against a written rule rather than against whatever the code happened to do.

If an issue and this matrix disagree, stop and reconcile the plan before
writing code. If this matrix and a promoted `concept_versions` row disagree,
the promoted row wins for evidence already collected — that is what versions
are for — and the change becomes a new version here.

## The rules every row obeys

1. **Observable, not cognitive.** A contract may say what was on the board,
   what the search retained, and what the player played. It may not say what
   the player saw, knew, considered, or intended. Where a v1 contract used
   cognitive language, v2 restates the same test operationally; the slug is
   stable and the old version keeps meaning what it meant.
2. **Geometry is not an opportunity.** A motif that exists on the board but has
   no verified consequence is a negative, not a chance the player missed.
3. **Verification comes from stored evidence only.** Legal board facts, static
   exchange evaluation, and already-stored `evaluation_candidates.pv` lines.
   This project adds no engine call, no network call, and no model call.
4. **Absent evidence abstains.** A detector that cannot obtain what its contract
   requires emits nothing. It never guesses, and it never records a failure it
   cannot support.
5. **An unobserved response is censored.** `success` and `score` are null and a
   `censored_reason` says why. Silence is never a failure.
6. **Difficulty is pre-response only.** Every difficulty input below is readable
   from the position before the response exists.
7. **One physical occurrence is one event.** Multiple concept/role labels hang
   off it through `event_concepts`. Roles are never averaged.

## Thresholds, versioned

These are part of the detector contract, so changing one changes the version
hash and therefore creates a new concept version.

| Name | Value | Meaning |
| --- | --- | --- |
| `MATERIAL_THRESHOLD_CP` | 100 | Static exchange gain at which material is "winnable". |
| `WINNING_THRESHOLD` | 0.75 | Subject expected score at which a position "should win". |
| `WORSE_THRESHOLD` | 0.35 | Subject expected score at which a position is "worse". |
| `CRITICALITY_THRESHOLD` | 0.10 | Spread between best and worst retained candidate at which a decision is critical. |
| `TOLERANCE_RULE.expectedScoreTolerance` | 0.02 | Decision loss still counted as acceptable. Owned by `engine/contract.ts`. |

`CRITICALITY_THRESHOLD` exists because `criticality` is non-null whenever the
search retained two lines, and two lines that agree describe a position where
nothing was at stake. 0.02 is already defined as "indistinguishable"; 0.10 is
five times that — a decision that moves the expected result by ten points is a
moment where the available moves led to genuinely different games. A position
scoring below it is not a critical moment and v2 does not emit one.

## Roles, and who holds them

`execute` and `respond` are the two roles the tactical families use, following
FOR-126:

* **`execute`** — the subject played the move that created and realised the
  verified motif. Actor colour is the subject.
* **`respond`** — the opponent created the verified motif and the subject was
  given a move against it. Actor colour is the opponent; affected colour is the
  subject.

`recognize` is reserved for contracts where the observable fact is that a
retained candidate was found, not that a motif was built. `create`, `avoid` and
`prevent` are supported by the schema and deliberately unused in this MVP.

---

## Existing families, corrected

### 1. `material_safety` — v2 — *Keeping your pieces safe*

| | |
| --- | --- |
| Physical event | `material_exposed` |
| Roles | `respond` (subject) |
| Focal ply | The subject's move ply *p* |
| Response window | Same ply. The subject is on move, so there is nothing to censor. |
| Trigger | In the position before *p*, a specific subject piece on square *S* is capturable by the opponent with SEE ≥ 100. *S* is recorded; the trigger is about that piece. |
| Success | The exposure of *S* is resolved: the piece moved, became defended so that SEE < 100, the attacker was captured, or the line was blocked. |
| Failure | The exposure of *S* is unresolved **and** the engine assessment for *p* exists and says the move was not acceptable. |
| Abstain | The exposure of *S* is unresolved but the engine says the move was acceptable — that is a sound sacrifice, not a hung piece, and this detector cannot tell the difference on its own. Also abstains when either position is unparseable. |
| Censor | Not reachable. |
| Difficulty | `materialAtRiskCp`, `attackerCount`, `defenderCount`, `legalReplies` |
| Required facts | `square`, `piece`, `atRiskCp`, `resolved`, `resolution` |
| Confidence | null (deterministic) |
| Evidence | Board + SEE; engine assessment only to distinguish sacrifice from blunder |

**v1 overclaim corrected.** v1 asked whether *any* subject piece was exposed
after the move, so saving the hanging knight while a pawn became loose scored as
a failure, and every sound sacrifice scored as a failure. v2 tracks the focal
piece across the move and abstains rather than blaming a sacrifice.

### 2. `free_material` — v2 — *Taking what is offered*

| | |
| --- | --- |
| Physical event | `material_offered` |
| Roles | `recognize` (subject) |
| Focal ply | The subject's move ply *p* |
| Response window | Same ply |
| Trigger | In the position before *p*, an opponent piece is capturable by the subject with SEE ≥ 100. |
| Success | The move played was a capture with SEE ≥ 100, **or** stored engine evidence shows the played move's expected score is within tolerance of the best available capture. |
| Failure | The move was not such a capture **and** stored engine evidence shows the played move lost more than tolerance against the best candidate. |
| Abstain | The move was not a capture and no engine assessment is stored for *p* — a stronger move may have existed and this detector cannot rule it out. |
| Censor | Not reachable. |
| Difficulty | `materialOnOfferCp`, `captureCount`, `targetIsDefended` |
| Required facts | `square`, `onOfferCp`, `taken`, `alternativeVerified` |
| Confidence | null (deterministic) |
| Evidence | Board + SEE; engine assessment to clear a stronger non-capture |

**v1 overclaim corrected.** v1 scored any non-capture as a failure, so a mate in
one, a winning zwischenzug, or a stronger recapture all counted as "missed free
material". v2 clears the stronger move from stored evidence or abstains.

### 3. `critical_moment` — v2 — *Positions that decide the game*

| | |
| --- | --- |
| Physical event | `critical_moment` — **one** event carrying both labels |
| Roles | `recognize` and `execute`, both subject |
| Focal ply | The subject's move ply *p* |
| Response window | Same ply |
| Trigger | `criticality` is not null **and** `criticality ≥ 0.10`. |
| Success (`recognize`) | `played_move_rank` is not null — the move played was one of the lines the deep search retained. |
| Success (`execute`) | `played_move_acceptable`. |
| Abstain | `criticality` is null (the search retained fewer than two lines), or `criticality < 0.10`. |
| Censor | Not reachable. |
| Difficulty | `criticality`, `expectedScoreBefore`, `acceptableMoveCount` |
| Required facts | `criticality`, `rank`, `acceptable`, `acceptableMoveCount` |
| Confidence | null |
| Evidence | Engine transition assessment |

**v1 overclaims corrected.** Two. First, v1 emitted whenever criticality was
non-null, which is whenever MultiPV returned two lines — including positions
where every retained line was equal and nothing was at stake. Second, the human
definition said "recognising one is finding a move worth considering", which
claims access to thought. v2 states it as what it measures: the move played was
among the candidates the search retained. Both labels now hang off one
`chess_events` row rather than writing the same moment twice (FOR-123).

### 4. `only_move` — v2 — *Finding the move that held*

| | |
| --- | --- |
| Physical event | `only_move` |
| Roles | `recognize` (subject) |
| Focal ply | The subject's move ply *p* |
| Response window | Same ply |
| Trigger | `only_move` is true — exactly one retained candidate was within tolerance. |
| Success | `played_move_acceptable`. |
| Subtype | `absolute` when the candidate count is known and equals the legal move count in the position; `searched` otherwise. |
| Abstain | `only_move` is null — the search retained fewer than two lines, so "was this the only move" has no answer. |
| Censor | Not reachable. |
| Difficulty | `expectedScoreBefore`, `legalReplies` |
| Required facts | `acceptable`, `coverage` (`absolute` \| `searched`), `candidateCount`, `legalMoveCount` |
| Confidence | null |
| Evidence | Engine transition assessment + legal move count from the board |

**v1 overclaim corrected.** `only_move` is computed from the *retained* candidate
set, so v1's "exactly one move held and everything else lost ground" claimed a
proof over all legal moves that the search never performed. v2 records the
coverage it actually has. `candidateCount` is null until FOR-132 loads it, so
every M1 event is `searched`; the field exists now so the honest subtype is
recorded the moment the evidence is there, rather than the wording being
retro-fitted later.

### 5. `winning_conversion` — v2 — *Converting a winning position*

| | |
| --- | --- |
| Physical event | `winning_position_reached` |
| Roles | `convert` (subject) |
| Focal ply | The ply of the position that became winning — `reached.fromPly + 1`, the position *after* the transition that crossed the threshold |
| Response window | From the focal ply to the subject's last move in the game |
| Trigger | The subject's expected score after some transition first reaches 0.75. |
| Success | The subject's expected score after their final move is at least 0.75. |
| Censor | The subject made no move after the winning position existed. Reason follows the provider's termination: `opponent_resigned`, `clock_expired`, else `game_ended`. |
| Abstain | No transition ever crossed the threshold, or the subject made no move in the game at all. |
| Difficulty | `expectedScoreAtWin`, `movesRemaining` |
| Required facts | `converted`, `movesPlayed`, `censored` |
| Confidence | null |
| Evidence | Engine expected-score trajectory |
| Cardinality | One per game |

**v1 overclaim corrected.** v1 set `opportunity_ply = reached.fromPly`, which is
the position the subject moved *from* — one ply before the position that was
actually winning. The opportunity now begins in the winning position itself.
Censoring is unchanged and remains correct.

### 6. `worse_position_defence` — v2 — *Defending a worse position*

| | |
| --- | --- |
| Physical event | `defending_worse` |
| Roles | `respond` (subject) |
| Focal ply | The subject's move ply *p* |
| Response window | Same ply |
| Trigger | The subject's expected score before *p* is at most 0.35. |
| Success | `played_move_acceptable`. |
| Abstain | No engine assessment for *p*. |
| Censor | Not reachable. |
| Difficulty | `expectedScoreBefore` |
| Required facts | `expectedScoreBefore` |
| Confidence | null |
| Evidence | Engine transition assessment |

**Reconfirmed, not corrected.** Expected scores are stored from White's
perspective and `fromSubject` flips them for Black; the v1 rule is right for both
colours. v2 exists only so the family shares one version generation with the
rest of the corrected catalogue and so its abstention rule is written down.

---

## New tactical families

All six share a shape: a legal focal move creates geometry, stored evidence
verifies a consequence, and the subject is measured on one side of it. All six
abstain rather than guess.

### 7. `double_attack` — v1 — *Attacking two things at once*

| | |
| --- | --- |
| Physical event | `double_attack` |
| Roles | `execute` (subject creates), `respond` (opponent creates, subject answers) |
| Focal ply | The ply of the move that creates the double attack |
| Response window | `execute`: the focal ply. `respond`: the subject's next move. |
| Trigger | One legal move leaves a single attacking unit giving two or more simultaneous relevant threats. |
| Verification | SEE and/or a stored PV shows at least one target, or a decisive outcome, cannot be saved without conceding an equivalent amount. |
| Success (`execute`) | The subject played the move and the verified consequence follows in the stored line. |
| Success (`respond`) | The subject's reply meets both threats, or concedes less than the verified consequence. |
| Subtypes | `fork` (one piece, two or more targets), `royal_fork` (a target is the king), `double_attack` (generic) — stored as event facts, never as separate skill dimensions. |
| Abstain | Both threats can be met, the attacker is illegally pinned, the sequence is unsound, or the PV is absent/truncated/illegal. |
| Censor | `respond` where the game ended before the subject moved. |
| Difficulty | `targetCount`, `targetValueCp`, `kingInvolved`, `defendedTargets`, `legalReplies` |
| Required facts | `mover`, `from`, `to`, `targets[]`, `targetValues[]`, `kingInvolved`, `subtype`, `verificationLine`, `expectedGainCp` |
| Confidence | From verification strength: PV-proven vs SEE-only |
| Evidence | Legal attack map + SEE + stored PV |

### 8. `pin` — v1 — *Pinning a piece*

| | |
| --- | --- |
| Physical event | `pin` |
| Roles | `execute`, `respond` |
| Focal ply | The ply of the move that creates or exploits the pin |
| Response window | `execute`: focal ply. `respond`: the subject's next move. |
| Trigger | A legal sliding attack where a pinner, a pinned piece, and a king or higher-value target lie on one ray with no other blocker. |
| Verification | An exploitable consequence: stored PV or SEE shows the pinned piece is won, or the pinned piece's immobility is what makes a further threat work. Static alignment alone is not an opportunity. |
| Success (`execute`) | The subject created or exploited the pin and the verified consequence follows. |
| Success (`respond`) | The subject broke the pin, defended adequately, or counter-attacked for equivalent value. |
| Subtypes | `absolute` (target is the king), `relative` (target is higher-value). |
| Abstain | Alignment with no verified consequence, pinner illegally pinned itself, or evidence incomplete. |
| Censor | `respond` where the subject never moved again. |
| Difficulty | `pinnedValueCp`, `targetValueCp`, `subtype`, `rayLength`, `legalReplies` |
| Required facts | `pinner`, `pinned`, `target`, `ray[]`, `subtype`, `verificationLine` |
| Confidence | PV-proven vs SEE-only |
| Evidence | Legal ray/blocker analysis + SEE + stored PV |

### 9. `skewer` — v1 — *Attacking through a piece*

| | |
| --- | --- |
| Physical event | `skewer` |
| Roles | `execute`, `respond` |
| Focal ply | The ply of the move that creates the skewer |
| Response window | `execute`: focal ply. `respond`: the subject's next move. |
| Trigger | A legal sliding attack on a ray where the **front** target is the higher-priority one and a rear target stands behind it. |
| Verification | Stored PV or SEE shows the front target must move or concede an equivalent outcome, and the rear target is then won or decisively attacked. |
| Success (`execute`) | The subject created it and the verified gain follows. |
| Success (`respond`) | The subject saved both, or conceded less than the verified amount. |
| Abstain | Front target need not move, rear target is defended adequately, or evidence incomplete. |
| Censor | `respond` where the subject never moved again. |
| Difficulty | `frontValueCp`, `rearValueCp`, `rayLength`, `legalReplies` |
| Required facts | `attacker`, `front`, `rear`, `ray[]`, `verificationLine`, `expectedGainCp` |
| Confidence | PV-proven vs SEE-only |
| Evidence | Legal ray analysis + SEE + stored PV |

**Distinguished from `pin`.** Same geometry, opposite ordering: in a pin the
valuable piece is behind, in a skewer it is in front. The detector decides by
comparing values along the ray and emits exactly one of the two.

### 10. `discovered_attack` — v1 — *Uncovering an attack*

| | |
| --- | --- |
| Physical event | `discovered_attack` |
| Roles | `execute`, `respond` |
| Focal ply | The ply of the move that vacates the line |
| Response window | `execute`: focal ply. `respond`: the subject's next move. |
| Trigger | Comparing the legal attack maps before and after the focal move, a moved blocker uncovers a rook, bishop or queen line onto a relevant target. |
| Verification | Stored PV or SEE shows the uncovered threat, or the combination of it with the moving piece's own threat, wins material or forces a decisive outcome. |
| Success (`execute`) | The subject played it and the verified consequence follows. |
| Success (`respond`) | The subject's reply meets the uncovered threat and the moving piece's threat, or concedes less. |
| Subtypes | `discovered_attack`, `discovered_check`, `double_check` — facts under one family. |
| Abstain | The uncovered line hits nothing relevant, the threat is adequately met, or evidence incomplete. |
| Censor | `respond` where the subject never moved again. |
| Difficulty | `uncoveredTargetValueCp`, `moverThreatValueCp`, `subtype`, `legalReplies` |
| Required facts | `mover`, `from`, `to`, `discoveredPiece`, `uncoveredTarget`, `moverTarget`, `subtype`, `verificationLine` |
| Confidence | PV-proven vs SEE-only |
| Evidence | Before/after legal attack maps + SEE + stored PV |

### 11. `removal_of_defender` — v1 — *Taking out the defender*

| | |
| --- | --- |
| Physical event | `removal_of_defender` |
| Roles | `execute`, `respond` |
| Focal ply | The ply of the move that removes or deflects the defender |
| Response window | `execute`: focal ply. `respond`: the subject's next move. |
| Trigger | In the pre-move position a target is protected by an identified defender with a specific duty; the focal move captures that defender or forces it onto a square where the duty is lost. |
| Verification | A legal stored line or SEE shows the protected target, or a decisive square, is then won. |
| Success (`execute`) | The subject removed the defender and the verified follow-up is available. |
| Success (`respond`) | The subject restored the defence, moved the target, or conceded less than the verified amount. |
| Abstain | The target has another adequate defender, the duty was not actually lost, or evidence incomplete. |
| Censor | `respond` where the subject never moved again. |
| Difficulty | `targetValueCp`, `defenderValueCp`, `remainingDefenders`, `legalReplies` |
| Required facts | `target`, `defender`, `duty`, `removalMethod` (`capture` \| `deflection`), `followUp`, `verificationLine` |
| Confidence | PV-proven vs SEE-only |
| Evidence | Defender map + SEE + stored PV |

### 12. `trapped_piece` — v1 — *A piece with nowhere to go*

| | |
| --- | --- |
| Physical event | `trapped_piece` |
| Roles | `execute` (subject traps), `respond` (subject's piece is trapped) |
| Focal ply | The ply at which the piece becomes trapped |
| Response window | `execute`: focal ply. `respond`: the subject's next move. |
| Trigger | A non-king piece is under attack or newly restricted. |
| Verification | Enumerate legal retreats, captures, blocks, counter-attacks and defended exchanges. The piece is trapped only when every adequate resource loses it or concedes an equivalent amount, proven by SEE or a stored PV. |
| Success (`execute`) | The subject created the trap and the piece cannot escape. |
| Success (`respond`) | The subject saved the piece or conceded less than the verified amount. |
| Abstain | Any adequate escape exists, the piece is a king, or evidence incomplete. |
| Censor | `respond` where the subject never moved again. |
| Difficulty | `pieceValueCp`, `escapeSquareCount`, `attackerCount`, `legalReplies` |
| Required facts | `piece`, `square`, `attackers[]`, `escapesTried[]`, `verificationLine`, `expectedLossCp` |
| Confidence | PV-proven vs SEE-only |
| Evidence | Legal move enumeration + SEE + stored PV |

---

## Canonical fixture manifest

Every detector ticket must cover these six shapes. The concrete positions live
in `server/src/analysis/concepts/fixtures.ts`, which asserts that every FEN
parses to a legal position and every listed move is legal in it — a fixture that
does not replay is not evidence.

| Shape | What it proves |
| --- | --- |
| `positive` | The motif exists, the consequence is verified, the event and role are emitted. |
| `near_miss` | The geometry is one square away from the motif. Negative. |
| `refuted_geometry` | The motif exists but the defender holds. Negative, not a missed chance. |
| `alternative_better` | The motif exists and a stronger move also existed. Must not score as failure. |
| `illegal_attacker` | The would-be attacker is pinned and cannot legally play the move. Negative. |
| `incomplete_evidence` | The PV is absent or truncated. Abstain — no row at all. |

Colour-reversed variants are required for every tactical family, because a
detector that only works for White is a detector that measures half the players.

## Deliberately deferred

Named here so that a fixture containing one does not become a reason to build
it. None of these is in this project:

pawn-structure and positional catalogues; opening-principle, endgame-theory and
named-mating-pattern detectors; clock-management concepts; `event_relations` and
`trajectory_episodes` producers; a generic rule language or detector plugin
framework; LLM-generated motifs or explanations; provider puzzle tags as
authoritative truth.
