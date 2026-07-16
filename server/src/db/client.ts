import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Supabase poolers (transaction mode) don't support prepared statements.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
export { client };
