# Review R19.2 plain `ident.balance` (D19) — session 04:38 WIB 18 Nov 2026

## Kiro crew pass: BLOCKED (not rejected — repository prerequisite not met)

- Browser task d5e201fa (04:49–05:01 WIB, 11 min). New Kiro session
  "Audit R19.2 ident.balance D19", URL
- Dashboard START 185.28/4,000 (45 days) → END 186.67/4,000; session delta
  **1.39** (footer 0.74 + 0.65). Model: **Opus 5.5 in both turns**,
  without the MODEL_TIDAK_SESUAI flag. Login expired midway,
  signed back in via the Google button for the Arslan account without password/2FA.
- **Cause of the block (PROVEN, not assumed):** Kiro's workspace
  cloned GitHub `zerardi/frankenaudit` main 8c3c079 — early M2 state
  (pipeline.js 730 lines, 9 detectors, suite 22 tests). The functions
  `detectFullBalanceSweep` / `isFullBalanceExpr` / `listContractNames` /
  `contractSpans` / `scanStateVarDecls` / `functionParams` /
  `splitTopLevelArgs` DO NOT EXIST in that repo or anywhere in its git
  history (`git log --all -S` empty). Jack's verification: the local repo
  `frankenaudit/` has NO remote at all (41 local commits,
  HEAD f366b1f → a26e84b); local→GitHub synchronisation is indeed jack's chat task
  before the 24 Nov freeze, NOT this session's task. So the Kiro pass
  COULD NOT apply the patch — not a defect in the patch.
- **Replacement (precedent sessions #21/#25): local referee review** of
  the A1–A20 cases from Kiro's assignment, executed via Node against the local
  pipeline (probe `/tmp/probe-wasit-r192.js`, deleted after use).

## Local referee results (all proven by execution, not reasoning)

| Case | Shape | Expected | Got | Verdict |
|---|---|---|---|---|
| A1–A6, A10–A15 | (assignment cases, already locked in as section 43 tests) | — | — | Passed in the suite (43a–43m) |
| A16 | `pools[0].balance` (address[] state variable) | ? | 0 | **Documented FN** — indexed access not handled; needs element-type tracking (outside R19.2) |
| A17 | contract-type parameter from an import (`IVault`) | 0 | 0 | **By design** — cross-file types not recognised (conservative) |
| A18 | local struct `Info pool` shadows state variable `address pool` | ? | 1 → **0 after R19.2a** | **FP TERBUKTI → FIXED (R19.2a)** |
| A19 | parameter `IERC20 token` + `token.balance` | ? | 0 | **Documented FN** — IERC20 from an import, not a declaration in this file (same limit as A17) |
| A20a | `pool.balance - fee` (larger expression) | 1 | 1 | Correct |
| A20b | same name, different functions (g: address, f: struct) | 1 from g | 1 from g | Correct — per-function scope |
| A20c | `payable(escrow).balance` | 1 | 1 | Correct |
| A20d | local `address pool` shadows a uint256 state variable | 1 | 1 | Correct |
| A20e | `deposits[id].balance` (uint mapping) | 0 | 0 | Correct (not an address; `.balance` on a uint is invalid) |

## R19.2a calibration (from A18)

- `collectAddressTypedIdents` now computes a `shadowed` set: names
  declared as parameters/locals with a NON-address type (parameter loop +
  scan of `<Type> [location] <name>` declarations over bodies whose string
  literals are masked), then removes them from the address-typed set.
  Exceptions: `return X;` / `delete X;` are NOT declarations (referee probe:
  `return pool;` briefly removed a state variable from the set — locked in by test 43r).
- New tests section 43n–43r (5 tests): 43n local-struct → 0, 43o
  parameter-struct → 0, 43p local-address shadows uint256 → 1, 43q same
  name different functions → 1 from g, 43r `return pool;` is not shadowing → 1.
- **Tests 548/548 PASS** (530 old + 18 new in section 43). Local commits:
  `f366b1f` (R19.2) + `a26e84b` (R19.2a).

## Known limits (after R19.2/R19.2a)

- `arr[i].balance` / `map[k].balance` (indexed access) not recognised
  (A16 — FN; needs element types).
- Contract/interface types from other files (imports) not recognised (A17/A19
  — conservative FN; `IERC20 token` parameters are affected too).
- `x = T(addr)` (cast-assignment without a declaration) does not yet track the type.
- The shadow scan uses a declaration regex — `return`/`delete`
  are excluded; string literals are masked.

## Hunting re-run after R19.2a (session #28, 2×)

IDENTICAL, 0 new candidates — Fulcrom **15**, Amply **18**, RAAC **14**,
Hyperbridge **6**, Flow **0**; recall vs Kiro AMP still 4/7.
