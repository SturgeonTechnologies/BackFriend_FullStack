import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE, MountRow } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { canSeeMount } from "../../lib/mounts";
import { listAllObjects } from "../../lib/s3";
import { ok, error } from "../../lib/response";

const MAX_RESULTS = 200;

/**
 * GET /search?q=<term>
 *
 * Global filename search across every mount the caller can see. Recursively
 * lists each accessible mount and returns files whose path (relative to the
 * mount) contains the term (case-insensitive). Tier-1 approach: fine at this
 * scale; revisit with an index if the file count grows large.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");

    const q = String(event.queryStringParameters?.q ?? "").trim().toLowerCase();
    if (!q) return ok({ query: "", results: [], truncated: false });

    const scan = await ddb.send(new ScanCommand({ TableName: MOUNTS_TABLE, Limit: 500 }));
    const visible = ((scan.Items ?? []) as MountRow[]).filter((m) => canSeeMount(caller, m));

    const results: {
      mountPath: string; mountName: string; name: string; path: string;
      size: number; lastModified?: string;
    }[] = [];
    let truncated = false;

    outer: for (const mount of visible) {
      const objs = await listAllObjects(mount.bucket, mount.prefix);
      for (const o of objs) {
        const rel = o.key.startsWith(mount.prefix) ? o.key.slice(mount.prefix.length) : o.key;
        if (!rel || rel.endsWith("/")) continue; // skip folder markers
        if (!rel.toLowerCase().includes(q)) continue;
        if (results.length >= MAX_RESULTS) { truncated = true; break outer; }
        results.push({
          mountPath: mount.mountPath,
          mountName: mount.displayName,
          name: rel.split("/").pop() ?? rel,
          path: rel,
          size: o.size,
          lastModified: o.lastModified,
        });
      }
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return ok({ query: q, results, truncated });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};
