import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Terms of service · Forma" },
    { name: "description", content: "The terms governing access to Forma's completed-game analysis service." },
  ];
}

const UPDATED = "14 August 2026";

export default function Terms() {
  return (
    <PublicPage>
      <article className="legal">
        <h1>Terms of service</h1>
        <p className="legal-meta">Last updated {UPDATED}</p>

        <div className="legal-notice" role="note">
          <strong>Completed games only.</strong> Forma is a study and training
          service. It must not be used to obtain assistance during an ongoing
          game, and it cannot submit moves or play on your behalf.
        </div>

        <h2>1. About Forma</h2>
        <p>
          Forma is an independent chess-analysis service operated in Ireland.
          It imports completed games from an account you connect, analyses
          patterns across those games, and produces personal reports and training
          material. These terms form an agreement between you and Forma when you
          access or create an account for the service.
        </p>
        <p>
          Forma is not affiliated with, endorsed by, sponsored by, or operated by
          Chess.com or Lichess. Platform names and marks belong to their respective
          owners, and your use of each platform remains governed by its own terms
          and policies.
        </p>

        <h2>2. Early access</h2>
        <p>
          Forma is currently a limited early-access service. Invitations may be
          limited, features may be unfinished, analysis may be re-run, and stored
          data may need to be migrated as the product develops. Please do not rely
          on early-access availability for competitions, coaching obligations, or
          any purpose where interruption would cause material loss.
        </p>
        <p>
          Early-access codes are personal preview credentials. Do not publish,
          resell, or use them to give access to people outside the invited group.
          They are not a substitute for a Forma user account or its security.
        </p>

        <h2>3. Eligibility and your Forma account</h2>
        <p>
          You must be at least 16 and legally able to accept these terms. You are
          responsible for accurate registration information, protecting access to
          your Forma account, and activity carried out through it. Notify us at{" "}
          <a href="mailto:hello@formachess.app">hello@formachess.app</a> if you
          believe the account has been compromised.
        </p>

        <h2>4. Connecting a chess account</h2>
        <p>
          You may connect only a chess account that you own or are expressly
          authorized to manage. Where OAuth is available, Forma uses the platform's
          authorization flow to verify the connection without receiving your
          platform password. You authorize Forma to request completed-game and
          public profile information needed to provide the service and to store
          the resulting personal analysis.
        </p>
        <p>
          You may revoke a platform authorization through the platform or ask us
          to disconnect it. Revocation prevents future authorized requests but
          does not automatically delete information already imported into Forma;
          deletion is handled as described in our <Link to="/privacy">privacy policy</Link>.
        </p>

        <h2>5. Fair play</h2>
        <p>
          Forma is designed exclusively for post-game study. You must not open,
          consult, or use Forma to help choose moves in an ongoing game where
          external assistance is prohibited. This includes rated, tournament,
          prize, and other games governed by a platform's fair-play rules.
        </p>
        <p>You must not use Forma to:</p>
        <ul>
          <li>receive engine evaluations, opening guidance, or move recommendations during a prohibited ongoing game;</li>
          <li>automate play, submit moves, operate a bot, or circumvent a platform restriction;</li>
          <li>misrepresent ownership or authorization of a connected account; or</li>
          <li>help another person breach Chess.com's, Lichess's, a tournament organizer's, or another provider's rules.</li>
        </ul>
        <p>
          We may suspend or terminate access where we reasonably believe Forma is
          being used for live assistance or another fair-play violation.
        </p>

        <h2>6. Other acceptable-use rules</h2>
        <p>You also agree not to:</p>
        <ul>
          <li>access another person's private Forma account or data without permission;</li>
          <li>probe, disrupt, overload, reverse engineer, or bypass security or service limits;</li>
          <li>scrape or systematically copy Forma's interface, reports, opening catalogue, or analysis for a competing dataset or service;</li>
          <li>resell access or generated reports without written permission; or</li>
          <li>use Forma unlawfully, fraudulently, or in a way that infringes another person's rights.</li>
        </ul>

        <h2>7. Game data and permission to process it</h2>
        <p>
          You retain whatever rights you hold in the information you provide.
          Chess-game and platform data may also be governed by the source
          platform's terms. You give Forma the limited permission necessary to
          request, copy, normalize, store, analyse, and display connected completed
          games and public account information back to you for the operation and
          improvement of the service.
        </p>
        <p>
          Forma does not claim ownership of your completed games. Forma's original
          interface, software, scoring methods, written presentation, brand, and
          generated report structure remain protected by applicable intellectual
          property law. You may use your personal reports and drills for your own
          non-commercial chess study and coaching sessions.
        </p>

        <h2>8. Analysis limitations</h2>
        <p>
          Chess-engine evaluations are produced with finite compute and can change
          with search depth, engine version, or position context. Pattern labels,
          explanations, opening classifications, priorities, and recommendations
          may be incomplete or wrong. Forma does not guarantee rating improvement,
          tournament results, or that every mistake will be found or explained.
        </p>

        <h2>9. Plans, payments, and cancellation</h2>
        <p>
          Early access may be provided without charge. Before paid subscriptions
          are enabled, the pricing page and checkout will state the current price,
          billing interval, included features, renewal terms, taxes where
          applicable, and any trial or refund conditions. We will not charge you
          without an affirmative checkout action.
        </p>
        <p>
          Once subscriptions are available, you may cancel renewal at any time and
          retain paid access until the end of the current billing period. Mandatory
          consumer cancellation and refund rights continue to apply. Material
          price changes for an existing renewing subscription will be communicated
          before the next affected charge.
        </p>

        <h2>10. Third-party services</h2>
        <p>
          Forma depends on third-party platforms and infrastructure, including
          chess providers, authentication, hosting, database, and payment services.
          Their availability, APIs, policies, and permissions may change. We may
          limit, alter, or discontinue an integration if necessary to comply with
          a provider's requirements or protect the service.
        </p>

        <h2>11. Availability and changes</h2>
        <p>
          We work to keep Forma accurate and available, but do not promise
          uninterrupted operation or permanent availability of a feature. During
          early access, we may change the data model, re-run analysis, reset
          derived findings, or restrict access while repairing the service. If a
          future paid feature is materially discontinued, we will provide any
          remedy required by law and otherwise aim to treat affected subscribers
          fairly.
        </p>

        <h2>12. Suspension, termination, and deletion</h2>
        <p>
          You may stop using Forma at any time and may request account deletion as
          described in the privacy policy. We may restrict or terminate access for
          a serious or repeated breach of these terms, security or fair-play risk,
          unlawful activity, non-payment, or where a platform integration requires
          us to do so. Where reasonable, we will explain the restriction and give
          an opportunity to contact us.
        </p>

        <h2>13. Disclaimers and liability</h2>
        <p>
          Forma is provided with reasonable care but, to the extent law permits,
          without a guarantee that it will always be available, error-free, or
          suitable for a particular training goal. We are not responsible for
          losses caused solely by a third-party platform outage, your breach of
          fair-play rules, or decisions made in reliance on an engine suggestion.
        </p>
        <p>
          To the extent permitted by law, Forma's aggregate liability arising from
          the service will not exceed the amount you paid Forma in the twelve
          months preceding the event giving rise to the claim. Nothing in these
          terms excludes liability that cannot legally be excluded or limits your
          mandatory consumer rights.
        </p>

        <h2>14. Governing law</h2>
        <p>
          These terms are governed by Irish law. If you are a consumer, this does
          not deprive you of mandatory protections or court rights available under
          the law of your country of residence. We encourage you to contact us
          first so we can try to resolve a concern informally.
        </p>

        <h2>15. Changes and contact</h2>
        <p>
          We may update these terms as Forma develops. The date above identifies
          the current version. If a change materially affects existing users, we
          will provide reasonable notice through the service or by email.
        </p>
        <p>
          Questions about these terms: <a href="mailto:hello@formachess.app">hello@formachess.app</a>.
          Privacy requests: <a href="mailto:privacy@formachess.app">privacy@formachess.app</a>.
        </p>

        <p className="legal-foot">
          See also our <Link to="/privacy">privacy policy</Link> and{" "}
          <Link to="/brand">brand disclosure</Link>.
        </p>
      </article>
    </PublicPage>
  );
}
