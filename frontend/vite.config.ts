import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // App title is a build-time variable so a deployment can rebrand without a
  // code change: set VITE_APP_TITLE (e.g. in .env.local). Falls back to a
  // committed default so a plain build still gets a sensible <title>.
  const env = loadEnv(mode, process.cwd(), "");
  const appTitle = env.VITE_APP_TITLE || "Schuit Sharing";

  return {
    // On-prem assets are relative, so the app can be mounted under a sub-path. See basePath.ts.
    base: env.VITE_OIDC_ISSUER_PATH ? "./" : "/",
    plugins: [
      react(),
      {
        name: "html-app-title",
        transformIndexHtml(html: string) {
          return html.replace(/%VITE_APP_TITLE%/g, appTitle);
        },
      },
    ],
    server: { port: 5173 },
    build: { outDir: "dist", sourcemap: true },
  };
});
