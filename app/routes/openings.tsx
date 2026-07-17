import { Form, Link, useFetcher, useSearchParams } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/openings";
import { Chessboard } from "../components/Chessboard";
import { InfoTip } from "../components/InfoTip";
import { OpeningLineTree } from "../components/OpeningLineTree";
import {
  handledPercent,
  rankOpeningFamilies,
  reliabilityLabel,
  type OpeningExplorerData,
  type OpeningFailure,
  type OpeningFamily,
  type PlayerCoverage,
} from "../lib/openings";

const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_ENGINE_URL ?? "/api");

export function meta() {
  return [
    { title: "Opening Review · Tempo Chess" },
    { name: "description", content: "See which opening positions deserve another look, and why." },
  ];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const query = new URLSearchParams(url.search);
  if (!query.has("username")) query.set("username", "ncarcasc");
  const username = query.get("username")!;
  const [explorerResponse, coverageResponse] = await Promise.all([
    fetch(`${API}/opening-explorer?${query}`),
    fetch(`${API}/players/${encodeURIComponent(username)}/coverage`),
  ]);
  let explorer = await explorerResponse.json() as OpeningExplorerData & { error?: string };
  const coverage = await coverageResponse.json();
  if (!explorerResponse.ok) throw new Error(explorer.error ?? "Could not build your opening review.");
  if (!coverageResponse.ok) throw new Error(coverage.error ?? "Could not check your game history.");
  if (!query.has("node") && !query.has("family")) {
    const first = rankOpeningFamilies(explorer.families).find((family) => family.failures > 0);
    if (first?.weakestNodeKey && explorer.selected?.nodeKey !== first.weakestNodeKey) {
      query.set("family", first.family);
      query.set("node", first.weakestNodeKey);
      const selectedResponse = await fetch(`${API}/opening-explorer?${query}`);
      const selectedData = await selectedResponse.json();
      if (selectedResponse.ok) explorer = selectedData as OpeningExplorerData;
    }
  }
  return {
    explorer,
    coverage: coverage as PlayerCoverage,
  };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "sync") {
    const response = await fetch(`${API}/imports/lichess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), games: "all" }),
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, intent, message: data.error ?? "Could not sync games." };
    return { ok: true, intent, message: `Syncing ${data.import.requestedGames} games from Lichess.` };
  }

  const response = await fetch(`${API}/opening-explorer/drills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: form.get("username"),
      positionKey: form.get("positionKey"),
    }),
  });
  const data = await response.json();
  if (!response.ok) return { ok: false, intent: "drill", message: data.error ?? "Could not create practice." };
  return { ok: true, intent: "drill", message: "Position added to your practice queue." };
}

function queryHref(params: URLSearchParams, changes: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return `/openings?${next}`;
}

function moveName(fen: string, uci: string | null): string | null {
  if (!uci) return null;
  try {
    const chess = new Chess(fen);
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4],
    }).san;
  } catch {
    return uci;
  }
}

function CoverageBar({ coverage, username }: { coverage: PlayerCoverage; username: string }) {
  const sync = useFetcher<typeof clientAction>();
  const busy = sync.state !== "idle" || coverage.activeImport != null;
  const complete = coverage.historyComplete;
  const percent = coverage.availableGames
    ? Math.min(100, Math.round((coverage.importedGames / coverage.availableGames) * 100))
    : 0;

  return (
    <section className="coverage-bar" aria-label="Game history coverage">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong>{coverage.importedGames} of {coverage.availableGames} Lichess games imported</strong>
          <InfoTip label="game coverage">
            Tempo had only imported the latest 30 games. Opening patterns improve as more of your history is added. Non-standard variants may be skipped.
          </InfoTip>
        </div>
        <div className="coverage-track" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
        <p>
          {complete
            ? coverage.skippedGames > 0
              ? `${coverage.analyzedGames} games have engine analysis. ${coverage.skippedGames} non-standard ${coverage.skippedGames === 1 ? "game was" : "games were"} skipped.`
              : `${coverage.analyzedGames} games have engine analysis.`
            : `${coverage.availableGames - coverage.importedGames} ${coverage.availableGames - coverage.importedGames === 1 ? "game is" : "games are"} still missing from this report.`}
        </p>
      </div>
      {!complete ? (
        <sync.Form method="post">
          <input type="hidden" name="intent" value="sync" />
          <input type="hidden" name="username" value={username} />
          <button className="secondary-button" disabled={busy}>
            {busy ? "Syncing games…" : "Import all games"}
          </button>
        </sync.Form>
      ) : null}
      {sync.data ? <p className="sr-only" aria-live="polite">{sync.data.message}</p> : null}
    </section>
  );
}

