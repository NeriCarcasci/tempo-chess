import { redirect } from "react-router";

/**
 * `/patterns` is `/path` now.
 *
 * The page named its content; it names its purpose now. Three tabs, three
 * meanings: Today is what is happening, Path is what to work through,
 * Practice is what is due right now. The URL survives as a redirect because
 * it shipped in the nav, and a dead URL is a worse answer than the page
 * under its new name.
 */
export function clientLoader() {
  return redirect("/path");
}

export default function PatternsRedirect() {
  return null;
}
