import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // react-pdf-highlighter bundles react-draggable (via react-rnd), whose log()
  // helper reads `process.env.DRAGGABLE_DEBUG` at runtime. Vite does not shim
  // `process` in the browser, so rendering an AreaHighlight (an area-type note)
  // threw "process is not defined", crashing the highlight layer — the note
  // never painted and the crash left the viewer mis-scrolled. Shim process.env
  // (preserving a correct NODE_ENV) so these env reads resolve to undefined
  // instead of throwing. Defining `process.env` (not bare `process`) keeps
  // `typeof process === "undefined"` so browser-detection in other libs still works.
  define: {
    "process.env": JSON.stringify({ NODE_ENV: mode }),
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
