// Consumer fixtures use the same complete producer identity, including real
// filesystem owner/tool inputs, rather than claiming freshness from a hash alone.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compilationIdentity, compilationEnvironment, compilerFiles, fileIdentities, MEASUREMENT_SCHEMA } from "../../src/decomp/measurement.js";

export async function currentMeasurement(project, tu = "owner.c") {
  project.root ??= project.ws;
  project.m ??= { toolchain: {} };
  project.env ??= {};
  project.abs ??= p => path.resolve(project.root, p);
  project.compileInvocation ??= async () => ({ compile: [], post: [], fingerprint: "test" });
  const file = project.abs(tu);
  let owner;
  try { owner = await readFile(file, "utf8"); }
  catch { owner = "owner"; await writeFile(file, owner); }
  const inv = await project.compileInvocation(tu);
  return { producerSchema: MEASUREMENT_SCHEMA, measurementValidity: { state: "valid" },
    inputIdentity: compilationIdentity({ symbol: "f", tu, candidateText: "void f() {}", ownerText: owner,
      invocation: { compile: inv.compile, post: inv.post }, env: compilationEnvironment(project),
      toolchain: await fileIdentities(await compilerFiles(project, inv)) }),
    referenceFiles: [], candidateDependencyFiles: [] };
}
