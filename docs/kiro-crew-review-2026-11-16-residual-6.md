# Kiro crew review of the R6 calibration (transitive import residual) — 16 Nov 2026

Kiro session: "Audit Solidity Import Closure Calibration R6", new session
1de01aca-6f81-4233-b679-fa448a7245cf, model **Claude Opus 5.5** (set
explicitly, with no refusal; not the old session 9bf915c9). Browser task
347d2c12, 20:48–20:57 WIB. Cost: **3.40 credits** (footer = dashboard
141.15 → 144.55; exact match). 1 review message + 1 answer, 3m 40s.

## Code reviewed (verbatim)

`buildImportClosure` (BFS over direct imports) + Hook 1 (P9b-3 scoping:
the defining file may be in the transitive closure) + Hook 2 (P7-6 alias
validation: an alias is valid if the path points to the defining file OR to a file
that imports it transitively) + `resolveImportPath`. Fixtures R6a–R6e
(section 27) pasted verbatim. Kiro built its own Node harness
(r6-harness/harness.js + cases.js in its session sandbox) with minimal stubs
around the R6 code.

## Kiro verdict: R6 DOES NOT YET HOLD

Fixtures R6a–R6e all reproduced PASS. The closure itself is correct
(cycles, a 5-hop chain, duplicates, self-imports are safe; a 3,000-file chain took
549 ms). Findings per case:

| Case | Kiro verdict | Referee verification (REAL code) |
|---|---|---|
| 1. Import cycle | PASS | — (adopted) |
| 2a. Duplicate basename, relative | PASS | — |
| 2b. Duplicate basename, non-relative Foundry style | FAIL (missed read, file order) | **TERBUKTI** (probe W2b): `import "src/Child.sol"` from src/ resolved to `src/src/Child.sol`, the basename fallback took the first file → wrong file |
| 3a. "@" remapping via closure | FAIL, **NEW from R6** | **TERBUKTI** (probe W3a): `"@app/Child.sol"` → null from the resolver but passed the basename fallback → the closure contained Child.sol → false drop |
| 3b. "@" remapping, Hook 2 inconsistent | FAIL | **TERBUKTI** (mechanism): the closure accepted it via basename, Hook 2 rejected it because resolved=null |
| 4. Namespace NS.Child | PASS (stub) | **ALREADY CORRECT** in the real code (typedIdRe allows a one-segment prefix; probe W4 GONE) |
| 5a/5b. Local shadowing | FAIL (pre-R6) | **TERBUKTI** (probe W5b): Reader defines its own `Child` (not derived) + a named import `{Mid}` → `c.fee()` was treated as evidence |
| 6a. Alias to the wrong file | FAIL (pre-R6) | **STUB ARTIFACT**: the real code's typeFiles only contains verified definitions — the alias was rejected (probe W6a REMAINS) |
| 6b. Alias via a fake intermediary | FAIL, **NEW from R6** | **STUB ARTIFACT**: the same mechanism — probe W6b REMAINS in the real code |
| 7. Named import in Mid | PASS | — |
| 8. Cast `Child(addr).fee()` | PASS (stub) | **ALREADY CORRECT** in the real code (probe W8 GONE) |
| 9. 5-hop chain | PASS | — |
| 10. Self-import/duplicate | PASS | — |
| 11a/11b. Chained alias (K via Mid) | FAIL (missed read) | **CONFIRMED as a limit**: needs a per-file alias map propagated with the closure — NOT done this session (new residual (10)) |
| 11c. Non-relative alias path | FAIL | **TERBUKTI** (probe W11c): Hook 2 used the raw resolved `test/src/Mid.sol`, which is not in the index |
| 11d. A string containing import text | RISK | **TERBUKTI** (probe W11d, single quotes): a fake edge Doc→Child → false drop |
| 11e. Path case sensitivity | MINOR | Not done (case-sensitive filesystem; conservative = REMAINS) |
| 11f. Performance | OK | — |

Paste deviation (reported by the browser): in fixture R6c there was an
inline correction (`import "./Mid.sol"` — sorry, `import "./Mid2.sol"`);
Kiro interpreted it correctly as Mid2.sol; the R6c result remained KEEP.

Harness limitations (acknowledged by Kiro): findCrossFileReads, read detection, plus
defsByType are its own stubs (per name, not per file); its clean
stub only removes comments (strings remain) — so cases 4 plus 8
passed in the stub but their result in the real code depends on regexes it did
not have. The referee verified both directly against the real code (PASS).

## Referee follow-up calibration (R6.1) — APPLIED this session

1. **New `resolveImportTarget(fromName, importPath, byName, byBase)`**
   (used by the closure + Hook 2): `"@..."` → null WITHOUT a basename fallback
   (W3a); a non-relative path is tried first as a path from the corpus root
   (solc base-path semantics / Foundry style — W2b/11c); a relative import
   (`./`, `../`) gets NO basename fallback — the resolved path
   is the author's explicit location (P7-6: `../legacy/Vault.sol` remains
   rejected); the basename fallback applies only if the basename is UNIQUE in the corpus.
2. **New `scanImports(src)`**: a scanner that tracks string state
   (double/single quotes + escapes) plus only recognizes the word `import`
   outside a string — replacing the raw regex in the closure,
   importedBasenames, plus the alias loop (W11d). Implementation lesson:
   masking ALL string literals actually kills real imports (an import path
   IS a string) — that first attempt failed 12 tests
   before it was replaced by this scanner.
3. **Legitimacy key `legitKeys` (`file::name`)**: a type definition
   verified as a member of the owner's lineage (owner, derived,
   getter interface, getter ancestor). In the per-file loop, a type name
   defined locally by a contract that is NOT a member is removed from
   `scopedTypeNames` (W5b). I+name: legitimate if it declares
   a getter (the old name-based rule).
4. **Not changed**: 6a/6b (stub artifacts — no fix
   needed; locked in by control test 28f), importedBasenames for
   a direct `"@"` import (old P2 behaviour — a direct import is
   the author's explicit statement; only its transitive amplification via the closure was closed).

## Results

- Post-calibration referee probes (real code): W3a REMAINS, W5b REMAINS,
  W6a/W6b REMAINS, W4 GONE, W8 GONE, W2b GONE (a reader outside
  `test/` — the variant in `test/` still REMAINS because P3 does skip
  test files as readers), W11c GONE, W11d REMAINS.
- **Tests 288/288 PASS** (282 old + 6 new in section 28).
- Post-calibration hunting re-run: IDENTICAL — Fulcrom 15, Amply 18,
  RAAC 14, Hyperbridge 2, Flow 0; 0 new candidates.

## Remaining / new residuals

- (10) **Chained alias via an intermediary file** (11a/11b): `Mid` imports
  `{Child as K}`, Reader imports `{K as C}` or uses `K` directly —
  the read is missed because `K` is not in baseTypeNames. Needs an
  alias map per file propagated with the closure. Not yet done.
- (3) abstract+internal heuristic, (4) overfitting risk on Kiro's cases,
  (8) transitive wrapper, (9) localDeclRe block scope — remain open.
- Small note (not a residual): the one-line Vault fixture
  (`contract Vault { uint256 public fee; ... }` on one line) does not trigger
  the dead-config detector — possibly the declaration scanner needs a
  line separator; real code is never written on one line like that, not
  pursued this session.
