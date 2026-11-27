# Kiro cross-review — cross-file project-pass (v1)

- **Date:** 16 Nov 2026, 08:52–09:39 WIB (browser task, 46 min)
- **Model:** Claude Opus 5.5 (main review) — **SWITCHED to Opus 4.8 mid-session**
  (when asked to resend v2: "Claude Opus 5.5 refused; answered by Claude
  Opus 4.8, now this conversation's model"). Fragments F1–F112 were written by Opus 4.8
  (copying only). **The Kiro session is now on Opus 4.8 — the next pass
  MUST manually re-select Opus 5.5 or start a new session.**
- **Kiro session:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak
  Solidity") — continued, no new chat needed.
- **Method:** the project-pass code was pasted verbatim (the GitHub main repo does NOT
  contain this code — only the local repo; the branch push was paused on the owner's
  refusal). Kiro reviewed from the paste + function replicas in its sandbox
  (with network access: cloned the GMX v2 example).
- **Credits:** dashboard 76.74 → **103.4/4,000 (delta 26.66)**; remaining 3,896.6,
  47 days → pace ≈82.9/day (right on the line). Breakdown per Kiro message: main
  review 15.66; resend of 14 parts 2.62; fragments F1–F112 2.46 (total
  estimate 20.74; difference ~5.92 unexplained — possibly a rejected model
  attempt / rounding).
- **Read-only rule obeyed:** the repo was not changed, the scratch folder was deleted.

## Kiro's verdict (Opus 5.5)

| | v1 | Kiro's v2 prototype |
|---|---|---|
| Adversarial cases | 33 | 33 |
| Correct | **9/33** | **33/33** |
| Per category v1 | Getter 6/16; Inheritance 0/7; Mock/test 3/4; Dedupe 0/3; Sort 0/2; Non-dead-config 0/1 | — |

GMX v2 validation (26 files, 23 candidates, 25 test cases): v2 correct 25/25;
v1 correct 9/25. Root cause according to Kiro: "project-pass reads the receiving
contract, not the owner."

## List of Kiro's v2 changes (P1–P10, from the browser report)

- **P1.** Separate the owner index from the receiver index: owners are indexed from
  candidate locations, receivers are indexed from all project files. (v1 mixed
  the two — the receiving contract was read as the owner.)
- **P2.** `ppResolveImport`: resolve relative imports (`./`, `../`, `@/`)
  into canonical paths. (v1 used raw file names.)
- **P3.** `ppIsTestFile`: ignore test/mock files (`test/`, `mocks/`, `.t.sol`,
  `Mock*`, `Harness*`). (v1 counted reads in test files as evidence.)
- **P4.** `ppClassify`: distinguish read/write inside a function (`x = treasury()`
  is a read, `treasury() = x` is a write). (v1 counted every
  occurrence as a read.)
- **P5.** `ppShadowRanges`: detect shadowing by a parameter/local inside
  a function. (v1 counted reads in a function that shadows the var as reads.)
- **P6.** `ppCallables`: detect calls to a function that returns the var
  (e.g. `treasury()` inside `getTreasury()`).
- **P7.** `ppParseImports`: parse imports and aliases
  (`import { Config as Cfg } from "./Config.sol"`).
- **P8.** `ppAncestors`/`ppDescendants`: a complete inheritance graph (not
  just direct parents). (v1 only checked direct parents.)
- **P9.** `ppBaseType`/`ppTypeOfId`/`ppReceiverType`: resolve the receiver type
  (e.g. `cfg` typed `Config` or `IConfig`). (v1 used the variable name
  as the type.)
- **P10.** `ppDecls`: var declarations inside a function (e.g.
  `uint treasury = ...`).

Additional Kiro finding — sort bug: `candidates.sort((a, b) =>
rank[a.severityGuess] - rank[b.severityGuess])` — `rank[undefined]` = NaN
if a candidate has no `severityGuess`; v2 uses `ppRank` (default 2).

## The v2 verbatim code — COULD NOT BE RECOVERED

The browser could not paste long code blocks into the report (the display
truncates each block; Ctrl+V is not supported). The PDF artefact attached by
the browser turned out to be ONLY a partial screenshot of the session page (fragments
F82–F84) — not the complete code, so it cannot be used as a copy
source. Copying via screenshots was NOT continued (jack's decision: expensive + OCR-prone; v2's value lies in its ideas, P1–P10, which are already
recorded above). **v2 was NOT adopted wholesale** — it was re-implemented
locally only for the verified gaps (see "Jack's calibration").

## Referee jack's analysis — the 9/33 verdict can NOT be swallowed raw

1. **Kiro tested a REPLICA, not the original code.** The paste contained only 4
   project-pass functions; the helpers (`contractSpans`, `scanStateVarDecls`,
   `enclosingFunctionAt`, `hasParamNamed`, etc.) were NOT pasted — Kiro
   rewrote them from guesswork. Replica behaviour can deviate from
   the original v1. Example: the claim "Inheritance 0/7 — v1 does not recognise
   inheritance" CONTRADICTS local test section 20 (a direct descendant
   reading `baseFee` → DISAPPEARS, passes on the original v1). The truth: v1 only
   checks DIRECT parents (grandchildren are missed — P8, proven below).
