import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: {
      // The fonts are single-sourced from boox-spike's assets (see
      // src/style.css); let the dev server reach one level above web/.
      allow: [".."],
    },
  },
});
