import { useMemo } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/lessons";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";
import { fetchLessonProgress, type LessonProgress } from "../lib/account";
import { LESSONS } from "../lib/lessons";
import { RouteError } from "../components/RouteError";

export function meta() {
  return [{ title: "Lessons · Tempo" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Lessons unavailable" error={error} />;
}

export async function clientLoader({}: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const progress = await fetchLessonProgress(session.username);
  return { progress };
}

function Ring({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const r = 15;
  const circ = 2 * Math.PI * r;
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" className="lesson-ring" aria-hidden="true">
      <circle cx="19" cy="19" r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth="4" />
      <circle
        cx="19" cy="19" r={r} fill="none" stroke="var(--color-win)" strokeWidth="4"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)} strokeLinecap="round"
        transform="rotate(-90 19 19)"
      />
      <text x="19" y="20" textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight="800" fill="var(--color-ink)">
        {pct}
      </text>
    </svg>
  );
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
          <p className="eyebrow">Guided lessons</p>
          <h1>Learn an opening, one idea at a time</h1>
          <p>
            Play the moves yourself and Tempo explains the why behind each one — plans, targets, and
            the principles that make the opening work. {doneCount ? `${doneCount} completed so far.` : ""}
          </p>
        </header>

        {groups.map((group) => {
          const lessons = LESSONS.filter((l) => l.color === group.color);
          if (!lessons.length) return null;
          return (
            <section key={group.color} className="lessons-group">
              <h2 className="lessons-group-title">{group.label}</h2>
              <div className="lessons-grid">
                {lessons.map((lesson) => {
                  const p = progressBySlug.get(lesson.slug);
                  const started = p && p.completedSteps > 0;
                  const complete = !!p?.completedAt;
                  return (
                    <Link key={lesson.slug} to={`/lessons/${lesson.slug}`} className="lesson-card">
                      <div className="lesson-card-body">
                        <span className="lesson-family">{lesson.family}</span>
                        <strong>{lesson.title}</strong>
                        <p>{lesson.subtitle}</p>
                        <span className={`lesson-cta ${complete ? "is-done" : ""}`}>
                          {complete ? "Review ✓" : started ? "Continue →" : "Start →"}
                        </span>
                      </div>
                      <Ring done={p?.completedSteps ?? 0} total={lesson.interactiveCount} />
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
