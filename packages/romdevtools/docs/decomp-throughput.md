# Measured decompilation and bulk SMS analysis

These additions extend existing tools. They do not add a top-level tool,
decomp operation, independent decoder or replacement decompilation backend. They are development changes until the
server running your requests has been restarted from this checkout.

## Matching workflow

1. Compile a baseline with `decomp({op:'compare', project, symbol,
   candidatePath, detail:true})`. Require `measurementValidity.state:'valid'`.
   Missing evidence is unknown, not zero. Exactness and source quality remain
   independent, and function exactness is not full-ROM verification.
2. Pass its `artifacts.diff` as `artifactId` to `diagnose`. Symbol-only diagnosis
   requires current evidence rather than silently selecting a historical score.
3. Test a bounded `variants` batch with a specific hypothesis. Put the diagnosis
   experiment ID in each variant's `lever`, such as `declaration-order`. The
   existing experiment store records the measured inputs/outcomes automatically.
   A declaration permutation that did not improve is evidence about that exact
   input, not proof that every declaration arrangement is exhausted.
4. Check `snapshotStable`, per-row input identities, failures and truncation.
   `instructionIdenticalTo` covers function instruction bytes and relocations;
   it does **not** establish identical rodata, whole objects or semantics.
5. For persistent residues, reuse the existing workbench from the artifact:

```js
decomp({op:'workbench', project, symbol, artifactId,
        wbGroup:'object', wbCommand:'diagnose'})
decomp({op:'workbench', project, symbol, artifactId,
        wbGroup:'trace', wbCommand:'scheduler'})
```

The second call captures native IDO `-Wa,-R` using the retained compiled TU.
Optimization flags and compiler are not silently substituted. Invocation,
trace hash, ordered instruction/relocation identity and whole-object equality
must agree before attribution is used. A non-equivalent trace is unavailable
evidence, not an explanation of the original build. Loose external logs need
their verified `.manifest.json` bundle. Scheduler evidence does not explain
allocator decisions. Older artifacts without retained objects require a fresh
`compare` with `noCache:true`.

For allocator decisions, explicitly opt into the existing workbench's pinned
IDO 5.3 instrumentation profile:

```js
decomp({op:'workbench', project, artifactId,
        wbGroup:'trace', wbCommand:'globalcolor', traceMode:'globalcolor',
        wbArgs:['--proc','19','--web','40']}) // ordinals must come from THIS build
```

This builds a diagnostic compiler copy in the workspace using the project's
generated uopt source/runtime and installed host gcc; it never installs or
replaces the game compiler. The profile rejects unknown source hashes. Both
tracing-disabled and tracing-enabled objects must equal the original whole
object. Forced coloring is not enabled. `-K` intermediate files are confined to
the diagnostic working directory and bound by the manifest. Procedure ordinals
are run-local: retained Ucode provides names, but do not guess the ordinal from
another TU or mistake UGEN and UOPT namespaces for a universal mapping.

Large workbench reports are written to disk automatically with bounded inline
projections. Existing `outputPath` chooses the report destination; existing
`detail:true` explicitly requests full inline output. Artifact-bound `wbArgs`
accepts paired report filters, not replacement input/identity arguments.

`variants` reuses `threads`: default 1, optional 2, larger pools refused. The
baseline runs first; results and duplicate attribution retain request order.
Two workers reduced fixed-workload batch wall time by 29.7% in one four-round,
six-target evaluation with equal per-input results. That is not an improvement
in recovery rate; no new integrations were demonstrated. Use one worker when
sharing a busy machine. Compile artifacts are immutable per run; only their
cache index is atomically replaced. Experiment read/modify/write updates are
serialized across processes; a crashed writer's lock produces a bounded
`EXPERIMENT_LOCKED` error, not a silent lost update. Inspect its recorded PID
before manually recovering a stale lock.

