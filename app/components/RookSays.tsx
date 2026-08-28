import { RookMascot, type RookCue, type RookMood } from "./RookMascot";

/**
 * The one place on the product where prose is allowed.
 *
 * Every hub screen is held to short lines — a label is four words, a figure
 * prints as a number and a unit, a state is one word on a chip. That rule is
 * what makes the pages readable to somebody who came here to get better at
 * chess rather than to read a report, and it has one cost: there are a handful
 * of moments where a sentence really is the right answer, and a page with no
 * sentence in it has nowhere to put them.
 *
 * So the sentences all move to one channel and the channel is the mascot. Not
 * decoration — a bubble is the product speaking in the first person, and a
 * reader can tell at a glance that this text is Forma talking rather than a
 * measurement they are supposed to decode.
 *
 * **Onboarding, and nowhere else.**
 *
 * The channel started out with four placements — onboarding, the hub's one
 * action, a miss in practice, an empty state — and that was three too many.
 * A mascot speaking is charming on a screen somebody meets once and a
 * mannerism on the screen they open every morning: a hub that greets you in
 * character every day is performing at you rather than telling you something,
 * and the effect wears off exactly as fast as the numbers under it stop
 * being new.
 *
 * Onboarding is the one place where the product genuinely is introducing
 * itself, so it is the one place the first person is earned. Everywhere else
 * the same words go on the page as a short line, or into `FigureNote`, which
 * is a modal and can hold an essay without spending any of the page on it.
 *
 * **One bubble per screen, ever.** Two on one page means one of them is a
 * measurement that has not been cut down yet.
 *
 * The screen's action is a sibling rather than a child. It used to sit inside
 * the bubble's own column, which put the one accented control on the page
 * indented under the mascot and aligned to nothing — the heading above it, the
 * button below it and the bubble between them all started at three different
 * x positions.
 *
 * The bubble takes children rather than a string so a caller can put a move
 * chip or a link inside it, which is most of why the channel is worth having:
 * "you played Bc4 instead of Nc3" is dramatically more useful when the two
 * moves are the product's own move marks.
 */
export function RookSays({
  children,
  mood = "idle",
  cue,
  size = 72,
  tone,
}: {
  children: React.ReactNode;
  mood?: RookMood;
  cue?: RookCue;
  size?: number;
  /** `good` and `bad` tint the bubble's edge only. Never its ground. */
  tone?: "good" | "bad";
}) {
  return (
    <div className={`rooksays${tone ? ` is-${tone}` : ""}`}>
      <span className="rooksays-rook" aria-hidden="true">
        <RookMascot mood={mood} cue={cue} size={size} label="" />
      </span>
      <div className="rooksays-bubble">{children}</div>
    </div>
  );
}
