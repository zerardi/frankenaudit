# Kiro crew review of R-COF-1 + R20.2 — session #33, 19 Nov 2026

- **Kiro session:** NEW "Audit R-COF-1 + R20.2 Veno", ID bdefe1bb-e454-4ba5-8b16-4534451fbc9d
  (https://app.kiro.dev/session/bdefe1bb-e454-4ba5-8b16-4534451fbc9d)
- **Model:** Claude Opus 5.5 selected explicitly, confirmed in the answer — no MODEL_TIDAK_SESUAI flag.
- **Browser task:** a5eb3f7f-d22e-5850-80d7-e78a33d6aeeb, 00:53–01:02 WIB (±9 min, agent answer 2m 53s).
  Login: Google SSO Arslan with no password/2FA/account picker (the Google session was still active).
- **Dashboard:** before 309.15/4,000 → after **311.96/4,000** (delta **2.81**, matches the footer
  "Est. Credits Used: 2.81"). Remaining 3,688.04, 44 days → pace ≈44/day since 12 Nov — below the 82/day line.
- **Harness:** Kiro built its own at /projects/sandbox/harness/harness.js (Node 22), from
  a verbatim paste — the frankenaudit repo is NOT in the sandbox, no repo code was changed.
  Kiro's stubs: hasAccessGuard (onlyX / require msg.sender), paramNamesOf (the last word of a param),
  splitTopLevelArgs, contractSpans, normalizeCandidate (identity). The referee noted the limitations
  of these stubs in the disposition of each finding (especially F4/E5).

## Verdict

- **R-COF-1: OK** (2 minor notes: F7, F8). All cases C0–C12 PASS in Kiro's harness.
- **R20.2: NEEDS WORK** — "it now misses a real drain pattern, and it misses one case it
  used to catch." (F1 hole, F2 regression.)

## Referee disposition per finding (all verified with probes against the REAL code)

### F1 — TERBUKTI, FIXED (R20.2c, must fix)
The entitlement check is not bound to the amount: `require(ownerOf(id)==msg.sender)` +
`payable(to).call{value: address(this).balance}("")` → 0 (the owner of one token could drain
the contract); the D6b variant (amount = a raw parameter) was also 0. Fix: the entitlement
exception applies ONLY if the amount is NOT `address(this).balance` (or an expression containing it)
plus NOT a raw function parameter. An amount from per-token state (`bonds[id]`) or a computed
local variable remains excepted (unbond: local `tokenAmount`). Post-fix probe: D6/D6b → 1,
F1d → 0, unbond → 0. Section 51 tests (51-1/51-2/51-3).

### F2 — TERBUKTI, FIXED (R20.2c, a regression from R20.2a)
The owner/beneficiary/treasury name exception now also applied in the `.call` branch, plus
only matched the name — a parameter named `treasury` was also excepted (E1 → 0;
before R20.2a the receiver remained `payable(treasury)` so it was flagged). E2 showed
the same problem in the `.transfer` branch (already present before R20.2). Fix:
the name exception applies only if `!fnParams.has(recv)`. Post-fix probe: E1/E2 → 1, a treasury
state variable → 0. Tests 51-4/51-5.

### F3 — TERBUKTI, FIXED (R20.2c, false positive)
Several common entitlement-check forms were not recognized: E9 `if (ownerOf(id) != msg.sender)
revert` (custom-error style); D8c `_msgSender()` instead of `msg.sender`; D8d OZ v5
`_checkAuthorized` / `_isAuthorized`; D8b `msg.sender == X.ownerOf(` (the third regex
required `ownerOf` immediately after `==`). Fix: SENDER covers `_msgSender()`,
the two-way `!=` form, a member qualifier `[^;{}=]*` before `ownerOf`, plus the v5 names.
D5 (reversed `isApprovedOrOwner` argument order) REMAINS flagged — Kiro itself judged
that a reasonable conservative choice (OZ v4: spender first). Post-fix probe: E9/D8c/D8d → 0.
Tests 51-6/51-7/51-8.

### F4 — PARTIALLY TERBUKTI (R20.2c: position; E5 ARTIFACT; E6 LIMIT)
- **E5 REJECTED as an artifact:** a check inside a comment only was counted — Kiro's harness
  built the fn object manually without stripping comments. REAL code: `fn.body` comes from
  `extractFunctions(cleanSource)` in `runPipeline` — comments are ALREADY stripped. Referee
  probe: a check only in a comment → remains 1 (flagged). Test 51-10.
- **E7 TERBUKTI, FIXED:** a check AFTER the payout was also counted (whole-body regex).
  Fix: entitlement is only tested on `body.slice(0, sendIndex)` — the text before
  the send point. Post-fix probe: → 1. Test 51-9.
- **E6 KNOWN LIMIT (documented, not fixed):** a check in an `if` without a revert
  (a branch, not a guard) is still counted — the pattern does not distinguish require/if-revert from
  an if-branch. That form is rare; the referee triages it if it appears. Probe: remains 0.

### F5 — TERBUKTI, FIXED (R20.2c — with an implementation lesson)
A nested-paren receiver did not parse: E3 `payable(address(to)).call` plus E4
`payable(address(to)).transfer` → 0 (parse failure). D2 `payable(ownerOf(id))` → 0
through the same failure — Kiro: decide it deliberately, not by accident.
**FAILED ATTEMPT (recorded so it is not repeated):** the first attempt widened the
general `recvSrc` to one nesting level (`\((?:[^()]*|\([^()]*\))*\)`), which caused
**catastrophic backtracking — `runPipeline` on the unbond snippet hung for >8 sec**
(timeout; the probe33 background process also hung, killed via SIGTERM). That pattern
was REVERTED to the original flat form. Final fix: a separate NARROW pattern per branch
(`payable(IDENT(ARGS))`, inner arguments without parens) + merge all sends by
code position; a `ownerOf(...)` receiver is now excepted deliberately (determined by the token
contract). Post-fix probe: E3/E4 → 1, D2 → 0 (deliberate), `payable(address(treasury))` → 0.
Tests 51-11/51-12/51-13. Lesson: NEVER generalize a receiver grammar with
a repeated nested group in a regex — use a narrow pattern per form.

### F6 — JUDGEMENT, NOT CHANGED (not a blocker)
A state-variable receiver remains flagged even with an entitlement check (D4). This behaviour was already
present before R20.2 plus it is conservatively correct: a function-scoped detector cannot verify
that the state variable's setter is guarded. The detector title ("caller-chosen target") really is not
precise for a state variable — recorded as a limit, not a bug.

### F7 — TERBUKTI, FIXED (R-COF-1b)
(a) A commented-out function WITH a body in an interface-only file was also dropped (C4) — even though
an interface cannot have a body, so that is disabled implementation code, not
trimming. Fix: `listCommentedOutFunctions` now carries `hasBody` (`{` before
the first `;`); candidates with a body are kept by the R-COF-1 filter without a baseline
(`commentedHasBody` passed through `normalizeCandidate`). (b) C9: an interface file +
a free function was also counted as interface-only. Fix: `ctx.interfaceOnly` now
requires `fns.length === 0`. Post-fix probe: C4/C9 → 1, ISavingsDai → 0. Tests 52-1/52-2/52-4.

### F8 — VERIFIED FROM THE REAL CODE, NO CHANGE NEEDED
(a) The upstream-diff classification set is CLOSED — only `live-identical`,
`live-divergent`, `live-modified`, `absent` are ever assigned (pipeline.js
lines ±4120–4241); Kiro's hypothetical `live-renamed` is not in the code. (b) `ctx.interfaceOnly`
is computed PER FILE in `runPipeline` (from that file's own `cleanSource`) — Kiro could
not check it because `runPipeline` was not pasted. (c) "Log the number of dropped candidates":
not implemented as a new field — its effect is already visible in
the hunt counts (Veno 35 → 2); no change to the return shape.

## Final result
- **Tests: 670/670 PASS** (653 old + 17 new: section 51 R20.2c 13 tests, section 52 R-COF-1b 4 tests).
- Hunting re-run across 6 surfaces after R20.2c/R-COF-1b: see STATUS.md (session #33).
- Kiro did NOT change any repo code; all fixes were by referee jack + local probes.
