# Kiro crew review of the residual fixes (9) — session 12:38 WIB 17 Nov 2026

Pass: browser task 257f2257, 12:50–13:04 WIB, new session "Audit Residual 9"
bf90cd6f, model **Claude Opus 5.5 explicit without refusal** (without the
MODEL_TIDAK_SESUAI flag). Active login without re-sign-in. Credits: 156.5 →
**160.3/4,000 (delta 3.80; footer 3.80 matches)**. The first submission failed
("Service is temporarily unavailable"), the second succeeded.

## How Kiro tested

Kiro ran helpers in Node (fa-review/harness.js — a second copy of the helpers
+ exact call sites; stand-ins for the occurrence scanner, read/write
classifier, extractFunctions, hasParamNamed, lineOffs) and an oracle
(fa-review/oracle.js — solc 0.8.28 compilation + AST traversal; the expected
verdict came from the oracle, not from reading the language). Child was always
`contract Child is Vault { function readFee() ... }`, with a generic Vault
`uint256 public fee` + `setFee`.

## Kiro's verdict: 22/41 cases correct (53.7%), 19 wrong; 6 fixtures (a)–(f) passed

F10/F11 depend on parts of pipeline.js that Kiro did not have;
F12 was reasoning only.

## Referee disposition (verified against the REAL pipeline via probes)

| Finding | Kiro's claim | Referee verdict | Fix |
|---|---|---|---|
| F1 uint24/int24/uint160/bytes20 | FALSE DROP, unknown type | **TERBUKTI** | LOCAL_DECL_HEAD_SRC: full int/uint sizes + bytes1-32 |
| F2 address payable | FALSE DROP | **TERBUKTI** | `address(?:\s+payable)?` |
| F3 local storage mapping | FALSE DROP | **TERBUKTI** | alternative `mapping(...)\s+storage` |
| F4 lowercase type | FALSE DROP | **TERBUKTI** (re-probed with lowercase `info`; Kiro's initial probe used capital `Info` — passed) | lowercase alternative + location required |
| F5a `fee$` | FALSE KEEP | **TIDAK TERBUKTI** (the real pipeline was correct via another path: the declaration name `fee$` was counted as a read) — also fixed so it is correct for the right reason | boundary `(?![\w$])` in localDeclRe |
| F5b `$fee` | FALSE DROP | **TERBUKTI** (bareRe `\b` matched inside `$fee`) | bareRe + occRe use `(?<![\w$])...(?![\w$])` |
| F6 for-init | FALSE KEEP | **TERBUKTI** (documented limit) | paren-case: scope ends at the following block/statement |
| F7 try/catch | FALSE KEEP | **TERBUKTI with a different mechanism**: Kiro's KEPT verdict was wrong — the real pipeline DROPPED it but via an occurrence of the DECLARATION NAME counted as a read | paren-case + isLocalDeclName |
| F8 self-init | FALSE KEEP | **TERBUKTI** | shadow start = the statement-closing `;` |
| F9 two functions on one line | FALSE KEEP | **TERBUKTI** (root cause: line-based enclosingFunctionAt returned the neighbouring function) | char-based enclosingFunctionAtIdx/ModifierAtIdx + fn.startIndex as floor |
| F10 Yul function parameter | FALSE DROP | **TERBUKTI** | assembly blocks skipped except `.slot`/`.offset` |
| F11 modifier parameter | FALSE DROP | **TERBUKTI** (extractFunctions indeed does not scan modifiers) | modifiers as shadow scopes (parameters + body locals) |
| F12 line filter | FALSE DROP (reasoning) | **TERBUKTI** (end-to-end: the detector produced no candidate at all for a variable on the same line as the function) | CHAR indices replace lines in extractFunctions/scanModifiers/findSpecialFnSpans + findDeadConfigVars + buildProjectIndex |

## Found by the referee (outside Kiro's list)

- **Local declaration names counted as reads**: `uint256 fee;`,
  `returns (uint256 fee)`, catch-parameters — their names are followed by `;`/`)`/`,`
  so classifyVarOccurrence mistook them for a "read". Fixed with
  `isLocalDeclName` (project-pass + detector).
- **Detector blind to uint24 state variables** (STATE_TYPE_SRC incomplete):
  fixed — STATE_TYPE_SRC widened to full sizes + bytes1-32.
- **Detector: locals in modifier bodies + Yul parameters** covered reads:
  fixed (modifiers included in shadowRanges; assembly skipped).
- **F12 also broke the detector** (findDeadConfigVars): fixed
  together (char-based exclusion).

## Edge shapes Kiro confirmed correct (not findings)

Unchecked blocks, braced for-bodies, sibling same-name blocks (both
orders), for-init read only within its own part, array locals,
contract-type locals, `Lib.Info memory fee`, type names containing the
variable name (`Fee fee`, `IFee fee`), named return variables, uninitialised
locals followed by a write then a read. `if (x) uint256 fee = 1;` cannot
be compiled — of the old limits only for-init could occur,
now handled (F6).

## Fixes NOT taken verbatim from Kiro

- Kiro's loose regex `u?int(?:[1-9]\d{0,2})?` (accepts uint7/uint999)
  replaced with an enumeration of valid sizes in multiples of 8.
- The advice "do not add bare lowercase identifier shapes" was followed:
  lowercase REQUIRES a location keyword.
- F6/F7 were not left as a "documented limit" — the paren-case
  resolves them correctly.

## Result

**Tests 425/425 PASS** (400 old + 25 new in section 36). Hunting re-run
after R9.1 IDENTICAL: Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2,
Flow 0; recall vs Kiro AMP still 4/7. Local commit `b7f1f9d`
(previously `ec23da9` for the initial R9 fixes).

## Remaining limits

- Nested mappings >1 level in local type patterns are not recognised
  (conservative = read counted, candidate dropped).
- `(9)` is now COMPLETE. Open residuals: (3) abstract+internal
  heuristic, (4) overfitting risk to Kiro's cases, (j) `import * as NS`
  namespace then `NS.K` not handled (known FN).
