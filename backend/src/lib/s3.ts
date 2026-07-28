import {
  S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({});

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
