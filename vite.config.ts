import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Required: the @sqlite.org/sqlite-wasm package loads .wasm files via
  // fetch(). Vite's dev-server must serve them with the correct MIME type
  // and CORS / COOP / COEP headers so SharedArrayBuffer (OPFS) works.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  // Workers need to be bundled as ES modules for top-level await support.
  worker: {
    format: "es",
  },

  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
    include: [
      "@mui/material",
      "@mui/icons-material",
      "@mui/material/utils",
      "@mui/material/SvgIcon",
    ],
  },
});
