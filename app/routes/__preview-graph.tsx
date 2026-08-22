import { EngineGraph } from "../components/EngineGraph";
import { buildGraph, MOBILE_MAX_MOVE } from "../lib/todayGraph";
import type { PlayerStats } from "../lib/playerStats";
import fixture from "../lib/devFixtureStats.json";

/**
 * The engine graph on its own, from a committed fixture.
 *
 * It is here so the figure can be looked at and worked on without a database,
 * a session, or an analysed archive behind it — which is how it was built. The
 * fixture is a real player's counted statistics, frozen: thirty one games, forty
 * move numbers, the opening through the endgame.
 *
 * This is deliberately not the whole Today page. The prototype's Today is typed
 * against a data model this repository does not have, and reviving it to look at
 * one figure would drag all of it back. One figure, one fixture, no session.
 */
export function meta() {
  return [{ title: "Engine graph · Forma" }];
}

export default function PreviewGraph() {
  const stats = fixture as unknown as PlayerStats;
  const graph = buildGraph(stats);

  return (
    <main className="today" style={{ paddingBlock: "3rem" }}>
      <p className="cap" style={{ marginBottom: "0.75rem" }}>
        engine graph · fixture · {stats.games?.analyzed ?? 0} analysed games
      </p>
      <EngineGraph graph={graph} username="fixture" truncatedAt={null} />
      <p className="today-truncation" style={{ marginTop: "1.5rem", paddingLeft: 0 }}>
        Drawn from <code>app/lib/devFixtureStats.json</code>. Narrow the window below 768px and the
        axis stops at move {MOBILE_MAX_MOVE} rather than scrolling sideways.
      </p>
    </main>
  );
}
