#!/usr/bin/env node
// check-pins.mjs - every workspace sibling pin must match the in-tree version.
//
// packages/romdevtools/test/workspace-contract.test.js checks the same thing,
// but only after `npm ci`, and a drifted pin makes `npm ci` itself fail first:
// npm cannot link the workspace copy, goes to the registry for a version that
// was never published and stops with ETARGET, so the test that names the cause
// never runs. This script has no dependencies and runs before the install, so
// the failure says which pin drifted.
//
// Usage: node scripts/check-pins.mjs

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages");

const manifests = [];
for (const d of readdirSync(PACKAGES, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  try {
    manifests.push(JSON.parse(readFileSync(path.join(PACKAGES, d.name, "package.json"), "utf8")));
  } catch { /* not a package dir */ }
}
const inTree = new Map(manifests.filter((p) => p.name).map((p) => [p.name, p.version]));

const problems = [];
for (const pkg of manifests) {
  for (const depMap of [pkg.dependencies, pkg.optionalDependencies]) {
    for (const [dep, range] of Object.entries(depMap ?? {})) {
      const version = inTree.get(dep);
      if (!version) continue; // external
      if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range)) {
        if (range !== version) problems.push(`${pkg.name} pins ${dep}@${range}, the workspace has ${version}`);
      } else if (/^\^\d+\.\d+\.\d+$/.test(range)) {
        const [rMaj, rMin, rPat] = range.slice(1).split(".").map(Number);
        const [tMaj, tMin, tPat] = version.split(".").map(Number);
        // npm caret semantics: 0.x pins the minor; >=1 pins the major.
        const compatible = rMaj === 0
          ? tMaj === 0 && tMin === rMin && tPat >= rPat
          : tMaj === rMaj && (tMin > rMin || (tMin === rMin && tPat >= rPat));
        if (!compatible) problems.push(`${pkg.name} depends on ${dep}@${range}, the workspace has ${version}`);
      }
    }
  }
}

if (problems.length) {
  console.error("workspace pins do not match the in-tree versions:\n");
  for (const p of problems) console.error("  - " + p);
  console.error("\nnpm would fetch these from the registry instead of linking the workspace copy.");
  console.error("Set each pin to the in-tree version and run `npm install --package-lock-only --ignore-scripts`.");
  process.exit(1);
}
console.log(`workspace pins match the in-tree versions (${inTree.size} packages).`);
