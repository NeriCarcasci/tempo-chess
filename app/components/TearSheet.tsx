import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Board } from "./Board";
import { FigureNote } from "./FigureNote";
import { OpeningBookPanel } from "./OpeningBookPanel";
import { lessonForFamily } from "../lib/lessons";
import { openingSlug } from "../lib/openingContent";
import { MAX_MOVE, OTHER_ROW, tallyCells } from "../lib/tearSheet";
import type { SheetCell, SheetRow, TearSheet as Sheet } from "../lib/tearSheet";
import type { OpeningExplorerCoverage } from "../lib/v1/types";

/**
 * The opening sheet: one row per line in the player's repertoire.
 *
 * The row carries its name, a strip of its own moves shaded by how many were
 * mistakes, the count, and the action. Rows sort worst first, so reading down
 * the page is reading a to-do list.
 *
 * **Vocabulary rule.** Nothing here invents a word for something chess already
 * names. A `failure` in the model is a player move a published analysis judged
 * outside the versioned tolerance, which is a *mistake*, so the page says
 * mistake and states the threshold. Earlier copy called them "decisions that
 * cost you the thread" and described lines that "hold", "tear" and can be
 * "walked": three metaphors and a private vocabulary, none of which a player
 * could check against anything.
 *
 * **The threshold changed with the source, and the page says the new one.**
 * The sheet used to read the prototype graph, which called a move a mistake
 * when it lost 90 centipawns against a stored evaluation. It now reads
 * `GET /v1/openings/explorer`, and the canonical rule is different: a move is
 * outside tolerance when it gives up more than 0.02 of expected score against
 * the best line the *same search* found (`server/src/engine/contract.ts`,
 * `TOLERANCE_RULE`). Different measurement, same word — so the number under the
 * heading names the rule it was counted by. That tolerance is versioned
 * precisely so a change of method cannot pass as a change in the player.
 *
 * **Unanalysed is not clean.** `coverage.playerDecisions` minus
 * `coverage.scoredDecisions` is how many of the player's own opening moves
 * nobody has judged. The sheet states that gap once, at the top, and no row
 * says "no mistakes" unless something was actually judged in it.
 *
 * **One fact per line.** Every row states its count and its move in the same
 * two-part shape, so only the numbers change between rows. The panel headline
 * is derived from the selected square and nothing else, which is what keeps it
 * from disagreeing with the number underneath it.
 */

const SECTION_LABEL = {
  white: "As White",
  black: "As Black",
} as const;

/** Rows shown before the rest fold away. A screen of rows is a spreadsheet. */
const VISIBLE_ROWS = 6;

type VerdictKind = "tears" | "shaky" | "holds" | "thin" | "unjudged";

interface Verdict {
  kind: VerdictKind;
  /** Mistakes across the whole line. */
  mistakes: number;
  /** Where it first stops being reliable, or the depth it reaches when it does. */
  moveNo: number;
  /** The count. */
  headline: string;
  /** Where the count applies. Empty when there is not enough to say. */
  detail: string;
}

/**
 * Worst first. The product's own rule, applied to the order of the page.
 *
 * A line nobody has analysed sorts last rather than first. It is not evidence
 * of anything yet, and floating an unknown above a measured problem would make
 * the top of the page the least informative part of it.
 */
const RANK: Record<VerdictKind, number> = { tears: 0, shaky: 1, holds: 2, thin: 3, unjudged: 4 };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The last move number this line has any scored move at. */
function depthOf(cells: SheetCell[]): number {
  return cells.reduce((deepest, cell) => (cell.decisions > 0 ? cell.moveNo : deepest), 0);
}

/**
 * What a line amounts to: a count, and the move it applies from.
 *
 * The last branch used to read "Too few games" with nothing under it, which was
 * a threshold guess wearing the voice of a finding — and it fired for two
 * unrelated situations. A line with four judged moves and a line with forty
 * moves nobody has looked at both landed there, and a reader could not tell
 * which they were being shown. Both now state the number they actually have.
 */
