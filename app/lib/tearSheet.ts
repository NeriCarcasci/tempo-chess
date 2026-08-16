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
/** Columns never run past here, however deep the book goes. */
const MAX_MOVE = 12;
const MIN_MOVE_SPAN = 8;
/** Positions kept per cell for the detail panel. */
const MAX_CELL_POSITIONS = 3;

export type CellState = "scored" | "thin" | "blank" | "pre";
export type CellHeat = "holds" | "shaky" | "tears";

export interface SheetCell {
  moveNo: number;
  /** Engine-scored player decisions pooled here. */
  decisions: number;
  /** How many of them cost something. */
  failures: number;
  state: CellState;
  /** Only set when the cell cleared the sample floor. */
  heat?: CellHeat;
  /** Positions behind the cell, worst first — what the detail panel shows. */
  nodeKeys: string[];
}

export interface SheetVariationRow {
  key: string;
  label: string;
  games: number;
  cells: SheetCell[];
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

function heatOf(decisions: number, failures: number): CellHeat | undefined {
  if (decisions < FLOOR_COLOR) return undefined;
  const rate = failures / decisions;
  if (rate >= TEARS_AT) return "tears";
  if (rate >= SHAKY_AT) return "shaky";
  return "holds";
}

interface Bucket {
  decisions: number;
  failures: number;
  /** Parent position keys, with the failures each contributed. */
  positions: Map<string, number>;
  games: number;
}

const emptyBucket = (): Bucket => ({ decisions: 0, failures: 0, positions: new Map(), games: 0 });

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

  const naming = new Map<number, { family: string | null; variation: string | null }>();
  naming.set(graph.root, { family: null, variation: null });

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
        naming.set(edge.b, { family, variation });
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
      if (edge.op > 0 && family && target.p >= 2) {
        const moveNo = moveNoOf(graph.nodes[edge.a]!.p);
        if (moveNo > MAX_MOVE) continue;

        const fam = familyBuckets.get(family) ?? new Map<number, Bucket>();
        const cell = fam.get(moveNo) ?? emptyBucket();
        cell.decisions += edge.op;
        cell.failures += edge.fa;
        cell.games += edge.g;
        if (edge.fa > 0 || cell.positions.size < MAX_CELL_POSITIONS) {
          const node = graph.nodes[edge.a]!;
          cell.positions.set(node.k, (cell.positions.get(node.k) ?? 0) + edge.fa);
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
        vcell.games += edge.g;
        if (edge.fa > 0 || vcell.positions.size < MAX_CELL_POSITIONS) {
          const node = graph.nodes[edge.a]!;
          vcell.positions.set(node.k, (vcell.positions.get(node.k) ?? 0) + edge.fa);
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
    if (decisions > 0) bookDepth = moveNo;

    // A cell before the line even exists is empty space, not fog. Only the
    // right-hand edge means "past your book", so the dashes keep one meaning.
    const state: CellState =
      moveNo < startMove ? "pre" : decisions === 0 ? "blank" : decisions < FLOOR_COLOR ? "thin" : "scored";

    const nodeKeys = bucket
      ? [...bucket.positions.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_CELL_POSITIONS)
          .map(([key]) => key)
      : [];

    cells.push({ moveNo, decisions, failures, state, heat: heatOf(decisions, failures), nodeKeys });
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
        cell.games += bucket.games;
        for (const [key, fa] of bucket.positions) {
          cell.positions.set(key, (cell.positions.get(key) ?? 0) + fa);
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
