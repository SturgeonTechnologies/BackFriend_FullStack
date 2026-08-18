import {
  S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand,
  DeleteObjectCommand, DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Pin the region explicitly when SharesBucket lives outside this stack's own
// region -- a client for one region gets PermanentRedirect errors on every
// call to a bucket in another.
export const s3 = new S3Client(
  process.env.SHARES_BUCKET_REGION ? { region: process.env.SHARES_BUCKET_REGION } : {},
);

export interface S3Object { key: string; size: number; lastModified?: string; }

/** All objects under a prefix with metadata (paginated, no delimiter — recurses). */
export async function listAllObjects(bucket: string, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** All object keys under a prefix (paginated, no delimiter — recurses). */
export async function listAllKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Delete objects in batches of 1000 (DeleteObjects limit). Returns count deleted. */
export async function deleteObjects(bucket: string, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    deleted += batch.length - (res.Errors?.length ?? 0);
  }
  return deleted;
}

/**
 * Presigned PUT URL for a direct browser → S3 upload. ContentType is
 * intentionally not part of the signed request, so the browser may send any
 * Content-Type without breaking the signature.
 */
export async function presignPut(
  bucket: string,
  key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Create a "directory" in S3 by writing a zero-byte marker object whose key
 * ends in "/". S3 has no real folders; this makes an empty prefix show up in
 * delimiter-based listings (and lets the explorer navigate into it).
 */
export async function putFolderMarker(bucket: string, key: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "" }));
}

export async function presignGet(
  bucket: string,
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export interface S3ListResult {
  folders: string[]; // full keys ending in "/"
  files: { key: string; size: number; lastModified?: string }[];
  truncated: boolean;
  nextContinuationToken?: string;
}

/**
 * List one "directory level" at the given prefix using Delimiter='/'.
 * Folders are returned as the full S3 keys (ending with "/").
 */
export async function listDir(
  bucket: string,
  prefix: string,
  continuationToken?: string,
  maxKeys = 1000,
): Promise<S3ListResult> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: "/",
      ContinuationToken: continuationToken,
      MaxKeys: maxKeys,
    }),
  );

  const folders = (res.CommonPrefixes ?? [])
    .map((p) => p.Prefix!)
    .filter(Boolean);

  const files = (res.Contents ?? [])
    // Skip the folder placeholder object if present (same as the prefix itself).
    .filter((obj) => obj.Key && obj.Key !== prefix)
    .map((obj) => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString(),
    }));

  return {
    folders,
    files,
    truncated: !!res.IsTruncated,
    nextContinuationToken: res.NextContinuationToken,
  };
}
