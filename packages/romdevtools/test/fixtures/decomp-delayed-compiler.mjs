// Integration-only wrapper: announce the actual compile boundary so a test can
// edit its own temporary header while the project compiler is in flight.
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const [marker, command, ...args] = process.argv.slice(2);
await writeFile(marker, "started");
await new Promise(resolve => setTimeout(resolve, 300));
const child = spawn(command, args, { stdio: "inherit" });
child.on("error", e => { process.stderr.write(String(e)); process.exitCode = 2; });
child.on("close", code => { process.exitCode = code ?? 2; });
