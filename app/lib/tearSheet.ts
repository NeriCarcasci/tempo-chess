import { openingFamily } from "./openingFamily";
import type { OpeningGraph } from "./openings";

/**
 * The tear sheet: the player's opening skill as a grid.
 *
 * Rows are the lines their repertoire actually walks, columns are their own
 * move number, and a cell pools every engine-scored decision they made at that
 * depth in that line. The reading it has to produce is a sentence: "fine for
 * five moves in the Sicilian, shaky at six, and move seven is where it tears."
 *
 * Depth is the axis because that is where opening mistakes cluster. A player
 * is not bad at the Sicilian — they are fine until their book runs out, and
 * the column where the colour breaks is the thing no game-by-game review can
 * show them.
 */

/** Decisions a cell needs before its colour means anything. */
export const FLOOR_COLOR = 5;
/** Failure rates at which a cell turns. Tuned by eye, not by theory. */
const TEARS_AT = 0.25;
const SHAKY_AT = 0.12;
/** Families below this many games fold into one quiet row per section. */
const MIN_ROW_GAMES = 2;
/**
 * Columns never run past here, however deep the book goes.
 *
 * Exported because the sheet's own method note has to compare a measured depth
 * against the real cap. It used to compare against `sheet.maxMove`, which is
 * derived from the deepest line on the sheet - so for any repertoire reaching
 * move 8 the test was always true, the note always claimed the model had hit
 * its cap, and it always reported a depth one move short of the truth.
 */
export const MAX_MOVE = 12;
const MIN_MOVE_SPAN = 8;
/** Positions kept per cell for the detail panel. */
const MAX_CELL_POSITIONS = 3;

export type CellState = "scored" | "thin" | "unjudged" | "blank" | "pre";
export type CellHeat = "holds" | "shaky" | "tears";

export interface SheetCell {
  moveNo: number;
  /** Player decisions here that a published analysis judged. */
  decisions: number;
  /** How many of them cost something. */
  failures: number;
  /**
   * Player decisions here that nobody has judged, because the game they came
   * from has no published analysis.
   *
   * Kept apart from `decisions` because it is the difference between "you were
   * fine here" and "nobody has looked". Before this existed the pooling skipped
   * an unjudged move entirely, so an opening whose games were all unanalysed
   * had no row on the sheet at all, and one with a few analysed games reported
   * "no mistakes" over a sample it was not describing.
   */
  unjudged: number;
  state: CellState;
  /** Only set when the cell cleared the sample floor. */
  heat?: CellHeat;
  /** Positions behind the cell, worst first — what the detail panel shows. */
  nodeKeys: string[];
  /**
   * The UCI moves that reach each of `nodeKeys`, same order, space separated.
   *
   * Carried because the book endpoint cannot say where a line left the book
   * from a position alone — it needs the move order that got there, since a
   * position reached by a transposition left the book somewhere else than the
   * same position reached down the main line.
   */
  nodeLines: string[];
}

export interface SheetVariationRow {
  key: string;
  label: string;
  games: number;
  cells: SheetCell[];
}

/**
 * Player decisions on an edge that no published analysis judged.
 *
 * `g` is games that played the move; `op` is the ones carrying a verdict. An
 * opponent move is excluded because Forma does not judge those, so the gap
 * there is not a coverage gap. A `mixed` edge — the player in some games, the
 * opponent in others — is counted as if it were all the player's, which is the
 * same rule `unjudgedOn` in the v1 explorer applies. Overstating an unknown is
 * the safe direction, and the two surfaces agreeing matters more than a
 * correction the wire encoding does not carry the numbers for.
 */
function unjudgedOn(edge: { ac: "p" | "o" | "m"; g: number; op: number }): number {
  if (edge.ac === "o") return 0;
  return Math.max(0, edge.g - edge.op);
}

export interface SheetRow {
  key: string;
  family: string;
  /** How the section says it: "vs Sicilian" as White, "your Sicilian" as Black. */
  label: string;
  games: number;
  /** First column where this line is identifiable — earlier cells are `pre`. */
  startMove: number;
  /** Last column with any scored decision. Where the row fades is a finding. */
  bookDepth: number;
  cells: SheetCell[];
  variations: SheetVariationRow[];
}

