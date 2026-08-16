/* ------------------------------------------------------------------ */
/* Sound for the rook mascot.                                           */
/*                                                                      */
/* Synthesised rather than sampled. Five cues is a handful of seconds of */
/* audio, and shipping it as code means it weighs nothing, needs no      */
/* licence, and can be tuned by changing a number instead of re-cutting  */
/* a file.                                                               */
/*                                                                      */
/* The brief is a wooden chess piece on a wooden board, not a game UI.   */
/* An earlier pass built these out of clean oscillator tones on a        */
/* pentatonic scale, which is exactly what makes a sound effect read as  */
/* a jingle: real objects are not in tune, and a struck object is mostly */
/* noise. So there are only two voices here.                            */
/*                                                                      */
/*   impact() — a burst of noise through two sharp resonant peaks with   */
/*     a fast exponential decay. That is modal synthesis, more or less:  */
/*     the peaks are the body's resonances, the noise is the strike, and */
/*     the decay time is what separates wood from stone from glass. The  */
/*     peaks are deliberately not in any harmonic relation, because in a */
/*     real block they are not either.                                   */
/*                                                                      */
/*   air() — band-passed noise with the corner swept. Wind, and nothing  */
/*     else. No pitch under it.                                          */
/*                                                                      */
/* Nothing here has a hard attack; every envelope ramps in over a few    */
/* milliseconds, which is the difference between a knock and a click.    */
/* ------------------------------------------------------------------ */

export type RookSoundCue =
  | "press"
  | "success"
  | "error"
  | "spin"
  | "launch"
  | "explosion"
  | "collapse";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = false;

/** Overall level. Deliberately quiet — a mascot is not an alert. */
const LEVEL = 0.3;

export function setRookMuted(next: boolean) {
  muted = next;
  if (master && ctx) master.gain.setTargetAtTime(next ? 0 : LEVEL, ctx.currentTime, 0.02);
}

export function isRookMuted() {
  return muted;
}

/* Built on first use, which is always inside a click handler — browsers
   will not start an AudioContext any other way. */
function audio() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : LEVEL;
    master.connect(ctx.destination);

    /* Two seconds of white noise, reused by everything below. */
    const n = ctx.sampleRate * 2;
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

type ImpactOpts = {
  at?: number;
  /** The two resonances. Lower one is the body, upper one is the contact. */
  modes: [number, number];
  /** How long it rings. Wood is short: 60–140ms. */
  dur?: number;
  gain?: number;
  /** Higher is more tuned, lower is more of a thud. 6–14 reads as wood. */
  q?: number;
};

