import { z } from "zod";
import { resolveAnalysisSubject, withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { MAX_BOOK_LINE_PLIES, parseLine, readOpeningBook } from "../../openings/book.js";

/**
 * The opening book.
 *
 * `GET /v1/openings/explorer` finds the line the player keeps getting wrong.
 * This is the other half of that loop: the thing they study to fix it. It is
 * deliberately not a second explorer — it answers about one position, in depth,
 * and it exists because "your Sicilian tears at move 7" is a diagnosis with no
 * treatment attached to it.
 *
 * Three answers, which is the whole endpoint:
 *
 *   - **What is this called.** The deepest position the catalogue still names
 *     on the caller's own move order, with its ECO code and the line that
 *     reaches it. Not only the exact position: one move past the book there is
 *     no row, and "unknown" is a true and useless answer to a player who is two
 *     plies into a Najdorf.
 *   - **What does the book play.** Every catalogue move from the position, with
 *     what each one leads to, ordered so the caller's own move sits at the top
 *     of the list they are being asked to compare against.
 *   - **Where did you leave it.** The first move of the given line the
 *     catalogue has no edge for, and the last position it still recognised.
 *
 * ## Authenticated, not public
 *
 * The catalogue itself is CC0 reference data and a public endpoint over it
 * would leak nothing. This endpoint is not that. Two of its three answers are
 * about the caller — how many of *their* games played each book move, and where
 * *their* line departed — and those read `chess.subject_games`, which is tenant
 * data behind row level security. Splitting the reference half onto a public
 * route would mean the screen makes two round trips to draw one panel, and the
 * two halves could describe different positions.
 *
 * The position key in the query is also not neutral. It is only ever a position
 * the caller's own games reached, handed over by the sheet or the explorer, so
 * an unauthenticated version of this route would be an uncapped path into a
 * join by any position anybody cared to name.
 *
 * The response is therefore `private` in `Cache-Control` even though most of it
 * is a public catalogue: a shared cache holding one player's counts under a
 * position key would serve them to the next player who asked about that line.
 */

/**
 * A core position key: board, side to move, castling rights, en-passant square.
 *
 * Expressed as a pattern rather than a `refine` so it survives into the OpenAPI
 * document — a constraint the generated contract does not carry is a constraint
 * every generated client is free to violate. The castling field is `-` or one
 * to four of `KQkq`; writing it as four optionals would also match the empty
 * string and let a double space through.
 */
const CORE_KEY =
  /^(?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8} [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36])$/;

/** UCI moves separated by spaces or commas: `e2e4 e7e5 g1f3`. */
const UCI_LINE = /^[a-h][1-8][a-h][1-8][qrbn]?(?:[ ,]+[a-h][1-8][a-h][1-8][qrbn]?)*$/;

const bookQuery = z.object({
  /** The position being studied. */
  position: z.string().trim().regex(CORE_KEY),
  /**
   * The moves that reached it, from the initial position. Optional: without it
   * the catalogue's own representative line names the opening, but there is no
   * departure to report, because nobody said which way the caller came.
   */
  line: z
    .string()
    .trim()
    .regex(UCI_LINE)
    // Five characters per move plus a separator is the loosest bound that
    // still refuses a query string built to make the recursion long.
    .max(MAX_BOOK_LINE_PLIES * 6)
    .optional(),
});

const openingSchema = z.object({
  name: z.string(),
  eco: z.string().nullable(),
  family: z.string(),
  variation: z.string().nullable(),
  ply: z.number().int(),
  lineSan: z.string(),
  lineUci: z.string(),
  /** False when the name comes from an earlier position on the line. */
  atRequestedPosition: z.boolean(),
});

const continuationSchema = z.object({
  uci: z.string(),
  san: z.string(),
  /** What the resulting position is called, when the catalogue names it. */
  name: z.string().nullable(),
  eco: z.string().nullable(),
  yourGames: z.number().int(),
});

const playerMoveSchema = z.object({
  uci: z.string(),
  /** SAN as the caller's own game recorded it. */
  san: z.string().nullable(),
  inBook: z.boolean(),
  games: z.number().int(),
  /**
   * Of `games`, the ones a published analysis judged. The gap is unanalysed
   * games; `games - mistakes` is not a count of moves that went well.
   */
  judged: z.number().int(),
  /** Of `judged`, the ones outside the versioned tolerance. */
  mistakes: z.number().int(),
});

const departureSchema = z.object({
  ply: z.number().int(),
  uci: z.string(),
  side: z.enum(["white", "black"]),
  lastBookKey: z.string(),
  lastBookName: z.string().nullable(),
});

const bookSchema = z.object({
  /** Newest row behind this answer. Never a clock; see `openings/book.ts`. */
  asOf: z.string().nullable(),
  requested: z.object({ position: z.string(), line: z.string().nullable() }),
  /** Null when the catalogue recognises neither the position nor the line. */
  opening: openingSchema.nullable(),
  book: z.object({
    fromKey: z.string(),
    atRequestedPosition: z.boolean(),
    inBookPlies: z.number().int(),
    continuations: z.array(continuationSchema),
  }),
  yourMoves: z.array(playerMoveSchema),
  /** Null when the whole line is book, or when no line was given. */
  departure: departureSchema.nullable(),
});

const bookRoute: RouteDefinition<
  z.infer<typeof bookQuery>,
  never,
  z.infer<typeof bookSchema>
> = {
  method: "GET",
  path: "/v1/openings/book",
  operationId: "getOpeningBook",
  summary: "What this opening is called, what the book plays, and where you left it",
  description:
    "The named-opening catalogue at one position, with the caller's own games counted against it. `opening` names the deepest position the catalogue still recognises on the given line, `book.continuations` are the catalogue's moves from there, and `departure` is the first move of the line the catalogue has no edge for. `yourMoves` separates games played from games judged, so an unanalysed game is never rendered as a move that went well.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  querySchema: bookQuery,
  dataSchema: bookSchema,
  // The catalogue changes only on a re-import and the caller's counts only on a
  // publication, so studying a line re-reads the same bytes and an ETag turns
  // those reads into 304s.
  etag: true,
  // Private despite most of the body being a public catalogue: the counts and
  // the departure are the caller's.
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, query }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");

    // The pattern above already guarantees the shape, so this cannot throw for
    // a request that reached here. It is the same parse the module exposes to
    // direct callers, kept rather than inlined so the route and a script agree
    // on what a line is.
    let line: string[] | null = null;
    try {
      line = query.line === undefined ? null : parseLine(query.line);
    } catch {
      throw new ProblemError("VALIDATION_FAILED", {
        detail: "The line must be UCI moves from the initial position.",
        errors: [{ path: "query.line", code: "INVALID_UCI_LINE", message: "expected UCI moves" }],
      });
    }

    return withActorContext(auth.profileId, async (sql) => {
      // Not `auth.subjects[0]` — that is the profile id, always, and a query
      // scoped by it matches nothing and reports an empty account.
      const subjectId = await resolveAnalysisSubject(sql, auth.profileId);
      // A caller with no subject still gets the catalogue. Their own counts are
      // absent rather than zero-filled: `yourMoves` is empty, which the screen
      // reads as "nothing of yours here" rather than "you never played this".
      return { data: await readOpeningBook(sql, subjectId, { position: query.position, line }) };
    });
  },
};

export const OPENING_BOOK_ROUTES = [bookRoute] as const;
