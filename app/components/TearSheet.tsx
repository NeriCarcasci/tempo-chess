import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Board } from "./Board";
import { openingSlug } from "../lib/openingContent";
import type { SheetCell, SheetRow, TearSheet as Sheet } from "../lib/tearSheet";

/**
 * The tear sheet.
 *
 * Rows are the lines the player's games actually walk, columns are their own
 * move number, and colour is how their decisions went at that depth. The point
 * of the shape is that it can be read as a sentence — fine for five moves,
 * shaky at six, torn at seven — which is the one thing a tree of moves cannot
 * do for anyone who does not already read chess notation fluently.
 *
 * Nothing here shows a move. Notation lives one altitude down, in the docked
 * panel and the explorer beyond it, where the reader has asked for it.
 */

const SECTION_LABEL = {
  white: "As White",
  black: "As Black",
} as const;

/** Rows shown before the rest fold away. A screen of rows is a spreadsheet. */
const VISIBLE_ROWS = 5;

/** What a cell says when you point at it. */
function cellTitle(row: SheetRow, cell: SheetCell): string {
  const where = `${row.label} · your move ${cell.moveNo}`;
  if (cell.state === "pre") return `${where} — before this line begins`;
  if (cell.state === "blank") return `${where} — past your book`;
  const rate = Math.round((cell.failures / cell.decisions) * 100);
  return `${where} — ${cell.decisions} decisions, ${cell.failures} cost you something (${rate}%)`;
}

