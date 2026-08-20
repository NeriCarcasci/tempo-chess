/**
 * The handle a query helper accepts.
 *
 * `postgres`'s `Sql` and `TransactionSql` are siblings rather than parent and
 * child — both extend `ISql`, and neither is assignable to the other. A helper
 * typed as `Sql` therefore cannot be called with a transaction handle, which is
 * the wrong constraint: almost every helper in this codebase must work both
 * standalone and as one step inside a caller's transaction, because that is how
 * a multi-statement invariant is kept atomic.
 *
 * So helpers take `Queryable`. A function that genuinely needs to *open* a
 * transaction keeps `Sql`, and the type then says so.
 */

import type { ISql } from "postgres";

export type Queryable = ISql;
