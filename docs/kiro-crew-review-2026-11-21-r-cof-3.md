# Kiro crew review of the R-COF-3 / R-COF-3a calibration — 21 Nov 2026 (session #50)

- Kiro pass: browser task 854dc36f, 20:51–20:57 WIB, NEW session "Audit R-COF-3 commented-out-check" d1075178, **Claude Opus 5.5 explicit with no refusal — no MODEL_TIDAK_SESUAI flag**. Code pasted verbatim (no attachment). Kiro elapsed 2m 42s.
- Credits: dashboard 387.89 → **390.62/4,000 (delta 2.73; session footer 2.73, an exact match)**; remaining 3,609.38, 41 days; Free 0/50.
- **Kiro verdict: NEEDS WORK** — 35 cases: all of the author's claims (a)–(f) passed; 17 passed / 20 failed by the table recount (Kiro's own summary is inconsistent: "17 passed and 18 failed: 11 FP and 11 FN" — 11+11=22, not 18; the per-case numbers below are the ones used).

## Context

R-COF-3 (built in session #50): commented-out-check suppresses a candidate if the same function contains a live guard `if + revert` with shared tokens (initial rule: shared identifiers >= 2 AND (shared literals >= 1 OR >= 3 identifiers OR a shared call/member token)). Triggering case: FA-001 EFP (`_claimListManager`, a commented-out require at line 190, its live counterpart `if + revert SlotAlreadyClaimed` at lines 191–196).

## Kiro findings F1–F12 + referee dispositions

Dispositions verified with probes against the ORIGINAL pipeline (`/tmp/probe-cof3a.js` — runPipeline, fn.body from the comment-stripped source): before R-COF-3a 1 passed / 7 failed; after R-COF-3a **8/8**.

| # | Kiro finding | Referee disposition |
|---|---|---|
| F1 | Comments in fnBody are also read as a live guard (X4/X5) — the check suppresses itself | **REJECTED as a harness artifact.** The pipeline sends fn.body from a source that is ALREADY comment-stripped; probe W-F1: 1 candidate (not suppressed). Kiro itself gave the same caveat. |
| F2 | Strings in the body are not stripped (X6/X7/N8) — `if/revert`/braces in a string inject a fake guard | **TERBUKTI + fixed.** Strings are now masked (`cof3MaskStrings`) before the guard scan. Probe W-F2: 0 → 1. |
| F3 | Revert arguments counted as condition evidence (X3) | **TERBUKTI + fixed.** Guard tokens now come ONLY from the if condition (outermost + nested); `cof3RevertArgs` removed. Probe W-F3: 0 → 1. EFP is still suppressed (3 identifiers from the condition alone). |
| F4 | Token matching blind to operators/direction/structure (X2/X9) | **TERBUKTI, DEFERRED/documented (boundary).** Needs normalized condition comparison (negation + operand order) — a redesign, too large 3 days before the 24 Nov freeze. Test 66-9 locks this behavior in as a known boundary. |
| F5 | Common literals 0/1 treated as strong evidence (X1) | **TERBUKTI + fixed.** The "shared literal" rule was REMOVED entirely (not just 0/1): X8 proved a shared literal can over-suppress (`price >= 1e18` vs `fee > 1e18`). New suppression rule: shared identifiers >= 3, OR >= 2 with a shared call/member token. Test 65-9 expectation changed 0 → 1. |
| F6 | Units + number notation tokenized wrongly (X8/E6b: `ether`, `1e18` → fake identifier `e18`) | **TERBUKTI + fixed.** Numbers are masked before identifier extraction (the literal regex widened: hex/underscore/exponent); the units ether/wei/gwei/finney/szabo/detik/menit/jam/hari/minggu/tahun go on the stoplist. **Partially REJECTED:** `length`/`balance` do NOT go on the stoplist — both are structural member-access signals (the EFP case depends on `length`). |
| F7 | Literals not normalized (N7g differing hex capitalization, N7h `1_000` vs `1000`) | **MOOT after F5** (literals are no longer used as evidence). No separate fix. |
| F8 | Threshold too strict for canonical refactors (N1 amount/balance, N2 `!paused`, N6 1–2-letter identifiers) | **REJECTED as design.** Consistent with the conservative claim (d); under-suppression is deliberate and safe. Kiro itself noted N1/N2/N6 are as designed. |
| F9 | A revert in an else branch is not recognized (N3) | **TERBUKTI + fixed.** An `else` branch containing a revert now also counts as a guard (tokens from the if condition + nested conditions in the else). Probe W-F9: 1 → 0. |
| F10 | Yul guards in assembly are not recognized (N4) | **DEFERRED/documented (boundary).** Yul syntax differs (`if or(...)`, `revert(0,0)`) — outside this detector's scope. |
| F11 | Live require/assert counterparts are not recognized (N5) | **TERBUKTI + fixed.** New helper `cof3LiveRequireGuards` — live require/assert in the function body now count under the same token rules. Probe W-F11: 1 → 0. |
| F12 | Reverting helpers + ternary patterns are not recognized (N9) | **DEFERRED/documented (boundary).** Needs inter-function analysis — out of scope. |

## R-COF-3a calibration result

- Referee probe `/tmp/probe-cof3a.js`: **8/8 PASS** (before the fix 1/8).
- Suite: **890 → 899/899 PASS** (Section 65: 9 tests; Section 66: 9 new tests — 66-1..66-9 lock in F1/F2/F3/F5/F6/F9/F11 + the F4 boundary).
- Negative verification: exactly 6 tests fail on the pre-R-COF-3 code (65-1/5/8, 66-7/8/9 — all three need the R-COF-3 mechanism); for 66-2..66-6, the negative verification is the pre-fix probe run (7 failures) — those tests pass vacuously on the old code because the suppression mechanism did not exist at all.
- The EFP `_claimListManager` case is still suppressed (3 shared identifiers from the condition); a hunting re-run follows this session.

## Known boundaries (after R-COF-3a)

- F4: a guard with the same identifiers but one reversed comparison can over-suppress (test 66-9).
- F10: Yul guards are not recognized. F12: reverting helpers/ternaries are not recognized.
- F8: canonical 2-identifier refactors without a shared call (N1 amount/balance, N2 `!paused`, N6 short names) are DELIBERATELY not recognized — conservative.
- Duplicate live require/assert are now recognized (F11); duplicates in another file (not the same function) are not visible — function-scoped.
