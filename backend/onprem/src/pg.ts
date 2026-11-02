import pg from "pg";
import { config } from "./config";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config().databaseUrl, max: 10 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** The three DynamoDB tables keep their shape, as JSONB documents in one table. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  tbl    text   NOT NULL,
  pk     text   NOT NULL,
  sk     text   NOT NULL DEFAULT '',
  token  text,
  ttl    bigint,
  doc    jsonb  NOT NULL,
  PRIMARY KEY (tbl, pk, sk)
);
CREATE UNIQUE INDEX IF NOT EXISTS items_token ON items (token) WHERE token IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  sub        text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  groups     text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
`;

export async function migrate(): Promise<void> {
  await db().query(SCHEMA);
}

/** Replaces DynamoDB's TTL expiry of invite rows. */
export async function purgeExpired(): Promise<number> {
  const res = await db().query(
    "DELETE FROM items WHERE ttl IS NOT NULL AND ttl < extract(epoch FROM now())",
  );
  return res.rowCount ?? 0;
}
