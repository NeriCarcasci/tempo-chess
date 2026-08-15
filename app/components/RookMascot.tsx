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
/*   <RookMascot ref={rook} mood="idle" size={96} sound />              */
/*   rook.current?.play("success")                                      */
/*                                                                      */
/* Three structural decisions here exist entirely to serve the motion,   */
/* and none of them are obvious from the artwork:                       */
/*                                                                      */
/* 1. The crown lives in its own `.rk-head` group. Nothing about the     */
/*    drawing needs that — the animation does. A head that lags the body */
/*    by a beat and overshoots coming back is the whole of this thing's  */
/*    personality, and it is the reason it does not need a face.         */
/*                                                                      */
/* 2. Shading is a pair of rectangles clipped to each part, not a shape  */
/*    drawn to fit. Sliding them is what makes the spin read as a turn   */
/*    while the silhouette stays put. Two of them, one full piece-width  */
/*    apart, so the sweep loops with no seam.                            */
/*                                                                      */
/* 3. The crown is painted in three passes so a merlon can leave without */
/*    tearing a hole in it. See the comment at the crown below.          */
/*                                                                      */
/* All motion is CSS keyframes in app/rook.css; sound is synthesised in  */
/* app/lib/rookSound.ts. Nothing here runs per frame.                    */
/* ------------------------------------------------------------------ */
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { playRookSound } from "../lib/rookSound";

export type RookMood = "idle" | "curious" | "sleeping";
export type RookCue =
  | "press"
  | "success"
  | "error"
  | "spin"
  | "launch"
  | "explosion"
  | "collapse";
export type RookHandle = { play: (cue: RookCue) => void };

/* Long enough to cover the keyframes plus the largest per-merlon stagger.
   Kept in step with app/rook.css by hand — they are two halves of one
   thing, so a change to a duration there belongs here too. */
const CUE_MS: Record<RookCue, number> = {
  press: 380,
  success: 1050,
  error: 640,
  spin: 1250,
  launch: 1200,
  explosion: 2200,
  collapse: 3000,
};

/* The natural aspect of the artwork. `size` is the height in px. */
const VIEW_W = 280;
const VIEW_H = 350;

/* The piece spans x 52–228. A shade rect is exactly that wide, and the
   pair sit one sweep-period apart so translating by SWEEP puts the second
   exactly where the first began. */
const PIECE_W = 176;
const SHADE_X = 108 - PIECE_W; // right edge lands on the rest-state terminator
const SWEEP = PIECE_W * 2;

/* The crenellations, on a 50-unit pitch.
 *
 * Three of them are the mark. The fourth sits off the left-hand edge and
 * is not rendered at all except during a spin, where it is what lets the
 * pattern travel: shift all four by exactly one pitch and the crown looks
 * identical again, because the spare has arrived at the position the
 * left-hand merlon just left. Six of those shifts is a whole turn.
 *
 * All four travel together at a constant rate, and the crown's two side
 * walls are drawn over the top of them, so a merlon reaching an edge
 * simply passes behind the wall. That is the whole trick: the wall is
 * always there at full weight, so there is never a cut edge to see and
 * never a sliver of a merlon to catch the eye.
 *
 * `h` and `rot` are the toss: how high that merlon goes and how far it
 * turns while it is up. `fx`, `fy` and `frot` are the explosion: one
 * charge throws all three, so they share a vertical impulse and differ
 * only in how much of it went sideways. Heights differ so the three do not read as one
 * object, and every rotation is a whole number of turns so each lands
 * square. All in viewBox units — see the note on absolute units at the
 * top of app/rook.css. */