function readLine(cells: SheetCell[]): Verdict {
  const depth = depthOf(cells);
  const { decisions, mistakes, unjudged } = tallyCells(cells);
  const count = `${mistakes} ${plural(mistakes, "mistake", "mistakes")}`;

  // Nothing here carries a verdict. "No mistakes" would be a claim about moves
  // nobody has judged, which is the one sentence this sheet must never print.
  if (decisions === 0) {
    return {
      kind: "unjudged",
      mistakes: 0,
      moveNo: depth,
      headline: "Not analysed yet",
      detail: `${unjudged} ${plural(unjudged, "move", "moves")} waiting`,
    };
  }

  const breaks = cells.find((cell) => cell.heat === "tears" || cell.heat === "shaky");
  if (breaks) {
    return {
      kind: breaks.heat === "tears" ? "tears" : "shaky",
      mistakes,
      moveNo: breaks.moveNo,
      headline: count,
      detail: `from move ${breaks.moveNo}`,
    };
  }
  if (cells.some((cell) => cell.heat === "holds")) {
    return {
      kind: "holds",
      mistakes,
      moveNo: depth,
      headline: mistakes === 0 ? "No mistakes" : count,
      detail: `through move ${depth}`,
    };
  }
  // Judged, but no column reached the sample floor. The count is real and the
  // sample is small, so both are printed rather than replaced by an adjective.
  return {
    kind: "thin",
    mistakes,
    moveNo: depth,
    headline: count,
    detail: `in ${decisions} judged ${plural(decisions, "move", "moves")}`,
  };
}

/** The square a line opens on: the one with the most mistakes, deepest to break ties. */
function worstCell(cells: SheetCell[]): SheetCell | null {
  let best: SheetCell | null = null;
  for (const cell of cells) {
    if (cell.decisions === 0) continue;
    if (
      !best ||
      cell.failures > best.failures ||
      (cell.failures === best.failures && cell.moveNo > best.moveNo)
    ) {
      best = cell;
    }
  }
  return best;
}

/**
 * One square, in words. Used for the panel headline and the tooltip, so the
 * two can never say different things about the same square.
 */
function readCell(where: string, cell: SheetCell | null): string {
  if (!cell) return `${where}. No moves analysed yet.`;
  const at = `${where}, move ${cell.moveNo}.`;
  if (cell.state === "pre") return `${at} The line has not started yet.`;
  // Played but unjudged, and unplayed, are opposite facts that both used to
  // render as "you have never played this deep here".
  if (cell.decisions === 0 && cell.unjudged > 0) {
    const waiting = `${cell.unjudged} ${plural(cell.unjudged, "move", "moves")}`;
    return `${at} You have played ${waiting} here and none of them has been analysed yet.`;
  }
  if (cell.decisions === 0) return `${at} You have never played this deep here.`;
  const moves = `${cell.decisions} judged ${plural(cell.decisions, "move", "moves")}`;
  // The unjudged tail rides on every sentence that quotes a sample, because the
  // sample is the thing the reader is being asked to trust.
  const waiting = cell.unjudged > 0 ? ` ${cell.unjudged} more here ${plural(cell.unjudged, "is", "are")} not analysed.` : "";
  if (cell.failures === 0) return `${at} None of your ${moves} here were mistakes.${waiting}`;
  const thin = cell.state === "thin" ? " Too few to read yet." : "";
  return `${at} ${cell.failures} of your ${moves} here ${plural(cell.failures, "was a mistake", "were mistakes")}.${thin}${waiting}`;
}

/**
 * The move strip: the row's own picture of where its mistakes are.
 *
 * Presentational while the row is closed, and the same squares become buttons
 * once it opens. A closed row is a count you scan; an open row is an instrument
 * you point at. Making every square on the page pressable at rest is what made
 * the old sheet read as a spreadsheet.
 */
