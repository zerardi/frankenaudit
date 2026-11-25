# Kiro Crew Review — Detector #16 `vacuous-identity-check` (v2 + v2.1 calibration)

**Date:** 15 Nov 2026 (session 20:38 WIB) · **Reviewer:** Kiro crew, Opus 5.5, session "Audit Bug Bounty Kontrak Solidity" (`9bf915c9-a01e-4675-a9bb-b92f0a1c418a`), 20:49–21:10 WIB, Est. Credits Used **6.05** · **Review target:** detector #16 v1 + fixture `trap-vault.sol` BUG 17.
**Kiro review result:** fixture passed; v1 was correct on only **6/30** of Kiro's test cases (7 FP + 22 FN); 0 hits / 0 FP across 2,549 functions (GMX v1/v2, Aave v3 core/periphery, Uniswap v3-periphery); the gate fired on only 8 functions.
**Referee follow-up (jack):** v2 calibration applied in full from Kiro's findings, then v2.1 from triage of the RAAC hunt in the same session. All changes tested (`tests/run-m2-tests.js` **172/172 PASS**).

## 1. Kiro findings (summary)

### 1.1 False positives in v1
| # | FP class | Example |
|---|----------|--------|
| F1 | The operand is the intermediary identity itself | `msg.sender == router` — the check selects which intermediary is authorized |
| F2 | The guard also allows direct calls | a modifier with `\|\|` that opens an EOA path |
| F3 | `tx.origin` as operand | `other = "tx"` |
| F4 | A function named `restrict` | the v1 gate matched the function name, not a modifier |
| F5 | Role name substring | `GHOST_ROLE`, `NON_ROUTER_ADMIN` |

### 1.2 False negatives in v1
| # | FN class | Example |
|---|----------|--------|
| N1 | Modifier suffix/prefix | `onlyHandlerOrOwner`, `onlyHandlers`, `onlyRouterPlugin`, `onlyPositionRouter` |
| N2 | Other role names | `onlyController` (91× in GMX v2), `onlyTrustedForwarder`, `onlyAllowedCaller`, `onlyBridge`/`onlyGateway` |
| N3 | `onlyRole` variants | `onlyRoles`, `Roles.ROUTER`, `keccak256("HANDLER_ROLE")`, `handlerRole` |
| N4 | Guard in the body | `isHandler[msg.sender]`, `_checkRole` |
| N5 | Sender forms | `_msgSender()`, local alias `address caller = msg.sender` |
| N6 | Operand forms | `address(a)`, indexed left operand, `msg.sender == address(codeOwners[c])` |
| N7 | First-match-only bug | the first `address(this)` hid the real comparison |
| N8 | Comparison in an internal helper | GMX style `_setCode` |

### 1.3 Severity & context
- Severity **Medium** is correct for the Fulcrom case (FA-FUL-01).
- Polarity-based: bypass → Medium; DoS → Low/Medium; operand = intermediary identity → Info.
- Kiro: a corpus with no true positive → v2 recall is unmeasured; Kiro's v2 prototype passed 30/30 of its own cases (overfitting risk noted).
- Context: `ReferralStorage.setTraderReferralCode` in GMX v1 (line 73) **does not have** a self-referral check — the Fulcrom bug is a user-path check copied into the handler path; this detector is primarily a fork-diff heuristic.

## 2. Referee disposition — what was applied (v2)