/** Judged decisions, mistakes and unjudged decisions across a row of cells. */
export function tallyCells(cells: readonly SheetCell[]): {
  decisions: number;
  mistakes: number;
  unjudged: number;
} {
  return cells.reduce(
    (total, cell) => ({
      decisions: total.decisions + cell.decisions,
      mistakes: total.mistakes + cell.failures,
      unjudged: total.unjudged + cell.unjudged,
    }),
    { decisions: 0, mistakes: 0, unjudged: 0 },
  );
}

export interface SheetMarker {
  rowKey: string;
  variationKey: string | null;
  moveNo: number;
}

export interface TearSheet {
  sections: Array<{ color: "white" | "black"; rows: SheetRow[]; games: number }>;
  /** Exactly one across the whole sheet, or none when nothing qualifies. */
  marker: SheetMarker | null;
  maxMove: number;
}

/** Where the catch-all row and bucket live. */
export const OTHER_ROW = "Other lines";
const EARLY = "Early deviations";

/**
 * Catalogue names that describe a pawn having moved rather than a line anyone
 * chose. They are real families in the catalogue and a legitimate row for a
 * player who never goes anywhere more specific — but when something named does
 * grow out of one, the waypoint row is the *same games* counted again under a
 * placeholder, sitting above the line it leads to.
 */
const WAYPOINTS = new Set([
  "King's Pawn Game",
  "Queen's Pawn Game",
  "Indian Defense",
  "Indian Game",
]);

/**
 * A row is named after the opening, full stop.
 *
 * An earlier pass prefixed these with "vs" or "your" depending on whose choice
 * the name implied, which invented a distinction the data does not carry and
 * split one opening into two ways of saying it. The sheet is already scoped to
 * a side, so the side is not the row's job to state.
 */
function rowLabel(family: string): string {
  return family;
}

/**
 * The most specific opening a catalogue name points at.
 *
 * ECO files the London System under "Queen's Pawn Game: London System", and
 * taking the head before the colon — which is the right rule everywhere else —
 * turns a real opening into a variation of "a queen's pawn moved". When the
 * head is only a waypoint and the tail names an opening in its own right, the
 * tail is the one the player actually chose.
 */
function familyOf(name: string | undefined): string | null {
  const head = openingFamily(name);
  if (!name || !head || !WAYPOINTS.has(head)) return head;
  const colon = name.indexOf(":");
  if (colon < 0) return head;
  const tail = openingFamily(name.slice(colon + 1).trim());
  return tail && !WAYPOINTS.has(tail) ? tail : head;
}

/** The mover's own move number at a position of this ply. */
function moveNoOf(ply: number): number {
  return ply % 2 === 0 ? ply / 2 + 1 : (ply + 1) / 2;
}

export function heatOf(decisions: number, failures: number): CellHeat | undefined {
  if (decisions < FLOOR_COLOR) return undefined;
  const rate = failures / decisions;
  if (rate >= TEARS_AT) return "tears";
  if (rate >= SHAKY_AT) return "shaky";
  return "holds";
}

interface Bucket {
  decisions: number;
  failures: number;
  unjudged: number;
  /** Parent position keys, with the failures each contributed and how it is reached. */
  positions: Map<string, { failures: number; line: string }>;
  games: number;
}

const emptyBucket = (): Bucket => ({
  decisions: 0,
  failures: 0,
  unjudged: 0,
  positions: new Map(),
  games: 0,
});

/**
 * The variation a name introduces, if it names one.
 *
 * Catalogue names are "Family: Variation, sub-detail". We keep the first
 * segment after the colon — deeper detail is noise at this altitude and would
 * split one line into a dozen one-game rows.
 */
function variationOf(name: string | undefined, family: string): string | null {
  if (!name) return null;
  const colon = name.indexOf(":");
  if (colon < 0) return null;
  const tail = name.slice(colon + 1).split(",")[0]!.trim();
  if (!tail || tail === family) return null;
  return tail;
}

/**
 * Walk one colour's graph and pool decisions by (family, variation, move №).
 *
 * Each node is assigned the family and variation of the first path that
 * reaches it — BFS, so that is the shortest telling of the line, and a
 * transposition cannot be counted under two different names. Edges are then
 * visited exactly once, which is what keeps the totals honest.
 */