export function MoveStrip({
  cells,
  maxMove,
  label,
  markedMove,
  pickedMove,
  onPick,
  small,
}: {
  cells: SheetCell[];
  maxMove: number;
  label: string;
  markedMove?: number | null;
  pickedMove?: number | null;
  onPick?: (cell: SheetCell) => void;
  small?: boolean;
}) {
  const shown = cells.slice(0, maxMove);
  /**
   * The row's own worst move sets the height.
   *
   * One scale across the whole sheet was the first attempt, on the argument
   * that a bar should mean the same trouble in the Scotch as in the Alekhine.
   * It does not survive real data: one line with forty-six mistakes on a move
   * flattens every other row on the page to a two-pixel stub, and the reader
   * loses the only question these bars are here to answer - which move in
   * *this* line goes wrong. The cross-row comparison is already carried, in
   * words, by the mistake count beside the strip and by the order of the
   * rows, which is worst first.
   */
  const top = Math.max(1, ...shown.map((cell) => cell.failures));

  return (
    <div className={`movebars ${small ? "is-small" : ""}`} aria-hidden={!onPick}>
      {shown.map((cell, i) => {
        const dead = cell.state === "pre" || cell.state === "blank";
        const className = [
          "movebar",
          markedMove === cell.moveNo ? "is-marked" : "",
          pickedMove === cell.moveNo ? "is-picked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const style = {
          "--i": i,
          "--h": `${Math.min(100, (cell.failures / top) * 100)}%`,
        } as React.CSSProperties;

        const body = (
          <>
            <span className="movebar-fill" aria-hidden="true" />
            {onPick ? (
              <span className="movebar-no" aria-hidden="true">
                {cell.moveNo}
              </span>
            ) : null}
          </>
        );

        if (!onPick) {
          return (
            <span key={cell.moveNo} className={className} data-state={cell.state} style={style}>
              {body}
            </span>
          );
        }
        const title = readCell(label, cell);
        return (
          <button
            key={cell.moveNo}
            type="button"
            className={className}
            data-state={cell.state}
            style={style}
            disabled={dead}
            title={title}
            aria-label={title}
            aria-pressed={pickedMove === cell.moveNo}
            onClick={() => onPick(cell)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}


/**
 * Practice, and the one thing the reader has to be told about it.
 *
 * The control still goes to `/train`, which is a working screen and the only
 * per-line drill the product has. What it is *not* is a `/v1` surface:
 * `/train` builds its lines from the prototype's `GET /opening-explorer`, which
 * reads the observation table this sheet has stopped reading and which counts a
 * mistake at 90 centipawns.
 *
 * So the sheet says so. Pointing at it silently would carry a reader straight
 * from a number counted one way into a drill selected another way, under one
 * word — which is the exact confusion this page's threshold line exists to
 * prevent. Disabling it would be worse: it works, and a switched-off control on
 * a feature that exists is its own kind of lie.
 *
 * `/v1` has three practice routes — the queue, an attempt and a refill — and
 * none of them takes an opening. `POST /v1/practice/refill` mints drills from
 * the whole account's recent mistakes, so there is nothing on `/v1` to point a
 * per-line control at yet. When there is, this note goes and the link changes;
 * nothing else about the row has to.
 */
const PRACTICE_SOURCE =
  "Practice still builds its lines from the older opening graph, which counted a mistake at 90 centipawns rather than against the tolerance above. It drills the same openings; it does not pick them by the same measurement.";

export function TearSheet({
  sheet,
  coverage,
  openFamily = null,
}: {
  sheet: Sheet;
  /** From `GET /v1/openings/explorer`. The gap in it is stated, not hidden. */
  coverage: OpeningExplorerCoverage;
  /** The line `/openings/:familySlug` names. Opens instead of the marker's. */
  openFamily?: string | null;
}) {
  /**
   * One line open at a time, starting on the one the URL names and otherwise on
   * the one the marker does.
   *
   * A page where every row can be open at once is the spreadsheet again, one
   * scroll further down. The single open row is also what makes "the next
   * thing" a place on the page rather than a card above it.
   *
   * The URL wins over the marker: somebody who followed a link to a line has
   * already said which one they came for, and opening a different row would
   * answer a question they did not ask.
   */
  const [open, setOpen] = useState<string | null>(() => {
    const named = openFamily
      ? sheet.sections.flatMap((section) => section.rows).find((row) => row.family === openFamily)
      : null;
    return named?.key ?? sheet.marker?.rowKey ?? null;
  });
  const [showAll, setShowAll] = useState<Set<string>>(new Set());

  const lines = sheet.sections.reduce((n, section) => n + section.rows.length, 0);
  const depth = sheet.sections.reduce(
    (max, section) => section.rows.reduce((m, row) => Math.max(m, row.bookDepth), max),
    0,
  );
  const mistakes = sheet.sections.reduce(
    (n, section) =>
      section.rows.reduce(
        (m, row) => m + row.cells.reduce((k, cell) => k + cell.failures, 0),
        n,
      ),
    0,
  );

  // The API's own two numbers, not a threshold guess about them. `scored` is
  // the caller's opening decisions a published analysis judged; `decided` is
  // all of them, analysed or not. The difference is games nothing has looked
  // at, and it is the denominator behind every figure above.
  const scored = coverage.scoredDecisions;
  const decided = coverage.playerDecisions;
  const waiting = Math.max(0, decided - scored);

  return (
    <div className="lsheet">
      {/* No heading here.
          The route above prints "Your lines" and this printed "Openings"
          directly under it, at the same size, giving one screen two names and
          restating the nav tab. The component owns rows; the route owns the
          page. What survives is the method note, which belongs to the rows. */}
      <div className="lsheet-note">
          <FigureNote title="How this page counts">
            <p>
              <b>{lines}</b> {plural(lines, "line", "lines")}, <b>{mistakes}</b>{" "}
              {plural(mistakes, "mistake", "mistakes")}, deepest{" "}
              {depth >= MAX_MOVE ? "past" : "to"} move{" "}
              <b>{depth >= MAX_MOVE ? MAX_MOVE : depth}</b>. The model stops counting at
              move {MAX_MOVE}, so a line that runs deeper reports the cap rather than a
              depth it did not measure.
            </p>
            <p>
              One bar per move, tallest where you make the most mistakes, on one scale
              across every line here. A mistake is a move Forma's published analysis judged
              outside tolerance: it gave up more than 0.02 of expected score against the
              best line the same search found.
            </p>
            <p>
              {decided === 0 ? (
                "None of your opening moves have been analysed yet, so nothing here is a verdict."
              ) : waiting === 0 ? (
                <>
                  All <b>{decided}</b> of your opening moves in these games have been
                  analysed.
                </>
              ) : (
                <>
                  <b>{scored}</b> of your <b>{decided}</b> opening moves have been analysed.
                  The other <b>{waiting}</b> are counted as unanalysed, never as moves that
                  went well
                  {coverage.unanalysedGames > 0
                    ? ` (${coverage.unanalysedGames} ${plural(coverage.unanalysedGames, "game is", "games are")} still waiting)`
                    : ""}
                  .
                </>
              )}
            </p>
        </FigureNote>
      </div>

      {sheet.sections.map((section) => (
        <Section
          key={section.color}
          section={section}
          sheet={sheet}
          named={sheet.sections.length > 1}
          open={open}
          setOpen={setOpen}
          expanded={showAll.has(section.color)}
          onShowAll={() => setShowAll((prev) => new Set(prev).add(section.color))}
        />
      ))}
    </div>
  );
}

function Section({
  section,
  sheet,
  named,
  open,
  setOpen,
  expanded,
  onShowAll,
}: {
  section: Sheet["sections"][number];
  sheet: Sheet;
  named: boolean;
  open: string | null;
  setOpen: (key: string | null) => void;
  expanded: boolean;
  onShowAll: () => void;
}) {
  const marked = sheet.marker?.rowKey ?? null;

  /**
   * The marked line first, then worst first, catch-all last.
   *
   * The model orders rows by how often a line is played, which is the right
   * order for an archive and the wrong one for a page whose job is to say what
   * to fix. A line you play forty times and never go wrong in is not the first
   * thing you should read.
   *
   * Inside a severity the tie-break is total mistakes, not how early the line
   * gives out: ranking by earliness floats a nine-game line that wobbled at
   * move 3 over the sixty-game line that is actually bleeding. It is also the
   * rule the marker itself uses, so the row at the top and the square it names
   * never disagree.
   */
  const rows = useMemo(() => {
    const ranked = section.rows.map((row) => ({ row, verdict: readLine(row.cells) }));
    return ranked.sort((left, right) => {
      if (left.row.key === marked) return -1;
      if (right.row.key === marked) return 1;
      if (left.row.family === OTHER_ROW) return 1;
      if (right.row.family === OTHER_ROW) return -1;
      const byKind = RANK[left.verdict.kind] - RANK[right.verdict.kind];
      if (byKind !== 0) return byKind;
      if (left.verdict.mistakes !== right.verdict.mistakes) {
        return right.verdict.mistakes - left.verdict.mistakes;
      }
      return right.row.games - left.row.games;
    });
  }, [section.rows, marked]);

  /**
   * The open row is always drawn, even when it falls past the fold.
   *
   * A link to `/openings/:familySlug` opens a row that the worst-first ordering
   * may have put eighth, and without this the page would arrive with its answer
   * folded away behind "Show all".
   */
  const shown = useMemo(() => {
    if (expanded) return rows;
    const head = rows.slice(0, VISIBLE_ROWS);
    if (open === null || head.some(({ row }) => row.key === open)) return head;
    const opened = rows.find(({ row }) => row.key === open);
    return opened ? [...head, opened] : head;
  }, [rows, expanded, open]);

  return (
    <section className="lsheet-section">
      {named ? <h2 className="lsheet-section-head">{SECTION_LABEL[section.color]}</h2> : null}

      <ul className="line-list">
        {shown.map(({ row, verdict }) => (
          <LineRow
            key={row.key}
            row={row}
            verdict={verdict}
            color={section.color}
            maxMove={sheet.maxMove}
            marker={sheet.marker?.rowKey === row.key ? sheet.marker : null}
            open={open === row.key}
            onToggle={() => setOpen(open === row.key ? null : row.key)}
          />
        ))}
      </ul>

      {rows.length > shown.length ? (
        <button type="button" className="line-showmore" onClick={onShowAll}>
          Show all {rows.length}
        </button>
      ) : null}
    </section>
  );
}

/**
 * One line.
 *
 * The header is two siblings, never nested: a disclosure button carrying the
 * name, strip and count, and the Practice link beside it. Putting the link
 * inside the button would be the one thing that breaks both the keyboard and
 * the pointer at once.
 */
function LineRow({
  row,
  verdict,
  color,
  maxMove,
  marker,
  open,
  onToggle,
}: {
  row: SheetRow;
  verdict: Verdict;
  color: "white" | "black";
  maxMove: number;
  marker: Sheet["marker"];
  open: boolean;
  onToggle: () => void;
}) {
  /**
   * The square the line opens on.
   *
   * When the sheet has marked this row, that square wins: the marker is
   * computed at variation level and the row's own worst square at family
   * level, so they can name different moves. Opening on the family's worst
   * would then ring one square and select another, and the reader would have
   * to work out which of the two the page meant.
   */
  const opensOn = useMemo(() => {
    if (marker) {
      const variation = marker.variationKey
        ? row.variations.find((v) => v.key === marker.variationKey) ?? null
        : null;
      const cell = (variation ?? row).cells[marker.moveNo - 1];
      if (cell) return { cell, variation: variation?.label ?? null };
    }
    const worst = worstCell(row.cells);
    return worst ? { cell: worst, variation: null } : null;
  }, [marker, row]);

  const [picked, setPicked] = useState<{ cell: SheetCell; variation: string | null } | null>(null);
  const here = picked ?? opensOn;

  const panelId = `line-panel-${openingSlug(row.family)}-${color}`;
  // The row's own sample, so a reader can weigh its verdict without scrolling
  // back to the account-wide figure at the top.
  const waiting = tallyCells(row.cells).unjudged;
  // "Other lines" is a bucket, not an opening, so there is nothing to drill in
  // particular — the trainer gets the side and picks for itself.
  const practiceHref =
    row.family === OTHER_ROW
      ? `/train?color=${color}`
      : `/train?color=${color}&family=${encodeURIComponent(row.family)}`;

  return (
    <li className={`line-row ${open ? "is-open" : ""} ${marker ? "is-next" : ""}`}>
      <div className="line-head">
        <button
          type="button"
          className="line-open"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="line-name">
            <span className="line-caret" aria-hidden="true" />
            <span className="line-title">
              <strong>{row.label}</strong>
              <small>
                {row.games} {plural(row.games, "game", "games")}
                {row.variations.length ? ` · ${row.variations.length} variations` : ""}
                {waiting > 0 ? ` · ${waiting} unanalysed` : ""}
              </small>
            </span>
          </span>

          <MoveStrip
            cells={row.cells}
            maxMove={maxMove}
            label={row.label}
            markedMove={marker?.moveNo ?? null}
          />

          {/* Two facts in one shape on every row, so only the numbers change. */}
          <span className="line-count" data-kind={verdict.kind}>
            <strong>{verdict.headline}</strong>
            {verdict.detail ? <small>{verdict.detail}</small> : null}
          </span>
        </button>

        {/* The action, in its own slot beside the disclosure rather than
            inside it. The accessible name carries what the drill is built
            from, because a reader who tabs straight to this control never
            passes the note in the header. */}
        <Link
          to={practiceHref}
          className="line-practice"
          aria-label={`Practice ${row.label}. ${PRACTICE_SOURCE}`}
          title={PRACTICE_SOURCE}
        >
          Practice
        </Link>
      </div>

      <div className="line-panel" id={panelId} hidden={!open}>
        {open ? (
          <LinePanel
            row={row}
            color={color}
            maxMove={maxMove}
            marker={marker}
            here={here}
            onPick={setPicked}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * What is inside a line: the selected square in words, the positions behind it,
 * and the variations underneath.
 *
 * The headline is derived from the selected square alone. An earlier version
 * headlined the line's verdict and then printed the selected square's numbers
 * below it, which put two different move numbers three lines apart.
 *
 * This is the first altitude where a board appears. Above it the page is
 * deliberately wordless about chess; here the reader has asked a specific
 * question and gets positions, not prose.
 */
function LinePanel({
  row,
  color,
  maxMove,
  marker,
  here,
  onPick,
}: {
  row: SheetRow;
  color: "white" | "black";
  maxMove: number;
  marker: Sheet["marker"];
  here: { cell: SheetCell; variation: string | null } | null;
  onPick: (picked: { cell: SheetCell; variation: string | null }) => void;
}) {
  const cell = here?.cell ?? null;
  const where = here?.variation ? `${row.label}, ${here.variation}` : row.label;

  // A position key is a FEN prefix, and Board throws on anything that is not
  // one. A single malformed key would otherwise take the whole page down
  // through the error boundary, so the panel drops what it cannot draw and
  // still shows everything else it knows.
  //
  // Two positions, not three. A third board at this size stops being a
  // position and becomes a picture of one.
  const boards = (cell?.nodeKeys ?? [])
    .filter((key) => {
      const board = key.split(" ")[0] ?? "";
      return board.split("/").length === 8;
    })
    .slice(0, 2);

  // The walk, on the same screen, one route deeper. No username in the URL:
  // `/v1` resolves the subject from the access token, and a handle in a link
  // was exactly the thing that let one person's page name another's games.
  const walkHref = `/openings/${openingSlug(row.family)}?color=${color}`;

  // Written prose about this line, when somebody has written some. It sits in
  // the open panel rather than the row header: thirteen of the openings a
  // player might have have a lesson and the rest do not, and a control that
  // appears on some rows and not others turns the header into a place you have
  // to read rather than scan.
  const lesson = lessonForFamily(row.family, color);

  // The worst position behind the selected square, and the move order that
  // reaches it. Both come from the same sorted list in `buildCells`, so the
  // book is always asked about the board on screen.
  const bookPosition = cell?.nodeKeys[0] ?? null;
  const bookLine = cell?.nodeLines[0] ?? "";

  const strip = here?.variation
    ? row.variations.find((v) => v.label === here.variation)?.cells ?? row.cells
    : row.cells;

  // The marker belongs to one level of the line. Showing its ring on whichever
  // strip happens to be on screen would claim a square the marker never named.
  const markedVariation = marker?.variationKey
    ? row.variations.find((v) => v.key === marker.variationKey)?.label ?? null
    : null;
  const markedHere = Boolean(marker) && (here?.variation ?? null) === markedVariation;

  return (
    <div className="line-panel-inner">
      <div className="line-readout">
        <h3>{readCell(where, cell)}</h3>
      </div>

      <div className="line-instrument">
        <MoveStrip
          cells={strip}
          maxMove={maxMove}
          label={where}
          markedMove={markedHere ? marker?.moveNo ?? null : null}
          pickedMove={cell?.moveNo ?? null}
          onPick={(next) => onPick({ cell: next, variation: here?.variation ?? null })}
        />
      </div>

      {boards.length ? (
        <div className="line-boards">
          {boards.map((key) => (
            <Board key={key} fen={`${key} 0 1`} size={142} flip={color === "black"} />
          ))}
        </div>
      ) : null}

      {row.variations.length ? (
        <div className="line-variations">
          <p className="cap">Variations</p>
          <ul>
            <VariationRow
              label="Whole line"
              games={row.games}
              cells={row.cells}
              maxMove={maxMove}
              active={here?.variation == null}
              onSelect={() => {
                const worst = worstCell(row.cells);
                if (worst) onPick({ cell: worst, variation: null });
              }}
            />
            {row.variations.map((variation) => (
              <VariationRow
                key={variation.key}
                label={variation.label}
                games={variation.games}
                cells={variation.cells}
                maxMove={maxMove}
                active={here?.variation === variation.label}
                onSelect={() => {
                  const worst = worstCell(variation.cells);
                  if (worst) onPick({ cell: worst, variation: variation.label });
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {/* The other half of the loop. The sheet has said which square costs the
          most; the book says what the line is called, what it plays here, and
          which of the reader's own moves left it. Keyed on the position so
          picking a different square asks a different question rather than
          leaving the old answer on screen under a new heading. */}
      {bookPosition ? (
        <OpeningBookPanel key={bookPosition} position={bookPosition} line={bookLine} />
      ) : null}

      <div className="line-panel-actions">
        {cell && (cell.decisions > 0 || cell.unjudged > 0) ? (
          <Link to={walkHref} className="secondary-button">
            Walk this line
          </Link>
        ) : null}
        {lesson ? (
          <Link to={`/lessons/${lesson.slug}`} className="secondary-button">
            Read the lesson
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function VariationRow({
  label,
  games,
  cells,
  maxMove,
  active,
  onSelect,
}: {
  label: string;
  games: number;
  cells: SheetCell[];
  maxMove: number;
  active: boolean;
  onSelect: () => void;
}) {
  const verdict = readLine(cells);
  return (
    <li>
      <button
        type="button"
        className={`line-variation ${active ? "is-active" : ""}`}
        aria-pressed={active}
        onClick={onSelect}
      >
        <span className="line-variation-name">{label}</span>
        <MoveStrip cells={cells} maxMove={maxMove} label={label} small />
        <span className="line-variation-count" data-kind={verdict.kind}>
          {verdict.headline}
        </span>
        <span className="line-variation-games">
          {games} {plural(games, "game", "games")}
        </span>
      </button>
    </li>
  );
}
