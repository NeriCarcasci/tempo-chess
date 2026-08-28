import { redirect } from "react-router";

/**
 * `/mistakes` is `/patterns` now, and this stub is why the old URL still
 * lands somewhere: it lived in the nav for a revision, so it is in history,
 * bookmarks and muscle memory, and a dead URL is a worse answer than the
 * page under its new name. The rename is the client contract's: the page
 * describes what keeps happening, which is not only the failures.
 */
export function clientLoader() {
  return redirect("/path");
}

export default function MistakesRedirect() {
  return null;
}
