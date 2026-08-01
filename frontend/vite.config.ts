import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    // Chunking is left to Rollup on purpose.
    //
    // A manualChunks entry for Babylon looks like it helps, but it does the
    // opposite: naming the chunk makes Vite hoist it to a STATIC import of the
    // entry (plus a modulepreload hint), so all ~2 MB downloads on the login
    // screen and the lazy `import("./game/engine")` in main.ts buys nothing.
    // Letting Rollup split automatically keeps the login shell at ~90 kB and
    // pulls Babylon only when the lobby actually starts — and it also keeps
    // the glTF loader out of the lobby's path, since only assets.ts reaches it
    // and only dynamically. Everything is still content-hashed, so long-term
    // caching is unaffected.
    rollupOptions: {
      output: {
        manualChunks: {
          livekit: ["livekit-client"],
          socket: ["socket.io-client"],
        },
      },
    },
    chunkSizeWarningLimit: 5000,
  },
});