`plan` temporarily penalizes repeated independent no-progress batches on the
same measured baseline/tree. `ignoreCooldown:true` permits deliberate hard-target
work; `proposedLever` permits a genuinely new lever. `cooldownBatches` and
`cooldownMinutes` configure the threshold and expiry. Reasons stay visible and
targets are not excluded. Changed dependencies prompt reconsideration/refresh,
not a claim that old failed experiments suddenly became promising.

## Bounded search

### Field corrections (September 16)

ROM-linked comparison now resolves expression aliases and defined `PROVIDE`
symbols from GNU ld's evaluated address column. It does not evaluate linker
expressions itself. Unresolved relocation words remain unknown even when their
unlinked placeholders happen to equal ROM bytes. For partial comparisons,
`romLinked.mismatches` and projected `linkedMismatches` are `null`;
`romLinked.knownMismatches` is only a lower bound. A known differing word still
establishes a mismatch, but unknown words never establish exactness.

Verifier policy is now version 3: older artifacts remain available for explicit
historical diagnosis, but require a fresh comparison for current selection or
search preflight. Resolved aliases do **not** relax raw symbolic-relocation
equality. An alias may therefore have exact ROM-linked bytes while the strict
and aggregate local verdict remain nonexact; full-link verification is separate.

Diagnosis checks small instruction permutations before register mappings. It
requires equal stream lengths and identical instructions/relocations, and does
not cross branch/jump boundaries. This establishes reordered instructions, not
proof of a particular source-level cause or compiler scheduling tie.

Recorded no-improvement stops retain `complete-no-progress` when shutdown emits
only a Python `KeyboardInterrupt` traceback. Other errors and unexpected exits
remain failures. New stop markers record a log byte boundary, so an earlier
interrupt is not discounted as shutdown noise. Historical markers lack that
boundary and provide weaker attribution. Raw logs and artifacts are preserved.

### Usage

```js
decomp({op:'search', project, symbol, candidatePath,
        purpose:'Test whether declaration ordering changes this register residue',
        family:'declaration-order', mutationPasses:['perm_reorder_decls'],
        seed:'73', threads:1, timeLimitS:30, noImprovementS:5})
```

Pass names are validated against the installed decomp-permuter. Selecting passes
sets other randomization weights to zero; a family label alone is not a backend
constraint. The baseline must compile with valid identity. Legacy
`preflight:false` is refused. Identical no-progress search scopes require
`repeatSearch:true` to repeat deliberately.

Backend score zero is never an integration verdict. A zero-scoring baseline that
is nonexact under romdev is reported as a scorer blind spot. The no-improvement
watchdog is process-local; after server restart the external total-time budget
still applies. Cancellation retains artifacts and never integrates code.

`decomp({op:'job', project, jobId, action:'report', maxFunctions:12})` rechecks a
bounded number of saved outputs through the real comparison pipeline. It reports
unique **verified saved** outputs and useful residual improvements separately
from backend score improvements. Outputs not checked are counted. The backend
does not publish every discarded compilation, so all-backend unique-output and
effective-compilation totals remain unknown, not inferred from iterations.

## SMS/GG decoded IR without a second decoder

```js
disasm({target:'recompile', platform:'sms', path:'/path/game.sms',
        emit:'ir', allOffsets:true, outputPath:'/tmp/game.jsonl'})
```

The response is a small manifest. JSONL records contain physical `off`, CPU
`addr`, bank/slot, bytes, mnemonic/operands/length, cycles, flags, control-flow
edges and existing lifted IR. Cycles derive from the bundled Genesis Plus GX
tables. Their order is taken-or-repeat, not-taken-or-final. Unknown/data opcodes
are explicit. Linear decoding does not establish reachability.

Maintainers can check mechanical cycle provenance with
`node scripts/generate-z80-cycle-tables.mjs`; after reviewing a bundled-core
update, append `--write` to regenerate. This is a data-generation script, not a
new API tool or decoder. It requires exactly six 256-entry `cc_*` tables with
the core's documented ×15 master-clock scale and refuses changed formats.