function poolByLine(graph: OpeningGraph) {
  const outgoing = new Map<number, number[]>();
  graph.edges.forEach((edge, i) => {
    const list = outgoing.get(edge.a);
    if (list) list.push(i);
    else outgoing.set(edge.a, [i]);
  });

  // `line` is the UCI move order the breadth-first walk used to reach the node,
  // which is the same shortest telling of the line the family naming uses. It
  // travels with the naming so a cell can hand the book a move order rather
  // than a bare position.
  const naming = new Map<
    number,
    { family: string | null; variation: string | null; line: string[] }
  >();
  naming.set(graph.root, { family: null, variation: null, line: [] });

  const familyBuckets = new Map<string, Map<number, Bucket>>();
  const variationBuckets = new Map<string, Map<number, Bucket>>();
  const familyGames = new Map<string, number>();
  const variationGames = new Map<string, number>();
  const familyStart = new Map<string, number>();
  /** Families that something more specific grew out of. */
  const hasDescendant = new Set<string>();

  const queue = [graph.root];
  const seen = new Set(queue);

  while (queue.length) {
    const at = queue.shift()!;
    const here = naming.get(at)!;

    for (const ei of outgoing.get(at) ?? []) {
      const edge = graph.edges[ei]!;
      const target = graph.nodes[edge.b]!;

      // The position's own catalogue name first, and the edge label only as a
      // fallback. An edge's label is the opening that *dominates below it*, so
      // trusting it first drags deep names up the tree — on real data every
      // 1.e4 became "Ruy Lopez at move 1", which then claimed the game count
      // of the whole repertoire and buried the real rows.
      const named = target.nm ?? edge.lb;
      const family = familyOf(named) ?? here.family;
      const variation =
        family && family !== here.family
          ? variationOf(named, family)
          : (variationOf(named, family ?? "") ?? here.variation);

      if (here.family && family && family !== here.family) {
        hasDescendant.add(here.family);
      }

      if (!seen.has(edge.b)) {
        seen.add(edge.b);
        naming.set(edge.b, { family, variation, line: [...here.line, edge.u] });
        queue.push(edge.b);
      }

      // Only the player's own scored decisions land on the sheet. Opponent
      // moves shape the position but are not decisions we can grade.
      //
      // The first ply is excluded on purpose. Position names are inherited
      // from the game's eventual opening, so the position after 1.e4 is called
      // "Ruy Lopez" in a Ruy Lopez game and "Sicilian" in a Sicilian one —
      // and since every game shares that one node, whichever name the walk
      // meets first would claim the opening move of the entire repertoire.
      // Playing 1.e4 is not a line anyway; it is the thing lines branch from.
      // An unjudged player move is pooled too. Requiring `op > 0` here — which
      // this did — made an unanalysed game invisible rather than uncounted: a
      // family whose games had no published analysis produced no bucket, so it
      // had no row on the sheet at all, and a family with a handful of analysed
      // games reported "no mistakes" over a sample several times larger than
      // the one it had looked at.
      const unjudged = unjudgedOn(edge);
      if ((edge.op > 0 || unjudged > 0) && family && target.p >= 2) {
        const moveNo = moveNoOf(graph.nodes[edge.a]!.p);
        if (moveNo > MAX_MOVE) continue;

        const fam = familyBuckets.get(family) ?? new Map<number, Bucket>();
        const cell = fam.get(moveNo) ?? emptyBucket();
        cell.decisions += edge.op;
        cell.failures += edge.fa;
        cell.unjudged += unjudged;
        cell.games += edge.g;
        if (edge.fa > 0 || cell.positions.size < MAX_CELL_POSITIONS) {
          const node = graph.nodes[edge.a]!;
          const seenAt = cell.positions.get(node.k);
          cell.positions.set(node.k, {
            failures: (seenAt?.failures ?? 0) + edge.fa,
            line: seenAt?.line ?? here.line.join(" "),
          });
        }
        fam.set(moveNo, cell);
        familyBuckets.set(family, fam);

        const start = familyStart.get(family);
        if (start == null || moveNo < start) familyStart.set(family, moveNo);

        // Decisions inside a family that never reached a named variation are a
        // real group, not a gap: it is usually where the opponent left book
        // early and the player was on their own.
        const vkey = `${family}|${variation ?? EARLY}`;
        const vari = variationBuckets.get(vkey) ?? new Map<number, Bucket>();
        const vcell = vari.get(moveNo) ?? emptyBucket();
        vcell.decisions += edge.op;
        vcell.failures += edge.fa;
        vcell.unjudged += unjudged;
        vcell.games += edge.g;
        if (edge.fa > 0 || vcell.positions.size < MAX_CELL_POSITIONS) {
          const node = graph.nodes[edge.a]!;
          const seenAt = vcell.positions.get(node.k);
          vcell.positions.set(node.k, {
            failures: (seenAt?.failures ?? 0) + edge.fa,
            line: seenAt?.line ?? here.line.join(" "),
          });
        }
        vari.set(moveNo, vcell);
        variationBuckets.set(vkey, vari);
      }
    }
  }

  // Games are counted from the positions themselves, not from the edges that
  // scored. Reading the source node would credit the move that *enters* a line
  // to whatever came before it — every Caro-Kann would report the game count of
  // "1.e4 played", which is every game the opponent opened that way.
  for (const [index, { family, variation }] of naming) {
    if (!family) continue;
    const node = graph.nodes[index]!;
    familyGames.set(family, Math.max(familyGames.get(family) ?? 0, node.g));
    const vkey = `${family}|${variation ?? EARLY}`;
    variationGames.set(vkey, Math.max(variationGames.get(vkey) ?? 0, node.g));
  }

  return { familyBuckets, variationBuckets, familyGames, variationGames, familyStart, hasDescendant };
}

