import { useId, type ReactNode } from "react";
import type { Cone, PhaseAccuracy, PhaseCard } from "../lib/trajectory";
import { FigureNote } from "./FigureNote";
import { TrajectoryLine } from "./instruments";
import {
  accuracyFinding,
  coneFinding,
  coneText,
  phaseCards,
} from "../lib/trajectory";

/**
 * The trajectory: one evaluation picture across a whole archive, and a card
 * per phase underneath it.
 *
 * The picture is a row of readings, one per bin: the capsule's height is the
 * middle half of the games at that point (p25 to p75), the accent notch is
 * the median, and a dashed divider marks each phase boundary. See
 * `lib/trajectory.ts` for why the quantiles and not the median alone — the
 * short version is that the median of two hundred games is level everywhere,
 * so a line chart of it is a flat rule that reads as a broken component.
 *
 * ## Why capsules and not a smooth band
 *
 * The band was the familiar analytics mark: a filled curve between p25 and
 * p75, smoothed across bins. It smoothed away the one thing the product's own
 * mark vocabulary is built on — discrete cells. The move strip, the pattern
 * grid and the board itself all say "one square, one fact"; a bin here is one
 * fact (the published quantiles of that slice of the game), and drawing it as
 * its own capsule makes the widening a countable row of readings instead of a
 * shape a curve fit could have invented. Nothing is interpolated: every
 * capsule is exactly its bin, and hovering one states its numbers.
 *
 * ## Carrying the sample decay
 *
 * Only about a quarter of a typical archive reaches an endgame. The capsules
 * carry that themselves: opacity is the games behind the bin, so the picture
 * physically fades where the archive thins, and each card states the games
 * and the reach rate in words. The separate sample rail retired with the
 * band — a second register under the plot was furniture once the marks could
 * carry their own evidence.
 */

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * What the figure counts, written once and rendered either behind a mark or as
 * prose. Two copies would be two chances for the screen and the paper to define
 * the same picture differently.
 */
const DEFINITIONS = (
  <>
    <p>
      Every move of every game you have had read was scored by the engine, and turned into an
      expected score from your side of the board: 100% is won, 0% is lost, and level is a game
      either of you could still take.
    </p>
    <p>
      The line is the median: at each point across the game, half your games stand above it
      and half below. It passes through every measured point, and the curve between them only
      says how it travels, never adds a reading of its own.
    </p>
    <p>
      Fewer games reach the end than the start, so the later part of the line stands on less
      evidence; each phase states how many games reached it. Every phase is measured across
      its own length, which is what the dashed dividers mark.
    </p>
  </>
);

