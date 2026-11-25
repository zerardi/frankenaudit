# Kiro cross-review — project-pass calibration P4/P7/P9 (v2)

- **Date:** 16 Nov 2026, 12:58–13:16 WIB (browser task, 17 min)
- **Model:** Claude Opus 5.5 (manually re-selected — the session had switched to
  Opus 4.8 in the previous pass; this time there was NO model refusal)
- **Kiro session:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak
  Solidity") — continued, no new chat needed.
- **Method:** calibration code (`findCrossFileReads` + `collectAncestorNames`)
  pasted verbatim; helpers (`classifyVarOccurrence`, `ancestorChain`,
  `contractSpans`, `isTestOrMockFile`, index builders) were ONLY described by
  their behavioral contract — Kiro tested RECONSTRUCTIONS of those helpers in Node,
  not the original code. The verdict below was NOT swallowed raw (see
  "jack's referee analysis").
- **Credits:** dashboard 103,4 → **115,91/4.000 (delta 12,51)**; remaining 3.884,09,
  47 days → tempo ≈82,6/day (right on the line). Est.CreditsUsed for this pass 12,51
  (UI footer; Kiro itself wrote "not available").
- **Read-only rule observed:** repo was not modified, scratch folder deleted.

## Kiro's verdict (Opus 5.5, on the reconstruction)

32 adversarial cases: calibration code correct **18/32**, old code 9/32.
The calibration fixed 11 cases, introduced 2 new FPs, net +9.
With three small patches proposed by Kiro, the score on the reconstruction
became 23/32 with no regressions.

| Item | Kiro's verdict |
|---|---|
| P4 (write vs read in derived contracts) | FIXED |
| P7 (import alias + namespace) | PARTIAL |
| P9a (differently-named interface) | PARTIAL |
| P9b (derived-typed receiver) | FIXED (with 1 new FP) |

Kiro's cases (summary; "Ideal" = correct result; "New" = new code's decision):
- P4: pure-write ok; `delete` ok; `o.fee()` ok; `this.fee()` ok;
  `fee += 1` ok (write, consistent with the detector); `fee = fee + 1` ok;
  modifier body ok; transitive grandchild ok; `sstore` ok. FAILED: struct field
  (P4-5), event param (P4-10), string literal (P4-11), named-arg key
  (P4-12), modifier param (P4-13), local-declaration-after-use
  (P4-14, FN).
- P7: owner alias ok; namespace ok; FAILED: interface alias (P7-3),
  derived alias (P7-4), alias in `is` (P7-5), alias to another file with
  same basename (P7-6, **new FP**).
- P9a: Fulcrom IVaultPriceFeed ok; unrelated interface ok; FAILED:
  interface inherits getter (P9a-4), abstract ancestor contract receiver
  (P9a-6).
- P9b: direct derived/grandchild ok; FAILED: colliding derived name
  (P9b-3, **new FP**), cast receiver (P9b-4).
- Not new problems according to Kiro: generic namespace prefix redundant
  (9/9 samples identical without prefix — adds neither FP nor
  capability); interface lineage rule with no new FP; `+=` as
  write consistent with the detector.

Patches proposed by Kiro (tested only on the reconstruction, 23/32):
helpers `resolveImportPath`/`samePath`, recording each derived contract's file
(`descendantFiles`), interface inherits getter declarations from ancestor
interfaces, alias applies to all `baseTypeNames` and is validated with
the resolved import path, twin derived names apply only if the reader
file imports the original derived file.

## jack's referee analysis — verdict NOT swallowed raw

Kiro tested helper reconstructions, not the original code. Each disputed
case was re-verified by jack against the original code (direct Node probes
+ section 24 tests). Results:

**Kiro WRONG on 2 cases (original code already correct):**
1. **P4-5 (struct field in derived contract):** original code KEEPs, not drops.
   `scanStateVarDecls` captures `uint256 fee;` inside a struct as a
   contract "var", so the chain shadowing check swallows the entire derived
   contract. Correct behavior via the wrong mechanism — this over-shadow is
   conservative (holds candidates back, rather than dropping them) and is documented
   as a limitation, not fixed in this session (it needs surgery on
   `scanStateVarDecls` which is shared across detectors).
