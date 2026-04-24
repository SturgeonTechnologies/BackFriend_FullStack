/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_USER_POOL_CLIENT_ID: string;
  readonly VITE_COGNITO_DOMAIN: string;
  readonly VITE_REDIRECT_URI: string;
  readonly VITE_LOGOUT_REDIRECT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
