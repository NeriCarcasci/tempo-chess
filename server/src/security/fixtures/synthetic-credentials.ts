/**
 * Synthetic secret-shaped fixtures.
 *
 * Every value here is invented for the redaction assertions. None of them is, or
 * has ever been, a live credential: the hosts do not resolve, the JWT is signed
 * with nothing, and the keys match the vendor prefixes only so the redactor is
 * exercised against the shapes it will really meet.
 *
 * This file is the one named fixture the leak scanner excludes, which is why the
 * exclusion is a single explicit path rather than a pattern.
 */

export const SYNTHETIC_DATABASE_URL =
  "postgresql://forma_api:synthetic-not-a-real-password@db.synthetic.invalid:6543/postgres";

export const SYNTHETIC_PASSWORD = "synthetic-not-a-real-password";

export const SYNTHETIC_BEARER_TOKEN = "synthetic-bearer-value-0000000000";

export const SYNTHETIC_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtZml4dHVyZSJ9.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA";

export const SYNTHETIC_API_KEY = "sb_secret_syntheticfixturekeyvalue0000";

export const SYNTHETIC_SQL =
  "select id, email, plan from public.profiles where email = 'someone@synthetic.invalid'";

export const SYNTHETIC_ROW_PAYLOAD =
  '{"id":"00000000-0000-4000-8000-000000000001","email":"someone@synthetic.invalid","plan":"pro"}';

export const SYNTHETIC_PROVIDER_PAYLOAD =
  '{"provider":"synthetic","perfs":{"blitz":{"rating":1873}},"username":"synthetic-player"}';

/** Combined arbitrary payload used by the live API and pipeline failure probes. */
export const SYNTHETIC_FAILURE_PAYLOAD =
  `e01-raw-exception-marker someone@synthetic.invalid ${SYNTHETIC_PROVIDER_PAYLOAD}`;

/** Bare caller/provider value used to prove logging is allowlist-only. */
export const SYNTHETIC_ARBITRARY_PROVIDER_VALUE = "e01arbitraryprovidervalue";

export const SYNTHETIC_PGN =
  "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6";

export const SYNTHETIC_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

/** Cloud Run metadata fixtures for the secret-binding assertions. */
export const SYNTHETIC_METADATA = {
  exact: {
    env: [
      { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "forma-api-db-url", key: "1" } } },
      {
        name: "DATABASE_URL_SECRET_VERSION",
        value: "projects/tempo-chess-neri/secrets/forma-api-db-url/versions/1",
      },
    ],
  },
  literal: {
    env: [
      { name: "DATABASE_URL", value: SYNTHETIC_DATABASE_URL },
      {
        name: "DATABASE_URL_SECRET_VERSION",
        value: "projects/tempo-chess-neri/secrets/forma-api-db-url/versions/1",
      },
    ],
  },
  wrongSecret: {
    env: [
      { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "some-other-secret", key: "1" } } },
      {
        name: "DATABASE_URL_SECRET_VERSION",
        value: "projects/tempo-chess-neri/secrets/forma-api-db-url/versions/1",
      },
    ],
  },
  wrongVersion: {
    env: [
      { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "forma-api-db-url", key: "2" } } },
      {
        name: "DATABASE_URL_SECRET_VERSION",
        value: "projects/tempo-chess-neri/secrets/forma-api-db-url/versions/2",
      },
    ],
  },
} as const;

/**
 * Synthetic connection strings used by the configuration and startup assertions.
 * They live here rather than inline in the gates so the leak scanner keeps its
 * full reach over every other tracked file: this file is the one named fixture
 * exclusion, and credential-shaped literals belong in it.
 */
export const SYNTHETIC_POOLED_URL =
  "postgresql://forma_api.synthetic-ref:synthetic@127.0.0.1:6543/postgres";

/** Deterministically unreachable endpoint for real-process rejection probes. */
export const SYNTHETIC_UNREACHABLE_DATABASE_URL =
  "postgresql://forma_api:synthetic-unreachable@127.0.0.1:1/postgres?connect_timeout=1";

/** A deployed-shaped pooled URL for the production project ref. */
export function syntheticDeployedUrl(role: string, projectRef: string, port = 6543): string {
  return `postgresql://${role}.${projectRef}:pw@pooler.invalid:${port}/postgres`;
}

/** An owner-role URL on the wrong port, for the startup-rejection assertions. */
export const SYNTHETIC_OWNER_URL = "postgresql://postgres:pw@pooler.invalid:5432/postgres";
