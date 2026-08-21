import type { Route } from "./+types/accounts";
import { listAccounts } from "../../lib/admin";
import type { AdminAccount } from "../../lib/v1/types";

/**
 * Every account, and how far each one got.
 *
 * Counts and states, never content. Whether somebody linked a chess account and
 * whether a report exists are the questions this page is for; what is in their
 * games is not, and the API holds no policy that would let this page ask.
 */

interface LoaderData {
  accounts: AdminAccount[];
  hasMore: boolean;
}

export async function clientLoader(): Promise<LoaderData> {
  const page = await listAccounts({});
  return { accounts: page.items, hasMore: page.nextCursor !== null };
}

/**
 * How far along, in one word.
 *
 * `onboardingStage` is null for an account that never started, which is a
 * different thing from one that started and stalled at `linking`. Saying
 * "not started" for both would hide the second, which is the case worth seeing.
 */
function progressOf(account: AdminAccount): string {
  if (account.onboardingStatus === "activated") return "activated";
  if (!account.onboardingStage) return "not started";
  return account.onboardingStage.replace(/_/g, " ");
}

export default function AdminAccounts({ loaderData }: Route.ComponentProps) {
  const { accounts, hasMore } = loaderData;

  return (
    <section>
      <div className="admin-head">
        <h1>Accounts</h1>
        <p className="admin-meta">{accounts.length} shown, newest first</p>
      </div>

      {accounts.length === 0 ? (
        <p className="admin-empty">No accounts.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Access</th>
                <th scope="col">Joined</th>
                <th scope="col">Chess account</th>
                <th scope="col">Report</th>
                <th scope="col">Onboarding</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.userId}>
                  <td>{account.email ?? <span className="admin-null">no address</span>}</td>
                  <td>
                    <span className={`admin-state admin-state-${account.accessState ?? "pending"}`}>
                      {account.accessState ?? "none"}
                    </span>
                  </td>
                  <td className="admin-num">
                    {new Date(account.joinedAt).toLocaleDateString()}
                  </td>
                  <td>
                    {account.linkedAccounts === 0 ? (
                      <span className="admin-null">none</span>
                    ) : (
                      account.handles.map((h) => `${h.handle} (${h.provider})`).join(", ") ||
                      `${account.linkedAccounts} linked`
                    )}
                  </td>
                  {/* A word, not a tick. DESIGN.md: meaning is never carried by
                      colour or a glyph alone. */}
                  <td>{account.hasPublishedReport ? "published" : <span className="admin-null">none</span>}</td>
                  <td>{progressOf(account)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="admin-meta admin-more">There are more accounts than these.</p>
      ) : null}
    </section>
  );
}
