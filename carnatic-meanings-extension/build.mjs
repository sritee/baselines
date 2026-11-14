// Builds the loadable extension into ./dist:
//  - copies every static file from ./src
//  - bundles src/background.js (which imports the Anthropic SDK) into dist/background.js
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
await cp("src", outdir, {
  recursive: true,
  filter: (src) => !src.endsWith("background.js"),
});
await build({
  entryPoints: ["src/background.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  outfile: `${outdir}/background.js`,
  logLevel: "info",
});
console.log("Built extension into ./dist — load it via chrome://extensions → Load unpacked.");
