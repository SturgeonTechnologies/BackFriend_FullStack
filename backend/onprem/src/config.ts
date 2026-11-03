function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export interface Config {
  port: number;
  siteOrigin: string;
  appName: string;
  databaseUrl: string;
  contentRoot: string;
  staticRoot: string;
  fileSigningKey: Buffer;
  maxUploadBytes: number;
  oidcIssuer: string;
  oidcJwksUrl: string;
  oidcClientIds: string[];
  oidcAlgorithms: string[];
  bootstrapAdmins: Set<string>;
  adminGroup: string;
  googleEnabled: boolean;
  facebookEnabled: boolean;
  trustedProxyHops: number;
}

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const signingKey = required("FILE_SIGNING_KEY");
  if (signingKey.length < 32) throw new Error("FILE_SIGNING_KEY must be at least 32 characters");
  const siteOrigin = required("SITE_ORIGIN").replace(/\/+$/, "");
  const issuer = required("OIDC_ISSUER").replace(/\/+$/, "");
  // The handlers read these two directly, and the first decides which "bucket" name is valid.
  process.env.SHARES_BUCKET ??= "content";
  process.env.ADMIN_GROUP ??= "admins";
  const clientIds = list("OIDC_CLIENT_IDS");
  if (clientIds.length === 0) throw new Error("OIDC_CLIENT_IDS is required");

  cached = {
    port: Number(process.env.PORT ?? 8080),
    siteOrigin,
    appName: process.env.APP_DISPLAY_NAME ?? "BackFriend",
    databaseUrl: required("DATABASE_URL"),
    contentRoot: required("CONTENT_ROOT"),
    staticRoot: process.env.STATIC_ROOT ?? "",
    fileSigningKey: Buffer.from(signingKey),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 ** 3),
    oidcIssuer: issuer,
    oidcJwksUrl: process.env.OIDC_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
    oidcClientIds: clientIds,
    oidcAlgorithms: list("OIDC_ALGORITHMS").length ? list("OIDC_ALGORITHMS") : ["RS256", "ES256"],
    bootstrapAdmins: new Set(list("BOOTSTRAP_ADMIN_EMAILS").map((e) => e.toLowerCase())),
    adminGroup: process.env.ADMIN_GROUP ?? "admins",
    googleEnabled: process.env.GOOGLE_ENABLED === "true",
    facebookEnabled: process.env.FACEBOOK_ENABLED === "true",
    trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 1),
  };
  return cached;
}

/** Tests change env between cases. */
export function resetConfigForTests(): void {
  cached = undefined;
}
