# Kiro cross-review — 17th detector `dead-config-storage` (v2)

- **Date:** 16 Nov 2026, 00:41–01:21 WIB (browser task, 43 min)
- **Model:** Claude Opus 5.5 (already selected in the Kiro session)
- **Kiro session:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak Solidity")
- **Method:** code pasted verbatim (GitHub repo main 8c3c079 does NOT contain
  detectors #15/#16/#17 — they exist only in local repo 225243b..fdbc819; branch
  push was not possible because push via connector was paused following Toufik's refusal).
  Kiro ran the review from that paste in its sandbox (with network access:
  shallow clone GMX/Aave/Uniswap).
- **Credits:** dashboard 58,28 → **76,74/4.000 (delta 18,46)**; remaining 3.923,26,
  47 days → tempo ≈83,5/day (slightly above the ±82–84 line).
- **Read-only rule observed:** repo was not modified (`git status` clean),
  scratch folder outside the repo was deleted by Kiro.

## Verdict

| | v1 (before) | v2 Kiro prototype |
|---|---|---|
| Adversarial cases | 36 | 33 detections |
| Correct | **15/36** | **29/33** |
| Wrong | 6 FP + 13 FN + 2 upstream misclassifications | 4 remaining still flagged but downgraded to Info (F1, F3, F6, F14) |

Kiro harness validation: section 18 replica passed 15/15; trap-vault snippet
produced exactly {configDead, feeBps, thresholdDead}; liveCounter and
traderReferralCodes were not flagged; trap-vault.sol main version (without BUG 18)
produced a hit feeBps@payFee. Limitation noted by Kiro itself: test cases
were written by Kiro (overfitting risk on v2); local test suite of 172 tests was not run
because the code is not in main.

## FP cases (expect 0 hits; YES = detector wrongly flags)

| # | Pattern | v1 | v2 fix |
|---|---|---|---|
| F1 | read of another contract's getter in same file (`cfg.paused()`) | YES | P1: still flagged, downgraded to Info |
| F2 | `assembly { sload(fee.slot) }` | correct | — |
| F3 | `assembly { sload(0) }` (raw slot) | YES | P10: still flagged, downgraded to Info |
| F4 | `this.flag()` | correct | — |
| F5 | read by derived contract in same file | correct | P7: derived reads (transitive) still counted |
| F6 | abstract base, internal var, reader in another file | YES | P2: abstract+internal heuristic → Info (full project-pass deferred) |
| F7–F11 | `emit E(fee)`, external call argument, `delegatecall`, `abi.encode`, `keccak256` | correct | — |
| F12–F13 | storage ref to helper, struct field read `cfg.fee` | correct | — |
| F14 | `uint256 public override fee` (interface getter) | YES | P1: still flagged, downgraded to Info |
| F15–F16 | read in modifier, `super.quote()` chain | correct | super counted as read (jack's addition — Kiro v2 also 0 here) |
| F17 | same-named local in an `if` block, state var read after the block | YES | P5: shadowing per-block, not per-function |
| F18 | local in `receive()` treated as a state var | YES | receive/fallback excluded from state var declarations |

## FN cases (expect 1 hit; NO = detector wrongly misses)

| # | Pattern | v1 | v2 fix |
|---|---|---|---|
| N1 | write via `sstore(fee.slot, v)` | NO | P6: sstore → write |
| N2 | modifier param `check(uint256 fee)` read | NO | modifier param shadows |
| N3 | same-named var in another contract (same file) | NO | P7: scope per-contract |
| N4 | `infos[u].limit = v` (field write counted as read) | NO | P6: member-assign chain → write |
| N5 | array only `list.push(a)` | NO | P6: push/pop → write |
| N6 | tuple `(fee, cap) = abi.decode(...)` | NO | P6: tuple LHS → write |
| N7 | named return `returns (uint256 fee)` | NO | P5: return name shadows |
| N8 | name only in string literal `"fee too high"` | NO | P8: strings masked before analysis |
| N9 | local in one-line function | NO | P5: local regex loosened |
| N10 | local in for header | NO | P5: same |
| N11 | `event FeeUpdated(uint256 fee);` | NO | P4: skip event/error declarations |
| N12 | `error FeeTooHigh(uint256 fee);` / interface function without body | NO | P4: skip + interface span |
| N13 | tuple local `(uint256 fee, ) = ...` | NO | P5: same |
| N14 | read only in NatSpec/comments | correct (flagged) | — |
| N15 | only `fee += v` | correct (flagged) | — |

## Upstream classification (U)

- **U1:** baseline has only a same-named event param → v1 live-divergent (wrong),
  ideal live-identical → fixed by P4.
- **U2:** baseline same-named var read in another contract (baseline file) → v1
  live-divergent (wrong), ideal live-identical → fixed by P7.
- **U3:** baseline reads via modifier → already correct (live-divergent).
- **Other gap (Kiro suggestion, DONE this session):** baseline lookup based on
  file name — a renamed file/contract was treated as having no baseline.
  **Contract-name fallback added in `classifyUpstreamDiff`:** when
  basename misses, find a baseline whose contract name matches after normalizing
  version suffixes (`VaultPriceFeedV2` → `VaultPriceFeed`). Result: FA-FUL-02/03
  (`favorPrimaryPrice`/`spreadThresholdBasisPoints`) are now annotated
  `live-divergent; baseline VaultPriceFeed.sol` by the pipeline itself
  (previously only manual referee verification); Fulcrom without-baseline 9 → 3.

## Additional Kiro finding (shared helper)

`stripComments` does not recognize single-quoted strings — `'ipfs://cid'`
truncates the rest of the line; in Kiro's test, `uint256 public fee;` and a getter on the same
line were also lost. **Fixed this session (P8):** stripComments now
handles `'...'` like `"..."` — affecting ALL detectors, not only #17.

## v2 calibration applied by jack (in local repo)

P6 + P5 + P4 first (closing 10/13 FN), then P1 + P3, P7, P8, P10, P11,
rename fallback. Implementation deviations/choices vs Kiro's sketch:

- **Member-call order:** `.name(` is counted BEFORE the contract-scope filter —
  otherwise, F1 is never recorded (member-call is always outside the owner
  span). Found when the first 2 tests failed.
- **`super.x()` = read** (not a member-call): parent contract getter via super
  is a legitimate read (F16).
- **Function-without-body skip tightened:** Kiro's regex could swallow a function body
  containing `;` — jack's version requires no `{` between `)` and `;`.
- **Local shadowing per-block** computed via char index (find the opening `{` of the innermost
  block backwards + closing `}` forwards), not per-line.
- **P2 cross-file project-pass NOT implemented** (needs a multi-file
  pipeline) — replaced with abstract+internal heuristic → Info; full F6 remains
  residual.
- **P10 coarse at file level:** if there is a numeric-slot `sload/sstore` in the file → all
  hits in that file are downgraded to Info (not per-var).
- **P11 requires the file to mention ERC20** (`/ERC20/` in source).

## Local test results

**212/212 PASS** (172 old + 40 new: 36 Kiro F/N/U cases + P3 + P11 +
2 rename fallback tests). Trap-vault ground truth remains 20 candidates.

## Real-corpus verification (jack, local)

Pipeline v2 over local GMX v1 `contracts/` (154 files): **10 hits, 0 Low,
10 Info** — 8 fee/leverage params `public override` in Vault.sol + 2
ReferralStorage (`referrerTiers`, `referrerDiscountShares`, override).
Kiro over full clone (610 files, 5 repos): v1 22 hits GMX v1; v2 file-scope 17
hits (10 Info) → 7 after project-pass. Difference in counts explained: local corpus
is only `contracts/` (without `artifacts-v2` duplicates), P11 already removed
4 ERC20 metadata hits, and `ChainReader.latestBlockHash` is not in the local
baseline. Same conclusion: **0 of all hits are R-02 class bugs.**

## Post-v2 hunting re-run (this session)

Fulcrom **29 → 30** (new FA-FUL-04 `PositionManager.feeAdmin`, Low — see
bb-log; 15 Vault vars Low → Info via `override`); Amply **18**, RAAC **14**,
Hyperbridge **3**, Flow **0** — identical, 0 new submit candidates.

## Residual (for following sessions)

1. Cross-file project-pass (P1 second part + full P2): getter readers /
   derived contracts in other files are still only heuristic.
2. Rename fallback uses the FIRST contract in the file; multi-contract files can
   mismatch if the first contract is not the one sought.
3. Abstract+internal heuristic can over-downgrade (an internal var in an abstract
   contract that is genuinely dead stays Info, not Low).
4. Kiro's 36 test cases were written by Kiro itself — overfitting risk; if there are new FP/FN
   from real hunting, add them as regressions.
