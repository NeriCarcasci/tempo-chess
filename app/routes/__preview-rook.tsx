/** TEMPORARY dev preview — every mascot state on one page. */
import { useRef, type CSSProperties } from "react";
import {
  RookMascot,
  type RookCue,
  type RookHandle,
  type RookMood,
} from "../components/RookMascot";

const CUES: RookCue[] = ["press", "success", "error", "spin", "launch", "explosion", "collapse"];

const FILMSTRIP: { cue: RookCue; frames: number[] }[] = [
  { cue: "press", frames: [0, 70, 130, 200, 280, 370] },
  { cue: "success", frames: [0, 140, 300, 440, 560, 700, 860, 980] },
  { cue: "error", frames: [0, 90, 180, 290, 400, 520, 610] },
  { cue: "spin", frames: [0, 150, 300, 420, 520, 620, 720, 850, 1000, 1150] },
  { cue: "launch", frames: [0, 80, 160, 260, 350, 460, 560, 640, 720, 820, 950] },
  { cue: "explosion", frames: [0, 180, 340, 480, 570, 640, 720, 840, 990, 1160, 1400, 1700, 1950] },
  { cue: "collapse", frames: [0, 260, 420, 560, 700, 840, 980, 1140, 1350, 1700, 2000, 2200, 2400, 2600, 2800] },
];
const MOODS: { mood: RookMood; note: string }[] = [
  { mood: "idle", note: "resting — a breath, nothing more" },
  { mood: "curious", note: "perks up, looks left, looks right" },
  { mood: "sleeping", note: "listing over, breathing slow" },
];

export default function PreviewRook() {
  const stage = useRef<RookHandle>(null);

  return (
    <main className="opening-review-shell" style={{ position: "relative", zIndex: 10 }}>
      <p className="eyebrow">Dev preview</p>
      <h1 style={{ fontSize: "2.5rem", fontWeight: 650, letterSpacing: "-0.03em" }}>
        Rook mascot
      </h1>

      <section
        className="panel"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "3rem",
          flexWrap: "wrap",
          marginTop: "2rem",
          padding: "3rem",
        }}
      >
        {/* Room around it: launched merlons draw outside the SVG box. */}
        <div style={{ display: "grid", placeItems: "center", minWidth: "16rem", minHeight: "16rem" }}>
          <RookMascot ref={stage} mood="idle" size={190} sound track label="Rook mascot" />
        </div>

        <div style={{ display: "grid", gap: "0.6rem", alignContent: "start" }}>
          <p className="cap">Cues</p>
          {CUES.map((cue) => (
            <button
              key={cue}
              type="button"
              className="quiet-button"
              style={{ justifyContent: "center" }}
              onClick={() => stage.current?.play(cue)}
            >
              {cue}
            </button>
          ))}
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gap: "1.25rem",
          marginTop: "1.25rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
        }}
      >
        {MOODS.map(({ mood, note }) => (
          <div
            key={mood}
            className="panel"
            style={{ display: "grid", justifyItems: "center", gap: "0.75rem", padding: "2rem" }}
          >
            <RookMascot mood={mood} size={120} track />
            <p className="cap">{mood}</p>
            <p style={{ color: "var(--color-ink-muted)", fontSize: "0.78rem" }}>{note}</p>
          </div>
        ))}
      </section>

      <section
        className="panel"
        style={{ display: "flex", alignItems: "flex-end", gap: "2rem", marginTop: "1.25rem", padding: "2rem" }}
      >
        <p className="cap" style={{ alignSelf: "center" }}>Scale</p>
        {[24, 32, 48, 72, 120].map((s) => (
          <RookMascot key={s} mood="idle" size={s} />
        ))}
      </section>

      {/* Contact sheet. Each cue held still at a series of offsets, so the
          shape of the motion can be read without catching it live.

          These rules are deliberately unlayered — app/rook.css lives in
          @layer components, and an unlayered rule beats a layered one
          whatever its specificity, which is the only reliable way to
          override an `animation` shorthand from outside. */}
      <style>{`
        .rk-freeze .rk-piece,
        .rk-freeze .rk-head,
        .rk-freeze .rk-crown-lower,
        .rk-freeze .rk-crown-upper,
        .rk-freeze .rk-base,
        .rk-freeze .rk-body,
        .rk-freeze .rk-collar,
        .rk-freeze .rk-shade,
        .rk-freeze .rk-merlon .rk-shade,
        .rk-freeze .rk-edge,
        .rk-freeze .rk-merlon,
        .rk-freeze .rk-merlon-grow,
        .rk-freeze .rk-merlon-cap,
        .rk-freeze .rk-zzz {
          animation-play-state: paused;
          animation-delay: calc(var(--i, 0) * 50ms + var(--rk-t));
        }
        /* The crenellation carries its own start delay and repeats, so it
           needs the offset measured from where it actually begins. */
        .rk-freeze[data-state="spin"] .rk-merlon,
        .rk-freeze[data-state="spin"] .rk-merlon .rk-shade,
        .rk-freeze[data-state="spin"] .rk-edge {
          animation-delay: calc(260ms + var(--rk-t));
        }
      `}</style>
      {FILMSTRIP.map(({ cue, frames }) => (
        <section
          key={cue}
          className="panel"
          style={{ marginTop: "1.25rem", padding: "1.75rem 2rem" }}
        >
          <p className="cap">{cue}</p>
          <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
            {frames.map((t) => (
              <div key={t} style={{ display: "grid", justifyItems: "center", gap: "0.4rem" }}>
                {/* Headroom for merlons that have left the building. */}
                <div style={{ paddingTop: "5.5rem" }}>
                  <RookMascot
                    mood="idle"
                    cue={cue}
                    size={92}
                    className="rk-freeze"
                    style={{ "--rk-t": `-${t}ms` } as CSSProperties}
                  />
                </div>
                <span
                  className="metric"
                  style={{ fontSize: "0.65rem", color: "var(--color-ink-faint)" }}
                >
                  {t}ms
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