/* One struck object. Noise through two resonant peaks, decaying fast. */
function impact(o: ImpactOpts) {
  const c = audio();
  if (!c || !master || !noise) return;
  const t = c.currentTime + (o.at ?? 0);
  const dur = o.dur ?? 0.1;
  const q = o.q ?? 9;

  const src = c.createBufferSource();
  src.buffer = noise;
  /* Start at a random offset so two impacts close together are not the
     same few milliseconds of noise twice — that doubling is audible and
     is what makes repeated effects sound synthetic. */
  const off = Math.random() * 1.5;

  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(o.gain ?? 0.5, t + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  o.modes.forEach((f, i) => {
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.value = i === 0 ? q : q * 0.6;
    const g = c.createGain();
    /* Upper mode quieter and it is the one that says "hard surface". */
    g.gain.value = i === 0 ? 1 : 0.55;
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
  });

  out.connect(master);
  src.start(t, off);
  src.stop(t + dur + 0.05);
}

type AirOpts = {
  at?: number;
  dur: number;
  /** Band-pass corner over time: start, peak, end. */
  sweep: [number, number, number];
  gain?: number;
  /** Low Q is broad and windy; high Q starts to whistle. */
  q?: number;
};

function air(o: AirOpts) {
  const c = audio();
  if (!c || !master || !noise) return;
  const t = c.currentTime + (o.at ?? 0);

  const src = c.createBufferSource();
  src.buffer = noise;

  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = o.q ?? 0.7;
  bp.frequency.setValueAtTime(o.sweep[0], t);
  bp.frequency.exponentialRampToValueAtTime(o.sweep[1], t + o.dur * 0.5);
  bp.frequency.exponentialRampToValueAtTime(o.sweep[2], t + o.dur);

  /* Rolls the hiss off the top so it reads as moving air rather than
     as a noise generator. */
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5200;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.16, t + o.dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

  src.connect(bp);
  bp.connect(lp);
  lp.connect(g);
  g.connect(master);
  src.start(t, Math.random());
  src.stop(t + o.dur + 0.05);
}

/* The house sound: a piece set down on a board. Everything that makes
   contact anywhere below is a variation on this. */
const WOOD: [number, number] = [430, 1850];

export function playRookSound(cue: RookSoundCue) {
  if (!audio()) return;

  switch (cue) {
    /* One tap. Short enough that pressing and releasing does not sound
       like two separate events. */
    case "press":
      impact({ at: 0, modes: WOOD, dur: 0.085, gain: 0.5, q: 9 });
      break;

    /* Silence while it opens up — nothing is touching anything — then
       the four courses seating in the order they land. The base is
       already down, so what you hear is body, collar, crown, each a
       little lighter than the last because each is a smaller piece. */
    case "success":
      air({ at: 0.06, dur: 0.34, sweep: [300, 900, 420], gain: 0.05, q: 0.6 });
      impact({ at: 0.83, modes: [300, 1250], dur: 0.13, gain: 0.42, q: 7 });
      impact({ at: 0.87, modes: [390, 1600], dur: 0.11, gain: 0.34, q: 8 });
      impact({ at: 0.91, modes: [500, 2050], dur: 0.09, gain: 0.28, q: 9 });
      break;

    /* Two dull knocks, low and damped, the second softer. Nothing rings:
       an error sound that rings is one people learn to hate. */
    case "error":
      impact({ at: 0, modes: [190, 620], dur: 0.12, gain: 0.46, q: 5 });
      impact({ at: 0.115, modes: [155, 500], dur: 0.16, gain: 0.34, q: 4.5 });
      break;

    /* Wind, and only wind. Two passes at different heights so it moves
       rather than just sitting there, and it starts as the piece leaves
       the ground and dies as it comes back down. */
    case "spin":
      air({ at: 0.2, dur: 0.42, sweep: [320, 1500, 900], gain: 0.15, q: 0.8 });
      air({ at: 0.5, dur: 0.46, sweep: [900, 1750, 380], gain: 0.13, q: 0.7 });
      break;

    /* A scuff as the three break loose, air while they are up, and then
       each one dropping back into its socket — the main landing, and the
       lighter knock of the small bounce after it. Timings are the
       keyframes: they land at 58% of 1000ms plus a 50ms stagger, and
       bounce back down at 74%. */
    case "launch":
      impact({ at: 0, modes: [260, 1400], dur: 0.09, gain: 0.4, q: 6 });
      air({ at: 0.04, dur: 0.5, sweep: [500, 1600, 700], gain: 0.1, q: 0.9 });
      impact({ at: 0.58, modes: WOOD, dur: 0.11, gain: 0.44, q: 9 });
      impact({ at: 0.63, modes: [470, 1950], dur: 0.1, gain: 0.4, q: 9 });
      impact({ at: 0.68, modes: [400, 1700], dur: 0.12, gain: 0.46, q: 8 });
      impact({ at: 0.74, modes: WOOD, dur: 0.07, gain: 0.18, q: 10 });
      impact({ at: 0.79, modes: [470, 1950], dur: 0.06, gain: 0.16, q: 10 });
      impact({ at: 0.84, modes: [400, 1700], dur: 0.07, gain: 0.19, q: 10 });
      break;

    /* Three parts, matching the three the animation has. A low creak as
       the piece packs down; the burst, which is the only broadband thing
       in the whole set and the only one allowed to be loud; and then the
       regrowth, which is a quiet swell with no attack at all — stone
       arriving rather than stone landing — closed by the three new
       merlons seating. */
    case "explosion":
      /* the load: a knock as it takes the strain, then a low groan that
         climbs for the whole 640ms of the squeeze. High Q so it reads as
         something being wound up rather than as wind. */
      impact({ at: 0.02, modes: [90, 260], dur: 0.16, gain: 0.2, q: 3 });
      air({ at: 0.1, dur: 0.52, sweep: [120, 300, 520], gain: 0.09, q: 2.2 });
      /* the burst */
      impact({ at: 0.64, modes: [85, 500], dur: 0.34, gain: 0.62, q: 2.5 });
      air({ at: 0.64, dur: 0.46, sweep: [700, 2900, 450], gain: 0.2, q: 0.5 });
      /* the three of them going away */
      air({ at: 0.69, dur: 0.36, sweep: [1100, 1700, 600], gain: 0.08, q: 1.5 });
      /* and coming back */
      air({ at: 1.3, dur: 0.55, sweep: [170, 480, 260], gain: 0.07, q: 0.45 });
      impact({ at: 1.68, modes: [500, 2050], dur: 0.08, gain: 0.2, q: 9 });
      impact({ at: 1.74, modes: [430, 1850], dur: 0.09, gain: 0.23, q: 9 });
      impact({ at: 1.8, modes: [380, 1650], dur: 0.1, gain: 0.26, q: 8 });
      break;

    /* Seven things hitting a floor, then seven going back. The fall is
       the loud half and it is deliberately uneven — a heap does not land
       on a beat. The rebuild is the same set of contacts an octave up
       and much quieter, which is the whole trick: same material, less
       force, going the other way. */
    case "collapse":
      /* the tower gives */
      impact({ at: 0, modes: [95, 300], dur: 0.22, gain: 0.3, q: 3 });
      /* merlons off the top */
      impact({ at: 0.84, modes: [430, 1850], dur: 0.12, gain: 0.4, q: 8 });
      impact({ at: 0.9, modes: [500, 2050], dur: 0.1, gain: 0.34, q: 9 });
      impact({ at: 0.97, modes: [380, 1650], dur: 0.13, gain: 0.42, q: 8 });
      /* the crown, the collar, the body — heavier as they get lower */
      impact({ at: 1.01, modes: [240, 900], dur: 0.2, gain: 0.5, q: 5 });
      impact({ at: 1.18, modes: [200, 760], dur: 0.22, gain: 0.52, q: 4.5 });
      impact({ at: 1.35, modes: [150, 560], dur: 0.28, gain: 0.58, q: 4 });
      /* and the last of it settling */
      impact({ at: 1.44, modes: [420, 1500], dur: 0.08, gain: 0.16, q: 9 });
      /* going back up */
      impact({ at: 2.07, modes: [300, 1250], dur: 0.1, gain: 0.24, q: 8 });
      impact({ at: 2.21, modes: [390, 1600], dur: 0.09, gain: 0.22, q: 8 });
      impact({ at: 2.38, modes: [500, 2050], dur: 0.08, gain: 0.2, q: 9 });
      impact({ at: 2.58, modes: [560, 2300], dur: 0.07, gain: 0.17, q: 10 });
      impact({ at: 2.63, modes: [610, 2500], dur: 0.07, gain: 0.15, q: 10 });
      impact({ at: 2.68, modes: [660, 2700], dur: 0.06, gain: 0.14, q: 10 });
      break;
  }
}
