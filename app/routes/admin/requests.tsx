import { useState } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/requests";
import { ADMIN_BASE, decide, listAccessRequests } from "../../lib/admin";
import type { AccessState, AdminAccessRequest } from "../../lib/v1/types";

/**
 * The queue: who asked, when, what they said, approve or decline.
 *
 * The default filter is `pending`, because the only reason to open this page is
 * that somebody is waiting. The decided lists are there so a decision can be
 * checked or reversed, not so the queue can be browsed.
 */

const FILTERS: { key: AccessState | "all"; label: string }[] = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "Everyone" },
];

interface LoaderData {
  state: AccessState | "all";
  requests: AdminAccessRequest[];
  hasMore: boolean;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const url = new URL(request.url);
  const raw = url.searchParams.get("state");
  const state = (FILTERS.find((f) => f.key === raw)?.key ?? "pending") as AccessState | "all";
  const page = await listAccessRequests({ state: state === "all" ? undefined : state });
  return { state, requests: page.items, hasMore: page.nextCursor !== null };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const userId = String(form.get("userId") ?? "");
  const verdict = String(form.get("decision") ?? "");
  if (verdict !== "approved" && verdict !== "declined") {
    return { error: "Decide approved or declined." };
  }
  const note = String(form.get("note") ?? "").trim();
  try {
    await decide(userId, verdict, note || undefined);
    return { error: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: error instanceof Error ? error.message : "The decision did not save." };
  }
}

/** The wait, in days. The number an operator is actually judging by. */
function waitedDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function RequestCard({ request }: { request: AdminAccessRequest }) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [note, setNote] = useState("");
  const waited = waitedDays(request.requestedAt);

  return (
    <article className="admin-request">
      <header className="admin-request-head">
        <div>
          <h3>{request.email ?? "No address on file"}</h3>
          <p className="admin-meta">
            {/* Both dates, because they answer different questions: when they
                created the account, and how long they have been waiting. */}
            Asked {new Date(request.requestedAt).toLocaleDateString()} ·{" "}
            {waited === 0 ? "today" : `${waited} day${waited === 1 ? "" : "s"} ago`}
            {request.joinedAt ? ` · joined ${new Date(request.joinedAt).toLocaleDateString()}` : ""}
          </p>
        </div>
        <span className={`admin-state admin-state-${request.state}`}>{request.state}</span>
      </header>

      {request.note ? (
        <p className="admin-quote">{request.note}</p>
      ) : (
        <p className="admin-empty-note">They did not write anything.</p>
      )}

      {request.marketingSignup ? (
        /* Context, never evidence. This row matches on an address somebody
           typed into a public form, so it says what that form said and makes no
           claim that the person holding this account filled it in. */
        <p className="admin-signup">
          A beta signup with this address said: {request.marketingSignup.platform}
          {request.marketingSignup.rating ? `, ${request.marketingSignup.rating}` : ""}
          {request.marketingSignup.goal ? ` · "${request.marketingSignup.goal}"` : ""}
        </p>
      ) : null}

      {request.decidedAt ? (
        <p className="admin-meta">
          Decided {new Date(request.decidedAt).toLocaleDateString()}
          {request.decisionNote ? `: ${request.decisionNote}` : ""}
        </p>
      ) : null}

      <Form method="post" className="admin-decide">
        <input type="hidden" name="userId" value={request.userId} />
        <input
          type="text"
          name="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why (optional, shown to them on a decline)"
          maxLength={500}
        />
        <div className="admin-decide-actions">
          <button
            type="submit"
            name="decision"
            value="approved"
            className="primary-button"
            disabled={busy || request.state === "approved"}
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="declined"
            className="secondary-button"
            disabled={busy || request.state === "declined"}
          >
            Decline
          </button>
        </div>
      </Form>
    </article>
  );
}

export default function AdminRequests({ loaderData, actionData }: Route.ComponentProps) {
  const { state, requests, hasMore } = loaderData;
  const revalidator = useRevalidator();

  return (
    <section>
      <div className="admin-head">
        <h1>Requests</h1>
        <button
          type="button"
          className="link-button"
          onClick={() => revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Refresh
        </button>
      </div>

      <nav className="admin-filters" aria-label="Filter by state">
        {FILTERS.map((filter) => (
          <Link
            key={filter.key}
            to={`${ADMIN_BASE}/?state=${filter.key}`}
            className={`admin-filter ${state === filter.key ? "is-active" : ""}`}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      {actionData?.error ? <p className="auth-error">{actionData.error}</p> : null}

      {requests.length === 0 ? (
        <p className="admin-empty">
          {state === "pending" ? "Nobody is waiting." : "Nothing here."}
        </p>
      ) : (
        <div className="admin-list">
          {requests.map((request) => (
            <RequestCard key={request.userId} request={request} />
          ))}
        </div>
      )}

      {/* Said rather than hidden. A list that silently stops at twenty-five
          reads as "that is everyone", which is the one thing a queue must never
          imply. Paging comes when there is a page worth turning. */}
      {hasMore ? (
        <p className="admin-meta admin-more">
          There are more than these. Narrow the filter to see the rest.
        </p>
      ) : null}
    </section>
  );
}
