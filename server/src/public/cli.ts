/**
 * `npm run editorial -- <command>` — the editorial workflow, from a terminal.
 *
 * Publishing is not a product feature, so it is not a route. It is an operator
 * with a JSON file describing what they are about to make public, and a command
 * that refuses when the grounds are not there and says all of what is missing
 * rather than the first thing.
 *
 * Commands:
 *
 *   check    --file plan.json      What would stop this being published.
 *   publish  --file plan.json      Publish it, or refuse and list the blockers.
 *   withdraw --slug s --reason r   Take it down. The evidence stays.
 *   consent-withdrawn --id c --note n
 *                                  Record that somebody changed their mind.
 *
 * The plan file is the `CaseStudyInput` shape: slug, subjectId, runId,
 * publicationId, sourceId, consentId, reviewId, title, summary, caveats,
 * identifiesPlayerPublicly.
 */

import { readFileSync } from "node:fs";
import {
  NotReadyToPublish,
  publishCaseStudy,
  readiness,
  withdrawCaseStudy,
  withdrawConsent,
  type CaseStudyInput,
} from "./editorial.js";

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function planFrom(path: string): CaseStudyInput {
  return JSON.parse(readFileSync(path, "utf8")) as CaseStudyInput;
}

function reportBlockers(blockers: { code: string; detail: string }[]): void {
  for (const blocker of blockers) console.error(`  ${blocker.code}: ${blocker.detail}`);
}

const command = process.argv[2];

switch (command) {
  case "check": {
    const file = flag("file");
    if (!file) throw new Error("check needs --file <plan.json>");
    const decision = await readiness(planFrom(file));
    if (decision.ready) {
      console.log("ready to publish");
    } else {
      console.error(`not ready to publish (${decision.blockers.length}):`);
      reportBlockers(decision.blockers);
      process.exitCode = 1;
    }
    break;
  }
  case "publish": {
    const file = flag("file");
    if (!file) throw new Error("publish needs --file <plan.json>");
    try {
      const result = await publishCaseStudy(planFrom(file), { actorUserId: flag("actor") });
      console.log(`published ${result.caseStudyId} (${result.checksum.slice(0, 12)})`);
    } catch (error) {
      if (error instanceof NotReadyToPublish) {
        console.error(`refused (${error.blockers.length}):`);
        reportBlockers(error.blockers);
        process.exitCode = 1;
        break;
      }
      throw error;
    }
    break;
  }
  case "withdraw": {
    const slug = flag("slug");
    const reason = flag("reason");
    if (!slug || !reason) throw new Error("withdraw needs --slug <slug> --reason <reason>");
    const done = await withdrawCaseStudy({ slug, reason, actorUserId: flag("actor") });
    console.log(done ? `withdrawn ${slug}` : `${slug} was not published`);
    break;
  }
  case "consent-withdrawn": {
    const id = flag("id");
    const note = flag("note");
    if (!id || !note) throw new Error("consent-withdrawn needs --id <consentId> --note <note>");
    await withdrawConsent({ consentId: id, note });
    // Said out loud, because the operator should know the site is already
    // clean: the public read checks consent on every request.
    console.log(`consent ${id} withdrawn; any study resting on it is already off the surface`);
    break;
  }
  default:
    console.error("commands: check, publish, withdraw, consent-withdrawn");
    process.exitCode = 1;
}

const { client } = await import("../db/client.js");
await client.end({ timeout: 5 });
