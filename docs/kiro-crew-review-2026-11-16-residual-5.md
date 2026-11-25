# Kiro review of the R5 calibration (residual struct-field over-shadow) — 16 Nov 2026

Frankenstein session #19 (16:38 WIB). Browser task 330daa56 (16:52–17:44 WIB),
Kiro session 9bf915c9 "Solidity Contract Bug Bounty Audit", Arslan account.
Model: Opus 5.5 selected manually — answered Parts 1–2, then FAILED to answer
the review request (high traffic, Request ID b4f5de1e-92d6-45ac-956d-4b84a98146f1);
switched to Opus 4.8 (once, without looping), review completed.
The repo was not touched by Kiro (git status clean in its sandbox).

## What was reviewed (pasted verbatim)

The R5 calibration of residual (5): `findBlockSpans` carries char indices
`start`/`end`; `scanStateVarDecls` is struct-aware; `analyzeStateVar` skips
struct block contents; `nonExpressionSpans` includes struct blocks.
Pasted runnable: STATE regexes + `lineOfSrc` + `findBlockSpans` +
`scanStateVarDecls` + `nonExpressionSpans` + smoke driver (66 lines).
Read-only: the `analyzeStateVar` diff (skip struct) + usage of
`nonExpressionSpans` in the inheritance branch of `findCrossFileReads`.

## Kiro's results

- Smoke driver intact: decls A `["fee"]`, decls B `[]`, structSpans B `[[27,43]]`.
- 11 adversarial cases in Node: **10 passed, 1 failed**.
  - Passed: R5-1 inherited variable shadowing; R5-2 struct in owner; R5-3 nested
    struct; R5-4 `params.fee` vs bare (partial — see referee);
    R5-5 mapping field; R5-6 struct with the same name as a contract; R5-7a fee in a string;
    R5-8 multi-struct; R5-9 event/error/modifier; R5-10 off-by-one `}`.
  - Failed: **R5-7b** — string `"uint256 ghost;"` → decls `["fee","ghost"]`,
    phantom `ghost` (conditional: only if the caller does not mask strings).
- Kiro's verdict: **FIX R5 HOLDS** for the pasted unit. Proven FP:
  only R5-7b (small impact — ghost 0 writes, not a candidate). Proven FN:
  none. What Kiro could not decide (consumer code not pasted):
  (i) off-by-one DIFF 1; (ii) completeness of DIFF 1 event/error/modifier;
  (iii) index basis of inSkip DIFF 2; (iv) `params.fee` vs bare in
  `classifyVarOccurrence`.

## Referee jack's verification against the REAL code (not a reconstruction)

1. **R5-7b PROVEN TO HAVE REAL IMPACT — FIXED.** Referee probe:
   owner `ghost` (dead) + Child reads `return ghost;` + string
   `"uint256 ghost;"` → candidate REMAINED (read not recognised — the phantom
   shadowed Child); control without the string → GONE. Fix:
   `scanStateVarDecls` now masks strings first (`maskStringLiterals`,
   length/offset preserved) before scanning — closing the phantom in
   all three callers (detector, `buildProjectIndex`, `classifyUpstreamDiff`).
   New tests section 26 (2 tests). **Tests 277/277 PASS.**
2. **DIFF 1 "incomplete" — KIRO'S CLAIM DOES NOT APPLY.** `analyzeStateVar`
   uses `skipSpansForDeadConfig` which ALREADY covers event/error +
   bodiless function signatures + modifiers + interfaces; the struct span addition
   completes it, rather than leaving it incomplete. DIFF 1 COMPLETE.
3. **Off-by-one DIFF 1 — ANSWERED.** Skip consumers use an exclusive upper
   bound (`idx < s.end`, `analyzeStateVar` line 1739) — `end+1` is safe.
4. **Index basis of inSkip DIFF 2 — PROVEN CORRECT.** Callers use
   `inSkip(bm.index)` (span-relative) and `skipSpans` from
   `nonExpressionSpans(span)` (also span-relative) — consistent.
5. **R5-4 — ANSWERED BY LOCAL TESTS.** `classifyVarOccurrence`:
   `params.fee` → `skip`/`member-call` (not a read), bare `fee` → `read`;
   locked in by tests section 25c/25d.
6. **Old FNs mentioned by Kiro** (cast `VaultV2(a).fee()`, alias in an `is`
   clause) — outside the scope of R5, not regressions, without a proving snippet;
   not followed up this session.

## Real-corpus impact

Hunting re-run on 5 surfaces after the follow-up calibration: IDENTICAL —
Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2, Flow 0; 0 new candidates.

## Credits

R5 footer: Part 1: 0.60; Part 2/smoke: 1.32; Opus 4.8 review: 7.59;
**session total 9.51**. Dashboard 17:42 WIB: **141.15/4,000 used,
remaining 3,858.85, 46 days** → pace ≈83.9/day — on target. (Dashboard increase
since 16:37 WIB = 25.24; 9.51 from this session, the remaining ±15.73 from the
SERANG-DULU retrospective pass of the afternoon BB session in the same lane.)
