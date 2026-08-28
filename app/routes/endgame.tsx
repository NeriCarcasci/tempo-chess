import { redirect } from "react-router";

/**
 * `/endgame` is now a section of `/patterns`, not a page.
 *
 * Three routes for three thirds of a game was three tabs saying the same
 * thing, and two of them were the same component with a different noun. The
 * route survives as a redirect because links to it exist - in the hub's own
 * history, in anything anybody has bookmarked - and a dead URL is a worse
 * answer than the section it used to be.
 */
export function clientLoader() {
  return redirect("/path#endgame");
}

export default function Endgame() {
  return null;
}