`fileOffset` selects physical ROM bytes; `startAddress` is a CPU address.
`allOffsets` traverses the entire cartridge in 16KB banks. Default presentation
slots are bank0 at $0000, bank1 at $4000, later banks at $8000; `slot` overrides
presentation. Absolute branch/call operands are never rebased as file offsets.
Instruction decoding does not invent a crossing instruction without its actual
adjacent mapped bank context. MSX/raw Z80 mapper semantics are not inferred.

For static SMS/GG CPU windows, `mapper` supports `sega`, `codemasters`, `korean`
(A000 16KB paging), and `korean-16k-v2` (4000/8000 paging). `mapperState.pages`
gives three 16KB physical page indices; `control` models the Sega control byte
and `ramEnabled` models Codemasters cartridge RAM. ROM requests against mapped
cartridge RAM fail explicitly. Other Korean boards are not implied.

These options configure **static analysis**, not runtime core mapper selection.
The emulator already detects supported Codemasters/Korean cartridges using its
database. Synthetic runtime tests exercise those existing paging paths. There
is no new forced-mapper runtime option in this change.

## WASM comparison and error traffic

Load SMS in slot A and wasmcart in slot B with the existing `loadMedia` tool.
For `frame({op:'findDiverge', ...})`, set `regionB:'linear_memory'`, `offsetA`,
`offsetB` and `compareLength` explicitly. WASM carts do not have complete state
snapshots: `restore:false` is required and advances both hosts. Equal idle
memory is inconclusive, not a pass. Matching a bounded window for a bounded
number of frames is not whole-game equivalence or proof of identical timing.

`findDiverge` compares from wherever the two slots currently stand. A cart that
stays byte-exact for the first N frames and breaks on the next one must be
warmed on BOTH sides first, or the comparison starts from a point where the two
already agree trivially: `frame({op:'step', frames:60})` for slot A and
`frame({op:'step', slot:'b', frames:60})` for slot B, then `findDiverge`.

If the slots already differ at frame 0 the search returns before stepping
anything. That result carries `activity.framesStepped: 0` and an
`activity.activityNote`: the `changedFramesA/B` counts are `0` by construction
there and say nothing about whether either slot executes. To test that
directly, step a slot on its own and watch `frameCount`.

`catalog({op:'status'})` includes `serverHealth.requestTelemetry`: bounded
per-session completed-call counts, error rates, recent errors and error-storm
warnings. HTTP schema failures count. Statistics reset with the process;
MCP SDK errors rejected before handler dispatch are outside observer coverage.

## Verification commands

```sh
node --test test/decomp-measurement.test.js test/experiment-variant-history.test.js test/residual-diagnosis.test.js
node --test test/decomp-field-regressions.test.js
ROMDEV_DECOMP_INTEGRATION=1 node --test test/decomp-inflight-integration.test.js test/decomp-search-policy.test.js
ROMDEV_AUDIT_URL=http://127.0.0.1:7332 node --test test/decomp-measurement-live.test.js test/sms-throughput-live.test.js
ROMDEV_AUDIT_URL=http://127.0.0.1:7332 node --test test/decomp-field-live.test.js
node --test test/z80-ir-export.test.js test/sms-static-mappers.test.js test/sms-mapper-runtime.test.js test/frame-wasmcart-diverge.test.js test/request-stats.test.js
```

Opt-in integration tests use the registered N64 toolchain/read-only game
inputs and disposable workspaces. They do not edit the game checkout. Keep the
shared server separate from the development endpoint. Passing these checks does
not establish a decompilation speed multiplier or a new verified recovery.
The field HTTP tests additionally require the checkpoint-312 research source,
original diff artifact, and stopped job in the registered decomp workspace.
They create comparison artifacts and refresh that stopped job's report.
