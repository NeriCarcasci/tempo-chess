import { Chess } from "chess.js";
import { DEFAULT_VOICE, voiceFor, type Cue, type VoiceKey } from "./soundVoices";

/**
 * Lightweight board sound effects, synthesised with the Web Audio API so there
 * are no audio assets to license or ship. Each cue is a short percussive
 * envelope — a soft "knock" for moves, a brighter snap for captures, and so on.
 * Sound respects a global mute flag persisted in localStorage.
 */

const MUTE_KEY = "tempo-sound-muted";
const VOICE_KEY = "tempo-sound-voice";

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

export function soundVoice(): VoiceKey {
  try {
    return (localStorage.getItem(VOICE_KEY) as VoiceKey | null) ?? DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

export function setSoundVoice(key: VoiceKey): void {
  try {
    localStorage.setItem(VOICE_KEY, key);
  } catch {
    /* ignore */
  }
}

/**
 * Play one cue.
 *
 * The synthesis itself lives in `soundVoices`, one voice per palette, so the
 * board's sound is a choice a listener makes rather than a constant buried in
 * this file. `voice` is for the audition page, which needs to play a palette
 * without adopting it.
 */
export function playSound(cue: Cue, voice?: VoiceKey): void {
  if (isMuted()) return;
  const ac = audio();
  if (!ac) return;
  voiceFor(voice ?? soundVoice()).play(ac, cue, ac.currentTime);
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