function buildCells(
  buckets: Map<number, Bucket>,
  startMove: number,
  maxMove: number,
): { cells: SheetCell[]; bookDepth: number } {
  let bookDepth = startMove;
  const cells: SheetCell[] = [];
  for (let moveNo = 1; moveNo <= maxMove; moveNo++) {
    const bucket = buckets.get(moveNo);
    const decisions = bucket?.decisions ?? 0;
    const failures = bucket?.failures ?? 0;
    const unjudged = bucket?.unjudged ?? 0;
    if (decisions > 0) bookDepth = moveNo;

    // A cell before the line even exists is empty space, not fog. Only the
    // right-hand edge means "past your book", so the dashes keep one meaning.
    //
    // `unjudged` sits between `blank` and `thin`: moves were played here and
    // none of them has a verdict. Drawing it as `blank` would say the player
    // never went this deep, and drawing it on the heat ramp would put a colour
    // on a failure rate computed from nothing.
    const state: CellState =
      moveNo < startMove
        ? "pre"
        : decisions === 0
          ? unjudged > 0
            ? "unjudged"
            : "blank"
          : decisions < FLOOR_COLOR
            ? "thin"
            : "scored";

    // Worst first, and the line to each kept alongside its key. The two arrays
    // are built from one sort so they can never fall out of step: a position
    // paired with the move order of a different one would send the book looking
    // for a departure on a line nobody played.
    const positions = bucket
      ? [...bucket.positions.entries()]
          .sort((a, b) => b[1].failures - a[1].failures)
          .slice(0, MAX_CELL_POSITIONS)
      : [];

    cells.push({
      moveNo,
      decisions,
      failures,
      unjudged,
      state,
      heat: heatOf(decisions, failures),
      nodeKeys: positions.map(([key]) => key),
      nodeLines: positions.map(([, at]) => at.line),
    });
  }
  return { cells, bookDepth };
}

