# Kiro crew review of detectors 18/19 + referee calibration R18.1/R19.1

- Kiro session: "Audit Detectors 18-19 H3"
- Time: 17 Nov 2026, 20:51–21:05 WIB (browser task faf2eceb, 14 min).
- Model: **Claude Opus 5.5 explicit, with no refusal, with no MODEL_TIDAK_SESUAI flag** (the UI footer remained Opus 5.5; there was no "refused; answered by Opus 4.8").
- Credits: dashboard 178.92 → **182.29/4,000, delta 3.37** (footer "Est. Credits Used: 3.37, Elapsed Time: 3m 44s" — matches).
- Login: the account was already signed in as the Arslan account; with no Google click, with no password/2FA.
- Kiro's method: a Node harness over the detectors (33 cases according to its answer).
- Kiro's verdict: **NEEDS WORK** for both detectors (F1–F20).

## Referee disposition (jack) — each claim verified by probes against the REAL pipeline

Probes: `/tmp/wasit1819/probe.js` + `/tmp/wasit1819/debug.js` (node, over `app/pipeline.js` v1 pre-calibration).

### Detector 18 — permissionless-dispatcher

| Kiro claim | Referee verdict | Probe evidence |
|---|---|---|
| (a1) onlyGateway not recognized → FN | **TERBUKTI — but the label is wrong: this is an FP, not an FN** (a guarded function gets flagged) | P-a1: `onlyGateway` + dispatch → 1 (flagged). F1 adopted. |
| (a2) require(msg.sender == gateway) → CORRECT; that pattern also catches `!= address(0)` | **PARTIALLY CORRECT**: (a2) CORRECT; the `!=` claim is WRONG for the `require` regex (`!=` does not match `==`) — but `require(msg.sender == address(0))` IS incorrectly counted as a guard | P-a2a: `== address(0)` → 0 (treated as a guard). F2-narrow adopted (the RHS must be an identifier, not `address(0)`). |
| (a2b) guard `if (msg.sender != X) revert` | **TERBUKTI** (a referee finding from Kiro's F1/F2 priorities) | P-a2b: if-revert → 1 (flagged). if-revert recognition added. |
| (a3) delegatecall → CORRECT | **CORRECT** | Already test 38c. |
| (a4) functionCall → CORRECT | **CORRECT** | Already test 38f. |
| (a5) `calls[i].target.call(...)` missed (F4) | **TERBUKTI** | P-a5/P-a5b → 0. Root cause: the capture `[\w.$()]+?` swallows `.target` starting with a dot → rejected by validation, `.call` already consumed (debug: one match recv=`.target`). F4 adopted: the receiver must start with an identifier + `[..]`/member/call segments. |
| (a6) immutable target + caller data → CORRECT, distinguish label/severity (F11) | **The flag is CORRECT; F11 DEFERRED** | A function-scoped detector does not know state variable types; uniform Medium label. Known limit, the referee triages it. |
| (b) `.call{value:}("")` — the exclusion is correct, but an ETH-only drain is missed → sibling rule F8 | **TERBUKTI** | P-f8: bare drain `(bool ok,)=to.call{value:amt}("")` → 0 in D18+D19. F8 adopted as detector 20 `permissionless-value-send`; F9 obeyed (D18 remains non-empty data only). Note: Kiro's example "withdraw msg.sender.call" is mistaken — that is a legitimate withdraw (receiver msg.sender is excluded by F8). |
| (e) assembly call/delegatecall missed (F3) | **TERBUKTI** | P-asm: assembly `call(gas(), target, ...)` → 0. F3 adopted (basic assembly sinks; staticcall skipped — view-only). |
| (e) internal dispatcher + external forwarder slips through (F10) | **DEFERRED** | Needs a one-hop cross-function call graph (outside function-scoped scope). Known limit, not worked on in this session. |
| F5 receiver taint / F6 data taint | **REJECTED (for now)** | Naive parameter-name taint would REJECT the main target: `call.data` in CallDispatcher does not mention the parameter `encoded` (it flows via `abi.decode`) — it needs full decode-flow taint. The conservative behavior (flag) is retained; the referee triages fixed-data cases. |
| F7 broadened sinks | **ADOPTED** | `functionDelegateCall`, `functionCallWithValueAndGas`, `functionDelegateCallWithGas` added; staticcall variants are DELIBERATELY excluded. |

### Detector 19 — full-balance-sweep

| Kiro claim | Referee verdict | Probe evidence |
|---|---|---|
| (c1) var-form ERC20 → CORRECT | **CORRECT** | Already test 38h. |
| (c2) inline balanceOf → CORRECT | **CORRECT** | Already test 38i. |
| (c3) Call-struct `value:` missed | **REJECTED — artifact** | P-c3: the pure form `Call({..., value: balance, ...})` → 1 (flagged). Suspected to be because Kiro's harness used a replica / another variant. Locked in by test 39n. |
| (c4) rescuing its own balance is an FP | **ANSWERED — already handled in v1** | P-c4a var-form own-balance → 0; 38l direct-form → 0. F15 (exclusion for recipient address(this)/msg.sender) **REJECTED**: it would kill target H3b — P-c4c placeOrder (recipient address(this)) → 1, must remain flagged. |
| (c5) `balance = balance - fee` still flags → CORRECT | **CORRECT** | P-c5 → 1. Literal F14 ("reassignment = not a full-balance") **REJECTED** because it contradicts (c5); F18 adopted (last assignment: self-derived preserves the status, a full reassignment clears it). |
| (c6) multi-line assignment missed (F19) | **REJECTED — artifact** | P-c6 → 1. `\s*` after `=` already swallows the newline (debug: the rhs was captured whole). F19 not needed. Locked in by test 39n3. |
| (d) d1/d2 lazy-span FP "CONFIRMED" | **PARTIALLY WRONG**: the literal d1 example (two statements) **is NOT an FP** — the flag came from the second call which is indeed a sweep (P-d1 → 1, correct); but the cross-paren mechanism is **TERBUKTI** via d1b | P-d1b: `emit Log(transfer(a, 1), balance)` → 1 (a real FP — balance is not the transfer amount). F12 adopted: argument positions via balanced parentheses. |
| (d) transferFrom var as `from` → FP (F13) | **ALREADY CORRECT in v1 for transferFrom** (the prefix `[^,]+,` protects the position); **TERBUKTI for encodeWithSelector** | P-d1c transferFrom(balance, to, amount) → 0 (already correct). P-d1d encodeWithSelector balance as recipient → 1 (FP). F13 fully adopted via positional argument extraction. |
| F14/F18 reassignment | **F18 ADOPTED, F14 REJECTED** (see (c5)) | P-c5b `balance = required` → 1 in v1 (FP); post-F18 → 0 (test 39i). |
| F16 `ident.balance` / `payable().balance` / assembly `balance(x)` | **PARTIALLY ADOPTED (lite)**: `payable(X).balance` added; plain `ident.balance` is **NOT** recognized (struct field ambiguity — by design); assembly `balance(x)` not worked on (no corpus case). | Test 39l. |
| F17 `==` caught as assignment | **TERBUKTI** | P-e17: `x == balanceOf(pool)` then `transfer(to, x)` → 1 (FP). `=(?!=)` adopted. |
| F20 `value:` in directRe too broad | **ADOPTED** (via the F12/F13 rewrite) | The `value:` field value is now read only up to a top-level comma/`}`. |

## What was applied (calibration R18.1/R19.1 + F8)

1. `hasAccessGuard`: +13 only* modifiers (F1: onlyGateway, onlyDispatcher, onlyIntentGateway, onlyExecutor, onlyCaller, onlyTrusted, onlyBridge, onlyMessenger, onlyAdapter, onlyModule, onlySafe, onlyMultisig, onlyTimelock); `require(msg.sender == X)` only if the RHS is an identifier (not `address(0)`); guard `if (msg.sender != X) revert` in both directions (F2).
2. Detector 18: F4 receiver capture (identifier-anchored + `[..]` segments); F7 sinks; F3 assembly sinks (`call`/`delegatecall`/`callcode`, target is the 2nd argument; staticcall excluded).
3. Detector 19: rewritten — positional arguments via `splitTopLevelArgs` (F12/F13/F20); assignment `=(?!=)` + last-assignment semantics (F17/F18); `payable(X).balance` (F16-lite).
4. Detector 20 `permissionless-value-send` (F8, Medium): `.call{value:}(...)` with empty data + one-argument `.transfer`/`.send`, caller-chosen target; receiver msg.sender/owner/beneficiary/address(this) + value 0 excluded; ERC20 transfers (2 arguments) excluded via argument counting.
5. Fixture: BUG 21 `drainValue` + control N (withdrawToOwner/withdrawSelf) + O (payToken); ground truth 22 → **24 candidates**; negative controls 17 → **21**.
6. Tests: **482/482 PASS** (457 old + 25 new in section 39 — all referee probes locked in as regressions).

## New known limits (residual)

- (R18-a) F10: a one-hop forwarder (external → internal dispatcher) is not tracked — needs a call graph.
- (R18-b) F5/F6: receiver/data taint (decode-flow) does not exist yet — the detector is conservative (flags), the referee triages fixed-data / immutable-target cases (F11: uniform Medium label).
- (R19-a) Plain `ident.balance` is not recognized (by design, anti-FP for struct fields); assembly `balance(x)` is not recognized.
- (R19-b) `encodeWithSelector(...transferFrom.selector...)`: the amount is taken from the 3rd argument (transfer position) — for transferFrom (4 arguments) the actual amount is the 4th argument → missed (conservative, with no FP).
## Follow-up calibration from the hunting re-run (R18.2/R20.1, same session)

The post-R18.1/R19.1 hunting re-run found 4 RAAC FPs + 4 Hyperbridge wrapper FPs; all of them were dissected against the real code before being fixed:

- **RAAC 4× `permissionless-dispatcher` (FA-003..006) — GUGUR, FP**: `LendingPool.initiateLiquidation/closeLiquidation/finalizeLiquidation` + `StabilityPool.liquidateBorrower` delegate to a FIXED liquidation proxy (`liquidationProxy`/`liquidationStrategyProxy`, state vars — changed only via `onlyRole(PROTOCOL_ROLE)`) with FIXED selectors (`abi.encodeWithSignature("initiateLiquidation(address,address,bytes)")`, etc.) — not arbitrary targets/data. FP root cause: `hasAccessGuard` did not recognize compound modifiers (`onlyManagerOrOwner`, `onlyStabilityPool`, `onlySupportedAdapter` — `\bonlyManager\b` failed because `OrOwner` was attached). **Fix R18.2**: the only* pattern was made GENERIC (`only[A-Z]...`) + `notBlacklisted`; post-fix RAAC returned to **14** (0 D18). Limit: the F5/F6 principle (distinguishing fixed vs arbitrary targets) is still not worked on — suppression now goes through the only* heuristic.
- **Hyperbridge 4× `permissionless-value-send` Uniswap wrappers — GUGUR, FP**: `swapETHForExactTokens` (`WETH().call{value: msg.value}` — wraps the caller's own ETH to a fixed WETH address) + `swapExactTokensForETH` Gnosis/UniV3 (pulls `amountIn` from msg.sender → unwrap → sends to `to`). **Fix R20.1**: F8 excludes (a) a value of exactly `msg.value`, (b) a no-argument call receiver (`WETH()` = a fixed address), (c) an identifier value pulled from msg.sender via `transferFrom` in the same function. Post-fix Hyperbridge 9 → **6**; 1 F8 remains (UniV3 `swapExactTokensForETH`, value `amountOut` — swap output from the caller's `amountIn` deposit, output variable ≠ input variable → slips past check (c); **referee GUGUR, known limit**: F8 does not track swap-output derivatives).
- **Hyperbridge FA-005 `_execute` sweep (Low) — a NEW instance of class H3b**: `IntentsBase._execute` sweeps the full balance of the OUTPUT-side dispatcher (`balanceOf(dispatcher)` / `dispatcher.balance` → gateway, `emit DustCollected`) — the same class as the `placeOrder` input sweep (FA-004). Not a new submission candidate; material for the H3 draft (output side).
- **Final tests: 488/488 PASS** (482 + 6 new in section 40). Final hunting: Fulcrom **15**, Amply **18** (recall 4/7), RAAC **14**, Hyperbridge **6**, Flow **0**.
