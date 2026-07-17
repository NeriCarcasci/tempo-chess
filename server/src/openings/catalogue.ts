import { Chess } from "chess.js";
import { client } from "../db/client.js";
import { canonicalPositionKey, splitOpeningName } from "./model.js";

export const OPENING_CATALOGUE = Object.freeze({
  revision: "292fd0468068f58bb244f7fe1c3e573e493c3c53",
  license: "CC0-1.0",
  repository: "https://github.com/lichess-org/chess-openings",
});

interface CatalogueNode {
  position_key: string;
  fen: string;
  eco: string | null;
  opening_name: string | null;
  family: string | null;
  variation: string | null;
  ply: number;
  representative_line_uci: string;
  representative_line_san: string;
  source_revision: string;
  source_license: string;
  catalogue: boolean;
}

interface CatalogueEdge {
  from_key: string;
  move_uci: string;
  to_key: string;
  move_san: string;
  catalogue: boolean;
  source_revision: string;
}

function tsvRows(text: string): Array<{ eco: string; name: string; pgn: string }> {
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [eco, name, ...pgn] = line.split("\t");
      return { eco, name, pgn: pgn.join("\t") };
    })
    .filter((row) => row.eco && row.name && row.pgn);
}

function linePositions(row: { eco: string; name: string; pgn: string }): {
  nodes: CatalogueNode[];
  edges: CatalogueEdge[];
} {
  const chess = new Chess();
  chess.loadPgn(`[Result "*"]\n\n${row.pgn} *`);
  const history = chess.history({ verbose: true });
  chess.reset();
  const nodes: CatalogueNode[] = [];
  const edges: CatalogueEdge[] = [];
  const uciLine: string[] = [];
  const sanLine: string[] = [];
  const identity = splitOpeningName(row.name);

  for (const move of history) {
    const fromFen = chess.fen();
    const fromKey = canonicalPositionKey(fromFen);
    const played = chess.move(move.san);
    const uci = `${played.from}${played.to}${played.promotion ?? ""}`;
    uciLine.push(uci);
    sanLine.push(played.san);
    const toFen = chess.fen();
    const toKey = canonicalPositionKey(toFen);

    nodes.push({
      position_key: fromKey,
      fen: fromFen,
      eco: null,
      opening_name: null,
      family: null,
      variation: null,
      ply: uciLine.length - 1,
      representative_line_uci: uciLine.slice(0, -1).join(" "),
      representative_line_san: sanLine.slice(0, -1).join(" "),
      source_revision: OPENING_CATALOGUE.revision,
      source_license: OPENING_CATALOGUE.license,
      catalogue: true,
    });
    nodes.push({
      position_key: toKey,
      fen: toFen,
      eco: row.eco,
      opening_name: row.name,
      family: identity.family,
      variation: identity.variation,
      ply: uciLine.length,
      representative_line_uci: uciLine.join(" "),
      representative_line_san: sanLine.join(" "),
      source_revision: OPENING_CATALOGUE.revision,
      source_license: OPENING_CATALOGUE.license,
      catalogue: true,
    });
    edges.push({
      from_key: fromKey,
      move_uci: uci,
      to_key: toKey,
      move_san: played.san,
      catalogue: true,
      source_revision: OPENING_CATALOGUE.revision,
    });
  }
  return { nodes, edges };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

export async function importOpeningCatalogue(): Promise<{
  revision: string;
  positions: number;
  edges: number;
}> {
  const nodeMap = new Map<string, CatalogueNode>();
  const edgeMap = new Map<string, CatalogueEdge>();

  for (const volume of ["a", "b", "c", "d", "e"]) {
    const url = `https://raw.githubusercontent.com/lichess-org/chess-openings/${OPENING_CATALOGUE.revision}/${volume}.tsv`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Opening catalogue ${volume}: HTTP ${response.status}`);
    for (const row of tsvRows(await response.text())) {
      const line = linePositions(row);
      for (const node of line.nodes) {
        const existing = nodeMap.get(node.position_key);
        if (!existing || (node.opening_name && node.ply >= existing.ply)) {
          nodeMap.set(node.position_key, node);
        }
      }
      for (const edge of line.edges) {
        edgeMap.set(`${edge.from_key}|${edge.move_uci}|${edge.to_key}`, edge);
      }
    }
  }

  const nodes = [...nodeMap.values()];
  const edges = [...edgeMap.values()];
  await client.begin(async (sql) => {
    for (const batch of chunks(nodes, 350)) {
      await sql`
        insert into opening_positions ${sql(
          batch,
          "position_key",
          "fen",
          "eco",
          "opening_name",
          "family",
          "variation",
          "ply",
          "representative_line_uci",
          "representative_line_san",
          "source_revision",
          "source_license",
          "catalogue",
        )}
        on conflict (position_key) do update set
          eco = coalesce(excluded.eco, opening_positions.eco),
          opening_name = coalesce(excluded.opening_name, opening_positions.opening_name),
          family = coalesce(excluded.family, opening_positions.family),
          variation = coalesce(excluded.variation, opening_positions.variation),
          representative_line_uci = case
            when excluded.opening_name is not null then excluded.representative_line_uci
            else opening_positions.representative_line_uci end,
          representative_line_san = case
            when excluded.opening_name is not null then excluded.representative_line_san
            else opening_positions.representative_line_san end,
          source_revision = excluded.source_revision,
          source_license = excluded.source_license,
          catalogue = true,
          updated_at = now()`;
    }
    for (const batch of chunks(edges, 350)) {
      await sql`
        insert into opening_edges ${sql(
          batch,
          "from_key",
          "move_uci",
          "to_key",
          "move_san",
          "catalogue",
          "source_revision",
        )}
        on conflict (from_key, move_uci, to_key) do update set
          move_san = excluded.move_san,
          catalogue = true,
          source_revision = excluded.source_revision`;
    }
  });
  return {
    revision: OPENING_CATALOGUE.revision,
    positions: nodes.length,
    edges: edges.length,
  };
}

export async function ensureOpeningCatalogue(): Promise<void> {
  const rows = await client`
    select count(*)::int as count
    from opening_positions
    where catalogue = true and source_revision = ${OPENING_CATALOGUE.revision}`;
  if (Number(rows[0]?.count ?? 0) < 1_000) await importOpeningCatalogue();
}
