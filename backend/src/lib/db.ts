import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const base = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

export const INVITES_TABLE = process.env.INVITES_TABLE!;
export const MOUNTS_TABLE = process.env.MOUNTS_TABLE!;
export const PUBLIC_SHARES_TABLE = process.env.PUBLIC_SHARES_TABLE!;

/**
 * Reserved PublicSharesTable partition for admin explorer shares, which are
 * keyed by the full S3 key (no mount). Safe as a sentinel because real
 * mountPaths must match ^[a-z0-9]… and can never start with "_".
 */
export const BUCKET_PUBLIC_PARTITION = "__bucket__";

export interface InviteRow {
  email: string;
  groups: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  ttl: number;
  redeemedAt: string | null;
}

export interface MountRow {
  mountPath: string;   // e.g. "roms"
  bucket: string;      // e.g. "schuit-sharing"
  prefix: string;      // e.g. "Video_Game_ROMs/"  (always ends with "/")
  displayName: string; // e.g. "Video Game ROMs"
  description?: string;
  /**
   * Optional access control. If undefined or empty, the mount is visible to
   * every authenticated user. If non-empty, only listed lowercase emails
   * (plus admins, who always see everything) can see / browse it.
   */
  allowedEmails?: string[];
  createdBy: string;
  createdAt: string;
}

export interface PublicShareRow {
  mountPath: string; // partition key — the mount the file lives in
  path: string;      // sort key — file path relative to the mount prefix
  token: string;     // opaque random id used in the public URL (GSI: TokenIndex)
  bucket: string;    // resolved S3 bucket
  key: string;       // full S3 object key (mount.prefix + path)
  createdBy: string;
  createdAt: string;
}
