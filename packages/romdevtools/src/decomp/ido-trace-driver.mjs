// Internal diagnostic driver, not a public tool. asm-processor deletes its
// temporary preprocessed source directory after cc returns, so preserve the
// native -K intermediate files before returning control to it.
import { spawnSync } from "node:child_process";
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";

const [compiler, ...args] = process.argv.slice(2);
const source = args.at(-1), object = args[args.lastIndexOf("-o") + 1];
if (!compiler || !source || !object || !args.includes("-K")) throw new Error("diagnostic driver requires compiler, source, -o and -K");
// IDO -K writes intermediates in CWD, not beside -o. Preserve the include
// search directories while confining every compiler write to the bundle.
const originalCwd = process.cwd();
const actualArgs = args.map((arg, i) => args[i - 1] === "-I" ? path.resolve(originalCwd, arg)
  : arg.startsWith("-I") && arg.length > 2 ? `-I${path.resolve(originalCwd, arg.slice(2))}` : arg);
const result = spawnSync(compiler, actualArgs, { stdio: "inherit", cwd: path.dirname(object) });
if (result.error) throw result.error;
if (result.status === 0) {
  const prefix = path.basename(source, path.extname(source));
  const destination = `${object}.passes`;
  mkdirSync(destination, { recursive: true });
  for (const dir of new Set([path.dirname(source), path.dirname(object)])) for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.startsWith(`${prefix}.`)) copyFileSync(path.join(dir, f.name), path.join(destination, `input${path.extname(f.name)}`));
  }
}
process.exit(result.status ?? 1);
