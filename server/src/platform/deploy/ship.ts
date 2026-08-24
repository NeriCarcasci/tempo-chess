/**
 * `npm run deploy:ship` — build one digest and put every service on it.
 *
 * Written because the same mistake happened twice in one afternoon, both times
 * silently.
 *
 * The first: services were deployed one at a time from memory, and `forma-ops`
 * was forgotten. It is the deployment that dispatches the outbox, so it held an
 * image that had never heard of the `maia-rating` queue and quietly refused to
 * route anything to it. Nothing errored; work simply sat in the ledger. The
 * list of services now comes from the topology, so it cannot be short.
 *
 * The second: `gcloud run deploy` prints "serving 100 percent of traffic" and
 * then does not move traffic at all, because a tagged revision already holds
 * it. The promotion plan's staged rollout leaves exactly that state behind, so
 * every deploy after one silently landed on a revision nobody was served. Every
 * deploy here is followed by an explicit traffic shift, and then by reading
 * back what is actually serving.
 *
 * That last step is the point. A deploy script that does not verify is a script
 * that reports its own intentions.
 */

import { spawnSync } from "node:child_process";

import { DEPLOYMENTS, type DeploymentEntry } from "../topology.js";

const PROJECT = process.env.FORMA_GCP_PROJECT ?? "tempo-chess-neri";
const REGION = process.env.FORMA_GCP_REGION ?? "europe-west1";
const REPO = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy`;

/**
 * `forma-maia` is built from its own target and is not on the base digest.
 *
 * Named rather than inferred, because the failure mode of guessing is putting
 * the lean image on the service that needs the model and finding out when a
 * player waits forever for a move.
 */
const OWN_IMAGE = new Set(["forma-maia"]);

function gcloud(args: string[], quiet = false): string {
  const result = spawnSync("gcloud", [...args, "--project", PROJECT], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`gcloud ${args[0]} ${args[1] ?? ""} failed: ${detail.slice(0, 400)}`);
  }
  const out = (result.stdout ?? "").trim();
  if (!quiet && out) console.log(out.split("\n").slice(-1)[0]);
  return out;
}

function servesBaseImage(entry: DeploymentEntry): boolean {
  return !OWN_IMAGE.has(entry.name);
}

const revision = process.argv[2];
if (!revision) {
  console.error("usage: npm run deploy:ship -- <git-sha>");
  console.error("The sha is the tag the image is built under, so a serving revision names its source.");
  process.exit(2);
}

const tag = `${REPO}/forma:${revision}`;
const services = DEPLOYMENTS.filter(servesBaseImage);

console.log(`building ${tag}`);
gcloud(["builds", "submit", "--region", REGION, "--tag", tag], true);

// The digest, not the tag. A tag can be moved; a digest is the thing that was
// tested, which is the promotion plan's own rule.
const digest = gcloud(
  ["artifacts", "docker", "images", "describe", tag, "--format=value(image_summary.fully_qualified_digest)"],
  true,
);
console.log(`digest ${digest}`);
console.log("");

for (const service of services) {
  console.log(`  ${service.name}`);
  gcloud(["run", "deploy", service.name, "--region", REGION, "--image", digest], true);
  // Always, not only when a tag pin is suspected: the cost is one call and the
  // cost of skipping it is a deploy that reports success and serves nothing.
  gcloud(["run", "services", "update-traffic", service.name, "--region", REGION, "--to-latest"], true);
}

console.log("");
console.log("  serving now:");
let drifted = 0;
for (const service of services) {
  const serving = gcloud(
    [
      "run",
      "services",
      "describe",
      service.name,
      "--region",
      REGION,
      "--format=value(status.traffic.filter(\"percent=100\").extract(\"revisionName\"))",
    ],
    true,
  );
  const image = gcloud(
    [
      "run",
      "revisions",
      "describe",
      serving.trim(),
      "--region",
      REGION,
      "--format=value(spec.containers[0].image)",
    ],
    true,
  );
  const ok = image.trim() === digest;
  if (!ok) drifted += 1;
  console.log(`    ${ok ? "ok  " : "DRIFT"} ${service.name.padEnd(18)} ${serving.trim()}`);
}

if (drifted > 0) {
  console.error(`${drifted} service(s) are not serving the digest that was just built`);
  process.exit(1);
}
console.log("");
console.log(`every service on the base image is serving ${revision}`);
console.log("forma-maia builds from cloudbuild.maia3.yaml and is deployed separately.");
