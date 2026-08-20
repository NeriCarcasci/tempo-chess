export function pct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function playTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

export function monthYear(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

export function relTime(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * The same, for the ISO 8601 timestamps `/v1` sends.
 *
 * Separate from `relTime` rather than a widened argument, because the failure
 * has to be caught here: `Date.parse` of something unexpected is `NaN`, and
 * `relTime(NaN)` renders it as "56y ago" beside a game played this morning.
 * Null in or unparseable in, null out, and the caller says nothing at all.
 */
export function relTimeIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : relTime(ms);
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
