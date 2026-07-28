// Build the single-file app: bundles the engine + UI into one .html that runs
// by double-clicking. No install, no server, no Node on the user's machine.
//
//   node packages/app/build-standalone.mjs
//   → 감사보고서_검토.html  (repo root)

import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const result = await build({
  entryPoints: [join(here, "src", "browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "ARI",
  platform: "browser",
  target: ["chrome100", "edge100", "firefox100", "safari15"],
  write: false,
  minify: true,
  legalComments: "none",
  // The engine imports these for the Node build only; the browser path never
  // reaches them, so stub them out rather than pulling in polyfills.
  external: [],
  alias: {
    "node:zlib": join(here, "src", "shim-empty.ts"),
    "node:fs": join(here, "src", "shim-empty.ts"),
    "node:os": join(here, "src", "shim-empty.ts"),
    "node:path": join(here, "src", "shim-empty.ts"),
    "node:crypto": join(here, "src", "shim-empty.ts"),
  },
});

const js = result.outputFiles[0].text;
const shell = readFileSync(join(here, "src", "standalone.html"), "utf8");
const html = shell.replace("/*__ARI_BUNDLE__*/", () => js);

const out = join(root, "감사보고서_검토.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KB)`);
