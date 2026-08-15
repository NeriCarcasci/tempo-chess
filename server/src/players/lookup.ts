/**
 * "Is this you?" — look a username up on the platform before we import anything.
 *
 * This exists because the connect flow used to link a name and start an import
 * in the same breath, so a typo, or a name that only exists on the other site,
 * produced a linked account, a silent import failure, and a dashboard full of
 * zeroes with nothing to say why. Checking first turns all of that into one
 * honest sentence on the form.
 *
 * Read-only, public endpoints on both platforms, no token needed — the same
 * data their own profile pages serve.
 */

const UA = "forma-chess (+https://tempo-chess-9uf.pages.dev)";

export interface PlatformAccount {
  platform: "lichess" | "chesscom";
  /** As the platform spells it, which is not always as it was typed. */
  username: string;
  /** Profile URL, so the form can offer "not you? open the profile". */
  url: string;
  /** Games we can see, when the platform says. Null when it does not. */
  games: number | null;
  /** Best-known rating, for recognising your own account at a glance. */
  rating: number | null;
  /** Chess.com marks closed accounts; there is nothing to import from one. */
  closed: boolean;
}

/** Distinguishes "no such user" from "the platform is having a bad day". */
export class LookupUnavailable extends Error {}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new LookupUnavailable(`${url} returned ${res.status}`);
  return res.json();
}

async function lichess(username: string): Promise<PlatformAccount | null> {
  const data = (await getJson(`https://lichess.org/api/user/${encodeURIComponent(username)}`)) as
    | {
        username?: string;
        disabled?: boolean;
        count?: { rated?: number; all?: number };
        perfs?: Record<string, { rating?: number; games?: number }>;
      }
    | null;
  if (!data?.username) return null;

  // The rating shown is the one from the time control they have played most, so
  // it is the number they would recognise rather than an arbitrary first key.
  let rating: number | null = null;
  let most = -1;
  for (const perf of Object.values(data.perfs ?? {})) {
    if ((perf.games ?? 0) > most && perf.rating) {
      most = perf.games ?? 0;
      rating = perf.rating;
    }
  }

  return {
    platform: "lichess",
    username: data.username,
    url: `https://lichess.org/@/${data.username}`,
    games: data.count?.all ?? null,
    rating,
    closed: data.disabled === true,
  };
}

async function chesscom(username: string): Promise<PlatformAccount | null> {
  const handle = username.toLowerCase();
  const profile = (await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(handle)}`)) as
    | { username?: string; url?: string; status?: string }
    | null;
  if (!profile?.username) return null;

  // Stats are a second call and are allowed to fail: a profile with no rating
  // is still a profile, and refusing to confirm it because the stats endpoint
  // hiccuped would be worse than showing the name alone.
  let rating: number | null = null;
  try {
    const stats = (await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(handle)}/stats`)) as
      | Record<string, { last?: { rating?: number } }>
      | null;
    for (const key of ["chess_rapid", "chess_blitz", "chess_bullet", "chess_daily"]) {
      const found = stats?.[key]?.last?.rating;
      if (found) {
        rating = found;
        break;
      }
    }
  } catch {
    rating = null;
  }

  return {
    platform: "chesscom",
    username: profile.username,
    url: profile.url ?? `https://www.chess.com/member/${handle}`,
    // Chess.com does not publish a lifetime game count on the profile, and
    // counting the monthly archives would be a dozen requests for a number we
    // only wanted as reassurance.
    games: null,
    rating,
    closed: profile.status === "closed" || profile.status === "closed:fair_play_violations",
  };
}

export function lookupPlatformAccount(
  platform: "lichess" | "chesscom",
  username: string,
): Promise<PlatformAccount | null> {
  return platform === "chesscom" ? chesscom(username) : lichess(username);
}
