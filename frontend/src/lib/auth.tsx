import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BASE_PATH, withBase } from "./basePath";
import { challengeFromVerifier, randomState, randomVerifier } from "./pkce";

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN;
const CLIENT_ID = import.meta.env.VITE_USER_POOL_CLIENT_ID;
// Set only by the on-prem image build. Everything there is same-origin, so one
// image works on any domain. Unset (the cloud build) means Cognito, as before.
const IS_OIDC = !!import.meta.env.VITE_OIDC_ISSUER_PATH;
const OIDC_ISSUER_PATH = IS_OIDC ? withBase(import.meta.env.VITE_OIDC_ISSUER_PATH as string) : "";
const API_BASE = withBase(import.meta.env.VITE_API_BASE as string);
const REDIRECT_URI = IS_OIDC ? `${window.location.origin}${BASE_PATH}/auth/callback` : import.meta.env.VITE_REDIRECT_URI;
const LOGOUT_REDIRECT = IS_OIDC ? `${window.location.origin}${BASE_PATH}/login` : import.meta.env.VITE_LOGOUT_REDIRECT;
const AUTHORIZE_URL = IS_OIDC ? `${OIDC_ISSUER_PATH}/protocol/openid-connect/auth` : `${COGNITO_DOMAIN}/oauth2/authorize`;
const TOKEN_URL = IS_OIDC ? `${OIDC_ISSUER_PATH}/protocol/openid-connect/token` : `${COGNITO_DOMAIN}/oauth2/token`;
const LOGOUT_URL = IS_OIDC ? `${OIDC_ISSUER_PATH}/protocol/openid-connect/logout` : `${COGNITO_DOMAIN}/logout`;
export const SS_DENIED = "rh_denied";

const SS_VERIFIER = "rh_pkce_verifier";
const SS_STATE = "rh_oauth_state";
const SS_RETURN = "rh_return_to";
const LS_TOKENS = "rh_tokens";

interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
  "cognito:groups"?: string[];
}

function decodeJwt<T = any>(jwt: string): T {
  const payload = jwt.split(".")[1];
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(b64)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join(""),
  );
  return JSON.parse(json) as T;
}

function saveTokens(t: Tokens) {
  localStorage.setItem(LS_TOKENS, JSON.stringify(t));
}
function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(LS_TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch { return null; }
}
function clearTokens() {
  localStorage.removeItem(LS_TOKENS);
}

