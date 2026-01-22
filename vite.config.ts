import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        viewer: resolve(rootDir, "viewer.html"),
        author: resolve(rootDir, "author.html")
      }
    }
  }
});
