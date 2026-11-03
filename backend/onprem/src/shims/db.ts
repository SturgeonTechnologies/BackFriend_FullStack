// Replaces src/lib/db.ts. Implements only the DynamoDB calls the handlers make,
// and throws on anything else, so a new expression in a handler fails loudly in
// tests instead of silently skipping a condition.
import type { PoolClient } from "pg";
import { db } from "../pg";
import { Command, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "./lib-dynamodb";

export type { InviteRow, MountRow, PublicShareRow } from "../../../src/lib/db";

export const INVITES_TABLE = "invites";
export const MOUNTS_TABLE = "mounts";
export const PUBLIC_SHARES_TABLE = "public-shares";
export const BUCKET_PUBLIC_PARTITION = "__bucket__";

const KEYS: Record<string, [string, string?]> = {
  [INVITES_TABLE]: ["email"],
  [MOUNTS_TABLE]: ["mountPath"],
  [PUBLIC_SHARES_TABLE]: ["mountPath", "path"],
};

type Doc = Record<string, any>;

function keyOf(table: string, source: Doc): { pk: string; sk: string } {
  const spec = KEYS[table];
  if (!spec) throw new Error(`Unknown table ${table}`);
  return { pk: String(source[spec[0]]), sk: spec[1] ? String(source[spec[1]]) : "" };
}

function conditionFailed(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

/** Only the forms in createInvite/createMount/invites: attribute checks and `attr < :v`, joined by OR. */
export function evaluateCondition(expr: string, existing: Doc | undefined, values: Doc = {}): boolean {
  return expr.split(/\s+OR\s+/).some((part) => {
    const t = part.trim();
    let m = t.match(/^attribute_not_exists\((\w+)\)$/);
    if (m) return !existing || !(m[1] in existing);
    m = t.match(/^attribute_exists\((\w+)\)$/);
    if (m) return !!existing && m[1] in existing;
    m = t.match(/^(\w+) < (:\w+)$/);
    if (m) return !!existing && existing[m[1]] < values[m[2]];
    throw new Error(`Unsupported condition: ${t}`);
  });
}

/** `SET a = :a, #b = :b REMOVE #c, d`, the only update forms the handlers use. */
export function applyUpdate(doc: Doc, expr: string, names: Doc = {}, values: Doc = {}): Doc {
  const out = { ...doc };
  const m = expr.trim().match(/^(?:SET (.+?))?\s*(?:REMOVE (.+))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`Unsupported update: ${expr}`);
  const name = (n: string) => {
    if (n.startsWith("#") && !(n in names)) throw new Error(`Missing attribute name ${n}`);
    return n.startsWith("#") ? names[n] : n;
  };
  for (const clause of m[1]?.split(",") ?? []) {
    const parts = clause.trim().match(/^(#?\w+) = (:\w+)$/);
    if (!parts || !(parts[2] in values)) throw new Error(`Unsupported update clause: ${clause}`);
    out[name(parts[1])] = values[parts[2]];
  }
  for (const attr of m[2]?.split(",") ?? []) delete out[name(attr.trim())];
  return out;
}

async function upsert(client: PoolClient, table: string, doc: Doc): Promise<void> {
  const { pk, sk } = keyOf(table, doc);
  await client.query(
    `INSERT INTO items (tbl, pk, sk, token, ttl, doc) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tbl, pk, sk) DO UPDATE SET token = $4, ttl = $5, doc = $6`,
    [table, pk, sk, doc.token ?? null, doc.ttl ?? null, JSON.stringify(doc)],
  );
}

async function locked(client: PoolClient, table: string, key: Doc): Promise<Doc | undefined> {
  const { pk, sk } = keyOf(table, key);
  const res = await client.query(
    "SELECT doc FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3 FOR UPDATE",
    [table, pk, sk],
  );
  return res.rows[0]?.doc;
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // Serialises writers to the same key, including first inserts where there is no row to lock yet.
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function lockKey(client: PoolClient, table: string, key: Doc): Promise<void> {
  const { pk, sk } = keyOf(table, key);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([table, pk, sk])]);
}

export const ddb = {
  async send(cmd: Command): Promise<any> {
    const i = cmd.input;

    if (cmd instanceof GetCommand) {
      const { pk, sk } = keyOf(i.TableName, i.Key);
      const res = await db().query("SELECT doc FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3", [i.TableName, pk, sk]);
      return { Item: res.rows[0]?.doc };
    }

    if (cmd instanceof PutCommand) {
      return inTransaction(async (client) => {
        await lockKey(client, i.TableName, i.Item);
        if (i.ConditionExpression) {
          const existing = await locked(client, i.TableName, i.Item);
          if (!evaluateCondition(i.ConditionExpression, existing, i.ExpressionAttributeValues)) throw conditionFailed();
        }
        await upsert(client, i.TableName, i.Item);
        return {};
      });
    }

    if (cmd instanceof UpdateCommand) {
      if (i.ConditionExpression) throw new Error("Unsupported: conditional update");
      return inTransaction(async (client) => {
        await lockKey(client, i.TableName, i.Key);
        const existing = await locked(client, i.TableName, i.Key);
        const next = applyUpdate({ ...(existing ?? i.Key) }, i.UpdateExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues);
        await upsert(client, i.TableName, next);
        return { Attributes: next };
      });
    }

    if (cmd instanceof DeleteCommand) {
      const { pk, sk } = keyOf(i.TableName, i.Key);
      await db().query("DELETE FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3", [i.TableName, pk, sk]);
      return {};
    }

    if (cmd instanceof ScanCommand) {
      const res = await db().query("SELECT doc FROM items WHERE tbl = $1 ORDER BY pk, sk LIMIT $2", [i.TableName, i.Limit ?? 1000]);
      return { Items: res.rows.map((r) => r.doc) };
    }

    if (cmd instanceof QueryCommand) {
      const value = Object.values(i.ExpressionAttributeValues ?? {})[0];
      if (i.IndexName === "TokenIndex" && i.KeyConditionExpression === "#t = :t") {
        const res = await db().query("SELECT doc FROM items WHERE token = $1 AND tbl = $2", [value, i.TableName]);
        return { Items: res.rows.map((r) => r.doc) };
      }
      if (!i.IndexName && i.KeyConditionExpression === "mountPath = :m") {
        const res = await db().query("SELECT doc FROM items WHERE tbl = $1 AND pk = $2", [i.TableName, value]);
        return { Items: res.rows.map((r) => r.doc) };
      }
      throw new Error(`Unsupported query: ${i.KeyConditionExpression}`);
    }

    throw new Error(`Unsupported command: ${cmd.constructor.name}`);
  },
};
