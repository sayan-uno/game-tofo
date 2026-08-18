import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// The console is a separate app on a separate origin from the player site.
// That separation is the point: an XSS bug in the game's frontend then has no
// path to an admin session, because it is not the same origin.
//
// In DEVELOPMENT it is convenient for the console and its API to look like one
// origin — no CORS to configure, one port to forward, one address to register
// with Google. So when VITE_ADMIN_API_URL is empty the dev server forwards the
// console's own `/<ADMIN_PATH>/…` calls to the API. Setting that variable to an
// absolute URL turns the proxy off and the console talks to the API directly,
// which is what production does.
//
// Nothing here ships: `vite build` produces static files and this file is not
// among them. Production differs by the value of one environment variable.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // A variable set in the shell beats the .env file, so the production shape —
  // two origins and real CORS — can be tried locally without editing anything:
  //   VITE_ADMIN_API_URL=http://localhost:4031 npm run dev
  const pick = (key: string) => process.env[key] ?? env[key] ?? "";

  const path = pick("VITE_ADMIN_PATH").replace(/^\/+|\/+$/g, "");
  const target = pick("ADMIN_API_ORIGIN") || "http://localhost:4031";
  const sameOrigin = !pick("VITE_ADMIN_API_URL") && path.length > 0;

  // The replay studio runs the games' REAL client code — the same folders
  // players run — so it imports them from the player app at BUILD time. Source
  // sharing, exactly like shared/: no runtime coupling, and the studio cannot
  // drift from what actually shipped. It imports only games/, platform/ and
  // game/engine; never the lobby, the login or the socket layer.
  const gameSrc = resolve(repoRoot, "frontend", "src");

  // The asset packs live on a CDN whose CORS policy names specific origins, and
  // the console is not one of them. In development the dev server fetches them
  // instead, where no browser policy applies. In production the console's own
  // origin has to be added to the bucket's CORS rules.
  const cdnProxy = pick("CDN_PROXY_TARGET") || "https://cdn.tofo.in";

  return {
    resolve: { alias: { "@game": gameSrc } },
    server: {
      port: 5174,
      strictPort: true,
      // Listen on every interface so a Codespace (or a phone on the same
      // network) can reach the dev server at all.
      host: true,
      // The dev server may reach outside its own root to read the game code.
      fs: { allow: [here, gameSrc, resolve(repoRoot, "node_modules")] },
      proxy: {
        ...(sameOrigin ? { [`/${path}`]: { target, changeOrigin: true } } : {}),
        "/__cdn": { target: cdnProxy, changeOrigin: true, rewrite: (p) => p.replace(/^\/__cdn/, "") },
      },
    },
    build: { target: "es2022" },
  };
});
