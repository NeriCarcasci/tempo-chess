import { PublicPage } from "../components/PublicShell";
import { GameRatingResult } from "../components/GameRatingResult";
import { Working } from "./rating";
import type { GameHeaders, OpeningView, RatingView } from "../lib/gameRating";

/**
 * `/dev/rating` — every state the rating panel can be in, on one page.
 *
 * The real page needs Stockfish and a promoted human policy, so it cannot be
 * looked at during a front-end change without a fully provisioned backend. This
 * route exists so the panel's states stay reviewable: a strong game, a refusal,
 * a game at the top of the ladder, and a mismatch.
 *
 * The figures are invented and this page is not public. That is the reason it
 * lives under `/dev` with the other preview routes rather than anywhere a
 * visitor can reach: DESIGN.md's public copy rules forbid an invented figure on
 * a public surface, and these are all invented.
 */

/** Morphy's opera-box game, so the replay board has something real to play. */
const OPERA_PGN = `[White "Morphy"]
[Black "Allies"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

const METHOD = { key: "game_rating", version: "3", hash: "3ae9e6be303895f9c1d2".padEnd(64, "0") };

const OPERA_OPENING: OpeningView = {
  eco: "C41",
  name: "Philidor Defence: General",
  family: "Philidor Defence",
  variation: "General",
  bookPly: 6,
  leftBookAt: { ply: 7, moveNumber: 4, san: "dxe5", side: "white" },
};

const OPERA_GAME: GameHeaders = {
  white: "Morphy",
  black: "Duke of Brunswick and Count Isouard",
  whiteElo: null,
  blackElo: null,
  event: "Paris Opera",
  site: "Paris",
  date: "1858.10.21",
  result: "1-0",
  termination: null,
  timeControl: null,
  moveCount: 17,
};

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
    atCeiling: false,
    bandOpenHigh: true,
    gaveAway: 0.009,
    cleanliness: 0.91,
    decisionsScored: 30,
    decisionsFaced: 30,
    ratingDeclared: true,
  },
  black: {
    color: "black",
    playedLike: 1800,
    playedLikeLow: 1600,
    playedLikeHigh: 2000,
    outOfDomain: false,
    atCeiling: false,
    bandOpenHigh: false,
    gaveAway: 0.012,
    cleanliness: 0.88,
    decisionsScored: 30,
    decisionsFaced: 30,
    ratingDeclared: true,
  },
  demand: {
    demand: 0.83,
    tension: 0.91,
    narrowness: 0.75,
    duration: 1,
    positionsExamined: 12,
    onlyMoves: 6,
    liveDecisions: 33,
    totalDecisions: 33,
    meanTopCriticality: 0.46,
  },
  moments: [
    { code: "pressure_created", ply: 19, moveNumber: 10, actor: "white", playedUci: "c3b5", playedSan: "Nxb5", magnitude: 0.45 },
    { code: "advantage_returned", ply: 20, moveNumber: 10, actor: "black", playedUci: "c6b5", playedSan: "cxb5", magnitude: 0.31 },
    { code: "pressure_created", ply: 31, moveNumber: 16, actor: "white", playedUci: "b3b8", playedSan: "Qb8+", magnitude: 0.52 },
  ],
  coverage: { decisions: 33, practicalDecisions: 9, outOfDomain: false },
  game: OPERA_GAME,
  opening: OPERA_OPENING,
};

/**
 * Both sides pinned to the top rung.
 *
 * This used to be the "outside the calibrated range" case and carried two
 * apologies. The estimate was never outside anything — the ladder simply stops
 * at 2400, so the honest reading is "at least this strong" and the panel now
 * renders it as `2400+` with nothing else attached.
 */
const AT_CEILING: RatingView = {
  ...STRONG,
  rating: 9.3,
  ratingLow: 8.6,
  ratingHigh: 9.7,
  white: { ...STRONG.white, playedLike: 2400, playedLikeLow: 2200, playedLikeHigh: 2400, atCeiling: true, bandOpenHigh: true },
  black: { ...STRONG.black, playedLike: 2400, playedLikeLow: 2200, playedLikeHigh: 2400, atCeiling: true, bandOpenHigh: true },
  coverage: { decisions: 74, practicalDecisions: 11, outOfDomain: false },
  game: {
    ...OPERA_GAME,
    white: "Kasparov",
    black: "Topalov",
    whiteElo: 2812,
    blackElo: 2700,
    event: "Hoogovens",
    date: "1999.01.20",
    moveCount: 44,
    timeControl: "40/7200:20/3600:900+30",
  },
  opening: {
    eco: "B07",
    name: "Pirc Defence: Byrne Variation",
    family: "Pirc Defence",
    variation: "Byrne Variation",
    bookPly: 10,
    leftBookAt: { ply: 11, moveNumber: 6, san: "f3", side: "white" },
  },
} as RatingView;

const MISMATCH: RatingView = {
  ...STRONG,
  rating: 1.7,
  ratingLow: 1.4,
  ratingHigh: 2.1,
  quality: 0.308,
  white: { ...STRONG.white, playedLike: 2200, playedLikeLow: 2000, playedLikeHigh: 2200, bandOpenHigh: false, gaveAway: 0.006 },
  black: {
    ...STRONG.black,
    playedLike: 1000,
    playedLikeLow: 800,
    playedLikeHigh: 1200,
    gaveAway: 0.071,
    cleanliness: 0.29,
  },
  demand: {
    demand: 0.42,
    tension: 0.31,
    narrowness: 0.5,
    duration: 0.55,
    positionsExamined: 10,
    onlyMoves: 2,
    liveDecisions: 26,
    totalDecisions: 47,
    meanTopCriticality: 0.16,
  },
  moments: [
    { code: "collapse", ply: 18, moveNumber: 9, actor: "black", playedUci: "f7f6", playedSan: "f6", magnitude: 0.44 },
    { code: "advantage_returned", ply: 32, moveNumber: 16, actor: "black", playedUci: "c8d7", playedSan: "Bd7", magnitude: 0.19 },
  ],
  coverage: { decisions: 47, practicalDecisions: 4, outOfDomain: false },
  game: {
    ...OPERA_GAME,
    white: "trappist_ilya",
    black: "n_carcasci",
    event: "Rated blitz game",
    site: "lichess.org",
    date: "2026.08.02",
    result: "1-0",
    moveCount: 24,
    timeControl: "300+3",
    termination: "Time forfeit",
  },
  opening: {
    eco: "B01",
    name: "Scandinavian Defence: Mieses-Kotroc Variation",
    family: "Scandinavian Defence",
    variation: "Mieses-Kotroc Variation",
    bookPly: 6,
    leftBookAt: { ply: 7, moveNumber: 4, san: "Nf6", side: "white" },
  },
} as RatingView;

const REFUSED: RatingView = {
  status: "unavailable",
  method: METHOD,
  reason: "no_inference",
  white: { ...STRONG.white, playedLike: null, playedLikeLow: null, playedLikeHigh: null, decisionsScored: 0 },
  black: { ...STRONG.black, playedLike: null, playedLikeLow: null, playedLikeHigh: null, decisionsScored: 0 },
  demand: STRONG.status === "available" ? STRONG.demand : null,
  game: { ...OPERA_GAME, white: "Unknown", black: "Unknown", result: "1/2-1/2" },
  opening: OPERA_OPENING,
};

const CASES: { title: string; note: string; view: RatingView; pgn?: string }[] = [
  {
    title: "A strong game",
    note: "One side near the top of the ladder, in a game that kept asking. The board is live: pick a turning point.",
    view: STRONG,
    pgn: OPERA_PGN,
  },
  {
    title: "At the top of the ladder",
    note: "Both sides pinned to the strongest rung the model can be conditioned on, read as 2400+ rather than apologised for.",
    view: AT_CEILING,
  },
  { title: "A mismatch", note: "One side played well. The rating is still low, because half the moves were not.", view: MISMATCH },
  { title: "A refusal", note: "No policy inference, so no rating. The panel shows how far it got.", view: REFUSED },
];

export default function RatingPreview() {
  return (
    <PublicPage>
      <div className="gr-hero">
        <h1>Rating panel states</h1>
        <p>
          Every state the public rating panel can render, with invented figures. Not a public route:
          nothing here was measured.
        </p>
        <section style={{ width: "100%" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>Reading the game</h2>
          <p className="gr-note">
            The engine half is one long item, so there is no percentage to draw and the page says so.
          </p>
          <Working stage="screening" done={0} total={1} pgn={OPERA_PGN} />
        </section>
        <section style={{ width: "100%" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>Queued</h2>
          <p className="gr-note">A game nobody has rated, mid-flight. The count is real work items.</p>
          <Working stage="inferring" done={182} total={297} pgn={OPERA_PGN} />
        </section>
        {CASES.map((entry) => (
          <section key={entry.title} style={{ width: "100%" }}>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 620 }}>{entry.title}</h2>
            <p className="gr-note">{entry.note}</p>
            <GameRatingResult view={entry.view} pgn={entry.pgn} />
          </section>
        ))}
      </div>
    </PublicPage>
  );
}
