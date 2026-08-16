import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Privacy policy · Forma" },
    { name: "description", content: "How Forma collects, uses, protects, and deletes personal data." },
  ];
}

const UPDATED = "14 August 2026";

export default function Privacy() {
  return (
    <PublicPage>
      <article className="legal">
        <h1>Privacy policy</h1>
        <p className="legal-meta">Last updated {UPDATED}</p>

        <div className="legal-notice" role="note">
          <strong>The short version.</strong> Forma analyses completed chess games
          to produce a private, personalised training report. We do not sell
          personal data, run advertising, or use game data to train third-party
          AI models. You can ask us to export or delete your Forma data.
        </div>

        <h2>1. Who controls your data</h2>
        <p>
          Forma is an independent chess-analysis service operated in Ireland.
          Forma is the data controller for information processed through this
          service. Privacy questions and rights requests can be sent to{" "}
          <a href="mailto:privacy@formachess.app">privacy@formachess.app</a>.
        </p>
        <p>
          Forma is not affiliated with, endorsed by, or operated by Chess.com or
          Lichess. Those platforms remain controllers of the information you give
          them and their own privacy notices continue to apply.
        </p>

        <h2>2. Information we collect</h2>
        <h3>Forma account information</h3>
        <p>
          We process your email address, Forma user identifier, subscription plan,
          account dates, and authentication records. Authentication is provided by
          Supabase. Forma does not receive your password in readable form.
        </p>

        <h3>Connected chess-account information</h3>
        <p>
          We process the platform, username, public account identifier, ratings,
          and profile information needed to identify the chess account you choose
          to connect. When Chess.com OAuth is available, the authorization flow
          will verify that the Chess.com member approving the connection controls
          that account. Forma will not receive your Chess.com password.
        </p>

        <h3>Completed games and derived analysis</h3>
        <p>
          We import completed-game information made available by the connected
          platform: moves, players, public usernames and ratings, result, date,
          clocks where available, opening, time control, game URL, and provider
          annotations. We derive engine evaluations, critical positions, opening
          observations, recurring findings, training positions, repertoire data,
          and progress statistics from those games.
        </p>
        <p>
          A game necessarily contains an opponent's public username, rating, and
          moves. We use that information only as part of the connected member's
          game history. We do not create an independent marketing profile of the
          opponent.
        </p>

        <h3>Study, service, and technical information</h3>
        <p>
          We process repertoire choices, drill answers, lesson progress, feature
          usage, import status, and analysis usage so the product can remember
          progress and enforce service limits. Our infrastructure may also record
          IP address, user agent, request time, request path, and error details for
          security, reliability, and abuse prevention.
        </p>

        <h3>Early-access and payment information</h3>
        <p>
          If you request early access, we process the information you submit,
          which may include your name, email, chess username, rating, platform,
          and improvement goal. When paid plans launch, our payment provider will
          process card and billing details directly. Forma will retain only the
          references, status, and transaction records needed to administer the
          subscription and meet legal obligations.
        </p>

        <h2>3. Where the information comes from</h2>
        <p>
          Information comes from you, from your use of Forma, and from the
          official interfaces of the chess platform you connect. Chess.com describes
          its Published-Data API as read-only and limited to publicly available
          player and game data. Forma only analyses games that have finished.
        </p>

        <h2>4. Why we use it</h2>
        <ul>
          <li><strong>Provide Forma.</strong> Connect the account you select, import completed games, run analysis, generate reports and drills, and remember progress. The legal basis is performance of our contract with you.</li>
          <li><strong>Keep the service reliable and secure.</strong> Authenticate requests, prevent impersonation and abuse, diagnose errors, operate analysis queues, and enforce limits. The legal basis is our legitimate interests in operating a safe service.</li>
          <li><strong>Administer payments.</strong> Provide paid plans, invoices, refunds, and subscription management when billing launches. The legal bases are contract and legal obligation.</li>
          <li><strong>Communicate with you.</strong> Send essential account, security, analysis, billing, and policy messages. The legal bases are contract and legitimate interests. Optional marketing requires a separate choice and can be withdrawn.</li>
          <li><strong>Improve Forma.</strong> Understand aggregated feature usage and improve the reliability and usefulness of the product. The legal basis is our legitimate interests. We do not sell this information or use it for targeted advertising.</li>
        </ul>

        <h2>5. Who processes it for us</h2>
        <p>We use a limited set of service providers:</p>
        <ul>
          <li><strong>Supabase</strong> for authentication and database infrastructure;</li>
          <li><strong>Cloudflare</strong> for delivery and protection of the web application;</li>
          <li><strong>Google Cloud</strong> for API hosting, analysis compute, logs, and object storage;</li>
          <li><strong>our payment provider</strong> for checkout, subscription administration, fraud prevention, and payment records once billing is enabled; and</li>
          <li><strong>Chess.com or Lichess</strong> when you ask Forma to connect or refresh an account from that platform.</li>
        </ul>
        <p>
          These providers receive only the information needed for their role and
          process it under their own terms or our data-processing arrangements.
          We may also disclose information where law requires it or where needed
          to protect users, the service, or legal rights.
        </p>

        <h2>6. Retention and deletion</h2>
        <p>
          We retain account, connected-account, completed-game, analysis, and
          study information while your Forma account remains open. Import and
          security logs are kept only as long as reasonably needed to operate and
          protect the service. Financial records may be retained for the period
          required by tax and accounting law.
        </p>
        <p>
          To delete your account and associated live-service data, email{" "}
          <a href="mailto:privacy@formachess.app">privacy@formachess.app</a> from
          the address on your Forma account. We may verify the request before
          acting. Residual encrypted backups expire on their normal rotation and
          are not restored except for disaster recovery.
        </p>

        <h2>7. Your choices and rights</h2>
        <p>
          Depending on applicable law, you may ask for access, correction,
          erasure, restriction, portability, or an objection to processing. You
          may disconnect a chess platform or withdraw an OAuth authorization;
          disconnecting stops future imports but does not itself erase information
          already stored by Forma. Send requests to{" "}
          <a href="mailto:privacy@formachess.app">privacy@formachess.app</a>.
        </p>
        <p>
          If you are in the EEA, you may complain to your local supervisory
          authority or to Ireland's Data Protection Commission at{" "}
          <a href="https://www.dataprotection.ie" target="_blank" rel="noreferrer noopener">dataprotection.ie</a>.
        </p>

        <h2>8. Browser storage and tracking</h2>
        <p>
          Forma uses browser storage for authentication, early-access status,
          account selection, board appearance, sound, and other necessary product
          preferences. We do not currently use advertising cookies or cross-site
          behavioural tracking.
        </p>

        <h2>9. International processing</h2>
        <p>
          Some providers may process information outside Ireland or the EEA. When
          required, transfers are covered by an adequacy decision, the European
          Commission's standard contractual clauses, or another lawful safeguard.
        </p>

        <h2>10. Security</h2>
        <p>
          We use access controls, encrypted network connections, scoped service
          credentials, and authenticated API requests appropriate to the service.
          No online system is completely secure; please report suspected account
          or security problems promptly.
        </p>

        <h2>11. Children</h2>
        <p>
          Forma is currently intended for people aged 16 or older. We do not
          knowingly accept accounts from children under 16. If you believe a child
          has provided personal information, contact us so we can investigate and
          delete it where appropriate.
        </p>

        <h2>12. Automated analysis</h2>
        <p>
          Forma uses chess engines and deterministic scoring models to produce
          training recommendations. These recommendations do not make legal or
          similarly significant decisions about you, and they can be incomplete
          or wrong.
        </p>

        <h2>13. Changes and contact</h2>
        <p>
          We will update the date above when this notice changes and will provide
          additional notice when a change materially affects existing users.
          Questions and requests: <a href="mailto:privacy@formachess.app">privacy@formachess.app</a>.
        </p>

        <p className="legal-foot">
          See also our <Link to="/terms">terms of service</Link> and{" "}
          <Link to="/brand">brand disclosure</Link>.
        </p>
      </article>
    </PublicPage>
  );
}
