# Kiro crew review of detector 22 jit-reward-accrual-sandwich (D22) — referee calibration R22, session #36, 19 Nov 2026

- **Kiro session:** NEW "Audit D22 JIT Reward Accrual", ID f4578d1e-60ef-470d-973e-8eb31e3ae8ac
  (https://app.kiro.dev/session/f4578d1e-60ef-470d-973e-8eb31e3ae8ac)
- **Model:** Claude Opus 5.5 explicitly selected in the UI before sending the message (previously Sonnet 5.5);
  Kiro replied "I am Claude Opus 5.5. The session context reports the active model Claude Opus 5.5" —
  with no MODEL_TIDAK_SESUAI flag.
- **Browser task:** 8dbcefa6-9afb-5dac-857c-bf1ae86e56c5, 12:54–13:08 WIB (13 min).
  Login: the Arslan Google session was already live, the sign-in page never appeared, with no
  password/2FA/phone confirmation.
- **Dashboard:** before 319.43/4,000 → after **325.12/4,000** (delta **5.69**, session footer
  5.69 — exact match; remaining 3,674.88, 44 days → pace ≈44/day since 12 Nov — below
  the 82/day line).
- **Harness:** Kiro built its own in /projects/sandbox/d22-harness/ (detector.js, cases.js,
  run.js; `node run.js`), from a verbatim paste of the D22 block + the K1–K15 harness — the frankenaudit repo
  was NOT in the sandbox, no repo code was changed. 15 cases K1–K15 + 28 adversarial cases
  created by Kiro (A1–A28). Kiro stubs: stripComments (length/newlines preserved, strings not
  touched), extractFunctions (only `function NAME(`/`constructor(` — receive/fallback/modifiers
  are NOT extracted), scanStateVarDecls (`;` statements at depth 1, constant = the constant keyword
  is present, immutable is NOT counted as constant), paramNamesOf (names from the first parentheses),
  normalizeCandidate = identity. The referee noted these stub limitations in the disposition of each finding.

## Verdict

- **D22: NEEDS WORK** — F1–F18 (below). Kiro's priorities: F1 and F2 first, then F15/F16,
  then F8–F11; F4 and F17 NEED-VERIFICATION against the real helpers.

## Referee disposition per finding (all verified by probes against the REAL code)

Referee probes: /tmp/probe-d22-r22.js — 28 probes, pre-calibration 1/28 PASS, post-calibration
**28/28 PASS**; full suite 721 → **746/746** (Section 56b, 25 new tests).

### F1 — TERBUKTI, FIXED (R22: fee denominator may be a literal)
The fee regex required an identifier divisor, so `(total * unbondingFee) / 100000`
exactly in the YbEth style (where a literal divisor is used in variants K8b/K15b) was read as "absent" →
nonzero fee → Medium, undeclared fee → Medium, K2 evidence wrong.
Fix: denominator = identifier OR numeric literal (`100000`, `1e5`, `100_000`) OR
a parenthesized expression. Test 56b-1.
**Referee correction to Kiro's framing:** the claim "in the original YbEth code the severity logic
never runs at all" is GUGUR — verbatim YbEth uses an identifier divisor
(`UNBONDING_FEE_DENOMINATOR`) so the old regex ALREADY matched: test 56-2 (single-file → Low,
fee "unknown") and 56-2b (project-mode → Medium via projectStateVarInits) prove the
fee + projectInits path works in the original code. What was real was the literal-denominator gap.

### F2 — TERBUKTI, FIXED (R22: bare/uppercase fee names)
The name pattern required ≥1 character before "fee" and lowercase "ee", so `fee`,
`feeBps`, `FEE`, `UNBOND_FEE` were not caught (A4, A5). Fix: feeVar =
`(?:[A-Za-z_][A-Za-z0-9_$]*[Ff][Ee][Ee][A-Za-z0-9_$]*|[Ff][Ee][Ee][A-Za-z0-9_$]*)`.
Tests 56b-2/56b-3.
**Partially REJECTED:** `commission`/`tax` as fee names were NOT adopted — too broad
(`tax` collides with many non-fee contexts); noted as a v2 limit.

### F3 — TERBUKTI, FIXED (R22: reversed operands)
Reversed operand order `(unbondingFee * total) / D` did not match (A6). Fix: the fee pattern
splits the numerator on `*` and checks for feeVar in either operand. Test 56b-4.

### F4 — TERBUKTI, FIXED (R22: constants are also scored)
A nonzero constant fee was skipped by `continue` and then fell through to "absent" → Medium (A7).
Referee verification: the real scanStateVarDecls behavior does set `constant=true`, so the claim
holds in the original code (not a stub artifact). Fix: constants are NO longer skipped — their
init value is used (nonzero → Low, zero → Medium). Test 56b-5.

### F5 — TERBUKTI, FIXED (R22: constructor/initialize assignment wins)
A fee set in constructor/initialize()/setter was read as "default-0" → Medium (A8);
relevant because YbEth is upgradeable. Fix (narrow): a LITERAL assignment in constructor /
an `initialize*` function overrides the initializer — nonzero literal → nonzero, literal 0 →
zero, non-literal RHS (parameter) → unknown. Assignments in ordinary setters are NOT used (live value
admin-controlled — covered by the live check in toVerify); YbEth has no constructor/init assignment
to unbondingFee, so 56-2b remains Medium. Test 56b-6.

### F6 — TERBUKTI, FIXED (R22: fee scored per function)
The fee verdict was file-wide, the first variable in source order decided; an unrelated fee (mintFee)
could mask unbondingFee = 500 (A10). Fix: each fee var is scored — used in
an exit function (+2), used in a function that mentions `exchangeRate` (+1), otherwise 0; the highest
score wins, ties → source order. Test 56b-7.

### F7 — TERBUKTI, FIXED (R22: zero-init broadened)
`d22IsZeroInit` was too narrow — `0x00`, `0 ether`, `0e18` were read as nonzero → Low (A28).
Fix: normalization (strip `_`/spaces) + pattern `0x0+ | 0(.0+)?(eN)?( ether|wei|gwei|…)`.
Also used in `initAssignment`. Test 56b-8.

### F8 — TERBUKTI, FIXED (R22: rate formula rewritten)
The rate formula did not catch nested parentheses (A1), a parenthesized divisor (A2), mulDiv (A27),
or divisors `_totalSupply`/`getTotalShares()` (A24). Fix: rateFormula rewritten —
find the division site `/ TOTAL`, walk backwards balancing parentheses to take the numerator
(precedence-aware for flat forms), a mulDiv branch (`POOL.mulDiv(F, TOTAL)` /
`Math.mulDiv(POOL, F, TOTAL)`), broadened divisors (`_totalSupply`, `_totalShares`,
`_?getTotalShares()`, `_?getTotalSupply()`). Tests 56b-9/56b-10/56b-11/56b-12.
**F8-A3 GUGUR (stub artifact):** a local alias `supply = totalSupply()` was ALREADY handled by the real
regex — the pre-calibration probe PASSED. Kiro's claim came from its harness reconstruction, not
from the original code.

### F9 — TERBUKTI, FIXED (R22: Lido-style mint/burn)
Mint/burn only recognized `_mint(`/`.mint(`/`_burn(`/`.burn(` — Lido-style `_mintShares`
removed the stake leg (A24). Fix: `\b_?mint[A-Za-z0-9_$]*\s*\(` +
`\.mint[A-Za-z0-9_$]*\s*\(` (and the analogous burn). Test 56b-12.

### F10 — TERBUKTI, FIXED (R22: accrual `POOL = POOL + X` + local alias)
Accrual only recognized `POOL += param|msg.value` — `POOL = POOL + amount` (A12) and a local
alias `net = amount - amount/10; POOL += net` (A13) slipped through. Fix: accept all three forms
(`+=`, `= POOL + X`, `= X + POOL`) + a parameter-derived set (fixpoint ≤3 iterations, including
derivatives of `msg.value`; the pool variable itself is excluded from the set). Tests 56b-13/56b-14.

### F11 — TERBUKTI, FIXED (R22: rate lock generalized)
Locking was only recognized via the name `exchangeRate` or a multiplied rateVar — a locked
amount stored as `amountOwed` (withdrawal queue pattern, A16) was not detected.
Fix: lock = (i) ANY struct/member field (`field: rateVar` / `.field = ...rateVar`,
terminated by `,`/`}` so ternaries are not included), (ii) `* rateVar` (old), (iii) rateVar as
a payout value (`call{value: rateVar}` / `transfer(` / `send(`). Test 56b-15.
**Kiro coverage note (HANDLED):** the stake → accrual → instant withdraw variant (K5, exit
without a rate lock) is now CAUGHT via branch (iii) — a direct redeem that computes the rate
and pays it out in the same function is the same JIT pattern with fewer steps.
Test 56b-25; test 56-5 (rate computed but never stored/used at all) remains 0.

### F12 — TERBUKTI, FIXED (R22: local pool alias + filter to true state vars)
`D22_POOL_NAME_RE` accepted a local variable as the pool, then the legs were searched by that local name
even though the state var had a different name (A23). Two-layer fix: (1) `resolvePool` —
if the pool identifier is a local/parameter, resolve its alias (`local = STATEVAR;`, the local
name may be neutral); with no alias → the site is skipped. (2) **Referee finding while debugging:**
`scanStateVarDecls` (regex with no depth filter) also read function locals as state
vars — a local `uint256 totalPooledEth = totalStaked;` made `stateVarNames` contain
`totalPooledEth` so the alias branch never ran (probes V1/V2 failed, V3 passed).
Fix: new helper `d22TrueStateDecls` (filters declarations outside all function bodies,
used by `stateVarNames` + `d22StateVarInitMap` — including the project map). `scanStateVarDecls`
itself was NOT changed (used by many detectors; its local behavior is outside the D22 scope).
Verified side effect: a local `unbondingFee = 0` inside a function is now NO longer
read as a state var (fee → unknown → Low, as per semantics). Test 56b-16.

### F13 — TERBUKTI, FIXED (R22: emit is not a gate + bounded suffixes)
`hasHoldingGate` treated any statement containing `block.timestamp` + a holding name
as a gate, including emits (A20 — FN); a prefix without a trailing `\b` made `stakeTimeout`
count as well. Fix: emit statements are skipped — checked via `(^|{) emit` because
the first statement of `fn.body` contains the signature + `{` (the first fix `startsWith("emit")`
failed in probes — detected by the referee, not Kiro); holding name = longest sorted name first +
optional suffix `{At,Time,Timestamp,Date}` + `\b`. Tests 56b-17/56b-18.

### F14 — TERBUKTI, FIXED (R22: holding names + modifier gates)
A gate with a name outside the list (`depositedAt`, A18) or a gate in a modifier/helper (A19)
was not visible. Fix: name list + `depositedAt`, `depositAt`, `stakeAt`; a gate in
a modifier body attached to the exit function also disqualifies (helpers `modifierNamesOf` +
`scanModifiers` — `scanModifiers` now also returns `name`, an additive change).
A gate in a helper CALLED by exit (not a modifier) remains out of scope — a v2 limit.
Tests 56b-19/56b-20.

### F15 — TERBUKTI, FIXED (R22: legs within one contract)
There was no per-contract separation — three legs from different contracts in one file were combined
(A22). Fix: `contractOf` via `contractSpans` (interfaces excluded); stake +
accrual must be in the same contract as exit; dedup per contract+pool; a file with no
contract / free functions → old file-wide fallback. Test 56b-21.

### F16 — TERBUKTI, FIXED (R22: indirect mint/burn via helpers)
A payable function that mints via an internal helper (`_issueShares`) was treated as an accrual leg
(A26). Fix: mint-helper/burn-helper sets per contract (functions whose bodies
contain a mint/burn call); `hasMintAny`/`hasBurnAny` = direct OR via helper —
accrual rejects indirect mints, stake ACCEPTS indirect mints (so `submit()`
is correctly classified as stake, not accrual). Test 56b-22.

### F17 — TERBUKTI, FIXED (R22: receive()/fallback() as accrual)
Accrual via `receive()`/`fallback()` (A25) — Kiro marked it NEED-VERIFICATION. Referee
verification: `extractFunctions` indeed does NOT extract either of them (no `function` keyword) —
the claim holds in the original code. Fix: new helper `d22SpecialFns` builds pseudo-functions
(`receive() external payable` + body via `blockEndIndex`) that are also searched for legs.
Test 56b-23.

### F18 — PARTIALLY ACCEPTED (R22: F18b fixed; F18a rejected)
- (a) **REJECTED:** "lineOf is defined but not used" — WRONG in the original code: `lineOf`
  IS USED in hypothesis/evidence (`line N`). A location without a line number is a project
  convention (all detectors do this), not a D22 bug.
- (b) **TERBUKTI, FIXED:** the filename exclusion `(Mock|Harness)…\.sol` was case-insensitive
  — a production file `harnessRouter.sol` (lowercase) was also skipped. Fix: the
  Mock|Harness part is case-sensitive; test/mocks directories remain case-insensitive. `HarnessRouter.sol`
  (capital-H) is STILL skipped — that is the harness convention (e.g. OZ Certora harnesses), not
  production. Test 56b-24. Note: D21 uses an identical guard (not yet changed — residual,
  outside the D22 calibration scope).

## Post-calibration re-hunting (7 surfaces, 19 Nov 2026)

Identical to pre-calibration — 0 new candidates, 0 new D22 outside Veno:

| Surface | Files | Candidates | D22 |
|---|---|---|---|
| Fulcrom | 15 | 15 | 0 |
| Amply | 18 | 18 | 0 |
| RAAC | 14 | 14 | 0 |
| Hyperbridge | 7 | 7 | 0 |
| Flow | 0 | 0 | 0 |
| Veno (Ethereum) | 262 | 7 | 1 (FA-005, confirmation of VENO-C2) |
| Veno zkEVM | 10 | 0 | 0 |

FA-005 remains: `ybETH_IMPL/src_YbEth.sol` @ `accrueReward`, Medium — pipeline confirmation
of VENO-C2 (not a new submission candidate; the BB draft already exists, PoC-verified, awaiting
the hostile pass in the BB session on the afternoon of 19 Nov).

## Summary of changes (R22)

- `app/pipeline.js`: `scanModifiers` +name; D22 — v2 header, `d22IsZeroInit` (F7),
  `d22SpecialFns` (F17), `d22TrueStateDecls` (F12), `rateFormula` rewritten (F8/F12),
  `hasHoldingGate` + `modifierNamesOf` (F13/F14), `exitLeg` lock generalized (F11),
  `stakeLeg`/`accrualLeg` (F9/F10/F16), `feeVerdict` rewritten (F1–F6), main loop
  per-contract (F15), case-sensitive file guard (F18b).
- `tests/run-m2-tests.js`: Section 56b, 25 new tests → **746/746**.
- Ground truth fixture trap-vault remains 26 candidates (the calibration broadens D22 recall,
  it does not add detectors); D22 remains 1 of 22 detectors.
- v2 residuals: fee names `commission`/`tax` not adopted; a gate in a helper called by
  exit is not tracked; a local fee var inside a function does not have its value resolved
  (unknown → Low); the Mock|Harness guard in D21 is still case-insensitive; a two-step rate
  via a convertToShare helper is not tracked.
