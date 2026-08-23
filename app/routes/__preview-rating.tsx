import { PublicPage } from "../components/PublicShell";
import { GameRatingResult } from "../components/GameRatingResult";
import { NeedsAccount, Working } from "./rating";
import type { RatingView } from "../lib/gameRating";

/**
 * `/dev/rating` — every state the rating panel can be in, on one page.
 *
 * The real page needs Stockfish and a promoted human policy, so it cannot be
 * looked at during a front-end change without a fully provisioned backend. This
 * route exists so the panel's states stay reviewable: a strong game, a refusal,
 * an out-of-domain master game, and a mismatch.
 *
 * The figures are invented and this page is not public. That is the reason it
 * lives under `/dev` with the other preview routes rather than anywhere a
 * visitor can reach: DESIGN.md's public copy rules forbid an invented figure on
 * a public surface, and these are all invented.
 */

const METHOD = { key: "game_rating", version: "1", hash: "3ae9e6be303895f9c1d2".padEnd(64, "0") };

const STRONG: RatingView = {
  status: "available",
  method: METHOD,
  rating: 8.4,
  ratingLow: 7.9,
  ratingHigh: 8.8,
  quality: 0.886,
  white: {
    color: "white",
    playedLike: 2200,
    playedLikeLow: 2000,
    playedLikeHigh: 2400,
    outOfDomain: false,
    gaveAway: 0.009,
    cleanliness: 0.91,
    decisionsScored: 30,
    decisionsFaced: 30,
    ratingDeclared: true,
  },
  black: {
    color: "black",
    playedLike: 2200,
    playedLikeLow: 2000,
    playedLikeHigh: 2200,
    outOfDomain: false,
    gaveAway: 0.012,
    cleanliness: 0.88,
    decisionsScored: 30,
    decisionsFaced: 30,
    ratingDeclared: true,
  },
  demand: {
    demand: 1,
    tension: 1,
    narrowness: 1,
    duration: 1,
    positionsExamined: 12,
    onlyMoves: 6,
  },
  moments: [
    { code: "collapse", ply: 44, moveNumber: 22, actor: "black", playedUci: "g7g6", magnitude: 0.31 },
    { code: "pressure_created", ply: 41, moveNumber: 21, actor: "white", playedUci: "d4e6", magnitude: 0.45 },
    { code: "only_move_found", ply: 68, moveNumber: 34, actor: "black", playedUci: "h7h6", magnitude: 0.52 },
  ],
  coverage: { decisions: 60, practicalDecisions: 9, outOfDomain: false },
  game: { white: "Morphy", black: "Allies", event: "Paris", date: "1858.10.21", result: "1-0" },
};

const OUT_OF_DOMAIN: RatingView = {
  ...STRONG,
  rating: 9.3,
  ratingLow: 8.6,
  ratingHigh: 9.7,
  white: { ...STRONG.white, playedLike: 2400, playedLikeHigh: 2400, outOfDomain: true, ratingDeclared: false },
  black: { ...STRONG.black, playedLike: 2400, playedLikeLow: 2200, playedLikeHigh: 2400, outOfDomain: true, ratingDeclared: false },
  coverage: { decisions: 74, practicalDecisions: 11, outOfDomain: true },
  game: { white: "Kasparov", black: "Topalov", event: "Wijk aan Zee", date: "1999.01.20", result: "1-0" },
} as RatingView;

const MISMATCH: RatingView = {
  ...STRONG,
  rating: 1.7,
  ratingLow: 1.4,
  ratingHigh: 2.1,
  quality: 0.308,
  white: { ...STRONG.white, playedLike: 2200, playedLikeLow: 2000, playedLikeHigh: 2200, gaveAway: 0.006 },
  black: {
    ...STRONG.black,
    playedLike: 1000,
    playedLikeLow: 800,
    playedLikeHigh: 1200,
    gaveAway: 0.071,
    cleanliness: 0.29,
  },
  demand: { demand: 0.79, tension: 0.7, narrowness: 0.75, duration: 1, positionsExamined: 10, onlyMoves: 3 },
  moments: [
    { code: "collapse", ply: 18, moveNumber: 9, actor: "black", playedUci: "f7f6", magnitude: 0.44 },
    { code: "advantage_returned", ply: 32, moveNumber: 16, actor: "black", playedUci: "c8d7", magnitude: 0.19 },
  ],
  coverage: { decisions: 50, practicalDecisions: 4, outOfDomain: false },
  game: { white: "A", black: "B", event: null, date: null, result: "1-0" },
} as RatingView;

const REFUSED: RatingView = {
  status: "unavailable",
  method: METHOD,
  reason: "no_inference",
  white: { ...STRONG.white, playedLike: null, playedLikeLow: null, playedLikeHigh: null, decisionsScored: 0 },
  black: { ...STRONG.black, playedLike: null, playedLikeLow: null, playedLikeHigh: null, decisionsScored: 0 },
  demand: STRONG.status === "available" ? STRONG.demand : null,
  game: { white: "Unknown", black: "Unknown", event: null, date: null, result: "1/2-1/2" },
};

const CASES: { title: string; note: string; view: RatingView }[] = [
  { title: "A strong game", note: "Both sides near the top of the ladder, in a game that kept asking.", view: STRONG },
  {
    title: "Above the calibrated range",
    note: "The estimate runs past where the human model was calibrated, and the panel says so twice rather than once.",
    view: OUT_OF_DOMAIN,
  },
  { title: "A mismatch", note: "One side played well. The rating is still low, because half the moves were not.", view: MISMATCH },
  { title: "A refusal", note: "No policy inference, so no rating. The panel shows how far it got.", view: REFUSED },
];

export default function RatingPreview() {
  return (
    <PublicPage>
      <div className="rate-hero">
        <h1>Rating panel states</h1>
        <p>
          Every state the public rating panel can render, with invented figures. Not a public route:
          nothing here was measured.
        </p>
        <section style={{ width: "100%" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>Queued</h2>
          <p className="rate-note">A game nobody has rated, mid-flight. The count is real work items.</p>
          <Working done={182} total={297} />
        </section>
        <section style={{ width: "100%" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>Not rated, and not signed in</h2>
          <p className="rate-note">Reading is free; producing a new rating is the door that needs an account.</p>
          <NeedsAccount />
        </section>
        {CASES.map((entry) => (
          <section key={entry.title} style={{ width: "100%" }}>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>{entry.title}</h2>
            <p className="rate-note">{entry.note}</p>
            <GameRatingResult view={entry.view} />
          </section>
        ))}
      </div>
    </PublicPage>
  );
}
