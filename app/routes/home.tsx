import { Link, redirect } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { ADMIN_HOST } from "../lib/admin";
import { HeroBoard } from "../components/HeroBoard";
import { Showcase } from "../components/Showcase";
import { Scale } from "../components/Scale";

/**
 * `admin.formachess.com/` is the admin surface, not the landing page.
 *
 * One Pages project serves both hostnames, so without this the operator
 * subdomain shows the marketing site and the admin screens are reachable only
 * by typing the path. Exact hostname rather than `isAdminHost`, because that
 * helper also allows localhost, and redirecting `/` in development would put
 * the landing page out of reach of the person building it.
 */
export function clientLoader() {
  if (window.location.hostname === ADMIN_HOST) throw redirect("/admin");
  return null;
}

export function meta() {
  return [
    { title: "Forma · Your mistakes have a shape" },
    {
      name: "description",
      content:
        "Forma reads every game you have played, finds the mistakes you repeat, and turns them into drills.",
    },
  ];
}

export default function Home() {
  return (
    <PublicPage>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Your mistakes
            <br />
            have a <em>shape</em>.
          </h1>
          <p>
            Forma reads every game you have played, finds the errors you repeat,
            and turns them into drills.
          </p>
          <div className="hero-actions">
            <Link to="/signup" className="primary-button btn-lg">Analyse my games</Link>
            <Link to="/features" className="secondary-button btn-lg">How it works</Link>
          </div>
        </div>
        <HeroBoard />
      </section>

      <section className="statement">
        <p>
          Reviewing one game tells you what went wrong <i>once</i>. Forma reads
          your whole history at once, so the mistake you have made forty times
          stops looking like bad luck.
        </p>
      </section>

      {/* The claim above is only worth anything at volume, so the numbers sit
          directly under it rather than being saved for a stats page nobody
          opens. */}
      <Scale />

      <Showcase />

      <section className="closer">
        <h2>The analysis is already sitting in your game history.</h2>
        <Link to="/signup" className="primary-button btn-lg">Start free</Link>
      </section>
    </PublicPage>
  );
}
