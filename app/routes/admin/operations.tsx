import { useRevalidator } from "react-router";
import type { Route } from "./+types/operations";
import { getOperations } from "../../lib/admin";
import type { AdminOperations } from "../../lib/v1/types";

/**
 * The page you open when somebody says nothing is happening.
 *
 * Three readings, in the order they answer that question: which accounts are
 * part way through onboarding and how long they have been there, what work is
 * dead or waiting to retry and why, and what the recent syncs actually took in.
 *
 * The last one earns its place. A sync that stops early still finishes and
 * still reports success, and an archive once imported 196 games of 337 with
 * nothing anywhere saying so. `accepted` beside `rejected` and the rejection
 * tally is the reading that shows it, and it exists on no other surface.
 */

export async function clientLoader(): Promise<AdminOperations> {
  return getOperations();
}

/** How long it has sat where it is. The number that makes a row interesting. */
function ageOf(iso: string | null): string {
  if (!iso) return "unknown";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** Dead first, then retrying. Anything else is background. */
function severityOf(status: string): string {
  if (status === "dead") return "bad";
  if (status === "retry_wait") return "warn";
  return "quiet";
}

export default function AdminOperationsPage({ loaderData }: Route.ComponentProps) {
  const { onboarding, work, sync } = loaderData;
  const revalidator = useRevalidator();
  const stuck = work.filter((row) => row.status === "dead" || row.status === "retry_wait");

  return (
    <section className="admin-operations">
      <div className="admin-head">
        <h1>Operations</h1>
        <button
          type="button"
          className="link-button"
          onClick={() => revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Refresh
        </button>
      </div>

      <h2 className="admin-section">Onboarding in flight</h2>
      {onboarding.length === 0 ? (
        <p className="admin-empty">Nobody is part way through.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Stage</th>
                <th scope="col">Started</th>
                <th scope="col">Last moved</th>
              </tr>
            </thead>
            <tbody>
              {onboarding.map((run) => (
                <tr key={run.userId}>
                  <td>{run.email ?? <span className="admin-null">no address</span>}</td>
                  <td>{run.stage.replace(/_/g, " ")}</td>
                  <td className="admin-num">{ageOf(run.startedAt)} ago</td>
                  {/* The one that matters. A run whose stage last moved two days
                      ago is stuck, whatever the stage says it is doing. */}
                  <td className="admin-num">{ageOf(run.updatedAt)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="admin-section">
        Work ledger{stuck.length > 0 ? ` · ${stuck.length} needing attention` : ""}
      </h2>
      {work.length === 0 ? (
        <p className="admin-empty">Nothing outstanding.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Count</th>
                <th scope="col">Error</th>
                <th scope="col">Oldest</th>
              </tr>
            </thead>
            <tbody>
              {work.map((row) => (
                <tr key={`${row.taskType}:${row.status}:${row.errorCode ?? ""}`}>
                  <td>{row.taskType}</td>
                  <td>
                    <span className={`admin-state admin-state-${severityOf(row.status)}`}>
                      {row.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="admin-num">{row.count}</td>
                  <td>{row.errorCode ?? <span className="admin-null">none</span>}</td>
                  <td className="admin-num">{ageOf(row.oldestAt)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="admin-section">Sync health</h2>
      {sync.length === 0 ? (
        <p className="admin-empty">No syncs recorded.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Handle</th>
                <th scope="col">Mode</th>
                <th scope="col">State</th>
                <th scope="col">Accepted</th>
                <th scope="col">Duplicate</th>
                <th scope="col">Rejected</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {sync.map((run) => (
                <tr key={run.syncRunId}>
                  <td>{run.handle ?? <span className="admin-null">unknown</span>}</td>
                  <td>{run.mode}</td>
                  <td>
                    {run.state}
                    {run.failureClass ? ` (${run.failureClass})` : ""}
                  </td>
                  <td className="admin-num">{run.accepted}</td>
                  <td className="admin-num">{run.duplicate}</td>
                  <td className="admin-num">
                    {run.rejected}
                    {run.rejected > 0 && run.rejectionSummary ? (
                      /* The tally by reason, which is all the ledger keeps: a
                         game Forma refused leaves no id, url or replay behind. */
                      <span className="admin-null">
                        {" "}
                        {Object.entries(run.rejectionSummary)
                          .map(([reason, count]) => `${reason} ${String(count)}`)
                          .join(", ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="admin-num">{ageOf(run.startedAt)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
