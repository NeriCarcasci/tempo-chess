import { useMemo } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/lessons";
import { PieceGlyph } from "../components/PieceGlyph";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";
import { fetchLessonProgress, type LessonProgress } from "../lib/account";
import { LESSONS } from "../lib/lessons";
import { RouteError } from "../components/RouteError";
import { Donut } from "../components/instruments";

export function meta() {
  return [{ title: "Lessons · Forma" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Lessons unavailable" error={error} />;
}

export async function clientLoader({}: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const progress = await fetchLessonProgress(session.username);
  return { progress };
}

export default function Lessons({ loaderData }: Route.ComponentProps) {
  const progressBySlug = useMemo(() => {
    const map = new Map<string, LessonProgress>();
    for (const p of loaderData.progress) map.set(p.slug, p);
    return map;
  }, [loaderData.progress]);

  const groups: Array<{ label: string; color: "white" | "black" }> = [
    { label: "As White", color: "white" },
    { label: "As Black", color: "black" },
  ];

  const doneCount = LESSONS.filter((l) => progressBySlug.get(l.slug)?.completedAt).length;

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="lessons" />
      <main className="lessons-shell">
        <header className="lessons-head">
          {/* No kicker. "Guided lessons" over "Learn an opening" restated the
              heading in smaller type, which is furniture, and the nav already
              says where you are. The count is a chip, like every other
              standing figure in the product. */}
          <h1>Learn an opening, one idea at a time</h1>
          {doneCount ? (
            <p className="figchips on-paper lessons-standing">
              <span className="figchip">
                <b>
                  {doneCount} of {LESSONS.length}
                </b>
                <small>completed</small>
              </span>
            </p>
          ) : null}
          <p>
            Play the moves yourself; Forma explains the plan behind each one.
          </p>
        </header>

        {groups.map((group) => {
          const lessons = LESSONS.filter((l) => l.color === group.color);
          if (!lessons.length) return null;
          return (
            <section key={group.color} className="lessons-group">
              <h2 className="lessons-group-title">{group.label}</h2>
              <div className="lessons-grid">
                {lessons.map((lesson, index) => {
                  const p = progressBySlug.get(lesson.slug);
                  const started = p && p.completedSteps > 0;
                  const complete = !!p?.completedAt;
                  // An ascending run of pieces, the product's own mark for a
                  // sequence (see Scenes): the glyph names nothing about the
                  // lesson, so it repeats on a cycle rather than pretending
                  // each opening has a piece.
                  const glyph = ["p", "n", "b", "r", "q"][index % 5]!;
                  return (
                    <Link key={lesson.slug} to={`/lessons/${lesson.slug}`} className="lesson-card">
                      <span className="lesson-mark" aria-hidden="true">
                        <PieceGlyph letter={glyph} white={lesson.color === "white"} />
                      </span>
                      <div className="lesson-card-body">
                        <span className="lesson-family">{lesson.family}</span>
                        <strong>{lesson.title}</strong>
                        <p>{lesson.subtitle}</p>
                        <span className={`lesson-cta ${complete ? "is-done" : ""}`}>
                          {complete ? "Review ✓" : started ? "Continue →" : "Start →"}
                        </span>
                      </div>
                      {/* The product's one ring, not a second one drawn
                          here: a lesson's progress and a phase's rate are
                          the same kind of claim and must look it. */}
                      <Donut
                        value={lesson.interactiveCount ? (p?.completedSteps ?? 0) / lesson.interactiveCount : 0}
                        size={44}
                        stroke={4}
                      >
                        <b className="lesson-ring-figure metric">
                          {Math.round(
                            lesson.interactiveCount
                              ? ((p?.completedSteps ?? 0) / lesson.interactiveCount) * 100
                              : 0,
                          )}
                        </b>
                      </Donut>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
