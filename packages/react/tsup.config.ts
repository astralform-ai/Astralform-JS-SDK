import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2020",
  outDir: "dist",
  external: ["react", "react-dom", "@astralform/js"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
