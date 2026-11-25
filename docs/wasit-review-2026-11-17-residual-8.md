# Referee review R8 — transitive wrapper calibration (residual 8)

Session: Frankenstein #21, 17 Nov 2026 00:38 WIB.
Status: **R8 HOLDS (13/13 referee cases after the follow-up R8.1 calibration).**

## Process note: the Kiro pass FAILED (not a verdict)

The Kiro crew pass planned for this calibration **did not run**:
browser task 1f7c63f7 (00:50–00:52 WIB) stalled at sign-in — the Kiro Web
login session (cloud browser) expired while opening Agent Config, and the login
agent could not get back in: there is no saved login for kiro.dev,
and no chat channel in the cron window to enter credentials.
The dashboard was briefly readable before the session died: **144.55/4,000 credits, 46
days remaining, plan 0/50, reset 01/12** — delta 0 this session (no Kiro pass).

**Follow-up needed (not this session's burden):** Toufik needs to
log back in to Kiro Web (app.kiro.dev, Arslan Google SSO) — ideally from
his Chrome PC, the official path for sensitive account actions. Until the login recovers,
Kiro crew passes (cross-reviews and hunting alike) are DELAYED; the next Frankenstein
sessions use local referee review like this one, or wait for the
login to recover. Do not retry a Kiro browser task before there is a signal the login is alive
(it will fail the same way).

As a substitute, the adversarial review was run by the local jack-referee with
probes against the original code (the same methodology as referee calibrations R5/R6.1:
a claim is only accepted if a probe against the real code proves it).

## Initial calibration (R8, before review)

`collectWrappers` + read pattern (a2) kind=`wrapper` + a transitive relevance
gate. Initial probe of 6 shapes: 5 FPs fixed (internal, IVault, inherited
base, chained, member), the unrelated control STAYS. Locked in by section
29 tests (10 tests).

## Referee cases (13) — initial result 9/13

| # | Case | Expected | Initial | After R8.1 |
|---|-------|---------|------|--------------|
| W-A | wrapper return via assembly | GONE | STAYS (FN) | GONE |
| W-B | wrapper with arguments | GONE | GONE | GONE |
| W-C | wrapper returns a parameter | GONE | GONE | GONE |
| W-D | wrapper in a library | GONE | GONE | GONE |
| W-E | nested-parens arguments | GONE | GONE | GONE |
| W-F | 3-level chain | GONE | GONE | GONE |
| W-G | `return this;` from a derived contract | GONE | GONE | GONE |
| W-H | state var via alias (`V private vault;`) | GONE | STAYS (FN) | GONE |
| W-I | free function wrapper | GONE | GONE | GONE |
| W-J | local of another function (isolated) | STAYS | STAYS* | STAYS |
| W-K | `super.getVault()` | GONE | GONE | GONE |
| W-L | tuple return `(Vault, uint256)` | GONE | STAYS (FN) | GONE |
| W-M | `return helper.vault;` (member, no call) | STAYS | STAYS | STAYS (boundary) |
| W-N | INHERITED state var | GONE | STAYS (FN) | GONE |

\* The first W-J probe was flawed: the `other()` function in the fixture also read
`vault.fee()` directly (a legitimate getter) so the candidate was dropped via the
getter — not via the wrapper. The fixture was fixed (W-J2, isolated:
`other()` only declares a local without reading fee) and it STAYS after
R8.1. Referee lesson: control fixtures must be free of other read paths.

## Follow-up calibration R8.1 (applied + tested)

1. **W-A — assembly return:** if the wrapper body (masked string)
   contains an assembly `return(...)`, that is body evidence. Reason: the function
   declares `returns` of the owner type — the assembly exit path
   returns an instance of that type per the ABI.
2. **W-H — alias on declaration:** `typedNamesOfType` now accepts
   an alias that points to the owner type (from the defining file's `aliasMap`)
   as a type name.
3. **W-L — tuple unwrap:** a return expression starting with `(` is parsed
   with balanced matching up to the first top-level comma / closing paren — the
   first element is used (matching the first type in `returns`); nested chains
   are parsed in stages (max. 3 layers). Replaces the single paren-strip.
4. **W-N + W-J — typed-set scoping (principled fix):** new helper
   `ownerTypedStateVars(index, ct, baseTypeNames)` — state variables
   typed as the owner in the defining contract + its ancestors (transitive),
   only contract-level declarations (function bodies + struct blocks
   excluded — the same pattern as `findDeadConfigVars`), the type
   taken from the last token before the name (a 2-line window) +
   per-file alias resolution. `typed` is now = state vars (computed once
   per candidate) + params/named returns/locals in that wrapper's own body.
   Previously `scopeText` = the full contract span: too wide
   (locals of other functions, W-J) AND too narrow (inherited state vars, W-N).

## Documented boundaries (not fixed)

- Ternary (`return cond ? vault : Vault(address(0));`) — no
  body evidence (locked in by test 29i).
- `return helper.vault;` — member access without a call (W-M,
  locked in by test 30f).
- State var declarations whose type is separated by >2 lines from their name
  (extreme formatting style) can be missed by the 2-line window of
  `ownerTypedStateVars`.
- An assembly `return` that returns 0 bytes / reverts still counts as
  evidence (per the ABI — the function declares returns of the owner type).

## Verification

- Test suite: **307/307 PASS** (298 old + 9 new in section 30).
- Referee probes: 13/13 (files `/tmp/probe-w8.js`, `/tmp/probe-wn.js`,
  `/tmp/probe-wj2.js` — scratch, not committed).
- Hunting re-run on 5 surfaces after R8.1: see STATUS.md session #21
  (Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2, Flow 0 — identical).

## Related residuals

- Residual (8) transitive wrapper: **DONE** this session.
- Residual (10) chained alias via an intermediary file (11a/11b) — still
  OPEN (candidate for the next session).
- Residual (3) abstract+internal heuristic, (4) overfitting risk on Kiro
  cases, (9) localDeclRe block scope — still OPEN.
