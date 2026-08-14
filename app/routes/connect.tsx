import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/connect";
import {
  requireUser,
  invalidateSession,
  setActiveAccount,
  signOut,
  type LinkedAccount,
} from "../lib/session";
import { apiFetch } from "../lib/api";
import { invalidateCache } from "../lib/loaderCache";
import { BrandLock } from "../components/PublicShell";
import { LichessMark, ChessComMark } from "../components/PlatformMarks";

/**
 * Onboarding: a signed-in account is worth nothing until it points at some
 * games. Every study surface reads from an imported history, so this is the one
 * step between signing up and having a product.
 *
 * Two steps, on purpose. This used to link a name and start an import in the
 * same submit, which meant a typo — or a name that only exists on the other
 * platform — produced a linked account, an import that failed where nobody
 * could see it, and a dashboard of zeroes with no explanation. Now we look the
 * name up first and show what came back, so the only way to reach the dashboard
 * is to confirm an account that demonstrably exists.
 *
 * The same screen also serves "link another account", which is a different
 * errand wearing the same form: someone who plays on both sites, or under two
 * names on one. That mode says so in the copy, does not pre-fill the name of
 * the account you already have, and defaults the radio to the platform you are
 * *missing* — pre-filling for onboarding meant "Link another account" opened a
 * form already holding your Chess.com name with Lichess selected, and searching
 * it truthfully reported that no such Lichess player exists.
 */

export function meta() {
  return [{ title: "Connect your chess account · Tempo" }];
}

type Platform = "lichess" | "chesscom";

interface PlatformAccount {
  platform: Platform;
  username: string;
  url: string;
  games: number | null;
  rating: number | null;
  closed: boolean;
}

interface ConnectData {
  email: string | null;
  accounts: LinkedAccount[];
}

type ActionResult =
  | { error: string }
  | { notFound: { platform: Platform; username: string } }
  | { candidate: PlatformAccount; alreadyLinked: LinkedAccount | null };

export async function clientLoader(): Promise<ConnectData> {
  const session = await requireUser();
  return { email: session.email, accounts: session.accounts };
}

const PLATFORM_NAME: Record<Platform, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
};

/** The platform to pre-select: the one they have no account on yet. */
function suggestPlatform(accounts: LinkedAccount[]): Platform {
  if (!accounts.length) return "lichess";
  return accounts.every((a) => a.platform === "lichess") ? "chesscom" : "lichess";
}

function findLinked(
  accounts: LinkedAccount[],
  platform: Platform,
  username: string,
): LinkedAccount | null {
  const normalized = username.trim().toLowerCase();
  return (
    accounts.find((a) => a.platform === platform && a.normalizedUsername === normalized) ?? null
  );
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const session = await requireUser();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "lookup");
  const username = String(form.get("username") ?? "").trim();
  const platform = String(form.get("platform") ?? "lichess") as Platform;
  if (username.length < 2) return { error: "Enter your username." } satisfies ActionResult;

  // -- switch: they searched for an account they already have -------------
  if (intent === "use") {
    const linked = findLinked(session.accounts, platform, username);
    if (!linked) return { error: "That account is not linked to you." } satisfies ActionResult;
    setActiveAccount(session.userId, linked.id);
    throw redirect("/dashboard");
  }

  // -- step one: does this account exist? ---------------------------------
  if (intent === "lookup") {
    const res = await apiFetch(
      `/platform-accounts/${platform}/${encodeURIComponent(username)}`,
    ).catch(() => null);
    if (!res) return { error: "Could not reach us. Check your connection." } satisfies ActionResult;
    if (res.status === 503) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return {
        error: body?.error ?? `${PLATFORM_NAME[platform]} did not respond. Try again in a moment.`,
      } satisfies ActionResult;
    }
    if (!res.ok) return { error: "Could not check that username." } satisfies ActionResult;

    const body = (await res.json()) as { found: boolean; account?: PlatformAccount };
    if (!body.found || !body.account) {
      return { notFound: { platform, username } } satisfies ActionResult;
    }
    if (body.account.closed) {
      return {
        error: `That ${PLATFORM_NAME[platform]} account is closed, so there is nothing to import.`,
      } satisfies ActionResult;
    }
    return {
      candidate: body.account,
      // Searching for an account you already have is a switch, not a link, and
      // the card says so instead of re-importing what we already hold.
      alreadyLinked: findLinked(session.accounts, platform, body.account.username),
    } satisfies ActionResult;
  }

  // -- step two: they confirmed it, so link and import ---------------------
  const linked = await apiFetch("/me/accounts", { json: { username, platform } });
  if (!linked.ok) {
    const body = (await linked.json().catch(() => null)) as { error?: string } | null;
    return { error: body?.error ?? "Could not link that account." } satisfies ActionResult;
  }
  const created = (await linked.json().catch(() => null)) as { account?: LinkedAccount } | null;

  // A freshly linked account is the one they came here to use, so point the
  // product at it. Otherwise the second account you add stays invisible behind
  // the first, which is exactly the bug this flow used to have.
  if (created?.account?.id) setActiveAccount(session.userId, created.account.id);

  // Linking changes who /me reports, so both caches have to go before the
  // dashboard loader runs.
  invalidateSession();
  invalidateCache();

  // The platform goes with it. Without it the API assumed Lichess for everyone,
  // so a Chess.com account was looked up under the wrong platform and the
  // import died before it read a single game.
  await apiFetch("/imports/lichess", {
    json: { username, platform, games: "all" },
  }).catch(() => null);

  throw redirect("/dashboard");
}

