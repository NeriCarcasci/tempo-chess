/** Parse `[Key "Value"]` tag-pairs from a PGN into a plain object. */
export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\[(\w+)\s+"([^"]*)"\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/** Best-effort opening name from a chess.com ECO URL slug. */
export function openingNameFromEcoUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const slug = url.split("/").filter(Boolean).pop();
  if (!slug) return undefined;
  return decodeURIComponent(slug).replace(/-/g, " ").trim() || undefined;
}