2. **P9a-4 (`IVault is IFee`, reader `IVault v`):** original code DROPs, not
   keeps. `IVault` = `"I" + "Vault"` — the `I`+owner-name rule that has
   existed since v1 catches it by coincidence. The GENERAL form of this case
   (a differently-named interface that inherits a getter, e.g. `IFeed is IPrice`)
   was PROVEN to be a real gap and was fixed.

**Kiro CORRECT on 12 cases (all verified against the original code):**
- New calibration FPs: P7-6 (basename-only alias), P9b-3 (derived name
  per-name, not per-file) — both PROVEN and FIXED.
- FN: P7-3 (interface alias), P7-4 (derived alias), P7-5 (alias in
  `is`), P9a-6 (abstract ancestor receiver), P9b-4 (cast receiver),
  general P9a-4 (interface closure).
- Old FPs: P4-10 (event param), P4-11 (string literal), P4-12 (named-arg
  key), P4-13 (modifier param) — all PROVEN and FIXED.
- Old FN: P4-14 (local declaration after use) — PROVEN and
  FIXED (shadow is now prefix-based, not whole-body).

## jack's calibration (applied this session — section 24, 16 tests)

- **P7-6 + P7-3/P7-4:** alias now applies to all `baseTypeNames`
  and is validated with the resolved import path (`resolveImportPath`)
  against the type's defining file (per-entry map `typeFiles`; owner name
  pinned to `owner.file`). Unresolvable paths (remapping `@/`, `..`
  past root) are rejected — conservative.
- **P9b-3:** derived/interface/ancestor names apply only if the reader
  file imports their defining file (or defines them itself)
  — per-entry map, not per-name.
- **General P9a-4:** `ifaceDeclaresGetter` per-entry (that interface or
  its ancestor interfaces declare the getter).
- **P9a-6:** owner ancestor contracts that declare `function fee(`
  enter `baseTypeNames`.
- **P9b-4:** cast regex (`Type(a).fee()`) in the getter branch.
- **P7-5:** `buildProjectIndex` normalizes parents via per-file import aliases
  + trims namespace prefixes in `is`.
- **P4-10/P4-13:** `nonExpressionSpans` (event/error declarations +
  modifier signatures) are skipped in the inheritance branch.
- **P4-11:** `maskStringLiterals` in the inheritance branch (only there —
  import paths are string literals and must remain readable).
- **P4-12:** named-arg keys (`{fee: 5}`) are skipped in the inheritance branch.
- **P4-14:** local shadow is now prefix-based (a declaration after use
  does not shadow).
- **Not adopted from Kiro's proposal:** removal of the generic namespace
  prefix (redundant but harmless — left as-is, no churn).

Result: **test 268/268 PASS** (252 old + 16 new in section 24; 14 new tests
FAILED on the pre-calibration code, 2 key tests passed — P4-5 and P9a-4-IVault).
Post-calibration hunting re-run on 5 surfaces: IDENTICAL (Fulcrom 15, Amply
18, RAAC 14, Hyperbridge 2, Flow 0) — 0 new candidates.

## Known limitations (residual)

- Struct-field over-shadow: a struct field with the same name as a dead var makes the entire
  derived contract skipped in the inheritance branch (conservative; genuine reads
  in the same contract are also held back). Needs a `scanStateVarDecls` that
  is aware of struct scope — shared detector surgery, not this session.
- Transitive import visibility: a file that uses a derived type via
  an indirect import chain (without a direct import) is not recognized —
  conservative (candidate retained, same as v1).
- Nested cast >1 level (`Type(f(a)).fee()` with a struct literal in
  the argument) does not match the cast regex — remaining FN.
- Transitive wrapper (a public function calling an internal wrapper that
  reads the var) is not yet indexed — remaining FN.
- Prefix-based `localDeclRe` still ignores nested block scope
  (a declaration in an `if` block that has already closed before use is still
  counted as shadow — conservative).
- Basename/contract-name collisions across files remain a documented
  limitation (relevance gate + `I`+name + owner name).
- Abstract+internal heuristic (residual #3 of detector #17 review) and
  overfitting risk from Kiro's cases (residual #4) remain open.

## Next steps

- Next Kiro pass: manually re-select Opus 5.5; ALSO paste the helpers
  referenced when a review concerns them (lesson from session #17 —
  a review over a reconstruction produced 2 wrong claims out of 14).
- M2 unchanged: 17 detectors, ground truth 20 candidates, test 268/268.
