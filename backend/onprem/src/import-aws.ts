// One-time import of the cloud deployment's DynamoDB tables. Takes the JSON from
// `aws dynamodb scan`. See docs/onprem/migrate-from-aws.md.
//
// Cognito accounts can't be moved (passwords aren't exportable and the `sub`s
// change), so everyone signs in fresh. Redeemed invites are reopened for that
// reason; each one is used up again on that person's first on-prem sign-in.
import { readFileSync } from "node:fs";
import { closeDb, migrate } from "./pg";
import { PutCommand } from "./shims/lib-dynamodb";
import { ddb, INVITES_TABLE, MOUNTS_TABLE, PUBLIC_SHARES_TABLE } from "./shims/db";

export function unmarshall(value: any): any {
  const [[type, v]] = Object.entries(value) as [[string, any]];
  switch (type) {
    case "S": return v;
    case "N": return Number(v);
    case "BOOL": return v;
    case "NULL": return null;
    case "L": return v.map(unmarshall);
    case "M": return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmarshall(x)]));
    case "SS": return v;
    case "NS": return v.map(Number);
    default: throw new Error(`Unsupported DynamoDB type ${type}`);
  }
}

export const REOPENED_INVITE_DAYS = 365;

export function transformInvite(item: any, now = new Date()): any {
  if (!item.redeemedAt) return item;
  const expires = new Date(now.getTime() + REOPENED_INVITE_DAYS * 86_400_000);
  return { ...item, redeemedAt: null, expiresAt: expires.toISOString(), ttl: Math.floor(expires.getTime() / 1000) };
}

async function load(file: string, table: string, transform: (item: any) => any): Promise<number> {
  const items = JSON.parse(readFileSync(file, "utf8")).Items.map(unmarshall);
  for (const item of items) await ddb.send(new PutCommand({ TableName: table, Item: transform(item) }));
  return items.length;
}

async function main(): Promise<void> {
  const [invites, mounts, shares] = process.argv.slice(2);
  const bucket = process.env.SHARES_BUCKET;
  if (!invites || !mounts || !shares || !bucket) {
    throw new Error("Usage: SHARES_BUCKET=... DATABASE_URL=... node import-aws.mjs invites.json mounts.json public-shares.json");
  }
  await migrate();
  const counts = {
    invites: await load(invites, INVITES_TABLE, (i) => transformInvite(i)),
    mounts: await load(mounts, MOUNTS_TABLE, (m) => ({ ...m, bucket })),
    publicShares: await load(shares, PUBLIC_SHARES_TABLE, (s) => ({ ...s, bucket })),
  };
  console.log(JSON.stringify({ evt: "import-done", ...counts }));
  await closeDb();
}

if (process.argv[1]?.endsWith("import-aws.mjs")) {
  // Config needs these to exist even though the import never serves a request.
  process.env.SITE_ORIGIN ??= "http://import";
  await main();
}
