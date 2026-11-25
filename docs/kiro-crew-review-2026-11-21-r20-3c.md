# R20.3c calibration based on the Kiro R20.3b review (D20 swap-output)

Frankenstein session #48, 21 Nov 2026. **Kiro crew pass + referee calibration.**

## Kiro crew pass

- NEW session "Audit R20.3b D20 swap-output" (74ec0a1c-14e9-4aec-8a16-de7a34a57d64),
  browser task c407f520, 12:48–13:07 WIB, **Opus 5.5 explicit with no
  refusal — no MODEL_TIDAK_SESUAI flag**; Arslan SSO login alive
  with no obstacles. Pass credits: 5.14 (footer 0.50 + 0.20 + 4.44;
  dashboard 380.44 → 385.58/4,000).
- The attached file d20-r203b-kiro.js was REPORTED as attached 2× but Kiro said 2×
  that the message arrived without an attachment — fallback: the code was pasted verbatim
  (a ```js block) in the third message; the Node harness ran without regex crashes,
  and there were no transport artifacts reported as findings. Lesson: file attachments
  to a Kiro Web session are NOT reliable — verbatim pasting remains the main path.
- Kiro verdict: **NEEDS WORK — 20/22 cases passed** (C4 failed, T5
  report-only) + 11 new findings F1–F11.

## Referee disposition (probe of the ORIGINAL code /tmp/probe-d20-r203c.js + r203c2.js)

| Finding | Referee verdict | Reason / evidence |
|---|---|---|
| F1 (C4 push) | **TERBUKTI** (mechanism corrected) | The push capture `([^;]*)` swallowed the closing `)` → the value `swapCall)` failed the marker + one-hop. Kiro's claim "fills empty" is WRONG — fills were populated, their values were polluted. Fix: capture `[^;)]` + `[^;]*;`. |
| F2 (two fills) | **REJECTED as a harness artifact** | The code checks ALL fills (a `for...of fills` loop, returns true if any one passes). Local probe: data[0]=swap + data[1]=quote → 0. The claim "only the last fill is read" contradicts the code. |
| F2b (encodeCall) | **TERBUKTI — referee finding** | `abi.encodeCall(ISwapRouter.exactInputSingle, (...))` — the segment is followed by `,`, not `(`/`.selector` → the marker failed → 1. Fix: the terminator `,` was added to the c2 marker (not c1 — the encodeCall RHS is bytes, not swap output). |
| F3 (first def) | **TERBUKTI** | `defRe.exec` without /g only took the FIRST definition — a quote→swap reassignment was invisible → 1. Fix: a /g loop over ALL definitions, true if any one has the marker. |
| F4 (struct literal) | **REJECTED as an artifact** | The claim "the capture stops at the struct `{`" is WRONG — regex backtracking: the capture shrinks to the tuple's own `)` before `=`. Local probe: tuple + ExactInputSingleParams({...}) → 0. |
| F5 (assignment after send) | **REJECTED as an artifact** | `cut = body.slice(0, beforeIdx)` — assignments after the send are invisible. Local probe (tuple + plain, after the send) → 1. This contradicts T8, which passed in Kiro's own harness — their F5 probe body must have been different. |
| F6 (pull after assign) | **REJECTED — not a bug** | Kiro itself admitted "no bug here": the guard `pullPos >= lastAssignIdx` behaves correctly (the pull must precede the assignment). The invariant is ALREADY written in the code comments. |
| F7 (fallback wording) | **TERBUKTI — documented boundary, NOT changed** | The fallback `/exactInput\|exactOutput/.test(cut)` is indeed global — that is old pre-R20.3b behavior deliberately kept when the data is not filled in locally. Tightening it 3 days before the freeze risks new FPs on real multicall param-data. Residual. |
| F8 (swapFee) | **TERBUKTI** | `swap\w*` let `swapFee(`/`swapFee.selector` through in c1 + c2 → 0. Fix: `isSwapEntryPoint` — bare `swap`, or prefixed with `swap` + containing `Exact`, or exactInput/exactOutput. Controls: `swapTokensForExactTokens` + bare `swap` still 0. |
| F9 (scope) | **TERBUKTI — boundary, NOT changed** | The fill regex is global with no scope tracking: an inner-block `data` (swap) frees an outer-block payout `data` (quote). A fix needs scope analysis — too large 3 days before the 24 Nov freeze. Residual. |
| F10 (tuple bracket) | **REJECTED — invalid snippet** | `(uint256 amountOut[2], ...)` is not valid Solidity declaration syntax; the valid form `(amountOut[0], used) = swap(...)` + sending `amountOut[0]` → 0 CORRECTLY (THAT element is swap output). Bracket stripping retained. |
| F11 (cap 200) | **TERBUKTI** | A 226-character tuple → 1 (discarded by the cap). Fix: cap 200 → 400. |
| T5 (nested tuple) | **TERBUKTI — documented boundary** | The element `uint256 amountOut)` (leftover inner paren) did not match the last word. Fix: strip the trailing `)` from the element's last token. |

A note on Kiro's honesty (passed on as-is): F1 says the fallback
still frees C4 while the harness table records C4 actual 1;
F2 is labelled "false negative" while its prose describes
over-flagging; the FN/FP labels in Kiro's conclusion are swapped in several
places (T5 actual 1 = over-flag, not "drain missed"). The referee
uses the actual numbers + the original code as the authority, not Kiro's labels.

## R20.3c fixes

- New helpers `isSwapEntryPoint` + `hasSwapMarker` (used by c1 + c2).
- c1: the segment is captured + validated by the helper (not a raw test).
- c2 marker: `hasSwapMarker` on dataArg, fills, and definitions; terminator
  `,` added (encodeCall).
- Push fill: capture `[^;)]` + `[^;]*;`.
- Def lookup: a /g loop over all variable definitions.
- Tuple: cap 200 → 400; strip the trailing `)` from the element's last token.
- Suite: **868 → 879/879 PASS** (Section 64, 11 new tests). Negative
  verification: exactly 7 fix tests fail on the old code (64-1/3/4/5/6/9/10);
  4 controls also pass on the old code.

## Known boundaries (R20.3c)

- c2 fallback when the data is a param/another helper: global test (old behavior
  retained; F7).
- Same-named `data` fills across scopes: no scope tracking (F9).
- Tuples nested >2 levels / elements with a double `)` in the middle: not yet tested.
- (b) pull-forward: a variable token that is not WETH without `.withdraw(` in
  the same body is still flagged (an unwrap in another helper is not visible).
- F11 per-target labels + F10 two-hop remain DEFERRED (see STATUS.md
  session #47: F11 risks mis-valuing severity; F10 two-hop is too
  large 3 days before the 24 Nov freeze).
