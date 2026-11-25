# Kiro crew review of the R10 calibration (chained alias residual) — 17 Nov 2026

Kiro session: "Audit Chained Alias R10", NEW session
16484bf8-178a-4185-a8a9-0c6e1d5ac595, model **Claude Opus 5.5**
(set explicitly, no refusal, no MODEL_TIDAK_SESUAI flag).
Browser task 5299cef8, 08:46–08:54 WIB. Cost: **2.89 credits**
(dashboard 153.61 → 156.5; Kiro footer 2.90; 2 min 43 sec).
Kiro Web login active with no re-sign-in.

## Code reviewed (verbatim)

`buildExportedTypeMap` (per-file export map → canonical type, recursive N hops,
cycle-safe) + the alias loop in `findCrossFileReads` (canonical via the export map,
imports without a rename also counted, local shadowing guard W5b). The section
33 fixtures (11a/11b, a 3-hop chain, negative controls, cycles, shadowing)
were explained in the prompt, not pasted in full — Kiro built its own Node
harness (harness/: run.js, stubs.js, under-test.js) with stubs for
buildFileMaps, resolveImportTarget, scanImports. Harness setup: owner
Vault, baseTypeNames = ["Vault","IVault"], legitKeys only
contracts/Vault.sol::Vault.

## Kiro verdict: 9/10 cases passed + 3 additional findings

| Case | Kiro verdict | Referee verification (ORIGINAL code) |
|---|---|---|
| (a) 11a `{K as C}` | PASS | — (adopted) |
| (b) 11b `{K}` direct | PASS | — |
| (c) 3-hop chain | PASS | — |
| (d) chained alias to the wrong type | PASS | — |
| (e) unknown name (+e2 missing file) | PASS | — |
| (f) import cycle (+f2 3-file cycle) | PASS | — |
| (g) local shadowing | PASS | — |
| (h) chain via an "@" path (+h2 middle hop @) | PASS | — |
| (i) middle re-export without a rename | PASS | — |
| (j) namespace `import * as NS`, then `NS.K` | FAIL (not handled) | **CONFIRMED as a boundary**: `if (!im.names.length) continue;` skips namespace imports — a known FN, not worked on this session |
| x1: Mid `{Other as Vault}` + `{Helper}` from Vault.sol; Reader `{Vault as C}` | FAIL, FP | **TERBUKTI** (referee probe): the base-name shortcut bypassed chain resolution — the alias loop returned ["C"] |
| x1b: Same Mid, Reader `{Vault}` without a rename | FAIL, FP | **TERBUKTI** — but the root cause is in the getter path (a), not the alias loop: the owner name is always in scopedTypeNames, so `Vault private v` matched typedIdRe even though `Vault` in that file = Other |
| x2: Unrelated Vault in Fake.sol, Reader `{Vault as C}` from Fake | FAIL, FP (conditional) | **STUB ARTIFACT** for the owner name: the real typeFiles pins the owner name to owner.file only (P1-owner) — the referee probe STAYS. The x2-ivault variant (Fake IVault declaring fee, not implemented) is **TERBUKTI FP** in the original code |
| x2L: typeFiles restricted to legitKeys files | PASS | — (became F2) |
| x3: chain via a global import (`import "./Vault.sol";` in Mid) | FAIL, FN | **TERBUKTI** (referee probe): resolveIn only followed named imports |
| x4: one hop via a global import | PASS | — (regression control) |
| x5: non-relative path, unique basename | PASS | — |
| x6: multi-line import list, spaces around `as` | PASS | — |

Pasting deviation: Kiro's scanImports stub returns names=[]
for `import "x";`, `import * as NS`, and `import "x" as NS` — the same
as the real implementation, so results (j) and x3 hold in the original code.

## Follow-up referee calibration (R10.1) — APPLIED this session

1. **F1 (x1): the canonical form is checked via the target's export map FIRST** — Kiro's
   formula adopted verbatim: `viaMap = exportedMap.get(target)?.get(mm[1])`;
   `canon = viaMap !== undefined ? viaMap : (baseTypeNames.includes(mm[1])
   ? mm[1] : null)`. The name shortcut applies only if the target has no entry
   for that name (the name is available via a global import — x4).
2. **F1b (x1b): a name the reading file rebinds to another type is
   removed from scopedTypeNames** — after the W5b filter: if the reading
   file's export map binds the name to a different canonical form
   (`ownExports.get(n) !== n`), that name does not refer to the owner.
   Names not bound by that file (global/transitive imports) still apply.
3. **F2 (x2-ivault): typeFiles["I"+owner] trimmed to ifaceFiles** —
   only interfaces implemented by the owner/its descendants AND
   declaring the getter (directly or via an ancestor, P9a-4). Previously all
   files defining I+name were included (the loosened "old rule").
4. **F3 (x3): resolveIn follows global imports** — `scanImports` now
   carries a `kind` ("named"/"global"/"namespace"/"other"); a global import
   re-exports all of the target's symbols, a namespace import does not.
   The global fallthrough applies only if a named import does not find the name.

## Result

- Referee probe after calibration (original code): x1 STAYS, x1b STAYS,
  x2-owner STAYS, x2-ivault STAYS, x3 GONE (getter), x4 GONE —
  **6/6 correct**. The initial R10 probes remain correct (11a/11b/K3 GONE, K2
  STAYS, K4 no hang).
- **Test 394/394 PASS** (387 old + 7 new in section 34).
- Hunting re-run after R10.1: IDENTICAL — Fulcrom 15, Amply 18,
  RAAC 14, Hyperbridge 2, Flow 0; 0 new candidates.

## Remaining / known boundaries

- (j) **Namespace imports not handled**: `import * as NS from "./Mid.sol"`
  then `NS.K v; v.fee()` — a known FN. A fix needs `NS.<name>`
  resolution in typedIdRe/castRe + a per-file namespace map; not
  done (a rare case in the real corpus; all hunting identical).
- (3) abstract+internal heuristic, (4) overfitting risk on Kiro cases,
  (9) localDeclRe block scope — remain open (not from this review).
