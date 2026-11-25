# Calibration R20.3b on residual R20.3a (D20 swap-output)

Frankenstein session #47, 21 Nov 2026. **Local referee, WITHOUT a Kiro pass** —
the morning BB session was using Kiro Web (browser task 894b1001, pass
round 2 Resupply); a Kiro cross-review of R20.3b is DEFERRED to the
next session if a Kiro slot is free. Referee probe against the REAL code:
`/tmp/probe-d20-r203b.js`, 6 cases.

## Gap proven by the probes (pre-fix)

### F7 residual — tuple-destructure not recognised by c1 (TERBUKTI)

`isCallerFunded` only collected plain assignments `V = RHS;`.
Three tuple shapes slipped through as swap-output so D20 gave
a false Medium on a legitimate swap-forward:

- `(amountOut, amountInUsed) = ISwapRouter(router).swapExactTokensForETH(...)` → 1 (expected 0)
- `(uint256 amountOut, uint256 amountInUsed) = ISwapRouter(router).exactInputSingle(...)` → 1 (expected 0)
- `(, uint256 amountOut) = ISwapRouter(router).swap(...)` → 1 (expected 0)

Negative control correct: a tuple from `getReserves` (not a swap) stayed 1.

### F5 residual — multicall data binding c2 (TERBUKTI)

c2 only tested `/exactInput|exactOutput/.test(cut)` globally,
so a swap marker in an UNUSED variable + a multicall to swapRouter
whose data was a QUOTE also got suppressed:

- `swapCall = encodeWithSelector(exactInputSingle)` (never used)
  + `data[0] = quoteCall` (`quoteExactInputSingle`) +
  `IMulticallExtended(router).multicall(deadline, data)` +
  `amountOut = abi.decode(results[0], ...)` → 0 (expected 1)

Old c2 control correct: `data[0] = swapCall` (used) stayed 0.

## R20.3b fixes

1. **Tuple-destructure:** assignments `(...) = RHS;` are also collected
   as V assignments — merged with plain assignments, sorted
   by position, the one used is still the LAST. Tuple elements are tested
   per comma (the last word of an element after stripping the type must be V);
   member elements (containing `.`) are skipped (conservative). Limit:
   nested tuples `(a, (b, c))` are only caught if V appears
   as the last word of one of the comma pieces (sufficient for
   the common 1-level shape).
2. **c2 data binding:** a swap marker must now be BOUND to the multicall
   data argument — a literal in the argument, a `data[i]`/`push` fill,
   or the RHS of a variable that is filled in (one hop). Markers are tested per segment:
   the callee STARTS WITH `exactInput`/`exactOutput`/`swap` + `(` or
   `.selector` — `quoteExactInputSingle` and `previewSwap` do NOT
   pass. If the data is not filled locally (parameter/another helper), it falls back
   to the old global test so the behaviour for that shape does not change
   (a documented limit, not a new gap).

## Final result

- Referee probe after R20.3b: **6/6 PASS** (pre-fix 2/6).
- Suite: **862 → 868/868 PASS** (new section 63, 6 tests).
  Negative verification: exactly 4 new tests fail on the pre-R20.3b code
  (63-1/63-2/63-4/63-5).
- Hunting re-run on 9 surfaces after R20.3b: **IDENTICAL** to
  the baseline after R20.3a — Fulcrom 15, Amply 18, RAAC 14,
  Hyperbridge 7, Flow 0, Veno 6, Veno zkEVM 0, LCROBridge 0,
  Resupply 12; recall vs Kiro AMP still 4/7; **0 new candidates.**

## Known limits (R20.3b)

- c2 multicall data binding when the data is a parameter/another helper: falls back
  to the global test (old behaviour retained).
- (i) a small pull to address(this) that is reused as input to
  another swap (F2 residual — needs full taint).
- Nested tuple-destructures >1 level not yet tested.
- (b) pull-forward: a variable-named token that is not WETH without
  `.withdraw(` in the same function body is still flagged
  (conservative; an unwrap in another helper is not visible).
- F11 per-target labels + F10 two-hop remain DEFERRED (see STATUS.md
  session #47: F11 risks mis-scoring severity; F10 two-hop is too
  large 3 days before the 24 Nov freeze).
