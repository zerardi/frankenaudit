# Kiro crew cross-review of detector #15 (eth-locked-receive)

Date: 15 Nov 2026, 12:39–12:47 WIB (Frankenstein sprint session #12).
Model: Claude Opus 5.5 (selected manually in the "Audit Bug Bounty Kontrak Solidity"
session 9bf915c9-a01e-4675-a9bb-b92f0a1c418a; the initial picker showed Sonnet 5.5).
Credits: 32.68 → 36.74 (delta 4.06; Est. Credits Used in the answer: 4.06;
elapsed 3m 34s). The detector code was pasted verbatim + context + 5 questions.

## Kiro test results (26 cases in Node, a simple stripComments stub)

- 14 of 26 cases = false positive, 7 = false negative (before calibration).
- Almost all FPs came from unrecognized ETH-outflow idioms.

## 1. Missed ETH-outflow idioms (all proven FP in Kiro's test)

- Nested payable cast: `payable(owner()).transfer(x)` — `[^)]*` stops
  at the first `)`. The most frequent bug according to Kiro.
- `address payable` + immutable/constant: the old declRe captured the word
  `immutable` as a variable name.
- `address payable[]` array: `rs[i].transfer(x)` — declRe required a space
  after `payable`, the variable regex did not allow `[i]`.
- Solady/Solmate/Uniswap: `SafeTransferLib.safeTransferETH`,
  `forceSafeTransferETH`, `trySafeTransferETH`,
  `TransferHelper.safeTransferETH` — usually imported, the call body is not
  in the file.
- OZ Address: `Address.functionCallWithValue(t, data, x)` — only `sendValue`
  was recognized.
- Call option `{value:}` outside `.call`: `IWETH(w).deposit{value: x}()`,
  `entryPoint.depositTo{value: msg.value}(…)`,
  `router.swapExactETHForTokens{value: x}(…)`, `new B{value: x}()`.
- Legacy syntax (≤0.6): `to.call.value(x)("")`.
- `msg.sender` / `tx.origin` (≤0.7): `msg.sender.transfer(x)` — safe
  to add because in 0.8 that code does not compile for ERC20.
- Assembly: `call(gas(), to, v, 0, 0, 0, 0)`, `create(v, …)`,
  `create2(v, …)`.
- Premise correction: `WETH.withdraw()` is ETH IN, not out
  (WETH sends ETH to the contract); the outflow idiom is `deposit{value:}`.
  `delegatecall` is not an ETH-outflow idiom — it is the proxy FP case (point 2).

## 2. False positives

- Proxy delegatecall (OZ Proxy v4, ERC1967, Transparent, Beacon, Diamond,
  Safe proxy): the OZ Proxy test case produced 2 hits (receive + fallback);
  the ETH-outflow logic lives in the implementation (another file). A proxy is almost always
  present in a target repo.
- Inherited outflow from another file (`contract X is Rescuable`,
  `BasePaymaster`…) — cannot be resolved at file level.
  SimplexPaymaster was safe only because `withdrawTo` happened to be in the
  same file.
- Declaration without a body: `abstract contract A { receive() external payable
  virtual; }` → 1 hit; an interface declaring `receive` was also hit.
- A `receive` that immediately forwards ETH (`ep.depositTo{value:
  msg.value}(…)`, `IWETH.deposit{value:}`) — a derivative FP from the
  `{value:}` gap in point 1; a common pattern in paymasters.
- A `receive` that reverts or only accepts from one sender:
  `receive() external payable { revert(); }` → 1 hit; the Uniswap router
  (`assert(msg.sender == WETH)` + `TransferHelper.safeTransferETH`).
- Mock/test: `mocks/`, `test/`, `*.t.sol`, `Mock*`, `Harness*` —
  HostManager could only be recognized via a "test-only" comment, and that comment
  had already been removed by `stripComments`; a path filter is more reliable.
- WETH itself was safe and correctly produced 0 (its withdraw uses
  `call{value:}`).

## 3. False negatives (premise corrections + proven ones)

- WRONG premise: `fallback(bytes calldata d) external payable returns
  (bytes memory)` is STILL flagged (`[^)]*` handles parameters
  correctly); `receive() external payable onlyX` is still flagged; a `receive` in
  an interface produces an FP, not an FN.
- Proven FNs: `receive() payable external {}` (free modifier order);
  `receive() virtual external payable {}` + `override` in front;
  `receive() onlyX external payable {}`; `function() external payable {}`
  plus `function() payable public {}` (≤0.5, unnamed fallback).
- Suppression by DECLARATION, not by call: a `function
  withdrawTo(address,uint)` in the contract itself that only sends ERC20
  (OZ ERC20Wrapper style) also suppressed it; a `withdrawTo` in the `IEntryPoint` interface
  in the same file also suppressed it even though it was never
  called. The `sendValue\s*\(` pattern has the same problem.
- Outflow in ANOTHER contract in the same file: `contract B { …transfer…
  } contract A { receive… }` made A suppressed as well.
- Design limit (not tested by Kiro): a `call{value: 0}` or `call{value:
  msg.value}` that only forwards value still suppresses, even though ETH from
  a receive can never leave that way.

## 4. Severity

- Info is already correct as the default.
- Variants worth raising to Low (ETH comes in through the protocol's normal flow, not
  user error): the file calls `IWETH(…).withdraw(…)` but has
  no ETH-outflow path; the contract becomes a `refundAddress` / `refundTo =
  address(this)` for a bridge/messaging fee (LayerZero, CCIP,
  Hyperbridge); a payable function that receives more `msg.value` than it
  uses without a refund (outside the receive regex, same class).
- Remains Info/downgraded: a contract behind an upgradeable proxy (a rescue can
  be added via an upgrade); a `receive` with a `msg.sender == WETH` guard.

## 5. Kiro's proposed fixes (in priority order) + application status

1. Widen the ETH-outflow idioms — **APPLIED in v3** (general `{value:}` call option,
   nested casts, declRe for immutable/constant/array, the safeTransferETH
   family, `functionCallWithValue`, legacy `.value(`, `msg.sender`/
   `tx.origin` transfer/send, assembly `call(gas(),…)`). Two of Kiro's long regexes
   were truncated in the page display (the full declRe + the receive/fallback
   regex) — jack's own version was applied, tested 116/116.
   Assembly `create`/`create2` NOT YET applied (known limit).
2. Handle proxies separately — **APPLIED in v3**: a file containing
   `delegatecall(`/`_delegate(`/`_fallback(` → no hits.
3. New receive/fallback regex (only if there is a body, modifiers in any
   order, legacy fallback) — **APPLIED in v3**; a `receive()` that immediately
   `revert()`s has NOT YET been downgraded to a skip (known limit).
4. Per-contract scoping + count calls, not declarations —
   **PARTIALLY APPLIED in v3**: `withdrawTo`/`withdrawStake`/`sendValue`
   are now call patterns (`(?<!function\s)`). Per-contract splitting +
   a project pass (the `is` chain) NOT YET done — needs design, recorded
   as a known limit in pipeline.js.
5. Path filter + severity calibration — **APPLIED in v3/v3.1**: test/mock paths
   are skipped; raised to Low if there is `IWETH.withdraw` / `refund=
   address(this)`. v3.1: a plain `.withdraw(` is NOT enough — Hyperbridge's HostManager
   (`IHostManager(...).withdraw()`, withdrawing bridge revenue)
   was falsely elevated to Low; WETH must be the receiver.

## Post-calibration verification (this session)

- Test suite: **116/116 PASS** (94 old + 22 new in sections 15/15b).
- Hunting re-run of 15 detectors (+ baseline): Amply 18 (identical, FA-AMP-18/19
  remain Info), RAAC 8 (identical), Hyperbridge 2 (FA-HYP-07 back to Info
  after v3.1; FA-HYP-04 tx-origin High remains), Flow 0. **0 new
  candidates; no new KANDIDAT FRANKENSTEIN entries this session.**
- The trap-vault ground truth remains 16 candidates (TrapVault has
  `call{value:}` → correctly suppressed).
