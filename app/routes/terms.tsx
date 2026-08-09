import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Terms of service · Tempo" },
    { name: "description", content: "The terms covering your use of Tempo." },
  ];
}

/**
 * A working draft. Stripe requires published terms before it will approve an
 * account, and these cover the real shape of the service — but they have not
 * been through a lawyer, and the banner says so rather than implying otherwise.
 */

const UPDATED = "9 August 2026";

export default function Terms() {
  return (
    <PublicPage>
      <article className="legal">
        <p className="eyebrow">Legal</p>
        <h1>Terms of service</h1>
        <p className="legal-meta">Last updated {UPDATED}</p>

        <div className="legal-notice" role="note">
          <strong>Draft pending legal review.</strong> These terms describe how
          Tempo actually operates, but they have not yet been reviewed by a
          lawyer. Have them checked before taking payments.
        </div>

        <h2>1. Who we are</h2>
        <p>
          Tempo ("we", "us") provides software that analyses chess
          games you have already played on third-party platforms and turns that
          analysis into training material. These terms govern your use of the
          service. By creating an account you agree to them.
        </p>

        <h2>2. Your account</h2>
        <p>
          You need an account to use Tempo. You are responsible for keeping your
          password confidential and for activity that happens under your account.
          Tell us promptly if you believe someone else has gained access. You must
          be old enough to form a binding contract where you live; if you are
          under 16, ask a parent or guardian to accept these terms for you.
        </p>

        <h2>3. Connected chess accounts</h2>
        <p>
          Tempo reads publicly available game archives from platforms such as
          Lichess and Chess.com using the username you provide. We never ask for,
          and cannot accept, your password on those platforms, and we cannot play
          moves or otherwise act on your behalf there. You may only connect a
          username that belongs to you. We are not affiliated with, endorsed by,
          or operated by Lichess or Chess.com, and your use of those platforms
          remains subject to their own terms.
        </p>

        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>use Tempo, or any output from it, to receive assistance during a live game;</li>
          <li>connect a chess account you do not control, or attempt to access another user's data;</li>
          <li>scrape, resell, or redistribute analysis output as a competing dataset or service;</li>
          <li>overload, probe, or interfere with the service or the engines behind it;</li>
          <li>use Tempo for anything unlawful.</li>
        </ul>
        <p>
          Using engine assistance during rated play violates the rules of every
          major chess platform. Tempo is a study tool for games that are already
          finished. Accounts used for live assistance will be terminated.
        </p>

        <h2>5. Plans, billing, and cancellation</h2>
        <p>
          Tempo offers a free plan and a paid Pro subscription; what each includes
          is set out on the <Link to="/pricing">pricing page</Link>. Paid plans
          renew automatically at the end of each billing period until cancelled.
          You may cancel at any time and will keep Pro access until the end of the
          period you have paid for. We do not provide pro-rata refunds for partial
          periods, but if the service has failed you, contact us and we will deal
          with it fairly. We may change prices with at least 30 days' notice to
          existing subscribers.
        </p>
        <p>
          If you cancel, your analysed history is not deleted. Access is reduced
          to the free plan's limits, and restoring the subscription restores
          it.
        </p>

        <h2>6. Your content and our analysis</h2>
        <p>
          Games you play belong to you and to the platforms you played them on.
          You grant us the permission needed to fetch, store, analyse, and display
          that data back to you so the service can function. The analysis Tempo
          produces (evaluations, findings, generated puzzles) is ours, and you
          may use it freely for your own study.
        </p>

        <h2>7. Availability</h2>
        <p>
          We aim to keep Tempo running but do not guarantee uninterrupted
          availability. Analysis depends on third-party platforms whose data we
          fetch, and those platforms rate-limit and occasionally go down. We may
          change or discontinue features; if we discontinue something you paid
          for, we will give notice and a fair refund.
        </p>

        <h2>8. Disclaimer and liability</h2>
        <p>
          Tempo is provided "as is". Engine evaluations are approximations
          produced at a finite search depth and may be wrong. Nothing Tempo tells
          you is a guarantee of improvement or of any result. To the fullest
          extent permitted by law, our total liability arising from your use of
          the service is limited to the amount you paid us in the twelve months
          before the claim. Nothing here limits liability that cannot lawfully be
          limited.
        </p>

        <h2>9. Termination</h2>
        <p>
          You may delete your account at any time from your account settings. We
          may suspend or terminate an account that breaches these terms, and will
          explain why unless doing so would be unlawful.
        </p>

        <h2>10. Changes</h2>
        <p>
          We may update these terms. If a change materially affects your rights we
          will notify you by email or in the app before it takes effect. Continuing
          to use Tempo after that means you accept the updated terms.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about these terms: <a href="mailto:hello@tempochess.app">hello@tempochess.app</a>.
        </p>

        <p className="legal-foot">
          See also our <Link to="/privacy">privacy policy</Link>.
        </p>
      </article>
    </PublicPage>
  );
}
