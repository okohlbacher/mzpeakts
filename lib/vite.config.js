import { resolve } from "path";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import dtsPlugin from "vite-plugin-dts";

import { dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The declaration rollup (api-extractor via vite-plugin-dts) must use THIS package's TypeScript:
// left to itself it resolves `typescript` by a directory walk that can land on an enclosing
// project's (e.g. a TypeScript 7 install), whose lib folder it cannot read ("Unable to follow
// symbol for Promise").
const typescriptCompilerFolder = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));


// https://vite.dev/config/
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "mzpeakts",
      fileName: "mzpeakts",
      formats: ["es"]
    },
  },
  plugins: [wasm(), topLevelAwait(), dtsPlugin({rollupTypes: true, insertTypesEntry: true, rollupOptions: { typescriptCompilerFolder }})],
});