const MERLONS = [
  { id: "left",   x0: 72,  x1: 108, h: "110px", rot: "-360deg",
    fx: "-270px", fy: "0.85", frot: "-540deg",
    kx: "-52px",  ky: "204px", krot: "-125deg", spare: false },
  { id: "middle", x0: 122, x1: 158, h: "142px", rot: "720deg",
    fx: "55px",   fy: "1.4",  frot: "400deg",
    kx: "6px",    ky: "205px", krot: "150deg",  spare: false },
  { id: "right",  x0: 172, x1: 208, h: "122px", rot: "360deg",
    fx: "285px",  fy: "0.9",  frot: "560deg",
    kx: "58px",   ky: "207px", krot: "108deg",  spare: false },
  { id: "spare",  x0: 22,  x1: 58,  h: "0px",   rot: "0deg",
    fx: "0px",    fy: "1",    frot: "0deg",
    kx: "0px",    ky: "0px",   krot: "0deg",    spare: true },
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

const BODY = "M80 172 L68 272 L212 272 L200 172 Z";
const BASE =
  "M61 268 L219 268 A9 9 0 0 1 228 277 L228 304 A12 12 0 0 1 216 316 L64 316 A12 12 0 0 1 52 304 L52 277 A9 9 0 0 1 61 268 Z";

const INK = "var(--rk-ink)";
const SHELL = "var(--rk-shell)";
const SHELL_SHADE = "var(--rk-shell-shade)";

/* ------------------------------------------------------------------ */
/* Attention tracking.                                                  */
/*                                                                      */
/* One listener for the whole page rather than one per mascot: several   */
/* on a screen at once is normal, and a pointermove handler each would   */
/* be silly. Positions are batched to a frame, so a mascot costs one     */
/* getBoundingClientRect per frame while the pointer is actually moving  */
/* and nothing at all when it is still.                                  */
/*                                                                      */
/* Everything after that is CSS: the component only writes two numbers   */
/* onto the element and a transition does the easing. There is no        */
/* animation loop here.                                                  */
/* ------------------------------------------------------------------ */
type Aimer = (x: number, y: number) => void;
const aimers = new Set<Aimer>();
let aimRaf = 0;
let aimX = Number.NaN;
let aimY = Number.NaN;

function pumpAim() {
  aimRaf = 0;
  for (const f of aimers) f(aimX, aimY);
}
function onAimMove(e: PointerEvent) {
  aimX = e.clientX;
  aimY = e.clientY;
  if (!aimRaf) aimRaf = requestAnimationFrame(pumpAim);
}
/* Pointer gone from the window: look front again rather than staying
   frozen mid-glance at whatever it was last near. */
function onAimOut() {
  aimX = Number.NaN;
  aimY = Number.NaN;
  if (!aimRaf) aimRaf = requestAnimationFrame(pumpAim);
}

function subscribeAim(f: Aimer) {
  if (aimers.size === 0) {
    window.addEventListener("pointermove", onAimMove, { passive: true });
    document.addEventListener("pointerleave", onAimOut);
    window.addEventListener("blur", onAimOut);
  }
  aimers.add(f);
  return () => {
    aimers.delete(f);
    if (aimers.size === 0) {
      window.removeEventListener("pointermove", onAimMove);
      document.removeEventListener("pointerleave", onAimOut);
      window.removeEventListener("blur", onAimOut);
      if (aimRaf) cancelAnimationFrame(aimRaf);
      aimRaf = 0;
    }
  };
}

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

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
  /**
   * Play the synthesised sound for each cue. Off by default: audio needs a
   * user gesture to start, and a mascot that makes noise on a page the
   * visitor did not ask to make noise is a bug. Turn it on where the mascot
   * is reacting to something the visitor just did.
   */
  sound?: boolean;
  /**
   * Turn the head toward the pointer. Off by default — it is the one
   * thing here that costs an event listener, and a mascot that follows
   * the cursor everywhere is a lot. Worth it where the mascot is the
   * thing on the page you are meant to be looking at.
   *
   * Ignored on coarse pointers and under prefers-reduced-motion, and the
   * mascot stops noticing you entirely while it is asleep.
   */
  track?: boolean;
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
  sound = false,
  track = false,
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

  /* clipPath ids have to be unique per instance or two mascots on one page
     both resolve to whichever was parsed last. */
  const uid = useId().replace(/:/g, "");
  const clip = (part: string) => `rk-${uid}-${part}`;

  const onEnd = useRef(onCueEnd);
  onEnd.current = onCueEnd;
  const soundOn = useRef(sound);
  soundOn.current = sound;

  useImperativeHandle(
    ref,
    () => ({
      play(next: RookCue) {
        setPlayed(next);
        setRun((n) => n + 1);
        if (soundOn.current) playRookSound(next);
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

  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!track || typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = svgRef.current;
    if (!el) return;
    return subscribeAim((px, py) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      if (Number.isNaN(px)) {
        el.style.setProperty("--rk-aim-x", "0");
        el.style.setProperty("--rk-aim-y", "0");
        return;
      }
      /* How far away it still cares, scaled off its own size so a 32px
         mascot is not craning at something across the page. */
      const reach = Math.max(260, r.width * 3.5);
      const cx = r.left + r.width / 2;
      /* Measured from the collar joint, because that is the thing doing
         the turning — not from the middle of the box. */
      const cy = r.top + r.height * (152 / VIEW_H);
      el.style.setProperty("--rk-aim-x", String(clamp1((px - cx) / reach)));
      el.style.setProperty("--rk-aim-y", String(clamp1((py - cy) / reach)));
    });
    /* `run` remounts the <svg>, so the ref this closed over is stale
       after any cue plays. */
  }, [track, run]);

  const state = (controlled ? cue : played) ?? mood;

  /* The shaded side of a part: two rects a sweep apart, clipped to that
     part's own silhouette. At rest only the first is on screen, and only
     its right-hand end — which lands exactly where a hand-drawn shade
     shape would have. */
  const shade = (part: string, fill: string) => (
    <g clipPath={`url(#${clip(part)})`}>
      <g className="rk-shade">
        <rect x={SHADE_X} y={0} width={PIECE_W} height={VIEW_H} fill={fill} />
        <rect x={SHADE_X - SWEEP} y={0} width={PIECE_W} height={VIEW_H} fill={fill} />
      </g>
    </g>
  );

  return (
    <svg
      key={run}
      ref={svgRef}
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

      <defs>
        <clipPath id={clip("body")}>
          <path d={BODY} />
        </clipPath>
        <clipPath id={clip("base")}>
          <path d={BASE} />
        </clipPath>
        <clipPath id={clip("crown")}>
          <rect x="72" y="94" width="136" height="58" />
        </clipPath>
        <clipPath id={clip("collar")}>
          <rect x="60" y="144" width="160" height="34" rx="10" />
        </clipPath>
        {MERLONS.map((m) => (
          <clipPath key={m.id} id={clip(m.id)}>
            <path d={merlonFill(m.x0, m.x1)} />
          </clipPath>
        ))}
        {/* The inside face of the crown's two side walls. Merlons are
            held to it while the crown is turning, so one reaching an
            edge passes behind the wall instead of being cut off in the
            open. Off in every other state, because the launch needs the
            merlons to leave. */}
        <clipPath id={clip("band")}>
          <rect x="67.5" y="40" width="145" height="63" />
        </clipPath>
      </defs>

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

      {/* The lean is outside .rk-piece and the look is inside .rk-head,
          because both of those already carry animations of their own and
          one element cannot hold two transforms. */}
      <g className="rk-lean">
      <g className="rk-piece">
        <g className="rk-body">
          <path d={BODY} fill={SHELL} />
          {shade("body", SHELL_SHADE)}
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
          {shade("base", "var(--rk-stone-shade)")}
          <path
            d={BASE}
            stroke={INK}
            strokeWidth="9"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>

        {/* The head. Grouped so it can lag the body by a beat, which is
            where this thing's character comes from. */}
        <g className="rk-head">
        <g className="rk-look">
          {/* Three passes, so a merlon can leave without tearing the crown.
              The block's top edge goes down first and each merlon's fill
              covers the stretch it stands on — which is why that line only
              shows in the notches, and why it is already in place the moment
              a merlon launches. The block's remaining three edges go down
              last, because the merlon fills overlap the sides and would
              otherwise eat their inner half. The bottom edge is in that pass
              too: invisible behind the collar at rest, and the reason the
              crown reads as a closed block when it lifts away from it. */}
          <g className="rk-crown">
            {/* The block is in two groups with the merlons between them,
                which looks odd until you need the crown to move without
                taking the merlons with it. They are children of it, so a
                toppling crown drags merlons that have already landed
                across the floor. Splitting the block either side of them
                keeps the paint order exactly as it was — fill, top edge,
                merlons, side walls — while letting the collapse move the
                two halves and leave the merlons where they fell. */}
            <g className="rk-crown-lower">
            <rect x="72" y="94" width="136" height="58" fill={SHELL} />
            {shade("crown", SHELL_SHADE)}
            {/* Round caps, not butt. This line ends at x=72 and the side
                wall below starts at y=94, both squared off, which leaves
                a 4.5 square at each top corner covered by neither of
                them. Invisible while the merlons are seated on it, and
                a bite out of the corner the moment they are not. A round
                cap fills it and gives the drum's rim the same rounded
                corner as everything else on the piece. */}
            <path d="M72 94 L208 94" stroke={INK} strokeWidth="9" strokeLinecap="round" />
            </g>

            <g className="rk-merlons" style={{ "--rk-band": `url(#${clip("band")})` } as CSSProperties}>
              {MERLONS.map((m, i) => (
                <g
                  key={m.id}
                  className={m.spare ? "rk-merlon rk-merlon-spare" : "rk-merlon"}
                  style={
                    {
                      /* Its own pivot: the middle of its own footing, which
                         is what the toss rotates about. Passed as a variable
                         rather than set directly so the spin can repoint the
                         outer two at the crown's edges — that is where they
                         foreshorten from. A percentage origin would be no use
                         either way: it would be measured against a box the
                         clipped shade rects have blown wide open. */
                      "--rk-ox": `${(m.x0 + m.x1) / 2}px`,
                      "--i": i,
                      "--rk-h": m.h,
                      "--rk-rot": m.rot,
                      "--rk-fx": m.fx,
                      "--rk-fy": m.fy,
                      "--rk-frot": m.frot,
                      "--rk-kx": m.kx,
                      "--rk-ky": m.ky,
                      "--rk-krot": m.krot,
                    } as CSSProperties
                  }
                >
                  {/* Two nested groups, because the two things a merlon
                      does turn about different points. Flight rotates
                      about its centre of mass; growing back scales up
                      off its own footing. One element cannot carry two
                      transform origins. */}
                  <g
                    className="rk-merlon-grow"
                    style={{ "--rk-ox": `${(m.x0 + m.x1) / 2}px` } as CSSProperties}
                  >
                    <path d={merlonFill(m.x0, m.x1)} fill={SHELL} />
                    {shade(m.id, SHELL_SHADE)}
                    <path
                      d={merlonLine(m.x0, m.x1)}
                      stroke={INK}
                      strokeWidth="9"
                      strokeLinejoin="round"
                      strokeLinecap="butt"
                    />
                  {/* The bottom edge a merlon only needs once it is off the
                      crown and you can see underneath it. Hidden at rest —
                      drawn there it would be a dark line ruled across the
                      block. Faded in by the toss keyframes. */}
                    <path
                      className="rk-merlon-cap"
                      d={`M${m.x0} 98.5 L${m.x1} 98.5`}
                      stroke={INK}
                      strokeWidth="9"
                      strokeLinecap="round"
                    />
                  </g>
                </g>
              ))}
            </g>

            <g className="rk-crown-upper">
            <path
              d="M72 94 L72 152 L208 152 L208 94"
              stroke={INK}
              strokeWidth="9"
              strokeLinejoin="round"
              strokeLinecap="butt"
            />

            {/* The walls, carried on up past the crenellation and drawn
                over it. Only while turning: at rest the outer merlons'
                own outlines already stand exactly here. */}
            <path
              className="rk-crown-wall"
              d="M72 59.5 L72 96 M208 59.5 L208 96"
              stroke={INK}
              strokeWidth="9"
              strokeLinecap="butt"
            />
            </g>
          </g>
        </g>
        </g>

        <g className="rk-collar">
          <rect x="60" y="144" width="160" height="34" rx="10" fill="var(--rk-collar)" />
          {shade("collar", "var(--rk-collar-shade)")}
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
      </g>
    </svg>
  );
}
