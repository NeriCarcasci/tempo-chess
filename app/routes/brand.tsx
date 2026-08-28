import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Brand assets · Forma" },
    { name: "description", content: "Official Forma identity and logo asset." },
  ];
}

export default function Brand() {
  return (
    <PublicPage>
      <section className="brand-page">
        <div className="brand-page-inner">
          <p className="early-kicker">Official identity</p>
          <h1>The mark behind the analysis.</h1>
          <p className="brand-page-lede">
            Forma is a personal chess-analysis service for completed games. Its
            rook mark represents the calm second who has already read the board.
          </p>

          <div className="brand-assets">
            <div className="brand-logo-tile">
              <img src="/forma-logo.svg" width="200" height="200" alt="Forma rook logo" />
            </div>
            <div className="brand-asset-copy">
              <h2>Square application mark</h2>
              <p>
                The official square Forma logo, prepared for platform listings
                and OAuth application directories. SVG · 200 × 200 · under 5 MB.
              </p>
              <a className="brand-download" href="/forma-logo.svg" target="_blank" rel="noreferrer">
                Open direct logo file ↗
              </a>
            </div>
          </div>

          <p className="brand-disclosure">
            <strong>Independent product.</strong> Forma is not affiliated with,
            endorsed by, or operated by Chess.com or Lichess. Their names and
            marks belong to their respective owners.
          </p>

          {/* CC BY 4.0 requires a visible credit and a link, so it is on the
              page rather than only in NOTICE. */}
          <p className="brand-disclosure">
            <strong>Credits.</strong> Forma's marks are derived from{" "}
            <a href="https://streamlinehq.com" target="_blank" rel="noreferrer">
              Streamline
            </a>
            's Plump Color icons, used and modified under{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY 4.0
            </a>
            . The pieces are Cburnett's, under CC BY-SA 3.0.
          </p>
        </div>
      </section>
    </PublicPage>
  );
}
