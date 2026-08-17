import { client } from "../db/client.js";
import { SYNTHETIC_FAILURE_PAYLOAD } from "../security/fixtures/synthetic-credentials.js";
import { kickWorker, settleImportFailure } from "./service.js";

async function main(): Promise<void> {
  const scenario = process.argv[2];
  if (scenario === "outer-worker-database-failure") {
    kickWorker();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } else if (scenario === "import-double-failure") {
    await settleImportFailure("00000000-0000-4000-8000-000000000001", new Error(SYNTHETIC_FAILURE_PAYLOAD));
  } else {
    throw new Error("unknown fire-and-forget adversarial scenario");
  }
  await client.end({ timeout: 1 });
}

await main();
