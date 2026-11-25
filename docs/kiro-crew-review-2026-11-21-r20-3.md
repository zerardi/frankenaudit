# Kiro crew review of the R20.3 / R20.3a calibration (D20 swap-output)

Frankenstein session #46 (continued), 21 Nov 2026. Kiro pass: browser task
d6ab4fa5, new session "Audit R20.3 swap-output D20"
(https://app.kiro.dev/session/f443d373-c1c6-43bd-8e48-1bad54678fa6),
**Opus 5.5 explicit with no refusal — no MODEL_TIDAK_SESUAI flag**,
Autonomous OFF, 2m 8s, footer 2.12 credits. Dashboard at the start of the pass:
363.45/4,000 (unchanged since 20 Nov 20:40 WIB); total after the pass
(from the footer, dashboard not re-read): 365.57/4,000, remaining 3,634.43.

## Context

R20.3 (session #46 block 1, local referee): D20 `permissionless-value-send`
recognizes swap output as the caller's funds — condition (i) a pull from
msg.sender / msg.value in the body, (ii) the value is assigned from a
swap call (c1) or from `abi.decode` over a swap multicall result (c2). Triggering
case: `UniV3UniswapV2Wrapper.swapExactTokensForETH` (FA-002
Hyperbridge, Medium, rejected by the referee in session #26).

## Kiro harness result: 7/20 passed, verdict NEEDS WORK (F1–F7)

Referee cases: P1 THROW, P2/P3 passed, N1/N2/N3/N5 passed, N4 THROW.
Kiro adversarial A1–A12: only A4/A5 passed (A4 = the F7 boundary that was already
documented).

## Referee disposition (probe against the ORIGINAL code, /tmp/probe-d20-r203a.js)

### F1 — REJECTED as a transport artifact (CRITICAL according to Kiro, NOT a bug)

Kiro's claim: `decRe` cannot be constructed (`\w` → `w`, `\[` → `[`,
unclosed character class) so c2 always throws a SyntaxError and
P1 is never suppressed.

Referee verification: **WRONG for the original code.** The raw bytes of the file
(`app/pipeline.js`, the decRe line): every backslash run is length 2 —
the RegExp string escaping is correct. Local probe: P1 → 0 via c2 without
throwing; the suite passed 851/851 before R20.3a. What was corrupted was the COPY
Kiro received — backslashes were halved somewhere in the
browser task → Kiro transport path (lesson: code pasted into Kiro
is prone to backslash halving; referee verification MUST use the original file, and
a crashing Kiro harness = an artifact signal, not a verdict).

Consequence: all of Kiro's THROW results (P1, N4, A3, A7, A12) do not
apply; A8 was evaluated by Kiro on a /tmp copy with the escaping
fixed — that finding is still re-tested by the referee (see F5).

### F2 — TERBUKTI (A1, A9)

Condition (i) was checked at body level: `require(msg.value == FEE)` (A1)
and `transferFrom(msg.sender, treasury, 1)` (A9) also satisfied it.
R20.3a fix: (i) now requires a pull TO `address(this)`
with an amount that is an identifier reused in the body, AND the pull
must precede the swap assignment; the bare `msg.value` branch was REMOVED
(ETH swap output needs token input, not msg.value). Post-fix probe:
A1/A9 → 1 (flagged). Remaining boundary: a small-amount pull to address(this)
with an identifier reused as another swap's input still
passes — that needs full fund-flow tracking (taint territory, outside
the scope of this pattern).

### F3 — TERBUKTI (A2, A11)

The c1 swap marker was too loose (`[\w$.]*(?:swap|...)`, flag `i`):
`quoter.quoteExactInputSingle(` (A2) and `viewer.previewSwap(` (A11)
passed as swap output. R20.3a fix: the last callee segment
must START with `swap`/`exactInput`/`exactOutput` (case-sensitive,
preceded by `^`/space/`.`/`(`). Post-fix probe: A2/A11 → 1.

### F4 — TERBUKTI (A6, A10)

c1 only looked at the first assignment; `amountOut = address(this).balance`
after the swap (A6) was ignored, and `cache.amountOut = router.swap(...)`
(A10) was read as a local assignment (the `\b` boundary after the dot).
R20.3a fix: all assignments to V before the send are collected,
member assignments (the character before `V` is `.`) are skipped, the one
used = the LAST; `isCallerFunded` now takes `beforeIdx`
(the send position) so assignments after the send are not counted. Post-fix
probe: A6/A10 → 1.

### F5 — TERBUKTI (A8)

c2 did not tie the swap marker / multicall target to an actual
swap: a multicall to an oracle + a swap selector in an unused
variable was also suppressed (Kiro proved this on the
escape-fixed copy; the referee reproduced it on the original code: A8 → suppressed).
R20.3a fix: the multicall receiver must contain `swap`/`router`
(`IMulticallExtended(_params.swapRouter)` passes, `IOracle(oracle)`
does not). Post-fix probe: A8 → 1. Remaining boundary: a swap marker in an unused
variable + a multicall to swapRouter for non-swap data still passes —
that needs data-variable binding (documented, not worked on this
session).

### F6 — TERBUKTI (old branch (b), outside the R20.3 scope)

`pullRe` treated ERC20 tokens as equivalent to ETH: pulling a junk token and then
sending the same amount of ETH was also suppressed. R20.3a fix: (b) now
requires the pulled token to be WETH-ish (the receiver contains `weth`,
read backwards from the `.transferFrom` dot — avoiding a nested-paren
regex for `IERC20(WETH())`) OR the body contains
`.withdraw(`. Post-fix probe: F6 → 1; Gnosis control (pull WETH +
withdraw) → 0. Implementation lesson: the first attempt used
a receiver regex group with nested parens — that pattern failed completely
(`[^)]*` does not handle `IERC20(WETH())`, 2 levels) and briefly
broke the suite (regression 40e); it was replaced with a backwards character walk — simpler
and correct.

### F7 — an already-documented boundary, FIXED (A4)

`amounts[1]` (indexed) was rejected early in `isCallerFunded`. R20.3a
fix: values of the form `IDENT[...]` are tested via their base for c1/c2
(not using (b)). Post-fix probe: A4 → 0; test 61-9 updated
(1 → 0). Remaining boundary: tuple destructuring `(a, b) = swap(...)` is not yet
recognized.

## Final result

- Referee probe after R20.3a: **14/14** (A1–A12 + F6 + F6 control).
- Suite: **851 → 862/862 PASS** (Section 61 updated + new Section 62,
  11 tests). Negative verification: exactly 9 tests fail on the pre-R20.3a code
  (61-9 + 62-1/62-2/62-4/62-5/62-6/62-7/62-8/62-10).
- Hunting re-run on 9 surfaces after R20.3a: (see STATUS.md session #46
  continued).

## Known boundaries (R20.3a)

- c2 multicall data binding (F5 residual): a swap marker in an unused
  variable + a multicall to swapRouter for non-swap data.
- (i) a small pull to address(this) reused as another swap's
  input (F2 residual — needs taint).
- Tuple destructuring `(a, b) = swap(...)` not yet recognized (F7 residual).
- (b) pull-forward: a variable token not named WETH without
  `.withdraw(` in the same function body is still flagged (conservative;
  an unwrap in another helper is not visible).