/** What we found, for them to confirm or reject. */
function Candidate({
  account,
  alreadyLinked,
  busy,
}: {
  account: PlatformAccount;
  alreadyLinked: LinkedAccount | null;
  busy: boolean;
}) {
  const Mark = account.platform === "chesscom" ? ChessComMark : LichessMark;
  return (
    <>
      <div className="found">
        <span className="found-mark">
          <Mark size={22} />
        </span>
        <span className="found-who">
          <b>{account.username}</b>
          <i>
            {PLATFORM_NAME[account.platform]}
            {account.rating != null ? ` · ${account.rating}` : ""}
            {account.games != null ? ` · ${account.games.toLocaleString("en-GB")} games` : ""}
          </i>
        </span>
        <a className="found-link" href={account.url} target="_blank" rel="noreferrer noopener">
          View profile
        </a>
      </div>

      <Form method="post" className="auth-form">
        <input type="hidden" name="intent" value={alreadyLinked ? "use" : "confirm"} />
        <input type="hidden" name="platform" value={account.platform} />
        <input type="hidden" name="username" value={account.username} />
        <button className="primary-button auth-submit" type="submit" disabled={busy}>
          {alreadyLinked
            ? busy
              ? "Switching…"
              : "Switch to this account"
            : busy
              ? "Importing your games…"
              : "Yes, import my games"}
        </button>
      </Form>
      <Form method="get">
        <button type="submit" className="auth-inline-link">
          Not you? Search again
        </button>
      </Form>
    </>
  );
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const result = actionData as ActionResult | undefined;

  const candidate = result && "candidate" in result ? result.candidate : null;
  const alreadyLinked = result && "candidate" in result ? result.alreadyLinked : null;
  const notFound = result && "notFound" in result ? result.notFound : null;
  const error = result && "error" in result ? result.error : null;

  // Adding to a set of accounts is a different errand from having none.
  const accounts = loaderData.accounts;
  const adding = accounts.length > 0;
  const defaultPlatform = notFound?.platform ?? suggestPlatform(accounts);

  return (
    <main className="auth-shell">
      <div className="auth-card auth-card-wide">
        <Link to="/" className="auth-brand" aria-label="Tempo home">
          <BrandLock size={24} />
        </Link>

        <h1>
          {candidate
            ? alreadyLinked
              ? "You already have this one"
              : "Is this you?"
            : adding
              ? "Link another account"
              : "Connect your chess account"}
        </h1>
        <p className="auth-sub">
          {candidate
            ? alreadyLinked
              ? "This account is already linked to you. Switch to it and every page will read its games instead."
              : "We found one account with that name. Confirm it and we will read its whole history."
            : adding
              ? "Play on both sites, or under another name? Add it and you can switch between accounts from the menu at any time."
              : "Tempo analyses games you have already played. Tell us where you play and we will find your account."}
        </p>

        {/* What they already have, so "another" means something concrete and
            nobody re-types an account they linked last week. */}
        {adding && !candidate ? (
          <ul className="auth-linked" aria-label="Accounts already linked">
            {accounts.map((account) => (
              <li key={account.id}>
                {account.platform === "chesscom" ? <ChessComMark size={16} /> : <LichessMark size={16} />}
                <b>{account.username}</b>
                <small>{PLATFORM_NAME[account.platform]}</small>
              </li>
            ))}
          </ul>
        ) : null}

        {candidate ? (
          <Candidate account={candidate} alreadyLinked={alreadyLinked} busy={busy} />
        ) : (
          <Form method="post" className="auth-form">
            <input type="hidden" name="intent" value="lookup" />
            {/* The radio stays in the DOM for keyboard and screen readers; only
                its own box is hidden, so arrow keys still move through the group
                and the card shows the selection instead. */}
            <fieldset className="auth-choice">
              <legend>Where do you play?</legend>
              <label>
                <input
                  type="radio"
                  name="platform"
                  value="lichess"
                  defaultChecked={defaultPlatform === "lichess"}
                />
                <LichessMark size={20} />
                <span>Lichess</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="platform"
                  value="chesscom"
                  defaultChecked={defaultPlatform === "chesscom"}
                />
                <ChessComMark size={20} />
                <span>Chess.com</span>
              </label>
            </fieldset>
            <label>
              <span>{adding ? "Username on that site" : "Your username there"}</span>
              <input
                type="text"
                name="username"
                placeholder="e.g. ncarcasc"
                // Never pre-filled when adding: the only name we could offer is
                // one they have already linked.
                defaultValue={notFound?.username ?? ""}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </label>

            {/* Says which platform it searched, because "not found" is usually
                "found, on the other one". */}
            {notFound ? (
              <p className="auth-error">
                No {PLATFORM_NAME[notFound.platform]} player called{" "}
                <b>{notFound.username}</b>. Check the spelling, or try{" "}
                {notFound.platform === "lichess" ? "Chess.com" : "Lichess"}.
              </p>
            ) : null}
            {error ? <p className="auth-error">{error}</p> : null}

            <button className="primary-button auth-submit" type="submit" disabled={busy}>
              {busy ? "Looking…" : "Find my account"}
            </button>
          </Form>
        )}

        {/* Someone who wandered in from /account needs a way back that is not
            "link something". Onboarding has nowhere to go, so it keeps the
            sign-out escape hatch instead. */}
        {adding ? (
          <p className="auth-note">
            We only read public game data. <Link to="/account">Back to your account</Link>.
          </p>
        ) : (
          <p className="auth-note">
            We only read public game data. Signed in as {loaderData.email ?? "your account"}.{" "}
            <button
              type="button"
              className="auth-inline-link"
              onClick={async () => {
                await signOut();
                location.href = "/";
              }}
            >
              sign out
            </button>
            .
          </p>
        )}
      </div>
    </main>
  );
}