function buildSection(graph: OpeningGraph | null, color: "white" | "black") {
  if (!graph || !graph.nodes.length) return { color, rows: [] as SheetRow[], games: 0 };
  const pooled = poolByLine(graph);

  const families = [...pooled.familyBuckets.keys()].filter(
    (family) => !(WAYPOINTS.has(family) && pooled.hasDescendant.has(family)),
  );
  const kept: string[] = [];
  const folded: string[] = [];
  for (const family of families) {
    const games = pooled.familyGames.get(family) ?? 0;
    (games >= MIN_ROW_GAMES ? kept : folded).push(family);
  }

  const rows: SheetRow[] = kept.map((family) => {
    const startMove = pooled.familyStart.get(family) ?? 1;
    const { cells, bookDepth } = buildCells(pooled.familyBuckets.get(family)!, startMove, MAX_MOVE);
    const variations: SheetVariationRow[] = [...pooled.variationBuckets.entries()]
      .filter(([key]) => key.startsWith(`${family}|`))
      .map(([key, buckets]) => ({
        key: `${color}:${key}`,
        label: key.slice(family.length + 1),
        games: pooled.variationGames.get(key) ?? 0,
        cells: buildCells(buckets, startMove, MAX_MOVE).cells,
      }))
      .sort((a, b) => b.games - a.games);

    return {
      key: `${color}:${family}`,
      family,
      label: rowLabel(family),
      games: pooled.familyGames.get(family) ?? 0,
      startMove,
      bookDepth,
      cells,
      // A single variation row that just restates the family adds a chevron
      // and no information.
      variations: variations.length > 1 ? variations : [],
    };
  });

  // Everything too rare for a row of its own pools into one, so the sheet
  // stays readable without pretending the games did not happen.
  if (folded.length) {
    const merged = new Map<number, Bucket>();
    let games = 0;
    let start = MAX_MOVE;
    for (const family of folded) {
      games += pooled.familyGames.get(family) ?? 0;
      start = Math.min(start, pooled.familyStart.get(family) ?? 1);
      for (const [moveNo, bucket] of pooled.familyBuckets.get(family)!) {
        const cell = merged.get(moveNo) ?? emptyBucket();
        cell.decisions += bucket.decisions;
        cell.failures += bucket.failures;
        cell.unjudged += bucket.unjudged;
        cell.games += bucket.games;
        for (const [key, at] of bucket.positions) {
          const seenAt = cell.positions.get(key);
          cell.positions.set(key, {
            failures: (seenAt?.failures ?? 0) + at.failures,
            line: seenAt?.line ?? at.line,
          });
        }
        merged.set(moveNo, cell);
      }
    }
    const { cells, bookDepth } = buildCells(merged, start, MAX_MOVE);
    rows.push({
      key: `${color}:${OTHER_ROW}`,
      family: OTHER_ROW,
      label: OTHER_ROW,
      games,
      startMove: start,
      bookDepth,
      cells,
      variations: [],
    });
  }

  rows.sort((a, b) => {
    if (a.family === OTHER_ROW) return 1;
    if (b.family === OTHER_ROW) return -1;
    return b.games - a.games;
  });

  return { color, rows, games: graph.games };
}

/**
 * Pick the single cell worth starting from.
 *
 * Computed at variation level and surfaced to its family row, because pooling
 * hides exactly the thing we exist to find: a solid fifty-game Dragon would
 * average a disastrous ten-game Najdorf into "mildly shaky", and the tear
 * would disappear into its own family's success.
 */
function pickMarker(sections: TearSheet["sections"]): SheetMarker | null {
  let best: (SheetMarker & { failures: number; rate: number }) | null = null;

  const consider = (
    rowKey: string,
    variationKey: string | null,
    cell: SheetCell,
  ) => {
    // Judged decisions only. An unjudged cell has no failure rate to rank, and
    // nominating "the line to start with" from moves nobody has looked at would
    // be the page's single loudest claim resting on the one thing it does not
    // know.
    if (cell.decisions < FLOOR_COLOR || cell.failures === 0) return;
    const rate = cell.failures / cell.decisions;
    if (
      !best ||
      cell.failures > best.failures ||
      (cell.failures === best.failures && rate > best.rate)
    ) {
      best = { rowKey, variationKey, moveNo: cell.moveNo, failures: cell.failures, rate };
    }
  };

  for (const section of sections) {
    for (const row of section.rows) {
      if (row.family === OTHER_ROW) continue;
      if (row.variations.length) {
        for (const variation of row.variations) {
          for (const cell of variation.cells) consider(row.key, variation.key, cell);
        }
      } else {
        for (const cell of row.cells) consider(row.key, null, cell);
      }
    }
  }

  if (!best) return null;
  const { rowKey, variationKey, moveNo } = best;
  return { rowKey, variationKey, moveNo };
}

export function deriveTearSheet(
  white: OpeningGraph | null,
  black: OpeningGraph | null,
): TearSheet {
  const sections = [buildSection(white, "white"), buildSection(black, "black")].filter(
    (section) => section.rows.length > 0,
  );

  const deepest = sections.reduce(
    (max, section) => section.rows.reduce((m, row) => Math.max(m, row.bookDepth), max),
    0,
  );
  const maxMove = Math.min(MAX_MOVE, Math.max(MIN_MOVE_SPAN, deepest));

  return { sections, marker: pickMarker(sections), maxMove };
}
