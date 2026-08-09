import { Chess } from "chess.js";

/**
 * Lightweight board sound effects, synthesised with the Web Audio API so there
 * are no audio assets to license or ship. Each cue is a short percussive
 * envelope — a soft "knock" for moves, a brighter snap for captures, and so on.
 * Sound respects a global mute flag persisted in localStorage.
 */

const MUTE_KEY = "tempo-sound-muted";
type Cue = "move" | "capture" | "castle" | "check" | "promote" | "end";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  // Browsers suspend the context until a user gesture; resume opportunistically.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** A filtered noise burst — reads as a wooden knock/click. */
function knock(ac: AudioContext, when: number, { gain = 0.5, cutoff = 1400, decay = 0.09 }: { gain?: number; cutoff?: number; decay?: number }) {
  const frames = Math.floor(ac.sampleRate * decay);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const env = Math.pow(1 - i / frames, 2.4);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  const amp = ac.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(when);
}

/** A short sine blip — used for check / promotion accents. */
function blip(ac: AudioContext, when: number, freq: number, { gain = 0.16, decay = 0.16 }: { gain?: number; decay?: number } = {}) {
  const osc = ac.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(gain, when + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  osc.connect(amp).connect(ac.destination);
  osc.start(when);
  osc.stop(when + decay + 0.02);
}

export function playSound(cue: Cue): void {
  if (isMuted()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  switch (cue) {
    case "move":
      knock(ac, t, { gain: 0.42, cutoff: 1100, decay: 0.08 });
      break;
    case "capture":
      knock(ac, t, { gain: 0.6, cutoff: 2600, decay: 0.1 });
      knock(ac, t + 0.012, { gain: 0.3, cutoff: 900, decay: 0.08 });
      break;
    case "castle":
      knock(ac, t, { gain: 0.4, cutoff: 1100, decay: 0.08 });
      knock(ac, t + 0.1, { gain: 0.4, cutoff: 1100, decay: 0.08 });
      break;
    case "check":
      knock(ac, t, { gain: 0.4, cutoff: 1400, decay: 0.07 });
      blip(ac, t + 0.02, 880, { gain: 0.14, decay: 0.14 });
      break;
    case "promote":
      blip(ac, t, 660);
      blip(ac, t + 0.09, 880);
      blip(ac, t + 0.18, 1180, { gain: 0.18, decay: 0.22 });
      break;
    case "end":
      blip(ac, t, 520, { decay: 0.3 });
      blip(ac, t + 0.14, 392, { decay: 0.34 });
      blip(ac, t + 0.3, 294, { gain: 0.18, decay: 0.5 });
      break;
  }
}

/**
 * Classify the single legal move that turns `prevFen` into `nextFen` and play its
 * cue. If the change is not one legal move (a reset, navigation jump, or multi-ply
 * update) nothing plays — this keeps scrubbing and line-resets silent.
 */
export function playTransitionSound(prevFen: string, nextFen: string): void {
  if (isMuted() || prevFen === nextFen) return;
  let game: Chess;
  try {
    game = new Chess(prevFen);
  } catch {
    return;
  }
  const targetPlacement = nextFen.split(" ")[0];
  let matched: { flags: string } | null = null;
  for (const move of game.moves({ verbose: true }) as Array<{ from: string; to: string; promotion?: string; flags: string }>) {
    const probe = new Chess(prevFen);
    probe.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (probe.fen().split(" ")[0] === targetPlacement) {
      matched = { flags: move.flags };
      const check = probe.isCheckmate() || probe.isStalemate() ? "end" : probe.inCheck() ? "check" : null;
      if (check) return playSound(check);
      break;
    }
  }
  if (!matched) return;
  if (matched.flags.includes("p")) return playSound("promote");
  if (matched.flags.includes("k") || matched.flags.includes("q")) return playSound("castle");
  if (matched.flags.includes("c") || matched.flags.includes("e")) return playSound("capture");
  playSound("move");
}

/** SAN of the single legal move that turns prevFen into nextFen, for screen-reader announcements. */
export function moveSanBetween(prevFen: string, nextFen: string): string | null {
  let game: Chess;
  try {
    game = new Chess(prevFen);
  } catch {
    return null;
  }
  const target = nextFen.split(" ")[0];
  for (const move of game.moves({ verbose: true }) as Array<{ from: string; to: string; promotion?: string; san: string }>) {
    const probe = new Chess(prevFen);
    probe.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (probe.fen().split(" ")[0] === target) return move.san;
  }
  return null;
}
