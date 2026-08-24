/**
 * The board's voice, and the four alternatives to it.
 *
 * The original cue was a burst of white noise with its envelope written into
 * the sample buffer, which is where the harshness came from: the first frame is
 * already at full amplitude, so every move began with a step discontinuity the
 * ear hears as a click on top of the click, and broadband noise under a single
 * lowpass reads as hiss rather than as wood.
 *
 * Everything here fixes the same three things. Amplitude is shaped by a gain
 * node with a real attack, so nothing starts instantaneously. Noise is
 * band-limited rather than merely lowpassed, so it has a pitch centre instead of
 * a spectrum. And most voices pair the transient with a short pitched body that
 * falls a little, which is what a piece meeting a board actually does.
 *
 * Synthesised rather than sampled, as before: no audio assets to license, ship
 * or cache, and a voice is a dozen numbers a reader can adjust.
 */

export type Cue = "move" | "capture" | "castle" | "check" | "promote" | "end";

export interface VoiceId {
  id: "original" | "felt" | "wood" | "tock" | "whisper";
}

export type VoiceKey = VoiceId["id"];

export interface Voice {
  key: VoiceKey;
  name: string;
  blurb: string;
  play: (ac: AudioContext, cue: Cue, at: number) => void;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

interface NoiseOptions {
  gain?: number;
  /** Band centre. A centre plus a Q reads as a material; a lowpass reads as hiss. */
  freq?: number;
  q?: number;
  attack?: number;
  decay?: number;
  type?: BiquadFilterType;
}

/**
 * A band-limited noise transient.
 *
 * The envelope lives on a gain node rather than in the buffer so the attack can
 * be a ramp instead of a step. Six milliseconds is inaudible as a fade and is
 * the whole difference between "click" and "knock".
 */
function noise(
  ac: AudioContext,
  when: number,
  { gain = 0.4, freq = 900, q = 1, attack = 0.006, decay = 0.09, type = "bandpass" }: NoiseOptions,
): void {
  const frames = Math.max(1, Math.floor(ac.sampleRate * (attack + decay + 0.02)));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  // Slightly pink rather than white: a running average tilts the spectrum down
  // and takes the fizz off the top without another filter stage.
  let previous = 0;
  for (let i = 0; i < frames; i += 1) {
    const white = Math.random() * 2 - 1;
    previous = previous * 0.65 + white * 0.35;
    data[i] = previous;
  }

  const source = ac.createBufferSource();
  source.buffer = buffer;

  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;

  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(gain, when + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

  source.connect(filter).connect(amp).connect(ac.destination);
  source.start(when);
  source.stop(when + attack + decay + 0.02);
}

interface BodyOptions {
  freq: number;
  gain?: number;
  attack?: number;
  decay?: number;
  type?: OscillatorType;
  /** Where the pitch lands by the end. A small fall is what makes a thud a thud. */
  drop?: number;
}

/** A short pitched body — the weight under a transient, or a tone on its own. */
function body(
  ac: AudioContext,
  when: number,
  { freq, gain = 0.18, attack = 0.005, decay = 0.12, type = "sine", drop }: BodyOptions,
): void {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  if (drop) osc.frequency.exponentialRampToValueAtTime(Math.max(20, drop), when + decay);

  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(gain, when + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

  osc.connect(amp).connect(ac.destination);
  osc.start(when);
  osc.stop(when + attack + decay + 0.02);
}

/** The cue that plays today, kept so the alternatives can be judged against it. */
function originalKnock(
  ac: AudioContext,
  when: number,
  { gain = 0.5, cutoff = 1400, decay = 0.09 }: { gain?: number; cutoff?: number; decay?: number },
): void {
  const frames = Math.floor(ac.sampleRate * decay);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    const env = Math.pow(1 - i / frames, 2.4);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const source = ac.createBufferSource();
  source.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  const amp = ac.createGain();
  amp.gain.value = gain;
  source.connect(filter).connect(amp).connect(ac.destination);
  source.start(when);
}

function originalBlip(ac: AudioContext, when: number, freq: number, gain = 0.16, decay = 0.16): void {
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

// ---------------------------------------------------------------------------
// The voices
// ---------------------------------------------------------------------------

export const VOICES: Voice[] = [
  {
    key: "original",
    name: "Original",
    blurb: "What ships today. Here to be compared against, not chosen.",
    play(ac, cue, t) {
      switch (cue) {
        case "move":
          return originalKnock(ac, t, { gain: 0.42, cutoff: 1100, decay: 0.08 });
        case "capture":
          originalKnock(ac, t, { gain: 0.6, cutoff: 2600, decay: 0.1 });
          return originalKnock(ac, t + 0.012, { gain: 0.3, cutoff: 900, decay: 0.08 });
        case "castle":
          originalKnock(ac, t, { gain: 0.4, cutoff: 1100, decay: 0.08 });
          return originalKnock(ac, t + 0.1, { gain: 0.4, cutoff: 1100, decay: 0.08 });
        case "check":
          originalKnock(ac, t, { gain: 0.4, cutoff: 1400, decay: 0.07 });
          return originalBlip(ac, t + 0.02, 880, 0.14, 0.14);
        case "promote":
          originalBlip(ac, t, 660);
          originalBlip(ac, t + 0.09, 880);
          return originalBlip(ac, t + 0.18, 1180, 0.18, 0.22);
        case "end":
          originalBlip(ac, t, 520, 0.16, 0.3);
          originalBlip(ac, t + 0.14, 392, 0.16, 0.34);
          return originalBlip(ac, t + 0.3, 294, 0.18, 0.5);
      }
    },
  },

  {
    key: "felt",
    name: "Felt",
    blurb:
      "The quietest of the four. Almost no transient — a weighted piece set down on cloth. Disappears into a long session.",
    play(ac, cue, t) {
      switch (cue) {
        case "move":
          noise(ac, t, { gain: 0.10, freq: 420, q: 0.8, attack: 0.008, decay: 0.055 });
          return body(ac, t, { freq: 132, gain: 0.14, decay: 0.075, drop: 96 });
        case "capture":
          noise(ac, t, { gain: 0.17, freq: 620, q: 0.7, attack: 0.005, decay: 0.085 });
          body(ac, t, { freq: 150, gain: 0.17, decay: 0.1, drop: 84 });
          return body(ac, t + 0.028, { freq: 108, gain: 0.09, decay: 0.08, drop: 72 });
        case "castle":
          noise(ac, t, { gain: 0.09, freq: 420, q: 0.8, decay: 0.05 });
          body(ac, t, { freq: 132, gain: 0.12, decay: 0.07, drop: 96 });
          noise(ac, t + 0.105, { gain: 0.09, freq: 420, q: 0.8, decay: 0.05 });
          return body(ac, t + 0.105, { freq: 132, gain: 0.12, decay: 0.07, drop: 96 });
        case "check":
          noise(ac, t, { gain: 0.10, freq: 480, q: 0.8, decay: 0.055 });
          body(ac, t, { freq: 132, gain: 0.12, decay: 0.07, drop: 96 });
          return body(ac, t + 0.045, { freq: 523.25, gain: 0.07, decay: 0.24, type: "sine" });
        case "promote":
          body(ac, t, { freq: 392, gain: 0.08, decay: 0.2 });
          body(ac, t + 0.1, { freq: 523.25, gain: 0.08, decay: 0.22 });
          return body(ac, t + 0.2, { freq: 659.25, gain: 0.09, decay: 0.38 });
        case "end":
          body(ac, t, { freq: 261.63, gain: 0.1, decay: 0.5 });
          body(ac, t + 0.16, { freq: 196, gain: 0.1, decay: 0.55 });
          return body(ac, t + 0.34, { freq: 130.81, gain: 0.11, decay: 0.9 });
      }
    },
  },

  {
    key: "wood",
    name: "Wood",
    blurb:
      "A resonant board. Tuned transient over a body that falls a fifth — closest to a real set, and the most obviously 'chess' of the four.",
    play(ac, cue, t) {
      switch (cue) {
        case "move":
          noise(ac, t, { gain: 0.26, freq: 860, q: 1.6, attack: 0.004, decay: 0.07 });
          return body(ac, t, { freq: 196, gain: 0.2, decay: 0.11, drop: 124 });
        case "capture":
          noise(ac, t, { gain: 0.36, freq: 1500, q: 1.1, attack: 0.003, decay: 0.085 });
          body(ac, t, { freq: 220, gain: 0.22, decay: 0.13, drop: 110 });
          return body(ac, t + 0.03, { freq: 165, gain: 0.13, decay: 0.11, drop: 92 });
        case "castle":
          noise(ac, t, { gain: 0.24, freq: 860, q: 1.6, decay: 0.065 });
          body(ac, t, { freq: 196, gain: 0.18, decay: 0.1, drop: 124 });
          noise(ac, t + 0.115, { gain: 0.24, freq: 860, q: 1.6, decay: 0.065 });
          return body(ac, t + 0.115, { freq: 196, gain: 0.18, decay: 0.1, drop: 124 });
        case "check":
          noise(ac, t, { gain: 0.26, freq: 1000, q: 1.5, decay: 0.07 });
          body(ac, t, { freq: 196, gain: 0.18, decay: 0.1, drop: 124 });
          return body(ac, t + 0.04, { freq: 587.33, gain: 0.11, decay: 0.26, type: "triangle" });
        case "promote":
          body(ac, t, { freq: 392, gain: 0.13, decay: 0.18, type: "triangle" });
          body(ac, t + 0.095, { freq: 587.33, gain: 0.13, decay: 0.2, type: "triangle" });
          return body(ac, t + 0.19, { freq: 783.99, gain: 0.14, decay: 0.4, type: "triangle" });
        case "end":
          body(ac, t, { freq: 329.63, gain: 0.15, decay: 0.42, type: "triangle" });
          body(ac, t + 0.15, { freq: 246.94, gain: 0.15, decay: 0.48, type: "triangle" });
          return body(ac, t + 0.32, { freq: 164.81, gain: 0.16, decay: 0.85, type: "triangle" });
      }
    },
  },

  {
    key: "tock",
    name: "Tock",
    blurb:
      "No noise at all — a pitched tock with a fast fall. Clean and modern, and the only one that stays crisp on a laptop speaker.",
    play(ac, cue, t) {
      switch (cue) {
        case "move":
          return body(ac, t, { freq: 320, gain: 0.2, attack: 0.003, decay: 0.06, drop: 180 });
        case "capture":
          body(ac, t, { freq: 420, gain: 0.22, attack: 0.002, decay: 0.075, drop: 150 });
          return body(ac, t + 0.022, { freq: 210, gain: 0.12, decay: 0.07, drop: 120 });
        case "castle":
          body(ac, t, { freq: 320, gain: 0.18, decay: 0.055, drop: 180 });
          return body(ac, t + 0.1, { freq: 320, gain: 0.18, decay: 0.055, drop: 180 });
        case "check":
          body(ac, t, { freq: 320, gain: 0.18, decay: 0.055, drop: 180 });
          return body(ac, t + 0.04, { freq: 880, gain: 0.1, decay: 0.2 });
        case "promote":
          body(ac, t, { freq: 523.25, gain: 0.12, decay: 0.16 });
          body(ac, t + 0.085, { freq: 659.25, gain: 0.12, decay: 0.18 });
          return body(ac, t + 0.17, { freq: 987.77, gain: 0.13, decay: 0.34 });
        case "end":
          body(ac, t, { freq: 440, gain: 0.13, decay: 0.36 });
          body(ac, t + 0.14, { freq: 349.23, gain: 0.13, decay: 0.4 });
          return body(ac, t + 0.3, { freq: 220, gain: 0.14, decay: 0.7 });
      }
    },
  },

  {
    key: "whisper",
    name: "Whisper",
    blurb:
      "A interface tick rather than a board sound. Very short, very quiet, no low end — for people who want feedback without a chess set on the desk.",
    play(ac, cue, t) {
      switch (cue) {
        case "move":
          return noise(ac, t, { gain: 0.09, freq: 2200, q: 2.2, attack: 0.002, decay: 0.028 });
        case "capture":
          noise(ac, t, { gain: 0.13, freq: 3000, q: 1.8, attack: 0.002, decay: 0.038 });
          return noise(ac, t + 0.018, { gain: 0.06, freq: 1500, q: 2, decay: 0.03 });
        case "castle":
          noise(ac, t, { gain: 0.08, freq: 2200, q: 2.2, decay: 0.026 });
          return noise(ac, t + 0.085, { gain: 0.08, freq: 2200, q: 2.2, decay: 0.026 });
        case "check":
          noise(ac, t, { gain: 0.09, freq: 2400, q: 2.2, decay: 0.028 });
          return body(ac, t + 0.03, { freq: 1174.66, gain: 0.06, decay: 0.16 });
        case "promote":
          body(ac, t, { freq: 880, gain: 0.06, decay: 0.12 });
          return body(ac, t + 0.08, { freq: 1318.51, gain: 0.07, decay: 0.24 });
        case "end":
          body(ac, t, { freq: 659.25, gain: 0.07, decay: 0.3 });
          return body(ac, t + 0.16, { freq: 440, gain: 0.07, decay: 0.5 });
      }
    },
  },
];

export const DEFAULT_VOICE: VoiceKey = "felt";

export function voiceFor(key: string | null | undefined): Voice {
  return VOICES.find((voice) => voice.key === key) ?? VOICES.find((v) => v.key === DEFAULT_VOICE)!;
}
