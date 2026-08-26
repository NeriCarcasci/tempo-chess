import { useEffect, useId, useRef, useState } from "react";
import { PrimerFigure } from "./PrimerFigures";

/**
 * How Forma works, in four cards, once.
 *
 * It exists because of what the product looks like on the first morning. A
 * person connects an account, presses one button, and lands on a dashboard
 * whose every panel is waiting on an examination that takes minutes. Without
 * this, that screen reads as a product that does not work. With it, the same
 * screen reads as a product that is working — which is the truth.
 *
 * Four cards and no more. Each one answers a question somebody actually has, in
 * the order they have it:
 *
 *   1. why a whole archive rather than one game;
 *   2. what makes a mistake a mistake here;
 *   3. what arrives at the end of the first read;
 *   4. that the read is happening right now, behind this.
 *
 * The fourth is the one that does the work. It is the difference between "the
 * dashboard is broken" and "the dashboard is filling in", and it is why this
 * component takes a `live` flag rather than assuming: somebody who reads these
 * after their report is written must not be told to wait for it.
 *
 * Built on a real `<dialog>`, like `BetaForm`, so focus trapping, Escape, the
 * top layer and inert-ing the page behind it come from the platform instead of
 * from us reimplementing them slightly wrong. Escape and the backdrop both
 * close it and both count as read: this is an explanation, not a gate, and a
 * person who wants their dashboard is allowed to have it.
 *
 * ## Why the progress is a rule and not dots
 *
 * Because the product already has a way of saying "this far through", and it is
 * a bar. The strip across the top of the dashboard behind this card is the same
 * mark at a different size, so the two read as one language rather than as a
 * modal with its own carousel furniture. It also survives the reduced-motion
 * rule intact: a filled segment is legible with nothing ever animating.
 */

interface Card {
  key: string;
  title: string;
  body: string;
  /** A second paragraph, when one fact needs its own line and its own weight. */
  note?: string;
}

/** The three that are always true, whatever the run is doing. */
const CARDS: readonly Card[] = [
  {
    key: "archive",
    title: "Forma reads your whole archive, not one game",
    body:
      "Most review tools open a single game and grade it. Forma reads everything you have played and looks for what repeats: the same idea missed, the same line, the same moment in a game where things go wrong. One game is an anecdote. A few hundred is evidence.",
  },
  {
    key: "judgement",
    title: "A mistake only counts when you could have found it",
    body:
      "Every move is screened by the engine, and the ones that look decisive are searched again, deeper. Each is then checked against what players around your rating actually find in that position.",
    note:
      "So a move you had no reasonable way to see is not held against you, and a quiet move that threw the game away is not let off because the evaluation moved slowly.",
  },
  {
    key: "report",
    title: "What arrives at the end of the first read",
    body:
      "A baseline: where your games are really decided, which areas Forma had enough evidence to measure, the openings costing you the most, and the one line worth practising first.",
    note:
      "Every number says how much evidence sits behind it, including the ones that say Forma does not know yet. That is deliberate.",
  },
];

/** The fourth card, which is about right now rather than about the product. */
const RUNNING: Card = {
  key: "running",
  title: "Your first read is running now",
  body:
    "Forma is downloading your games and working through them. A small archive takes a few minutes and a large one takes longer, and it carries on whether or not this tab stays open.",
  note:
    "Your dashboard is behind this card already. The bar across the top says how far it has got, and each panel fills in as the answer to it arrives.",
};

const SETTLED: Card = {
  key: "settled",
  title: "Your games have already been read",
  body:
    "There is a report waiting for you rather than a wait. The dashboard behind this card opens on what Forma concluded, and the full write-up is one press away from it.",
};

