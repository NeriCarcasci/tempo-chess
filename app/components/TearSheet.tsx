import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Board } from "./Board";
import { openingSlug } from "../lib/openingContent";
import { OTHER_ROW } from "../lib/tearSheet";
import type { SheetCell, SheetRow, TearSheet as Sheet } from "../lib/tearSheet";

/**
 * The opening sheet: one row per line in the player's repertoire.
 *
 * The row carries its name, a strip of its own moves shaded by how many were
 * mistakes, the count, and the action. Rows sort worst first, so reading down
 * the page is reading a to-do list.
 *
 * **Vocabulary rule.** Nothing here invents a word for something chess already
 * names. A `failure` in the model is a player move outside book and repertoire
 * that lost 90 centipawns or more, which is a *mistake*, so the page says
 * mistake. Earlier copy called them "decisions that cost you the thread" and
 * described lines that "hold", "tear" and can be "walked": three metaphors and
 * a private vocabulary, none of which a player could check against anything.
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

type VerdictKind = "tears" | "shaky" | "holds" | "thin";

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

/** Worst first. The product's own rule, applied to the order of the page. */
const RANK: Record<VerdictKind, number> = { tears: 0, shaky: 1, holds: 2, thin: 3 };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The last move number this line has any scored move at. */
function depthOf(cells: SheetCell[]): number {
  return cells.reduce((deepest, cell) => (cell.decisions > 0 ? cell.moveNo : deepest), 0);
}

/** What a line amounts to: a count, and the move it applies from. */
function readLine(cells: SheetCell[]): Verdict {
  const depth = depthOf(cells);
  const mistakes = cells.reduce((n, cell) => n + cell.failures, 0);
  const count = `${mistakes} ${plural(mistakes, "mistake", "mistakes")}`;

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
  return { kind: "thin", mistakes, moveNo: depth, headline: "Too few games", detail: "" };
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
  if (cell.decisions === 0) return `${at} You have never played this deep here.`;
  const moves = `${cell.decisions} ${plural(cell.decisions, "move", "moves")}`;
  if (cell.failures === 0) return `${at} None of your ${moves} here were mistakes.`;
  const thin = cell.state === "thin" ? " Too few to read yet." : "";
  return `${at} ${cell.failures} of your ${moves} here ${plural(cell.failures, "was a mistake", "were mistakes")}.${thin}`;
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
  return (
    <div className={`line-strip ${small ? "is-small" : ""}`} aria-hidden={!onPick}>
      {shown.map((cell, i) => {
        const dead = cell.state === "pre" || cell.state === "blank";
        const className = [
          "line-sq",
          markedMove === cell.moveNo ? "is-marked" : "",
          pickedMove === cell.moveNo ? "is-picked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const style = { "--i": i } as React.CSSProperties;
        if (!onPick) {
          return (
            <span
              key={cell.moveNo}
              className={className}
              data-state={cell.state}
              data-heat={cell.heat}
              style={style}
            />
          );
        }
        const title = readCell(label, cell);
        return (
          <button
            key={cell.moveNo}
            type="button"
            className={className}
            data-state={cell.state}
            data-heat={cell.heat}
            style={style}
            disabled={dead}
            title={title}
            aria-label={title}
            aria-pressed={pickedMove === cell.moveNo}
            onClick={() => onPick(cell)}
          >
            <span className="line-sq-no" aria-hidden="true">
              {cell.moveNo}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TearSheet({
  sheet,
  username,
}: {
  sheet: Sheet;
  username: string;
}) {
  /**
   * One line open at a time, starting on the one the marker names.
   *
   * A page where every row can be open at once is the spreadsheet again, one
   * scroll further down. The single open row is also what makes "the next
   * thing" a place on the page rather than a card above it.
   */
  const [open, setOpen] = useState<string | null>(sheet.marker?.rowKey ?? null);
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

  return (
    <div className="lsheet">
      <header className="lsheet-head">
        <h1>Openings</h1>
        <p className="lsheet-facts">
          <span>
            <b>{lines}</b> {plural(lines, "line", "lines")}
          </span>
          <span>
            <b>{mistakes}</b> {plural(mistakes, "mistake", "mistakes")}
          </span>
          {/* The model caps columns at `maxMove`, so a line that runs deeper
              than the sheet is drawn reports the cap. Saying "to move 12" when
              the real answer is "we stopped counting at 12" is the kind of
              number that costs a reader their trust in the other two. */}
          <span>
            deepest {depth >= sheet.maxMove ? "past" : "to"} move{" "}
            <b>{depth >= sheet.maxMove ? sheet.maxMove - 1 : depth}</b>
          </span>
        </p>
        {/* The threshold is stated, not implied. A number a player can check is
            worth more than an adjective they have to take on trust. */}
        <p className="lsheet-key">
          One square per move, darkest where you make the most mistakes. A mistake is a
          move outside your book that lost 90 centipawns or more.
        </p>
      </header>

      {sheet.sections.map((section) => (
        <Section
          key={section.color}
          section={section}
          sheet={sheet}
          username={username}
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
  username,
  named,
  open,
  setOpen,
  expanded,
  onShowAll,
}: {
  section: Sheet["sections"][number];
  sheet: Sheet;
  username: string;
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

  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);

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
            username={username}
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
  username,
  open,
  onToggle,
}: {
  row: SheetRow;
  verdict: Verdict;
  color: "white" | "black";
  maxMove: number;
  marker: Sheet["marker"];
  username: string;
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
  // "Other lines" is a bucket, not an opening, so there is nothing to drill.
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

        <Link to={practiceHref} className="line-practice" aria-label={`Practice ${row.label}`}>
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
            username={username}
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
  username,
  here,
  onPick,
}: {
  row: SheetRow;
  color: "white" | "black";
  maxMove: number;
  marker: Sheet["marker"];
  username: string;
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

  const explorerHref = (() => {
    const query = new URLSearchParams({ username, color, family: row.family });
    if (cell?.nodeKeys[0]) query.set("node", cell.nodeKeys[0]);
    return `/openings/${openingSlug(row.family)}?${query}`;
  })();

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

      {cell && cell.decisions > 0 ? (
        <Link to={explorerHref} className="secondary-button line-explore">
          Open in explorer
        </Link>
      ) : null}
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
