/* ------------------------------------------------------------------ */
/* The rook mascot.                                                     */
/*                                                                      */
/* One character, two kinds of motion. A *mood* is the resting loop it   */
/* sits in — idle, curious, sleeping — and it runs until something       */
/* changes it. A *cue* is a one-shot reaction — press, success, error,   */
/* spin, launch — that plays over the top and hands the mascot back to   */
/* its mood when it finishes.                                           */
/*                                                                      */
/*   const rook = useRef<RookHandle>(null)                              */
/*   <RookMascot ref={rook} mood="idle" size={96} />                    */
/*   rook.current?.play("success")                                      */
/*                                                                      */
/* All motion is CSS keyframes in app/rook.css, so nothing here runs on  */
/* the main thread per frame and `prefers-reduced-motion` is honoured in */
/* one place. The only job this file has is holding which cue is live.   */
/* ------------------------------------------------------------------ */
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

export type RookMood = "idle" | "curious" | "sleeping";
export type RookCue = "press" | "success" | "error" | "spin" | "launch";
export type RookHandle = { play: (cue: RookCue) => void };

/* Long enough to cover the keyframes plus the largest per-merlon stagger.
   Kept in step with app/rook.css by hand — they are two halves of one
   thing, so a change to a duration there belongs here too. */
const CUE_MS: Record<RookCue, number> = {
  press: 380,
  success: 900,
  error: 540,
  spin: 900,
  launch: 1400,
};

/* The natural aspect of the artwork. `size` is the height in px. */
const VIEW_W = 280;
const VIEW_H = 350;

/* Where each merlon goes when it is fired, as a share of its own box.
   Middle one flies highest and straightest; the outer two fan away. */
const MERLONS = [
  { id: "left", x0: 72, x1: 108, shaded: true, dx: "-130%", dy: "-215%", rot: "-280deg" },
  { id: "middle", x0: 122, x1: 158, shaded: false, dx: "8%", dy: "-265%", rot: "215deg" },
  { id: "right", x0: 172, x1: 208, shaded: false, dx: "135%", dy: "-230%", rot: "300deg" },
] as const;

/* Runs 1.5 units past the outline so it still covers the block's top edge
   where the merlon stands. Any deeper and the merlon reads as too tall the
   moment it launches and you can see the whole of it. */
const merlonFill = (x0: number, x1: number) =>
  `M${x0} 100 L${x0} 69 A5 5 0 0 1 ${x0 + 5} 64 L${x1 - 5} 64 A5 5 0 0 1 ${x1} 69 L${x1} 100 Z`;

/* Three sides only — no bottom edge, so a merlon reads as continuous with
   the block under it. Stops at 98.5, flush with the underside of the
   notch-floor stroke, or the corners show a sliver of fill. */
const merlonLine = (x0: number, x1: number) =>
  `M${x0} 98.5 L${x0} 69 A5 5 0 0 1 ${x0 + 5} 64 L${x1 - 5} 64 A5 5 0 0 1 ${x1} 69 L${x1} 98.5`;

/* The bottom edge a merlon only needs once it is off the crown and you can
   see underneath it. Hidden at rest — drawn there it would be a dark line
   ruled across the block. Faded in by the launch keyframes. */
const merlonCap = (x0: number, x1: number) => `M${x0} 98.5 L${x1} 98.5`;

const BODY = "M80 172 L68 272 L212 272 L200 172 Z";
const BODY_SHADE = "M80 172 L68 272 L108 272 L108 172 Z";
const BASE =
  "M61 268 L219 268 A9 9 0 0 1 228 277 L228 304 A12 12 0 0 1 216 316 L64 316 A12 12 0 0 1 52 304 L52 277 A9 9 0 0 1 61 268 Z";
const BASE_SHADE =
  "M61 268 A9 9 0 0 0 52 277 L52 304 A12 12 0 0 0 64 316 L108 316 L108 268 Z";
const COLLAR_SHADE =
  "M108 178 L70 178 A10 10 0 0 1 60 168 L60 154 A10 10 0 0 1 70 144 L108 144 Z";

const INK = "var(--rk-ink)";
const SHELL = "var(--rk-shell)";
const SHELL_SHADE = "var(--rk-shell-shade)";

type Props = {
  /** The resting loop. Runs until it is changed. */
  mood?: RookMood;
  /**
   * Drive the cue yourself instead of calling play(). Pass `undefined` (the
   * default) to leave the mascot in charge: play() sets the cue and clears it
   * again when the keyframes are done. Pass a value — including `null` — and
   * the component stops managing it, holds exactly what you give it, and
   * never fires onCueEnd. Useful when the cue belongs to state you already
   * have, and for holding a single frame still.
   */
  cue?: RookCue | null;
  /** Height in px; width follows the artwork's aspect. */
  size?: number;
  /** Accessible name. Omit for a decorative mascot (hidden from readers). */
  label?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<RookHandle>;
  /** Fired when a one-shot cue finishes and the mood resumes. */
  onCueEnd?: (cue: RookCue) => void;
};