export function TearSheet({
  sheet,
  username,
}: {
  sheet: Sheet;
  username: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  /**
   * The cell under the cursor, so the sheet can light its column and row.
   * Reading a grid means finding "which move number is this" — a crosshair
   * answers that without the eye having to travel to the header and back.
   */
  const [hover, setHover] = useState<{ rowKey: string; moveNo: number } | null>(null);
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<{
    row: SheetRow;
    cell: SheetCell;
    color: "white" | "black";
    variation: string | null;
  } | null>(null);

  /**
   * The marker, resolved to the things the lead card and the detail panel
   * need: its row, the exact cell (variation-level when the marker names one,
   * so the boards behind it are the precise positions), and words for it.
   */
  const task = useMemo(() => {
    const m = sheet.marker;
    if (!m) return null;
    for (const section of sheet.sections) {
      const row = section.rows.find((r) => r.key === m.rowKey);
      if (!row) continue;
      const variation = m.variationKey
        ? row.variations.find((v) => v.key === m.variationKey) ?? null
        : null;
      const cell = (variation ?? row).cells[m.moveNo - 1];
      if (!cell) return null;
      return { section, row, variation, cell };
    }
    return null;
  }, [sheet]);

  const fixThis = () => {
    if (!task) return;
    if (task.variation) setOpen((prev) => new Set(prev).add(task.row.key));
    setPicked({
      row: task.row,
      cell: task.cell,
      color: task.section.color,
      variation: task.variation?.label ?? null,
    });
    // The panel docks below the sheet; bring it to the reader.
    requestAnimationFrame(() =>
      document.querySelector(".tsheet-detail")?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };

  const columns = useMemo(
    () => Array.from({ length: sheet.maxMove }, (_, i) => i + 1),
    [sheet.maxMove],
  );

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * Exactly one marker is visible at any time.
   *
   * It is computed against a variation, but variations start folded — so on a
   * folded row it surfaces to the family cell above it, and moves down to the
   * precise variation once the reader opens the row. Without this the sheet's
   * single most important square is invisible until someone thinks to unfold
   * the row it is hiding in.
   */
  const markerOn = (
    rowKey: string,
    variationKey: string | null,
    moveNo: number,
    unfolded: boolean,
  ) => {
    const m = sheet.marker;
    if (!m || m.rowKey !== rowKey || m.moveNo !== moveNo) return false;
    if (variationKey === null) return !unfolded || m.variationKey === null;
    return m.variationKey === variationKey;
  };

  const renderCells = (
    row: SheetRow,
    cells: SheetCell[],
    color: "white" | "black",
    variationKey: string | null,
    variationLabel: string | null,
    unfolded: boolean,
  ) =>
    cells.slice(0, sheet.maxMove).map((cell) => {
      const marked = markerOn(row.key, variationKey, cell.moveNo, unfolded);
      const dead = cell.state === "pre" || cell.state === "blank";
      const selected =
        picked?.row.key === row.key &&
        picked.cell.moveNo === cell.moveNo &&
        picked.variation === variationLabel;
      return (
        <button
          // The grid is one flat parent, so a family row and its variation
          // rows are siblings — a bare move number collides across them.
          key={`${variationKey ?? row.key}:${cell.moveNo}`}
          type="button"
          className={`tsheet-cell ${marked ? "is-marked" : ""} ${selected ? "is-picked" : ""} ${
            variationKey === null && cell.moveNo === row.bookDepth && cell.decisions > 0 ? "is-edge" : ""
          }`}
          data-state={cell.state}
          data-heat={cell.heat}
          disabled={dead}
          title={cellTitle(row, cell)}
          aria-label={cellTitle(row, cell)}
          onClick={() =>
            setPicked({ row, cell, color, variation: variationLabel })
          }
          onMouseEnter={() => setHover({ rowKey: variationKey ?? row.key, moveNo: cell.moveNo })}
          onFocus={() => setHover({ rowKey: variationKey ?? row.key, moveNo: cell.moveNo })}
        >
          {marked ? <span className="tsheet-pip" aria-hidden="true" /> : null}
          {/* The number only appears under the cursor: at rest the sheet is a
              picture, and on approach it becomes a readout. */}
          {cell.state === "scored" || cell.state === "thin" ? (
            <span className="tsheet-count" aria-hidden="true">{cell.failures}</span>
          ) : null}
        </button>
      );
    });

  const lines = sheet.sections.reduce((n, sec) => n + sec.rows.length, 0);
  const bookDepth = sheet.sections.reduce(
    (max, sec) => sec.rows.reduce((m, r) => Math.max(m, r.bookDepth), max),
    0,
  );
  const torn = sheet.sections.reduce(
    (n, sec) =>
      sec.rows.reduce(
        (m, r) => m + r.cells.filter((c) => c.heat === "tears").length,
        n,
      ),
    0,
  );

  return (
    <div className="tsheet">
      {/* Standing state, not a heading — the crown bar. */}
      <p className="tsheet-status" aria-label="Repertoire summary">
        <span><b>{lines}</b> lines</span>
        <span>book runs to move <b>{bookDepth}</b></span>
        <span><b>{torn}</b> torn</span>
      </p>

      {/* One task. The sheet below is the evidence for it. */}
      {task ? (
        <div className="tsheet-lead">
          <div>
            <h2>
              Your {task.row.label}
              {task.variation ? ` (${task.variation.label})` : ""} holds to move{" "}
              {task.cell.moveNo - 1}. Move {task.cell.moveNo} is where it goes.
            </h2>
            <p>
              {task.cell.failures} of {task.cell.decisions} decisions there cost you
              the thread.
            </p>
          </div>
          <button type="button" className="primary-button" onClick={fixThis}>
            Fix this
          </button>
        </div>
      ) : null}

      {sheet.sections.map((section) => (
        <section key={section.color} className="tsheet-section">
          {/* With the side gate in front there is one section, and naming it
              would repeat the breadcrumb. The head only earns its place when
              both colours share the page (previews, future views). */}
          {sheet.sections.length > 1 ? (
            <h2 className="tsheet-section-head">{SECTION_LABEL[section.color]}</h2>
          ) : null}

          <div className="tsheet-scroll">
            <div
              className="tsheet-grid"
              style={{ "--cols": sheet.maxMove } as React.CSSProperties}
              onMouseLeave={() => setHover(null)}
            >
              <div className="tsheet-corner">your move №</div>
              {columns.map((n) => (
                <div
                  key={n}
                  className={`tsheet-colhead ${hover?.moveNo === n ? "is-lit" : ""}`}
                  style={hover?.moveNo === n ? { color: "var(--color-accent)" } : undefined}
                >
                  {n}
                </div>
              ))}
              <div className="tsheet-corner tsheet-corner-end">games</div>

              {(showAll.has(section.color)
                ? section.rows
                : section.rows.filter(
                    (row, i) => i < VISIBLE_ROWS || row.key === sheet.marker?.rowKey,
                  )
              ).map((row) => {
                const unfolded = open.has(row.key);
                return [
                  <div
                    key={`${row.key}-label`}
                    className={`tsheet-rowhead ${hover?.rowKey === row.key ? "is-lit" : ""}`}
                  >
                    {row.variations.length ? (
                      <button
                        type="button"
                        className={`tsheet-unfold ${unfolded ? "is-open" : ""}`}
                        onClick={() => toggle(row.key)}
                        aria-expanded={unfolded}
                      >
                        {row.label}
                      </button>
                    ) : (
                      <span>{row.label}</span>
                    )}
                  </div>,
                  ...renderCells(row, row.cells, section.color, null, null, unfolded),
                  <div key={`${row.key}-games`} className="tsheet-rowgames">
                    {row.games}
                  </div>,

                  ...(unfolded
                    ? row.variations.flatMap((variation) => [
                        <div
                          key={`${variation.key}-label`}
                          className={`tsheet-rowhead is-variation ${hover?.rowKey === variation.key ? "is-lit" : ""}`}
                        >
                          <span>{variation.label}</span>
                        </div>,
                        ...renderCells(
                          row,
                          variation.cells,
                          section.color,
                          variation.key,
                          variation.label,
                          unfolded,
                        ),
                        <div
                          key={`${variation.key}-games`}
                          className="tsheet-rowgames is-variation"
                        >
                          {variation.games}
                        </div>,
                      ])
                    : []),
                ];
              })}
            </div>
          </div>
          {!showAll.has(section.color) && section.rows.length > VISIBLE_ROWS ? (
            <button
              type="button"
              className="tsheet-showmore"
              onClick={() => setShowAll((prev) => new Set(prev).add(section.color))}
            >
              Show{" "}
              {section.rows.length -
                section.rows.filter(
                  (row, i) => i < VISIBLE_ROWS || row.key === sheet.marker?.rowKey,
                ).length}{" "}
              quieter lines
            </button>
          ) : null}
        </section>
      ))}

      <p className="tsheet-legend">
        <span data-heat="holds" /> holds
        <span data-heat="shaky" /> shaky
        <span data-heat="tears" /> tears
        <span data-state="blank" /> you have never been this deep
      </p>

      {picked ? (
        <CellDetail
          picked={picked}
          username={username}
          onClose={() => setPicked(null)}
        />
      ) : (
        <p className="tsheet-hint">
          Pick a square to see the positions behind it.
        </p>
      )}
    </div>
  );
}

/**
 * What one cell contains, docked below the sheet rather than on another page —
 * the sheet is how you choose, so the answer belongs beside the choosing.
 *
 * This is the first altitude where a board appears. Above it the page is
 * deliberately wordless about chess; here the reader has asked a specific
 * question and gets positions, not prose.
 */
function CellDetail({
  picked,
  username,
  onClose,
}: {
  picked: {
    row: SheetRow;
    cell: SheetCell;
    color: "white" | "black";
    variation: string | null;
  };
  username: string;
  onClose: () => void;
}) {
  const { row, cell, color, variation } = picked;
  const where = variation ? `${row.label} · ${variation}` : row.label;

  // A position key is a FEN prefix, and Board throws on anything that is not
  // one. A single malformed key would otherwise take the whole page down
  // through the error boundary, so the panel drops what it cannot draw and
  // still shows everything else it knows.
  const boards = cell.nodeKeys.filter((key) => {
    const board = key.split(" ")[0] ?? "";
    return board.split("/").length === 8;
  });

  const href = (() => {
    const query = new URLSearchParams({
      username,
      color,
      family: row.family,
    });
    if (cell.nodeKeys[0]) query.set("node", cell.nodeKeys[0]);
    return `/openings/${openingSlug(row.family)}?${query}`;
  })();

  return (
    <div className="tsheet-detail">
      <div className="tsheet-detail-head">
        <div>
          <h3>
            {where} — your move {cell.moveNo}
          </h3>
          <p>
            {cell.decisions === 0
              ? "Your games have never reached this depth in this line."
              : cell.failures === 0
                ? `${cell.decisions} decisions here, none of them costly.`
                : `${cell.decisions} decisions here, ${cell.failures} cost you the thread.`}
            {cell.state === "thin"
              ? " Too few to draw a conclusion from yet."
              : ""}
          </p>
        </div>
        <button
          type="button"
          className="tsheet-detail-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {boards.length ? (
        <div className="tsheet-boards">
          {boards.map((key) => (
            <Board key={key} fen={`${key} 0 1`} size={132} flip={color === "black"} />
          ))}
        </div>
      ) : null}

      {cell.decisions > 0 ? (
        <Link to={href} className="primary-button tsheet-detail-go">
          Walk this line
        </Link>
      ) : null}
    </div>
  );
}
