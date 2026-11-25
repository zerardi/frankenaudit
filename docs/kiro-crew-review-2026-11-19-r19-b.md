# Review of calibration R19-b — D19 `encodeWithSelector` transferFrom (session #35, 19 Nov 2026)

## Context
Residual from the Kiro review of detectors 18/19 (17 Nov 2026, `kiro-crew-review-2026-11-17-detectors-18-19.md`,
section "Known limits", R19-b): in detector 19 `full-balance-sweep`,
`encodeWithSelector(...transfer.selector...)` takes the amount from the
3rd argument (the transfer position). For `transferFrom` (4 arguments) the actual amount
is in the 4th argument — that pattern was missed (conservative, without FP).

## Kiro crew pass: DEFERRED this session
The morning BB session on 19 Nov 2026 (08:08 WIB) was running in parallel and planned to use
Kiro Web for the Veno cluster — the Kiro pass on R19-b was deferred to avoid
an Arslan login collision (precedent sessions #21/#25/#29/#31). A local referee review
as replacement (Node probe against the real pipeline, not a stub).

## Referee probe (pre-fix, `/tmp/probe-r19b.js`, deleted after use)
| Case | Expected | Pre | Post |
|---|---|---|---|
| P1 transferFrom-selector + `balanceOf(pool)` directly in args[3] | 1 | 0 (FN TERBUKTI) | 1 |
| P2 transferFrom-selector + sweep variable `bal` in args[3] | 1 | 0 (FN TERBUKTI) | 1 |
| P3 transfer-selector + balanceOf in args[2] (regression) | 1 | 1 | 1 |
| P4 transferFrom-selector + literal amount | 0 | 0 | 0 |
| P5 transferFrom-selector + balanceOf in args[2] (the `to` position) + declared amount | 0 | 0 | 0 |
| P6 variable selector | 0 | 0 | 0 |
| P7 direct transferFrom + balanceOf (regression) | 1 | 1 | 1 |
| P8 transferFrom-selector + `pool.balance` (address state variable) | 1 | 0 (FN TERBUKTI) | 1 |

Pre-fix: 5/8. Post-fix: **8/8**.

## Fix (calibration R19-b, `app/pipeline.js`, `detectFullBalanceSweep` step 2)
The `encodeWithSelector` branch now distinguishes the selector before taking
the amount position:

```js
if (args[0] && /\.transferFrom\.selector/.test(args[0])) amount = args[3];
else if (args[0] && /\.transfer\.selector/.test(args[0])) amount = args[2];
```

Referee notes:
- The check order (transferFrom first) is defensive; the two regexes are mutually
  exclusive — `/\.transfer\.selector/` does not match
  `.transferFrom.selector` (there is `From` in the middle), and vice versa.
- P5 is the key negative: if the amount were taken blindly from args[2],
  a `to` that is a balance would be falsely flagged. This calibration does NOT
  change transfer behaviour (P3 remains 1) and does not touch the direct
  `transferFrom` branch (P7 remains 1, amount = args[2] there because
  a direct call only has 3 arguments: from, to, amount).
- A missing `args[3]` (malformed call) is safe: `isAmount`
  returns false for an empty expression.

## Tests
New section 55 in `tests/run-m2-tests.js` (8 tests: 55-1..55-8, copies
of probe cases P1–P8). **Tests 702/702 PASS** (694 old + 8 new).
Local commit `5b48a35`.

## Known limits (new)
- Hash-form selectors `keccak256("transferFrom(address,address,uint256)")`
  without a `.selector` member are not recognised — conservative, without FP.
- `safeTransferFrom` (SafeERC20 library) is not a token interface selector;
  not handled, by design.

## Hunting
Re-run on 6 surfaces after R19-b — see session #35 log in `STATUS.md`.