export function RookMascot({
  mood = "idle",
  cue,
  size = 96,
  label,
  className,
  style,
  ref,
  onCueEnd,
}: Props) {
  const controlled = cue !== undefined;
  const [played, setPlayed] = useState<RookCue | null>(null);
  /* Bumped on every play() so the <svg> remounts. Re-running the *same* cue
     twice is otherwise a no-op — CSS will not restart an animation whose
     name has not changed, and a mascot that ignores the second click of a
     double-click is worse than one that does not animate at all. */
  const [run, setRun] = useState(0);

  const onEnd = useRef(onCueEnd);
  onEnd.current = onCueEnd;

  useImperativeHandle(
    ref,
    () => ({
      play(next: RookCue) {
        setPlayed(next);
        setRun((n) => n + 1);
      },
    }),
    [],
  );

  useEffect(() => {
    if (controlled || !played) return;
    const id = window.setTimeout(() => {
      setPlayed(null);
      onEnd.current?.(played);
    }, CUE_MS[played]);
    return () => window.clearTimeout(id);
  }, [controlled, played, run]);

  const state = (controlled ? cue : played) ?? mood;

  return (
    <svg
      key={run}
      className={className ? `rk ${className}` : "rk"}
      style={style}
      data-state={state}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={Math.round((size * VIEW_W) / VIEW_H)}
      height={size}
      fill="none"
      focusable="false"
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
    >
      {label ? <title>{label}</title> : null}

      {/* Outside .rk-piece on purpose: the z's drift on their own rather
          than riding the sleeping tilt. Hidden in every other mood. */}
      <g className="rk-sleep-marks">
        {[
          { x: 226, y: 58, s: 1 },
          { x: 244, y: 32, s: 0.78 },
          { x: 258, y: 16, s: 0.58 },
        ].map((z, i) => (
          <g key={i} transform={`translate(${z.x} ${z.y}) scale(${z.s})`}>
            <g className="rk-zzz" style={{ "--i": i } as CSSProperties}>
              <path
                d="M0 0 L13 0 L0 14 L13 14"
                stroke={INK}
                strokeWidth="4.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          </g>
        ))}
      </g>

      <g className="rk-piece">
        <g className="rk-body">
          <path d={BODY} fill={SHELL} />
          <path d={BODY_SHADE} fill={SHELL_SHADE} />
          <path
            d={BODY}
            stroke={INK}
            strokeWidth="9"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>

        <g className="rk-base">
          <path d={BASE} fill="var(--rk-stone)" />
          <path d={BASE_SHADE} fill="var(--rk-stone-shade)" />
          <path
            d={BASE}
            stroke={INK}
            strokeWidth="9"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>

        {/* Three passes, so a merlon can leave without tearing the crown.
            The block's top edge goes down first and each merlon's fill
            covers the stretch it stands on — which is why that line only
            shows in the notches, and why it is already in place the moment
            a merlon launches. The block's two side edges go down last,
            because the merlon fills overlap them and would otherwise eat
            their inner half. */}
        <g className="rk-crown">
          <rect x="72" y="94" width="136" height="58" fill={SHELL} />
          <rect x="72" y="94" width="36" height="58" fill={SHELL_SHADE} />
          <path d="M72 94 L208 94" stroke={INK} strokeWidth="9" strokeLinecap="butt" />

          {MERLONS.map((m, i) => (
            <g
              key={m.id}
              className="rk-merlon"
              style={
                {
                  "--i": i,
                  "--rk-dx": m.dx,
                  "--rk-dy": m.dy,
                  "--rk-rot": m.rot,
                } as CSSProperties
              }
            >
              <path
                d={merlonFill(m.x0, m.x1)}
                fill={m.shaded ? SHELL_SHADE : SHELL}
              />
              <path
                d={merlonLine(m.x0, m.x1)}
                stroke={INK}
                strokeWidth="9"
                strokeLinejoin="round"
                strokeLinecap="butt"
              />
              <path
                className="rk-merlon-cap"
                d={merlonCap(m.x0, m.x1)}
                stroke={INK}
                strokeWidth="9"
                strokeLinecap="round"
              />
            </g>
          ))}

          <path
            d="M72 94 L72 152 M208 94 L208 152"
            stroke={INK}
            strokeWidth="9"
            strokeLinecap="butt"
          />
        </g>

        <g className="rk-collar">
          <rect x="60" y="144" width="160" height="34" rx="10" fill="var(--rk-collar)" />
          <path d={COLLAR_SHADE} fill="var(--rk-collar-shade)" />
          <rect
            x="60"
            y="144"
            width="160"
            height="34"
            rx="10"
            stroke={INK}
            strokeWidth="9"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </svg>
  );
}