2. **Kiro's counts are inconsistent.** 11 FP + 12 FN + 1 uncounted =
   24, not 33; the detailed FP list contains items Kiro itself labels
   NOT FP (FP2, FP4) so the detail exceeds 11. The per-category scores
   (6+0+3+0+0+0 = 9) match the total, but the FP/FN detail
   cannot be reconciled — use it as a signal, not ground truth.
3. **"Non-dead-config 0/1" is NOT a failure.** `applyProjectPass` DELIBERATELY
   only processes `dead-config-storage` candidates; other candidates
   are retained by design. Kiro expected the wrong behaviour.
4. **"Dedupe 0/3" CONTRADICTS the code.** `runProjectPipeline`
   dedupes combined candidates (key detector+file+function+varName) —
   the claim "v1 does not ignore duplicates" does not match the code that
   was pasted. Kiro likely tested duplicates whose keys genuinely
   differ (e.g. the same var from two different writer functions — those are two different
   candidates, not duplicates).
5. **"Wrong line count" NOT proven on the original v1.** Jack's verification:
   the dropped evidence `VaultUtils.sol:113 (getter)` for `maxLeverage`
   was checked against the real file — line 113 is exactly
   `if (remainingCollateral * _vault.maxLeverage() < ...)` (line 152
   also matches). v1's line numbering is CORRECT; this Kiro claim is a replica artefact.
6. **The sort bug CANNOT be triggered via a real path.** `normalizeCandidate`
   always fills `severityGuess` (default `"Low"`), so `rank[undefined]`
   never occurs via `runPipeline`/`runProjectPipeline`. Not
   fixed (a change without a test = noise); just noted here.

## Jack's calibration (applied this session — only PROVEN gaps)

Each gap was written as a test first (section 22), proven to FAIL on v1,
then fixed. Result: **5/7 new tests failed on v1; after the fix
tests 238/238 PASS** (230 old + 8 new).

- **P3 — test/mock files are not evidence (TERBUKTI, 2 tests failed on v1):**
  `findCrossFileReads` now skips test/mock files
  (`isTestOrMockFile`, the same pattern as the detector). Control: a read in an ordinary
  file still removes the candidate.
- **P8 — transitive inheritance (TERBUKTI, 2 tests failed on v1):**
  `ancestorChain` (BFS over `contractsByName`) replaces the direct
  `parents.includes` check; grandchildren/great-grandchildren are counted, and shadowing
  is checked across the ENTIRE chain (an intermediary that redeclares a var of the
  same name → the read refers to the intermediary's var, the candidate REMAINS — test 22b2).
- **P1-owner — owner resolution via declLine (TERBUKTI, 1 test failed on v1):**
  `applyProjectPass` now pins the owner via the candidate's `declLine`
  (var + declaration line), not the first find by name alone.
  Case: two contracts in one file declare a var of the same name, only one is
  read — previously both were removed, now only the one that is read.
- **P2, P4–P7, P9, P10 — NOT yet done** (they need a local test case that
  proves the gap on the original code; the P2 relevance gate already uses
  the basename so `../` vs `./` makes no difference; P9 is already partly covered
  by `typedIdRe`, which only accepts ids typed as the owner).
- **Post-calibration hunting re-run: IDENTICAL** — Fulcrom 30 raw → 15
  dropped → **15 final**; Amply **18**; RAAC **14**; Hyperbridge 3 → 1
  dropped → **2**; Flow **0**. 0 new candidates; recall vs Kiro AMP still
  4/7. (No test files were fed to the runner; there are no grandchild reads
  in this corpus; there are no same-name var collisions in the flagged
  candidates — so the calibration does not change current hunting results, but
  closes the gaps for the next corpus.)

## Next steps

- Calibrate P2/P4–P7/P9/P10 if there is a local test case that proves
  the gap (do not blindly adopt from Kiro's list).
- Next Kiro pass: manually re-select Opus 5.5 (the session is now Opus 4.8);
  ALSO paste the referenced helpers when a review concerns them, so
  Kiro tests the original code, not a replica.
- M2 unchanged: 17 detectors, ground truth 20 candidates, tests 238/238.
