import { client } from "../db/client.js";
import { reconcileLegacyImports } from "./legacy-shadow.js";

/**
 * Print the legacy-to-ledger reconciliation report.
 *
 * The operator artifact for the epic's migration contract: it says how many
 * committed legacy imports have a durable ledger record and where the two
 * disagree. It reads and never repairs — a reconciliation that quietly fixed
 * what it measured could not be used to decide whether a cutover is safe.
 *
 * Identifiers only. No username, no email, no game.
 */

const report = await reconcileLegacyImports();
console.log(
  JSON.stringify(
    {
      event: "legacy_ledger_reconciliation",
      legacyImports: report.legacyImports,
      shadowWorkflows: report.shadowWorkflows,
      missingShadow: report.missingShadow,
      stateDisagreements: report.stateDisagreements,
      examples: report.examples,
    },
    null,
    2,
  ),
);
await client.end({ timeout: 5 });
process.exit(report.missingShadow === 0 && report.stateDisagreements === 0 ? 0 : 1);
