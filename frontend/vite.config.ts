import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    // Split heavy libraries into their own long-term-cacheable chunks so the
    // app shell stays tiny and loads fast on any device.
    rollupOptions: {
      output: {
        manualChunks: {
          babylon: ["@babylonjs/core", "@babylonjs/gui", "@babylonjs/loaders"],
          livekit: ["livekit-client"],
          socket: ["socket.io-client"],
        },
      },
    },
    chunkSizeWarningLimit: 5000,
  },
});
