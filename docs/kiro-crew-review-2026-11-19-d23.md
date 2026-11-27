# Kiro crew review of the 23rd detector + referee calibration R23

Date: 2026-11-19 (Frankenstein session #37, 16:38 WIB).
Detector: `refund-locked-middleware` (VENO-C1 BridgeMiddleware zkCRO class).
> Status note (27 Nov 2026): VENO-C1 remains a LATENT candidate — mock PoC only,
> 0 victims, never submitted; a Medium pays $0 on this program. The trap fixture
> reproduces the pattern class (synthetic), not the live contract.
Kiro pass: NEW session e10bdb74-d30a-4e3a-9315-d7a13d02a61e,
model Claude Opus 5.5 set explicitly — NO refusal, NO
MODEL_TIDAK_SESUAI flag. Session footer 7,95 credits; dashboard 325,8 → 333,75.
Google SSO login without obstacles (browser task 2b3b400e, 16:47–16:57 WIB).

## Kiro's verdict: NEEDS WORK (F1–F18)

Kiro's method: the detector was run in Node 22 with self-written helper stubs
(stub assumption: body = contents inside curly braces — DIFFERENT from
the project's `extractFunctions` whose body starts from the keyword
`function`; C01 is a reconstruction, not the original BridgeMiddleware). Results per
case: 31 cases, 9 passed / 22 did not match expectations (10 FP + 12 FN).

## Referee verification (ORIGINAL code probe, /tmp/probe-d23-r23.js)

Pre-calibration: **5/35 passed** — all of Kiro's findings reproduced in the original
code EXCEPT F14. Post-calibration: **35/35 PASS**; suite **758 → 781/781**
(Section 57b, 23 new tests).

### ACCEPTED + FIXED (R23)

- **F1 (inline cast)** — TERBUKTI. `IBridgehub(x).requestL2...` did not
  match the old regex (identifier required before the dot). Fix:
  `bridgeCallIn` now scans for `.method(` then reads the object backwards —
  plain identifier OR cast `Type(args)` (balanced-paren reverse scan).
- **F2 (getter + first-match)** — TERBUKTI. Unanchored `bridge\w*`
  matched `bridgehub()`/`bridgeFee()`; first-match shadowed the real
  call. Fix: method regex anchored `^...$`, getter list
  (`get*`/`is*`/`has*` + bridgehub/bridgeFee/baseToken/sharedBridge/etc.
  excluded), ALL matches collected + scored (strong 3 / bridge-verb
  2 / deposit 2), best wins.
- **F3 (object substring)** — TERBUKTI. `l1` matched in `pool1`,
  `gateway` in `wethGateway`, `messenger` in `tokenMessenger`.
  Fix: the `deposit*` branch now requires the object's camelCase token
  = `bridge*` OR `router` (interface `I` prefix stripped) — `pool1`/
  `wethGateway`/`tokenMessenger` drop out; `l1Bridge`/`router`/`IBridgehub`
  remain.
- **F4 (`_msgSender()`)** — TERBUKTI. Inflow now accepts
  `msg.sender` OR `_msgSender()`; rescue lookahead extended to
  `_msgSender()` (a bridge function is no longer considered its own rescue).
- **F5 (`to.transfer` ETH)** — TERBUKTI. Plain `p.transfer` on an
  `address` parameter = ETH transfer, not a rescue. Fix: bare
  `p.transfer/safeTransfer` only if `p` is IERC20-typed; if `p`
  is an address, the form `IERC20(p).transfer/safeTransfer` is required.
- **F6 (rescue in a bridge function)** — TERBUKTI. `findRescue` now
  excludes functions that contain a bridge call (dust in the same tx
  does not help a refund that lands later).
- **F7 (rescue forms)** — TERBUKTI. Added: IERC20-typed parameter
  (`token.safeTransfer`), `SafeERC20.safeTransfer(IERC20(p),…)`,
  1-hop internal helper delegation, guarded arbitrary `execute(target,data)` (C31).
- **F8 (fake rescue)** — TERBUKTI. `transferFrom` REMOVED from the rescue
  pattern (reverts without self-allowance); `require(p == CONSTANT)`
  (allowlist) cancels a rescue.
- **F9 (rescue in parent)** — TERBUKTI. `findRescue` now searches in
  the contract + local-file ancestors (transitive via `contractSpans.parents`).
- **F10 (file-wide delegatecall)** — TERBUKTI. File is skipped only if
  `receive()`/`fallback()` delegates (proxy); multicall to
  `address(this)` does not silence the file.
- **F11 (library)** — TERBUKTI. 1-hop resolution to a library function
  (`Lib.fn`) with the index returned to the call site (line numbers stay correct).
- **F12 (Direct refund semantics)** — TERBUKTI, verified by the referee against
  PRIMARY SOURCES from era-contracts in the corpus (not just Kiro's claim):
  `Messaging.sol` — "refundRecipient … If the transaction fails, then
  this address will receive the `l2Value`" (on L2); `L1Bridgehub.sol`
  `requestL2TransactionDirect` — no nullifier recording (different from
  TwoBridges which calls `bridgehubConfirmL2Transaction`);
  `L1AssetRouter.depositLegacyErc20Bridge` — "Save the deposited amount
  to claim funds on L1 if the deposit failed on L2" (TwoBridges path).
  Fix: a `requestL2TransactionDirect` call is only counted
  if `refundRecipient = address(this)`; if to another user → skip.
  IMPACT: **FA-009 zkCROMintAndBridge GUGUR** (FP — refund returns to
  `_l2Receiver` on L2, not locked); VENO-C1 (TwoBridges) unchanged.
- **F13 (reverting/restricted receive)** — TERBUKTI. A `receive()` that
  contains `revert` / `require(msg.sender == …)` is now counted as absent.
- **F15 (2-hop anchor)** — TERBUKTI. Anchor is now a transitive BFS
  ≤3 hops to the nearest external/public entrypoint.
- **F16 (severity)** — ACCEPTED. Low if the path is ETH-only (without
  tokenInflow) OR the contract is upgradeable (`*Upgradeable` in parents /
  `_authorizeUpgrade`).
- **F17 (evidence text)** — TERBUKTI. ETH-revert note only if there is
  an ETH path (`{value:}` to the bridge — payable + `msg.value` as
  mintValue alone is not an ETH path); hard-coded phrase "specific token /
  ETH to treasury" removed.
- **F18 (path filter)** — TERBUKTI. Added: `script/` directory,
  `.s.sol`, `Mock`/`Harness` suffix before `.sol`.
- **W1 (referee, pre-calibration hunting)** — A call to another
  `*middleware*` contract (`bridgeMiddleware.bridge`) is NOT a bridge-forward
  (its deposit sender is that middleware). Fix: a callee named
  `*middleware*` is excluded. IMPACT: **FA-005 ybETHBridge + FA-008
  ybUSDBridge GUGUR** (transitive FP).

### REJECTED by the referee

- **F14 (wrong line number)** — STUB ARTIFACT. Kiro's claim (report
  line 21 vs original 24) came from its stub assumption (body = contents inside
  curly braces). The project's `extractFunctions`: `body` starts from the keyword
  `function` = `startIndex`, so `startIndex + index-in-body`
  is the correct absolute offset. Evidence: candidate FA-004 on the
  original BridgeMiddleware reported "(line 234)" and `grep -n`
  confirmed `requestL2TransactionTwoBridges` is indeed on line 234.
  Locked in by test 57b-0. No code change.

### ACCEPTED + FIXED (R23, continued — from hunting re-run)

- **F19 (referee, post-R23 hunting)** — The F1 fix (inline cast)
  opened a new hit that turned out to be an FP: `L1Bridgehub.requestL2-
  TransactionDirect` calls `IAssetRouterShared.bridgehubDeposit-
  BaseToken` and `AssetRouterBase._bridgehubDepositBaseToken` calls
  `IAssetHandler.bridgeBurn` — all three are protocol PLUMBING
  (the bridgehub/router/nullifier itself), not user-deposit forwarding
  middleware; refunds do not return to these contracts as
  deposit senders. Fix: contracts named `*bridgehub*` /
  `*assetrouter*` / `*sharedbridge*` / `*nullifier*` are excluded from
  D23. IMPACT: **FA-009/010/011 (bridge core) GUGUR**; Veno post-R23
  final = **8 candidates, D23 leaves only FA-004** (VENO-C1 confirmation).
  Limitation: a middleware that happens to be named `*SharedBridge*` is also
  excluded (judged unlikely; recorded).

## Post-R23 hunting results

- Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 7, Flow 0, Veno zkEVM 0 —
  identical (0 new D23, 0 new FP).
- Veno (Ethereum, 262 files) **11 → 8**: D23 leaves only **FA-004
  BridgeMiddleware#bridge = pipeline CONFIRMATION of VENO-C1**; dropped:
  FA-005/FA-008 (transitive, W1), FA-009 zkCROMintAndBridge (Direct, F12),
  FA-009/010/011 bridge core (F19). 0 new submit candidates.

## Known limitations (new)

- `deposit*` on an object without a `bridge`/`router` token (e.g.
  `l1Messenger.deposit`) is not flagged — conservative FN.
- Rescue via `transferFrom` from a THIRD contract (not
  `address(this)`) is not counted — rare, known limitation.
- Arbitrary `execute` WITHOUT a guard is not counted as a rescue (that is D18's domain).
- Transitive anchor limited to 3 hops; longer chains anchor to
  the internal bridge function.
- Non-zkSync refund semantics (other bridges) remain left to toVerify
  item 1.
