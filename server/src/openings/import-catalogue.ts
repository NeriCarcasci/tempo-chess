import { client } from "../db/client.js";
import { importOpeningCatalogue } from "./catalogue.js";

try {
  console.log(await importOpeningCatalogue());
} finally {
  await client.end();
}