export function Primer({
  open,
  live,
  onClose,
}: {
  open: boolean;
  /** Whether an examination is still running behind this. */
  live: boolean;
  /** Called on finish, Escape, the backdrop and the close control alike. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const ids = useId();
  const cards = [...CARDS, live ? RUNNING : SETTLED];
  const index = Math.min(step, cards.length - 1);
  const card = cards[index]!;
  const last = index >= cards.length - 1;

  // showModal()/close() are imperative by design; mirroring React state onto
  // them is the supported way to drive a <dialog>.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  // Move focus to the new heading on every step, so a screen reader hears the
  // card that just arrived rather than staying on a Next button whose label
  // never changes. `aria-live` would announce it twice.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, index]);

  const go = (to: number): void => setStep(Math.max(0, Math.min(cards.length - 1, to)));

  return (
    <dialog
      ref={ref}
      className="sheet primer"
      aria-labelledby={`${ids}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      /* Arrow keys move between cards, because four short cards read as one
         thing with a spine rather than four screens. Handled here rather than
         on the buttons so it works wherever focus happens to be inside. */
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") go(index + 1);
        if (event.key === "ArrowLeft") go(index - 1);
      }}
    >
      {/* Two columns, the same shape as the connect card a person met one
          screen ago: copy on the left, one figure on the accent ground on the
          right. It is not decoration — each figure draws the sentence beside
          it, and the panel is the reason this reads as an introduction rather
          than as a dialog box with a lot of text in it. */}
      <div className="primer-split">
      <div className="primer-left">
      {/* The progress, in the product's own mark, and across the copy column
          rather than the whole sheet. Full width, its unfilled segments ran
          over the top of the accent panel as a light grey seam, and every tone
          that reads on white reads as mud on orange. Progress belongs with the
          words it is counting anyway.

          Hidden from assistive technology because the step line at the foot
          says the same thing in words, and a reader does not want it twice. */}
      <div className="primer-rule" aria-hidden="true">
        {cards.map((entry, position) => (
          <span
            key={entry.key}
            className={position < index ? "is-past" : position === index ? "is-on" : ""}
          />
        ))}
      </div>

      <div className="sheet-body primer-body">
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <p className="cap primer-kicker">How Forma works</p>

        {/* Keyed on the card, so React replaces the subtree and the entrance
            plays again. Job: sequence, so each card lands as its own beat --
            the same job the showcase reveal names on the public site. */}
        <div className="primer-card" key={card.key}>
          <h2 id={`${ids}-title`} ref={headingRef} tabIndex={-1}>
            {card.title}
          </h2>
          <p className="primer-copy">{card.body}</p>
          {card.note ? <p className="primer-note">{card.note}</p> : null}
        </div>

        <div className="primer-foot">
          {/* The count lives down here rather than beside the kicker, where it
              shared a corner with the close control and lost its second half to
              it on a phone. It also gives the footer a left anchor, so the Back
              button arriving on card two moves nothing. */}
          <p className="primer-step">
            {String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}
          </p>

          <div className="primer-controls">
            {/* Absent on the first card rather than present and greyed: a
                control that cannot do anything is furniture, and this product's
                rule elsewhere is that something with no reason to be there is
                not drawn. */}
            {/* The same button as its neighbour, in the quieter of the two
                treatments. A smaller Back beside a full-size Next reads as a
                second-class control, and it is not one: on a four-card
                introduction, going back is as ordinary as going on. */}
            {index > 0 ? (
              <button type="button" className="secondary-button btn-lg" onClick={() => go(index - 1)}>
                Back
              </button>
            ) : null}
            <button
              type="button"
              className="primary-button btn-lg"
              onClick={() => (last ? onClose() : go(index + 1))}
            >
              {last ? (live ? "Watch it fill in" : "Open my dashboard") : "Next"}
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* Hidden from assistive technology: every figure restates the copy
          beside it, and a screen reader hearing it twice would be worse off
          than one that never sees it. Keyed on the card so the entrance plays
          again, exactly as the copy column does. */}
      <aside className="primer-aside" aria-hidden="true">
        <div className="primer-figure" key={card.key}>
          <PrimerFigure index={index} live={live} />
        </div>
      </aside>
      </div>
    </dialog>
  );
}