export interface AuthState {
  email: string | null;
  name: string | null;
  groups: string[];
  isAdmin: boolean;
  idToken: string | null;
  loading: boolean;
  loginWithGoogle: (returnTo?: string) => Promise<void>;
  loginWithFacebook: (returnTo?: string) => Promise<void>;
  loginWithEmail: (returnTo?: string) => Promise<void>;
  logout: () => void;
  handleCallback: () => Promise<string | null>; // returns returnTo path (if any)
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [tokens, setTokens] = useState<Tokens | null>(() => loadTokens());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // If a token exists and is expired, drop it. (We don't auto-refresh in this MVP —
    // the user will click "Sign in" again, which with Google SSO is near-instant.)
    const t = loadTokens();
    if (t && t.expiresAt < Date.now()) {
      clearTokens();
      setTokens(null);
    } else {
      setTokens(t);
    }
    setLoading(false);
  }, []);

  // Shared start of the OAuth Authorization Code + PKCE flow. Both sign-in
  // buttons use the exact same code→token exchange (handleCallback); the only
  // difference is whether we pin `identity_provider`:
  //   - "Google"    → hosted UI bounces straight to Google.
  //   - "Facebook"  → hosted UI bounces straight to Facebook.
  //   - undefined   → hosted UI shows its own page (email/password form,
  //                   "Sign up", "Forgot password", and Google/Facebook buttons).
  const startAuthorize = useCallback(async (identityProvider?: string, returnTo?: string) => {
    const verifier = randomVerifier();
    const challenge = await challengeFromVerifier(verifier);
    const state = randomState();
    sessionStorage.setItem(SS_VERIFIER, verifier);
    sessionStorage.setItem(SS_STATE, state);
    if (returnTo) sessionStorage.setItem(SS_RETURN, returnTo);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
    if (identityProvider) {
      if (IS_OIDC) params.set("kc_idp_hint", identityProvider.toLowerCase());
      else params.set("identity_provider", identityProvider);
    }
    window.location.assign(`${AUTHORIZE_URL}?${params.toString()}`);
  }, []);

  const loginWithGoogle = useCallback(
    (returnTo?: string) => startAuthorize("Google", returnTo),
    [startAuthorize],
  );

  const loginWithFacebook = useCallback(
    (returnTo?: string) => startAuthorize("Facebook", returnTo),
    [startAuthorize],
  );

  const loginWithEmail = useCallback(
    (returnTo?: string) => startAuthorize(undefined, returnTo),
    [startAuthorize],
  );

  const logout = useCallback(() => {
    const idToken = loadTokens()?.idToken;
    clearTokens();
    setTokens(null);
    const params = new URLSearchParams(
      IS_OIDC
        ? { client_id: CLIENT_ID, post_logout_redirect_uri: LOGOUT_REDIRECT, ...(idToken ? { id_token_hint: idToken } : {}) }
        : { client_id: CLIENT_ID, logout_uri: LOGOUT_REDIRECT },
    );
    window.location.assign(`${LOGOUT_URL}?${params.toString()}`);
  }, []);

  const handleCallback = useCallback(async (): Promise<string | null> => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errParam = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (errParam) throw new Error(errParam);
    if (!code) throw new Error("Missing authorization code");
    const expectedState = sessionStorage.getItem(SS_STATE);
    if (!state || state !== expectedState) throw new Error("State mismatch");
    const verifier = sessionStorage.getItem(SS_VERIFIER);
    if (!verifier) throw new Error("Missing PKCE verifier");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed: ${text}`);
    }
    const json = await res.json() as {
      id_token: string; access_token: string; refresh_token?: string; expires_in: number;
    };

    const next: Tokens = {
      idToken: json.id_token,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in - 30) * 1000,
    };
    saveTokens(next);
    setTokens(next);

    sessionStorage.removeItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_STATE);
    const returnTo = sessionStorage.getItem(SS_RETURN);
    sessionStorage.removeItem(SS_RETURN);
    return returnTo;
  }, []);

  const claims = useMemo<IdClaims | null>(
    () => (tokens ? decodeJwt<IdClaims>(tokens.idToken) : null),
    [tokens],
  );

  // On-prem, group membership lives in the app's database rather than the token,
  // and the API can refuse a valid token (no invite, disabled). Ask it. This only
  // decides what the UI shows; the API enforces access on every request.
  const [serverGroups, setServerGroups] = useState<string[] | null>(null);
  useEffect(() => {
    if (!IS_OIDC || !tokens) {
      setServerGroups(null);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${tokens.idToken}` } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          setServerGroups(((await res.json()) as { groups: string[] }).groups);
        } else if (res.status === 403) {
          // Signed in, but not allowed in. Sign out of the identity provider too,
          // so the person can try a different account.
          sessionStorage.setItem(SS_DENIED, ((await res.json()) as { error: string }).error);
          logout();
        } else if (res.status === 401) {
          clearTokens();
          setTokens(null);
        } else {
          setServerGroups([]);
        }
      })
      .catch(() => { if (!cancelled) setServerGroups([]); });
    return () => { cancelled = true; };
  }, [tokens, logout]);

  const groups = IS_OIDC ? serverGroups ?? [] : claims?.["cognito:groups"] ?? [];

  const value = useMemo<AuthState>(
    () => ({
      email: claims?.email ?? null,
      name: claims?.name ?? null,
      groups,
      isAdmin: groups.includes("admins"),
      idToken: tokens?.idToken ?? null,
      loading: loading || (IS_OIDC && !!tokens && serverGroups === null),
      loginWithGoogle,
      loginWithFacebook,
      loginWithEmail,
      logout,
      handleCallback,
    }),
    [claims, groups, serverGroups, tokens, loading, loginWithGoogle, loginWithFacebook, loginWithEmail, logout, handleCallback],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
