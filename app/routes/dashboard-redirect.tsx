import { redirect } from "react-router";

/**
 * `/dashboard` became `/today` when the primary nav moved to the three phases
 * of a game plus the queue that draws from them. This keeps every bookmark,
 * back button and older link working rather than dead-ending them.
 */
export async function clientLoader({ request }: { request: Request }) {
  const url = new URL(request.url);
  throw redirect(`/today${url.search}`);
}

export default function DashboardRedirect() {
  return null;
}
