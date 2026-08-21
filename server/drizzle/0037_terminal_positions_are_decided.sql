-- 0037_terminal_positions_are_decided
--
-- Let an evaluation say a position was decided by the rules rather than by a
-- search.
--
-- Hand-written and reviewed. Two constraint changes, no schema change, no row
-- touched. Re-running it is a no-op.
--
-- ## What was wrong
--
-- Screening evaluates every position of a game, and the last position of a game
-- that ended in checkmate or stalemate has no legal move. Stockfish answers
-- `bestmove (none)` with no score line at all -- no WDL, no mate distance, no
-- centipawns -- because there is nothing to search. `expectedScore` then raises,
-- correctly: converting nothing into a number is exactly what a calibration must
-- not do.
--
-- So the analysis of every game ending in mate or stalemate died on its final
-- position. In this archive that was sixty-one games of a hundred and ninety-six.
-- It is not a property of one player: about a third of any normal archive ends
-- that way, and none of it could ever be analysed.
--
-- The failure was invisible from the product. A game whose analysis never
-- completes has no publication, and a profile assembled from the games that did
-- complete looks like a smaller archive rather than a broken one.
--
-- ## Why a fourth method rather than reusing `logistic`
--
-- A stalemate is a half point. Feeding a zero-centipawn score to the logistic
-- curve also yields exactly 0.5, so the number would have been right and the
-- provenance would have been a lie: the row would claim a versioned curve
-- produced a value the laws of chess produced. `expected_score_method` exists so
-- that a number is never anonymous, and the honest fourth answer is that no
-- model was involved.
--
-- `terminal` rows therefore carry no engine provenance -- no depth, nodes, time
-- or best move -- and the second constraint enforces the part that matters: a
-- decided position cannot recommend a move, because there is none to recommend.
--
-- Checkmate is recorded as `mate_in = 0`, which the existing value check needs
-- (exactly one of a centipawn score and a mate distance) and which is true:
-- mated, here, now. A terminal draw is recorded as `score_cp = 0`.
--
-- No existing row changes. Nothing was ever written with this method, because
-- until now the write raised instead.

set local role forma_migrator
--> statement-breakpoint
alter table analysis.position_evaluations
  drop constraint position_evaluations_expected_method_check
--> statement-breakpoint
alter table analysis.position_evaluations
  add constraint position_evaluations_expected_method_check
  check (expected_score_method in ('wdl', 'mate', 'logistic', 'terminal'))
--> statement-breakpoint
-- A position with no legal move has no best move, and a row that named one
-- would be describing a search that never ran.
alter table analysis.position_evaluations
  drop constraint if exists position_evaluations_terminal_has_no_move
--> statement-breakpoint
alter table analysis.position_evaluations
  add constraint position_evaluations_terminal_has_no_move
  check (expected_score_method <> 'terminal' or best_move_uci is null)
--> statement-breakpoint
-- The candidate table records the engine's ranked lines. A decided position has
-- none, and the same method vocabulary applies.
alter table analysis.evaluation_candidates
  drop constraint if exists evaluation_candidates_expected_method_check
--> statement-breakpoint
alter table analysis.evaluation_candidates
  add constraint evaluation_candidates_expected_method_check
  check (expected_score_method in ('wdl', 'mate', 'logistic', 'terminal'))
--> statement-breakpoint
reset role
