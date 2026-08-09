import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Privacy policy · Tempo" },
    { name: "description", content: "What data Tempo collects, why, and what control you have over it." },
  ];
}

/**
 * A working draft that reflects what the system genuinely stores — the schema is
 * the source of truth here, so this list is accurate rather than boilerplate.
 * Still needs a legal review before launch.
 */

const UPDATED = "9 August 2026";

export default function Privacy() {
  return (
    <PublicPage>
      <article className="legal">
        <p className="eyebrow">Legal</p>
        <h1>Privacy policy</h1>
        <p className="legal-meta">Last updated {UPDATED}</p>

        <div className="legal-notice" role="note">
          <strong>Draft pending legal review.</strong> This describes what Tempo
          actually stores and why. It has not yet been reviewed by a lawyer or
          checked against every jurisdiction you may operate in.
        </div>

        <h2>The short version</h2>
        <p>
          We store your email, the chess usernames you connect, the games we fetch
          for those usernames, and the analysis we derive from them. We do not
          sell your data, we do not use it to train models for anyone else, and
          you can delete all of it.
        </p>

        <h2>What we collect</h2>
        <h3>Account data</h3>
        <p>
          Your email address and a securely hashed password, handled by our
          authentication provider (Supabase). We never see your password in plain
          text. We also store your plan (free or Pro) and when you signed up.
        </p>

        <h3>Connected chess accounts</h3>
        <p>
          The platform and username you connect, and the ratings we read from the
          public profile. We do not receive or store credentials for those
          platforms.
        </p>

        <h3>Game and analysis data</h3>
        <p>
          For each game we import: the moves, the result, the time control, the
          date, your opponent's public username and rating, the opening, and the
          game's URL on the source platform. From that we derive and store engine
          evaluations, recorded mistakes, opening statistics, and generated
          puzzles. All of this originates from publicly accessible archives on the
          platform where you played.
        </p>

        <h3>Study activity</h3>
        <p>
          Your repertoire choices, drill results, and lesson progress: the data
          behind your progress tracking.
        </p>

        <h3>Payment data</h3>
        <p>
          When paid plans go live, payments will be processed by Stripe. Card
          details go to Stripe directly and are never stored on our servers; we
          keep only a customer reference and your subscription status.
        </p>

        <h3>Technical data</h3>
        <p>
          Standard server logs (IP address, user agent, request paths and times)
          kept for security and debugging, and retained for a limited period.
        </p>

        <h2>Why we process it</h2>
        <ul>
          <li><strong>To provide the service.</strong> Analysing your games is the product; without this data there is nothing to show you. (Performance of a contract.)</li>
          <li><strong>To keep accounts secure.</strong> Authentication, abuse prevention, and debugging. (Legitimate interests.)</li>
          <li><strong>To take payment.</strong> For users on a paid plan. (Performance of a contract.)</li>
          <li><strong>To contact you.</strong> Service messages such as billing notices or material changes to these policies. (Legitimate interests / contract.)</li>
        </ul>

        <h2>Who we share it with</h2>
        <p>
          Only the providers needed to run Tempo: our authentication and database
          provider (Supabase), our hosting providers, our object storage provider
          for raw game files, and (once billing is live) Stripe. They process
          data on our instructions. We do not sell personal data or share it with
          advertisers.
        </p>
        <p>
          We fetch data <em>from</em> Lichess and Chess.com. We do not send them
          anything about you beyond the public request needed to read an archive.
        </p>

        <h2>Other players in your games</h2>
        <p>
          Imported games necessarily include your opponent's public username,
          rating, and moves. This is already public on the source platform. We use
          it only to describe your own games back to you, and we do not build
          profiles of players who have not signed up.
        </p>

        <h2>How long we keep it</h2>
        <p>
          Account and game data is kept while your account exists. Delete your
          account and we remove your profile, connected accounts, games, analysis,
          and study history; the database is set up to cascade those deletions.
          Backups roll off on their own schedule, and limited records may be
          retained where law requires it (for example, invoices).
        </p>

        <h2>Your rights</h2>
        <p>
          Depending on where you live you may have the right to access, correct,
          export, or delete your personal data, to object to or restrict certain
          processing, and to complain to a data protection authority. Email{" "}
          <a href="mailto:privacy@tempochess.app">privacy@tempochess.app</a> and we
          will respond within 30 days. Account deletion is available directly from
          your <Link to="/account">account page</Link>.
        </p>

        <h2>Cookies</h2>
        <p>
          Tempo uses browser storage to keep you signed in and to remember display
          preferences such as board theme and sound. These are necessary for the
          app to work. We do not use advertising or cross-site tracking cookies.
        </p>

        <h2>International transfers</h2>
        <p>
          Our providers may process data outside your country. Where that happens
          we rely on appropriate safeguards, such as the European Commission's
          standard contractual clauses.
        </p>

        <h2>Children</h2>
        <p>
          Tempo is not directed at children under 13, and we do not knowingly
          collect their data. If you believe a child has given us personal data,
          contact us and we will delete it.
        </p>

        <h2>Changes</h2>
        <p>
          We will post any updates here and, for material changes, notify you by
          email before they take effect.
        </p>

        <h2>Contact</h2>
        <p>
          <a href="mailto:privacy@tempochess.app">privacy@tempochess.app</a>
        </p>

        <p className="legal-foot">
          See also our <Link to="/terms">terms of service</Link>.
        </p>
      </article>
    </PublicPage>
  );
}
