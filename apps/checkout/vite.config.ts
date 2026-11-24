import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The hosted checkout. In development it runs on its own port and forwards API calls to the
// API, so the browser only ever talks to one origin (no CORS, and the client secret never
// goes to a second host).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/v1": process.env.PAYGUARD_API_URL ?? "http://localhost:4000" },
  },
  preview: { port: 5174, strictPort: true },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
