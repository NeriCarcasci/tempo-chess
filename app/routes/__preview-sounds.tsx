import { useEffect, useRef, useState } from "react";
import { PublicPage } from "../components/PublicShell";
import { VOICES, type Cue, type VoiceKey } from "../lib/soundVoices";
import { isMuted, playSound, setMuted, setSoundVoice, soundVoice } from "../lib/sounds";

/**
 * `/dev/sounds` — every board voice, side by side.
 *
 * A sound cannot be reviewed in a diff. This page exists so the choice is made
 * by listening: each voice plays its own cues, and a short passage plays the
 * cues in the rhythm a real game produces them, which is the only way to tell
 * an effect that is pleasant once from an effect that is pleasant four hundred
 * times.
 */

const CUES: Cue[] = ["move", "capture", "castle", "check", "promote", "end"];

/** Cue, then how long until the next one. Roughly a game's opening and a finish. */
const PASSAGE: [Cue, number][] = [
  ["move", 520],
  ["move", 480],
  ["move", 560],
  ["capture", 500],
  ["move", 440],
  ["capture", 620],
  ["castle", 700],
  ["move", 480],
  ["check", 760],
  ["move", 520],
  ["promote", 900],
  ["end", 0],
];

export default function SoundsPreview() {
  const [chosen, setChosen] = useState<VoiceKey>("felt");
  const [muted, setMutedState] = useState(false);
  const [playing, setPlaying] = useState<VoiceKey | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setChosen(soundVoice());
    setMutedState(isMuted());
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPlaying(null);
  };

  const passage = (voice: VoiceKey) => {
    stop();
    setPlaying(voice);
    let at = 0;
    PASSAGE.forEach(([cue, gap]) => {
      timers.current.push(setTimeout(() => playSound(cue, voice), at));
      at += gap;
    });
    timers.current.push(setTimeout(() => setPlaying(null), at + 400));
  };

  const choose = (voice: VoiceKey) => {
    setSoundVoice(voice);
    setChosen(voice);
    playSound("move", voice);
  };

  return (
    <PublicPage>
      <div className="gr-hero">
        <h1>Board voices</h1>
        <p>
          Every cue the board can make, in five palettes. Sound needs a gesture before a browser
          will allow it, so the first button you press may be silent — press it twice.
        </p>

        <label className="snd-mute">
          <input
            type="checkbox"
            checked={!muted}
            onChange={(event) => {
              setMuted(!event.target.checked);
              setMutedState(!event.target.checked);
            }}
          />
          Sound on
        </label>

        <div className="snd-list">
          {VOICES.map((voice) => (
            <section
              key={voice.key}
              className={`snd-voice${chosen === voice.key ? " is-chosen" : ""}`}
            >
              <div className="snd-voice-head">
                <h2>{voice.name}</h2>
                {chosen === voice.key ? <span className="tag tag-sub">In use</span> : null}
              </div>
              <p className="snd-blurb">{voice.blurb}</p>

              <div className="snd-cues">
                {CUES.map((cue) => (
                  <button
                    key={cue}
                    type="button"
                    className="snd-cue"
                    onClick={() => playSound(cue, voice.key)}
                  >
                    {cue}
                  </button>
                ))}
              </div>

              <div className="snd-actions">
                <button
                  type="button"
                  className="snd-passage"
                  onClick={() => (playing === voice.key ? stop() : passage(voice.key))}
                >
                  {playing === voice.key ? "Stop" : "Play a game"}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => choose(voice.key)}
                  disabled={chosen === voice.key}
                >
                  {chosen === voice.key ? "Chosen" : "Use this one"}
                </button>
              </div>
            </section>
          ))}
        </div>
      </div>
    </PublicPage>
  );
}