export function Trajectory({
  cone,
  accuracy = [],
  printable = false,
  compact = false,
  provenance,
  renderPhase,
  notes,
}: {
  cone: Cone;
  /**
   * Set on the published report, which is a document rather than a screen: it
   * carries exactly one control, the one that prints it, and a test holds that
   * rule. Here the definitions are set as prose so they are on the page and on
   * the paper. Everywhere else they sit behind a mark, because a returning
   * reader reads past them every time.
   */
  printable?: boolean;
  /**
   * The hub's cut of the same figure: a shorter plot, the phase legend down
   * to a name, its evidence and the one reading that earned a sentence (the
   * decisive phase's), and no caption prose at all — the definitions stay
   * behind the mark, and the findings live on the surfaces that own them.
   * The full reading is `/profile` and `/report`; the hub is a glance.
   */
  compact?: boolean;
  /**
   * How to read every figure this picture stands behind: the cohort it was
   * measured over and when it was published. It lives inside the note rather
   * than on the page, because it qualifies the figures rather than being one.
   */
  provenance?: string;
  /**
   * How often chances were taken in each phase, from the published dashboard.
   * Empty when the publication predates the phases section, and the cards say
   * so rather than deriving one.
   */
  accuracy?: readonly PhaseAccuracy[];
  /**
   * Replace a phase's legend entry with the caller's own node.
   *
   * The legend row is aligned under the plot's own segments by
   * `--phase-columns`, and that alignment is exactly what the hub's phase
   * tiles want — so rather than drawing a second row of phases under the
   * graph (two strips saying "opening, middlegame, endgame" a hundred pixels
   * apart), the hub hands its tile in here and the legend *is* the tiles.
   */
  renderPhase?: (card: PhaseCard) => ReactNode;
  /**
   * More for the note, from whoever owns the marks in the legend.
   *
   * The hub renders its phase dials *into* this figure, so the graph and the
   * three figures under it are one object with one edge — and an object with
   * one edge gets one note. Without this the hub had to hang a second `(i)`
   * under the first, and both opened on the same provenance sentence.
   */
  notes?: ReactNode;
}) {
  const uid = useId();
  const descriptionId = `cone-desc-${uid}`;

  const finding = coneFinding(cone);
  const cards = phaseCards(cone, accuracy);
  const rowFinding = accuracyFinding(cards);

  return (
    <figure className={`cone${compact ? " is-compact" : ""}`}>
      {/* `--cone-plot-share` survives from the era of the sample rail under
          the plot; the capsules carry the evidence themselves now, so the
          plot is all plot and the axis labels span the whole of it. */}
      <div
        className="cone-frame"
        style={
          {
            "--cone-plot-share": "100%",
            "--phase-columns": cards
              .map((card) => `${Math.round((card.to - card.from) * 1000)}fr`)
              .join(" "),
          } as React.CSSProperties
        }
      >
        <div className="cone-axis" aria-hidden="true">
          <span className="is-top">Won</span>
          <span className="is-level">Level</span>
          <span className="is-bottom">Lost</span>
        </div>

        {/* The plot: one line, the same mark the phase pages use, so the
            whole and the slice are one instrument. The spread behind it is a
            deep reading and is drawn only where deep reading happens. */}
        <div className="cone-plot" role="img" aria-label={finding.headline} aria-describedby={descriptionId}>
          <TrajectoryLine points={cone.points} dividers={cone.dividers} spread={!compact} />
        </div>

        {/*
          The phases, as the graph's own axis legend.

          Each phase is sized to the share of the axis it occupies, so this row
          labels the picture above it rather than restating it. It replaced
          three boxed cards that were a second layout competing with the graph:
          equal-width panels whatever the phase was worth, each carrying a
          heading, a figure, a reading, an evidence line and — three times over
          — the same paragraph about a rate nobody publishes. That absence is
          stated once now, in the figure's own caption, and the reading each
          card made is the one sentence kept here.

          `+49 points wider by the end` is gone with them. It was the figure's
          internal unit worn as a headline: nothing outside this component
          measures anything in points of expected-score spread, and a reader who
          has to be taught a unit before a number means anything is reading
          furniture. The width the band opens by is already drawn, at the only
          scale it is true at, immediately above.
        */}
        <ol
          className={`cone-phases${renderPhase ? " is-tiles" : ""}`}
          aria-label="The phases of a game, across the figure"
        >
          {cards.map((card) => {
            if (renderPhase) {
              return (
                <li key={card.phase} className="cone-phase-tile">
                  {renderPhase(card)}
                </li>
              );
            }
            // In the compact cut only the phase that earned a sentence keeps
            // one; the rest are a name and their evidence. Everywhere else
            // every phase states its reading.
            const decisive = cone.decisive?.phase === card.phase;
            return (
              <li key={card.phase} className="cone-phase">
                <b className="cap">{card.name}</b>
                {!compact || decisive ? (
                  <span className="cone-phase-reading">{card.reading}</span>
                ) : null}
                <span className="cone-phase-evidence">
                  {card.games.toLocaleString()} {card.games === 1 ? "game" : "games"} ·{" "}
                  {pct(card.reachRate)} reach it
                </span>
                {card.caution && !compact ? (
                  <span className="cone-phase-caution">{card.caution}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {compact ? (
        <figcaption className="cone-caption-compact">
          {cone.unreached.length > 0 ? (
            <p className="cone-absent">
              Your games did not reach the {cone.unreached.join(" or ")}, so that part of the
              picture is absent rather than flat.
            </p>
          ) : null}
          <div className="cone-note">
            <FigureNote title="How this figure is measured">
              {provenance ? <p>{provenance}</p> : null}
              {DEFINITIONS}
              {notes}
            </FigureNote>
          </div>
        </figcaption>
      ) : (
      <figcaption>
        <p className="cone-finding">{finding.detail}</p>
        {finding.lopsided ? <p className="cone-finding">{finding.lopsided}</p> : null}
        {rowFinding ? <p className="cone-finding">{rowFinding}</p> : null}
        {cone.unreached.length > 0 ? (
          <p className="cone-absent">
            Your games did not reach the {cone.unreached.join(" or ")}, so that part of the picture
            is absent rather than flat.
          </p>
        ) : null}
        {/* A `div`, not a `p`: `FigureNote` renders a `<dialog>`, and a dialog
            (or the heading and paragraphs inside it) is block content the HTML
            parser will not accept inside a paragraph — it closes the `<p>`
            early and every browser and React disagree about where.

            The unpublished per-phase rate is stated here, once. It used to be
            printed inside all three phase cards, which spent more of the page
            on an absence than on any figure present. */}
        <div className="cone-note">
          Expected score from your side of the board, whichever colour you had.
          {cards.some((card) => !card.accuracy)
            ? " How often you take a chance in each phase is recorded but not published to this screen yet, and Forma will not split the figures it does publish to fill the gap."
            : ""}
          {printable ? null : (
            <FigureNote title="How this figure is measured">
              {DEFINITIONS}
            </FigureNote>
          )}
        </div>
        {printable ? <div className="cone-note">{DEFINITIONS}</div> : null}
      </figcaption>
      )}
      {/* The finding in words, for a reader who is not looking at the marks.
          The old SVG carried the headline as its <title>; the capsule plot
          carries it here, ahead of the full description. */}
      <p id={descriptionId} className="sr-only">
        {finding.headline}{" "}
        {coneText(cone)}
      </p>
    </figure>
  );
}
