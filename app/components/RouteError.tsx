import { Link } from "react-router";
import { TopNav } from "./TopNav";

/** A styled fallback for route-level errors that keeps the nav and a way back,
 *  instead of dropping to the bare unstyled root error boundary. */
export function RouteError({ title, error }: { title: string; error: unknown }) {
  const message =
    error instanceof Error ? error.message : "Something went wrong loading this page.";
  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="home" />
      <main className="grid min-h-[70vh] place-items-center p-6">
        <div className="panel max-w-lg p-8 text-center">
          <h1 className="text-2xl font-black">{title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p>
          <div className="mt-6 flex justify-center gap-3">
            <Link to="/" className="primary-button inline-flex">Back to My Chess</Link>
            <Link to="/openings" className="secondary-button inline-flex items-center">Open the explorer</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
