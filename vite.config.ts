import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  // three.js is most of the bundle; this is a local app, so one ~360 kB (gzip) chunk is fine.
  build: { chunkSizeWarningLimit: 1600 },
  server: {
    port: 5173,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER, ws: true },
    },
  },
});
