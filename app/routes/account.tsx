import { useMemo } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/account";
import { TopNav } from "../components/TopNav";
import { requireSession, setActiveAccount, signOut, type Session } from "../lib/session";
import { EmptyState } from "../components/v1/Honesty";
import { LichessMark, ChessComMark } from "../components/PlatformMarks";
import { fetchRepertoire, fetchLessonProgress, fetchMistakes, fetchActivity, type RepertoireData, type LessonProgress } from "../lib/account";
import { getCached, setCached } from "../lib/loaderCache";
import { LESSONS } from "../lib/lessons";
import { RouteError } from "../components/RouteError";

interface AccountData {
  session: Session;
  repertoire: RepertoireData;
  lessonProgress: LessonProgress[];
  activity: Awaited<ReturnType<typeof fetchActivity>>;
  mistakes: { white: number; black: number };
}

export function meta() {
  return [{ title: "Your account · Forma" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Account unavailable" error={error} />;
}

export async function clientLoader({}: Route.ClientLoaderArgs): Promise<AccountData> {
  const session = await requireSession();
  const cacheKey = `account:${session.username}`;
  const cached = getCached<AccountData>(cacheKey, 60_000);
  if (cached) return cached;
  const [repertoire, lessonProgress, whiteMistakes, blackMistakes, activity] = await Promise.all([
    fetchRepertoire(session.username).catch(() => ({ openings: [], stats: [] }) as RepertoireData),
    fetchLessonProgress(session.username),
    fetchMistakes(session.username, "white"),
    fetchMistakes(session.username, "black"),
    fetchActivity(session.username),
  ]);
  const data: AccountData = {
    session,
    repertoire,
    lessonProgress,
    activity,
    mistakes: { white: whiteMistakes.length, black: blackMistakes.length },
  };
  setCached(cacheKey, data);
  return data;
}

function knowledge(accuracy: number | null, sessions: number): { label: string; pct: number } {
  if (!sessions || accuracy == null) return { label: "Not started", pct: 0 };
  const pct = Math.round(accuracy * 100);
  if (sessions >= 3 && pct >= 85) return { label: "Confident", pct };
  if (pct >= 70) return { label: "Getting there", pct };
  return { label: "Shaky", pct };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Plan + billing, and the accounts this sign-in owns.
 *
 * The plan block and the usage meters are gone. Both read the session's
 * `subscription`, `limits` and `usage`, which came from the prototype `/me`
 * and counted the prototype's tables — the ones the analysis pipeline stopped
 * writing to. The meter that said "0 / 50 analysed games" was measuring an
 * empty table, not a person's entitlement, and a wrong meter is worse than no
 * meter because it invites somebody to buy their way out of a bug. `/v1`
 * publishes no entitlement yet, so this says so and stops.
 *
 * The way to Pro is `/pricing`, which still runs checkout. The portal button
 * needed to know whether there was a subscription to manage, and nothing here
 * knows that any more.
 */
function BillingPanel({ session }: { session: Session }) {
  return (
    <section className="account-group">
      <h2 className="account-group-title">Plan &amp; billing</h2>
      <EmptyState
        title="Your plan is not shown here yet"
        detail="Forma cannot yet tell you which plan you are on, what it includes, or how much of it you have used. The figures that used to stand here were counted from a part of the database the analysis no longer writes to, so they are not shown at all rather than shown wrong."
        action={
          <Link to="/pricing" className="secondary-button">
            Compare plans
          </Link>
        }
      />

      <div className="account-identity">
        <div>
          <p className="eyebrow">Signed in as</p>
          <strong>{session.email ?? "—"}</strong>
          {/* Linked accounts are a list you act on, not a sentence. Until this
              was one, a second account could be linked and imported with no
              way to point the product at it. */}
          {session.accounts.length ? (
            <ul className="account-linked">
              {session.accounts.map((account) => {
                const active = account.id === session.activeAccount?.id;
                return (
                  <li key={account.id} className={active ? "is-active" : ""}>
                    <span className="account-linked-mark" aria-hidden="true">
                      {account.platform === "chesscom" ? <ChessComMark size={16} /> : <LichessMark size={16} />}
                    </span>
                    <span className="account-linked-who">
                      <b>{account.username}</b>
                      <small>{account.platform === "chesscom" ? "Chess.com" : "Lichess"}</small>
                    </span>
                    {active ? (
                      <span className="account-linked-badge">In use</span>
                    ) : (
                      <button
                        type="button"
                        className="chip-btn"
                        onClick={() => {
                          setActiveAccount(session.userId, account.id);
                          location.href = "/today";
                        }}
                      >
                        Use this
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No chess account linked yet.</p>
          )}
        </div>
        <div className="account-billing-actions">
          <Link to="/account/connect" className="secondary-button">Link another account</Link>
          <button
            type="button"
            className="text-link account-signout"
            onClick={async () => {
              await signOut();
              location.href = "/";
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { session, repertoire, lessonProgress, mistakes, activity } = loaderData;

  const statByKey = useMemo(() => {
    const m = new Map<string, RepertoireData["stats"][number]>();
    for (const s of repertoire.stats) m.set(`${s.color}:${s.family}`, s);
    return m;
  }, [repertoire.stats]);

  const lessonBySlug = useMemo(() => {
    const m = new Map<string, LessonProgress>();
    for (const p of lessonProgress) m.set(p.slug, p);
    return m;
  }, [lessonProgress]);

  const groups: Array<{ label: string; color: "white" | "black" }> = [
    { label: "As White", color: "white" },
    { label: "As Black", color: "black" },
  ];

  const totalSessions = repertoire.stats.reduce((n, s) => n + s.sessions, 0);
  const lessonsDone = lessonProgress.filter((p) => p.completedAt).length;

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="account" />
      <main className="account-shell">
        <header className="account-head">
          <span className="account-avatar-lg" aria-hidden="true">{session.username.charAt(0).toUpperCase()}</span>
          <div>
            <p className="eyebrow">Your account</p>
            <h1>{session.username}</h1>
            <p>
              {repertoire.openings.length} openings in your repertoire · {totalSessions} drills practised ·{" "}
              {lessonsDone} lessons completed
            </p>
          </div>
          <div className={`account-streak ${activity.streak > 0 ? "is-active" : ""}`}>
            <strong>{activity.streak > 0 ? `🔥 ${activity.streak}` : "0"}</strong>
            <span>day streak</span>
            <small>{activity.practicedToday ? "Practised today ✓" : activity.streak > 0 ? "Practise today to keep it" : "Practise today to start one"}</small>
          </div>
        </header>

        {mistakes.white + mistakes.black > 0 ? (
          <section className="account-fix">
            <div>
              <p className="eyebrow">Fix your mistakes</p>
              <h2>Turn your slip-ups into fixed lines</h2>
              <p>Forma found the opening moments where the engine beats the move you actually played. Drill the better move until it's automatic.</p>
            </div>
            <div className="account-fix-actions">
              {mistakes.white > 0 ? (
                <Link to="/mistakes?color=white" className="primary-button inline-flex items-center">
                  {mistakes.white}{mistakes.white >= 15 ? "+" : ""} as White →
                </Link>
              ) : null}
              {mistakes.black > 0 ? (
                <Link to="/mistakes?color=black" className="secondary-button inline-flex items-center">
                  {mistakes.black}{mistakes.black >= 15 ? "+" : ""} as Black →
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}

        {repertoire.openings.length === 0 ? (
          <div className="account-empty">
            <p>
              You haven't chosen any openings to own yet. Head to the explorer and star the openings you
              want in your repertoire — then track how well you know them here.
            </p>
            <Link to="/openings" className="primary-button mt-4 inline-flex">Choose openings →</Link>
          </div>
        ) : (
          groups.map((group) => {
            const openings = repertoire.openings.filter((o) => o.color === group.color);
            if (!openings.length) return null;
            return (
              <section key={group.color} className="account-group">
                <h2 className="account-group-title">{group.label}</h2>
                <div className="account-rep-list">
                  {openings.map((o) => {
                    const stat = statByKey.get(`${o.color}:${o.family}`);
                    const k = knowledge(stat?.accuracy ?? null, stat?.sessions ?? 0);
                    const lesson = LESSONS.find((l) => l.family === o.family && l.color === o.color);
                    return (
                      <article key={o.family} className="account-rep">
                        <div className="account-rep-main">
                          <strong>{o.family}</strong>
                          <span className="account-rep-meta">
                            {stat?.sessions ? `${stat.sessions} drill${stat.sessions === 1 ? "" : "s"} · last ${timeAgo(stat.lastPracticed)}` : "Not practised yet"}
                          </span>
                          <div className="account-know">
                            <span className="account-know-track"><i style={{ width: `${k.pct}%` }} /></span>
                            <span className={`account-know-label know-${k.label.toLowerCase().replace(/\s/g, "-")}`}>{k.label}</span>
                          </div>
                        </div>
                        <div className="account-rep-actions">
                          <Link className="chip-btn" to={`/train?color=${o.color}&family=${encodeURIComponent(o.family)}`}>Drill</Link>
                          {lesson ? (
                            <Link className="chip-btn" to={`/lessons/${lesson.slug}`}>
                              Lesson{lessonBySlug.get(lesson.slug)?.completedAt ? " ✓" : ""}
                            </Link>
                          ) : (
                            <Link className="chip-btn" to={`/openings?color=${o.color}`}>Explore</Link>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}

        {lessonProgress.length ? (
          <section className="account-group">
            <h2 className="account-group-title">Lesson progress</h2>
            <div className="account-lessons">
              {LESSONS.filter((l) => lessonBySlug.has(l.slug)).map((l) => {
                const p = lessonBySlug.get(l.slug)!;
                return (
                  <Link key={l.slug} to={`/lessons/${l.slug}`} className="account-lesson">
                    <span>{l.title}</span>
                    <small>{p.completedAt ? `Complete · best ${p.bestScore}/${l.interactiveCount}` : `In progress`}</small>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}

        <BillingPanel session={session} />
      </main>
    </div>
  );
}