| Finding | Disposition |
|---|---|
| F4 | The gate is tested **only on the signature tail after the `)` of the params** (`vicSignatureTail`) — `function restrict(` is no longer an FP |
| N1–N3 | Gate widened: camel-case modifier prefix/suffix, `onlyRoles` (Solady), `onlyRole(Roles.ROUTER)`, `onlyRole(keccak256("HANDLER_ROLE"))`, `onlyRole(handlerRole)` (case-insensitive), new roles Controller/Forwarder/Gateway/Bridge/Plugin/Executor/Adapter |
| N4 | Body guards recognized in the first 400 characters of the body (`isHandler[msg.sender]`, `_checkRole(HANDLER_ROLE)`) |
| N5 | Sender aliases recognized (`_msgSender()`, `address X = msg.sender`) |
| N6 | Operands normalized (unwrap `address(...)`, skip `this`/`0`/`0x0+`/`msg.sender`/`address`/`tx.origin`) |
| N7 | All comparisons checked (`matchAll`), one candidate per function, highest severity wins |
| F1, F3 | Operand = intermediary identity → **Info**; `tx.origin` skipped |
| Polarity | `require(x == sender)` → Low/dos; `if (x != sender)` → Low/dos; `require(x != sender)` / `if (x == sender)` / other → Medium/bypass |
| F5 | `onlyRole(GHOST_ROLE)` rejected via the non-letter rule before the role word; `onlyRole(NON_ROUTER_ADMIN)` **still matches (known residual)** |
| — | `onlyHandlerAndAbove` excluded (admin/EOA); `onlyRole(ADMIN_ROLE)`/`KEEPER_ROLE` remain excluded |
| — | `restrict(` **RETAINED** in the tail (a deviation from Kiro's "remove it" advice) — Hyperbridge `HostManager.onAccept` proved it is a real intermediary modifier; tail scoping already closes the function-name FP |

## 3. A bug found while testing v2 (not from Kiro)

**The sender-first alternative-operator regex group had the wrong number.** The combined regex has groups: 1=operand (alt 1), 2=operator (alt 1), 3=operator (alt 2, sender-first), 4=operand (alt 2) — `S` non-capturing. The code used `m[2] || m[5]`, so `op` was always `undefined` for the sender-first form (`msg.sender != X`) and polarity fell back to the default Medium. Evidence: RAAC `repayOnBehalf` was recorded as "if context, bypass class" even though `if` + `!=` should be Low/dos. **Fix:** `m[2] || m[3]` + a sender-first polarity test. Lesson: the early v2 polarity tests only covered the operand-first form.

## 4. v2.1 calibration — from triage of the RAAC hunt (same session)

Two new vacuous candidates from the RAAC hunt turned out to be **both FP**, through two different mechanisms:

### 4.1 FA-RAAC-02 `LendingPool.repayOnBehalf` — GUGUR
`onlySupportedAdapter(adapter)` validates a **parameter**, it does not restrict the caller — anyone can call the function (apart from a blacklist), so `msg.sender != onBehalfOf` is meaningful (self-repay vs third-party). There is no in-repo caller (only the definition + interface + mock). **Fix:** a `Supported*` modifier whose arguments are all function parameter names is excluded from the gate (`onlyRouter(router)` still counts as a gate — ambiguous without reading the modifier body).

### 4.2 FA-RAAC-03 `RWAVault.poolDepositAsset` — GUGUR
`require(msg.sender == stabilityPool)` is meaningful: StabilityPool calls the liquidation proxy via **delegatecall** (StabilityPool.sol:236) → msg.sender in RWAVault = StabilityPool → the check passes and functions as a caller allowlist. **Fix:** `pool` added to the list of intermediary-identity operands (Info class if the function really is handler-only).

Impact: RAAC hunt 16 → **14** (2 vacuous FPs gone); Fulcrom remains 29.

## 5. What was DEFERRED (known limits, not rejected)

- **Kiro §5.3 — a guard that allows direct calls** (a modifier with `\|\|` opening an EOA path): needs the modifier body from the same file; not yet implemented.
- **Kiro §5.4 — 1-level helper inlining** (comparison in an internal helper, GMX `_setCode` style): not yet implemented.
- **Residual:** `onlyRole(NON_ROUTER_ADMIN)` still matches (the non-letter rule only covers `GHOST_ROLE`); an intermediary role held by an EOA that overlaps with end users cannot be distinguished without a call graph.
- **Detector #17 limits (context):** file-scoped — cross-file reads via getters are invisible (16 Fulcrom FPs + 1 Hyperbridge this session); public variables can be read off-chain via getters (RAAC `s_last*` pattern); assembly `sload` is not mapped to a name; local shadowing is counted per line.

## 6. Verification

- `tests/run-m2-tests.js`: **172/172 PASS** (including regression on the original Fulcrom corpus `ReferralManager.sol` — `setTraderReferralCode` Medium, `setTraderReferralCodeByUser` not flagged — plus 4 v2.1 regression tests).
- Re-hunt after v2.1: Fulcrom **29**, Amply **18**, RAAC **14**, Hyperbridge **3**, Flow **0**. Recall vs Kiro AMP remains **4/7**. **0 new submit candidates this session.**