function ReviewLabel({ family }: { family: OpeningFamily }) {
  const costlyRate = family.opportunities ? family.failures / family.opportunities : 0;
  const text = family.games < 3
    ? "Not enough games"
    : family.failures >= 3 && costlyRate >= 0.15
      ? "Needs work"
      : "Holding up";
  return <span className={`review-label review-label-${text.toLowerCase().replaceAll(" ", "-")}`}>{text}</span>;
}

function FamilyList({
  families,
  selectedFamily,
  params,
  sampleGames,
}: {
  families: OpeningFamily[];
  selectedFamily: string;
  params: URLSearchParams;
  sampleGames: number;
}) {
  const priorities = rankOpeningFamilies(families)
    .filter((family) => family.failures > 0)
    .slice(0, 10);
  return (
    <aside className="opening-review-list" aria-labelledby="opening-list-heading">
      <div className="opening-section-heading">
        <div>
          <h2 id="opening-list-heading">Priority openings</h2>
          <p>Ranked from all {sampleGames} imported games.</p>
        </div>
        <InfoTip label="opening order">
          This is a priority list, not your complete opening history. Openings with repeated costly decisions appear first; openings without a flagged mistake are not shown here.
        </InfoTip>
      </div>
      <nav aria-label="Opening families">
        {priorities.map((family) => (
          <Link
            key={family.family}
            to={queryHref(params, {
              family: family.family,
              node: family.weakestNodeKey,
              from: null,
              move: null,
            })}
            className={`opening-review-link ${selectedFamily === family.family ? "is-active" : ""}`}
          >
            <span className="min-w-0">
              <strong>{family.family}</strong>
              <small>
                {family.failures} costly move{family.failures === 1 ? "" : "s"} · {family.games} game{family.games === 1 ? "" : "s"}
              </small>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </nav>
      <p className="opening-list-footnote">
        Showing {priorities.length} opening{priorities.length === 1 ? "" : "s"} with flagged moves. No games are excluded from the report.
      </p>
    </aside>
  );
}

function Filters({ username, params }: { username: string; params: URLSearchParams }) {
  const today = new Date();
  const since = (days: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const filters = [
    { name: "platform", label: "Site", options: [["all", "All sites"], ["lichess", "Lichess"], ["chesscom", "Chess.com"]] },
    { name: "speed", label: "Time control", options: [["all", "All speeds"], ["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapid"], ["classical", "Classical"]] },
    { name: "color", label: "Your color", options: [["all", "Both colors"], ["white", "White"], ["black", "Black"]] },
    { name: "since", label: "Games played", options: [["", "All time"], [since(90), "Last 90 days"], [since(180), "Last 6 months"], [since(365), "Last year"]] },
  ];

  return (
    <details className="opening-filters">
      <summary>Narrow the report</summary>
      <Form method="get" className="opening-filter-grid">
        <input type="hidden" name="username" value={username} />
        {filters.map(({ name, label, options }) => (
          <label key={name}>
            <span>{label}</span>
            <select name={name} defaultValue={params.get(name) ?? options[0]![0]}>
              {options.map(([value, copy]) => <option key={value} value={value}>{copy}</option>)}
            </select>
          </label>
        ))}
        <button className="secondary-button">Apply filters</button>
      </Form>
    </details>
  );
}

function RecommendationCopy({
  family,
  lineGames,
}: {
  family: OpeningFamily;
  lineGames: number;
}) {
  const handled = handledPercent(family);
  if (family.games < 3) {
    return (
      <p>
        You have only {family.games} game{family.games === 1 ? "" : "s"} in this opening. Review the position below, but do not treat it as a recurring weakness yet.
      </p>
    );
  }
  return (
    <p>
      Across {family.games} games, {family.failures} of {family.opportunities} checked opening moves lost meaningful value. You handled {handled}% well. The position below is the clearest example{lineGames > 1 ? ` and appeared in ${lineGames} games` : ""}.
    </p>
  );
}

function GameEvidence({ failure }: { failure: OpeningFailure }) {
  const date = failure.playedAt
    ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(failure.playedAt))
    : "Date unavailable";
  const swing = failure.evaluationLossCp == null ? null : (failure.evaluationLossCp / 100).toFixed(1);
  const preferredMove = moveName(failure.fen, failure.bestMoveUci);
  return (
    <article className="evidence-game">
      <div>
        <strong>vs {failure.opponent ?? "Unknown player"}</strong>
        <span>{date} · move {Math.ceil(failure.ply / 2)} · {failure.result}</span>
      </div>
      <div className="evidence-move">
        <span>You played <b>{failure.moveSan}</b></span>
        {preferredMove ? <span>Engine preferred <b>{preferredMove}</b></span> : null}
      </div>
      <div className="evidence-cost">
        {swing ? <strong>−{swing} pawns</strong> : <strong>Cost unavailable</strong>}
        <InfoTip label="evaluation swing">
          The engine’s estimate of how much the move changed the position, shown in pawn units. It is evidence about this move—not a rating of you.
        </InfoTip>
      </div>
      <Link to={`/game/${failure.platformGameId}?ply=${failure.ply}`} className="text-link">Review game <span aria-hidden="true">→</span></Link>
    </article>
  );
}

export default function OpeningReview({ loaderData }: Route.ComponentProps) {
  const { explorer: data, coverage } = loaderData;
  const [params] = useSearchParams();
  const practice = useFetcher<typeof clientAction>();
  const selected = data.selected;
  const family = data.families.find((item) => item.family === selected?.family) ?? data.families[0];
  const primaryFailure = data.failures[0];
  const preferredMove = primaryFailure ? moveName(primaryFailure.fen, primaryFailure.bestMoveUci) : null;
  const selectedMove = data.selectedMove;
  const decisionNode = selectedMove && data.tree
    ? data.tree.nodes.find((node) => node.key === selectedMove.fromKey)
    : null;
  const boardFen = primaryFailure?.fen ?? decisionNode?.fen ?? selected?.fen ?? "";
  const practicePositionKey = selectedMove?.fromKey ?? selected?.nodeKey ?? "";

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#opening-review-main">Skip to opening review</a>
      <header className="product-header">
        <div>
          <Link to="/" className="product-mark">Tempo <span>Chess</span></Link>
          <nav aria-label="Primary navigation">
            <Link to="/">Overview</Link>
            <Link to="/openings" aria-current="page">Opening review</Link>
          </nav>
        </div>
      </header>

      <main id="opening-review-main" className="opening-review-shell">
        <header className="opening-review-header">
          <div>
            <p className="eyebrow">Opening review</p>
            <h1>Know what to fix next.</h1>
            <p>Tempo checks the opening decisions in your own games, then shows the positions worth revisiting.</p>
          </div>
          <Link to="/" className="text-link">Back to overview</Link>
        </header>

        <CoverageBar coverage={coverage} username={data.username} />
        <Filters username={data.username} params={params} />

        {selected && family ? (
          <div className="opening-review-layout">
            <FamilyList
              families={data.families}
              selectedFamily={selected.family}
              params={params}
              sampleGames={data.sample.games}
            />

            <section className="opening-recommendation" aria-labelledby="recommendation-heading">
              <div className="recommendation-heading-row">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ReviewLabel family={family} />
                    <span className="plain-context">{reliabilityLabel(family.games)}</span>
                  </div>
                  <h2 id="recommendation-heading">{selected.family}</h2>
                  {selected.variation ? <p className="variation-name">{selected.variation}</p> : null}
                </div>
                <InfoTip label="this recommendation">
                  Tempo ranks openings using repeated engine-checked decisions, the number of different games, recency, and the size of the mistakes. Game count prevents one long game from looking like a strong pattern.
                </InfoTip>
              </div>

              <div className="recommendation-copy">
                <RecommendationCopy family={family} lineGames={selected.games} />
              </div>

              {data.tree ? (
                <OpeningLineTree
                  tree={data.tree}
                  selectedNodeKey={selected.nodeKey}
                  selectedMove={selectedMove}
                  params={params}
                />
              ) : null}

              <div className="opening-position-review">
                <div className="opening-board-wrap">
                  <Chessboard
                    fen={boardFen}
                    flip={primaryFailure?.playerColor === "black" ||
                      (!primaryFailure && params.get("color") === "black")}
                  />
                </div>
                <div className="position-explanation">
                  <p className="eyebrow">{selectedMove ? "Selected branch" : "Position to review"}</p>
                  {primaryFailure ? (
                    <>
                      <h3>You played {primaryFailure.moveSan}.</h3>
                      <p>
                        {preferredMove
                          ? `The engine preferred ${preferredMove}. Open the game to see the full continuation and why the difference mattered.`
                          : "Open the game to compare your move with the engine’s alternatives."}
                      </p>
                      <div className="position-actions">
                        <Link to={`/game/${primaryFailure.platformGameId}?ply=${primaryFailure.ply}`} className="primary-button">Review this game</Link>
                        <practice.Form method="post">
                          <input type="hidden" name="intent" value="drill" />
                          <input type="hidden" name="username" value={data.username} />
                          <input type="hidden" name="positionKey" value={practicePositionKey} />
                          <button className="secondary-button" disabled={practice.state !== "idle"}>
                            {practice.state === "idle" ? "Practice this position" : "Adding…"}
                          </button>
                        </practice.Form>
                      </div>
                      {practice.data ? <p className="action-message" aria-live="polite">{practice.data.message}</p> : null}
                    </>
                  ) : selectedMove ? (
                    <>
                      <h3>
                        {selectedMove.actor === "opponent"
                          ? `Opponent played ${selectedMove.moveSan}.`
                          : selectedMove.actor === "mixed"
                            ? `${selectedMove.moveSan} appeared for both sides.`
                            : `You played ${selectedMove.moveSan}.`}
                      </h3>
                      <p>
                        This branch appeared in {selectedMove.games} game{selectedMove.games === 1 ? "" : "s"} ({selectedMove.sharePercent}% of the games that reached this position).
                        {selectedMove.actor === "player" && selectedMove.failures === 0
                          ? " Tempo did not flag it as costly in the checked games."
                          : selectedMove.actor === "opponent"
                            ? " Follow the tree to inspect how you responded."
                            : ""}
                      </p>
                      <div className="position-actions">
                        <practice.Form method="post">
                          <input type="hidden" name="intent" value="drill" />
                          <input type="hidden" name="username" value={data.username} />
                          <input type="hidden" name="positionKey" value={practicePositionKey} />
                          <button className="secondary-button" disabled={practice.state !== "idle"}>
                            {practice.state === "idle" ? "Practice from here" : "Addingâ€¦"}
                          </button>
                        </practice.Form>
                      </div>
                      {practice.data ? <p className="action-message" aria-live="polite">{practice.data.message}</p> : null}
                    </>
                  ) : (
                    <>
                      <h3>No costly move found here.</h3>
                      <p>This line is shown because of the wider opening pattern. Choose another opening on the left for a concrete game example.</p>
                    </>
                  )}
                </div>
              </div>

              <section className="opening-evidence" aria-labelledby="evidence-heading">
                <div className="opening-section-heading">
                  <h3 id="evidence-heading">Games behind this recommendation</h3>
                  <InfoTip label="supporting games">
                    These are the games where the selected position occurred and your move lost at least 0.9 pawns according to the screening engine.
                  </InfoTip>
                </div>
                {data.failures.length
                  ? <div className="evidence-list">{data.failures.map((failure) => <GameEvidence key={`${failure.gameId}-${failure.ply}`} failure={failure} />)}</div>
                  : <p className="empty-evidence">No costly move from this exact position. The opening-level recommendation comes from other positions in the same family.</p>}
              </section>
            </section>
          </div>
        ) : (
          <section className="empty-opening-review">
            <h2>No opening review yet</h2>
            <p>Import your games first. Tempo needs completed engine checks before it can recommend a position.</p>
          </section>
        )}
      </main>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : "Could not load your opening review.";
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="panel max-w-lg p-8 text-center">
        <h1 className="text-2xl font-black">Opening review unavailable</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p>
        <Link to="/" className="primary-button mt-6 inline-flex">Return to overview</Link>
      </div>
    </main>
  );
}
