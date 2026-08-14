/** TEMPORARY dev preview — every mascot state on one page. */
import { useRef, type CSSProperties } from "react";
import {
  RookMascot,
  type RookCue,
  type RookHandle,
  type RookMood,
} from "../components/RookMascot";

const CUES: RookCue[] = ["press", "success", "error", "spin", "launch"];

const FILMSTRIP: { cue: RookCue; frames: number[] }[] = [
  { cue: "press", frames: [0, 70, 130, 200, 280, 370] },
  { cue: "success", frames: [0, 110, 230, 340, 460, 600, 750] },
  { cue: "error", frames: [0, 70, 150, 240, 330, 450] },
  { cue: "spin", frames: [0, 110, 240, 350, 460, 600, 780] },
  { cue: "launch", frames: [0, 110, 260, 420, 560, 760, 980, 1150] },
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
          <RookMascot ref={stage} mood="idle" size={190} label="Rook mascot" />
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
            <RookMascot mood={mood} size={120} />
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
          shape of the motion can be read without catching it live. The
          per-merlon stagger is approximated here (one constant for every
          cue), so launch frames are indicative rather than exact. */}
      <style>{`
        .rk-freeze .rk-piece,
        .rk-freeze .rk-merlon,
        .rk-freeze .rk-merlon-cap,
        .rk-freeze .rk-zzz {
          animation-play-state: paused;
          animation-delay: calc(var(--i, 0) * 60ms + var(--rk-t));
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
