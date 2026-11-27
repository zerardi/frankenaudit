# Kiro crew review of the F10 one-hop calibration + R18.3/F10.1 + referee calibration R10.2

- Kiro session: "Audit F10 One-Hop Dispatcher"
- Time: 18 Nov 2026, 01:08–01:21 WIB (browser task 8c84206f-ce7b-5227-924f-30a9a4d4a736, 13 min).
- Model: **Claude Opus 5.5 explicit, no refusal, no MODEL_TIDAK_SESUAI flag** (UI footer remained Opus 5.5; no "refused; answered by Opus 4.8").
- Credits: dashboard 182,29 → **185,28/4.000, delta 2,99** (footer "Est. Credits Used: 2.99, Elapsed Time: 2m 37s" — matches).
- Login: account already signed in as the Arslan account; no Google click, no password/2FA.
- Kiro's method: Node harness over the detector (26 cases per the assignment + new findings F1–F11, each proven by harness execution).
- Kiro's verdict: **NEEDS WORK** (26/26 cases PASS, 8 new findings claimed TERBUKTI).
- Browser note: reading the final page triggered a system security notice over tool results; the browser agent did not follow any instructions from the page contents and did not run/download/apply anything from it. No impact on this task.

## Table of 26 cases (all PASS according to Kiro)

1–8, 11, 21, 22, 26 as expected (1 candidate); 4–6, 9, 10, 12–15, 18–20, 23, 24, 25 as expected (0 candidates); 16–17 findDispatcherSink directly null. Case 23 (Amply verbatim withdrawETH) 0, case 24 (Hyperbridge verbatim fillOrder) 0; case 9 (two-hop) and 10 (named args) remain 0 per the already-stated known limitations.

## Referee disposition (jack) — each claim verified by probe against the ORIGINAL pipeline

Probe: `/tmp/wasit-f10b/probe.js` + `/tmp/wasit-f10b/probe2.js` (node, over `app/pipeline.js` post-F10/R18.3/F10.1).

| Kiro's claim | Referee verdict | Probe evidence |
|---|---|---|
| F1 FN: dispatcher with a benign sink first | **TERBUKTI (with re-isolation)** | jack's first probe did not isolate (the forwarder also passed data → flagged via sink-1). Isolation probe: forwarder ONLY passes the caller target, sink-1 `gateway.call(data)`, sink-2 `target.call(data)` → 0 (expected 1). Root: only the first sink was analyzed. |
| F2 FN: struct filled per-field | **TERBUKTI** | `c.to = to; c.data = data; _exec(c);` → 0. Root: `collectControlledAliases` only recognizes `name = ...`, not `name.field = ...`. |
| F3c FP: same-named overload | **TERBUKTI** | Forwarder calls the benign arity-1 overload; the Map stores the arity-2 overload (dangerous, last) → 1 (expected 0). |
| F3d FN: overload | **TERBUKTI (order-dependent)** | jack's probe with dangerous-first order → 1 "by coincidence" (the benign record was skipped by the both-empty guard so it did not overwrite). Reverse order (benign-first, dangerous-last + 2-arg forwarder) also 1 — but F3c proves the bug class is real: the Map collapses per name. The arity fix resolves both directions. |
| F4a/F4b FN: parameter names onlyIfSuccess/auth trigger the guard | **TERBUKTI** | D18 directly over `run(..., bool onlyIfSuccess)` → 0; `run(..., address auth)` → 0. Root: `hasAccessGuard` tested the ENTIRE signature including parameter names. |
| F5a FP: `_checkOwner` guard | **TERBUKTI** | `_checkOwner();` in the body → 1 (expected 0). OZ Ownable, very common. |
| F5b FP: `require(owner() == msg.sender)` | **TERBUKTI** | Reversed form → 1 (expected 0). |
| F5c FP: `require(isOperator[msg.sender])` | **TERBUKTI** | Pure membership → 1 (expected 0). Negative control: `require(balances[msg.sender] > 0)` remains 1 (balance check, not a guard). |
| F6a/F6b FP: `abi.encodePacked` / `bytes.concat` with selector | **TERBUKTI** | Data `abi.encodePacked(IMod.fill.selector, o)` / `bytes.concat(IMod.fill.selector, o)` → 1 (expected 0). Negative control: variable selector remains 1. |
| F11 FP: commented-out call | **REJECTED — harness artifact** | `runPipeline` over a snippet with `// _dispatch(calls);` → 0 (the pipeline strips comments first). Kiro's harness built the `fn` object manually without comment stripping — its own condition ("provided the caller has not yet removed the comments") admits this. |
| F7 two forwarders (one guarded, one not) | **NOT A PROBLEM** (Kiro itself) | Only the unguarded forwarder is flagged — correct behavior. |
| F8a/F8b payable/returns, `super._exec` | **NOT A PROBLEM** (Kiro itself) | — |
| F9 reversed alias | **NOT A PROBLEM** (Kiro itself) | — |
| F10 `abi.encode` without selector | **NOT A PROBLEM** (Kiro itself) | Conservatively flagged — intentional (encoding without a selector is not a call to a determined single function). |
| F3a/F3b | PASS "by coincidence" (Kiro) — now deterministic via arity | — |

## What was applied (referee calibration R10.2)

1. **F1 — `findDispatcherSinks` (plural):** all non-excluded sinks are collected; direct D18 still uses the first sink (same behavior); F10 uses the COMBINED target/data parameters from all sinks in the dispatcher body.
2. **F3 — overload arity:** dispatchers are stored as a LIST of records per name; a call is only checked against records whose arity matches (number of arguments == number of parameters). Same-arity overloads (different types) remain ambiguous — known limitation, the first matching one is used.
3. **F2 — member alias:** `collectControlledAliases` now also tracks member/index assignments (`c.field = <controlled>`, `c[k].field = ...`) → the root identifier is marked controlled (same fixpoint).
4. **F4 — `modifierPart(fn)`:** the `hasAccessGuard` modifier pattern is only tested on the signature portion after the parameter closing parenthesis and before `returns`/`{` — not parameter names, not the function name, not return parameters. Body-based checks are unchanged.
5. **F5a — guards `_checkOwner()` / `_checkRole(` / `_checkAdmin(`** are recognized as internal guard calls.
6. **F5b — `require(<ident>()? == msg.sender)`** (reversed form) is recognized as a guard.
7. **F5c — `require(X[msg.sender])`** (optional `== true`, optional second-argument error message) is recognized as a pure membership guard. `require(balances[msg.sender] > 0)` remains NOT a guard.
8. **F6 — `isSelectorPinnedData` extended:** `abi.encodePacked(` and `bytes.concat(` are pinned if the first argument is a constant selector (`.selector` / 4-byte literal / `bytes4(0x...)`); a variable first argument = not pinned. `abi.encode(...)` is DELIBERATELY not included.

## Tests

**530/530 PASS** (513 old + 17 new in section 42: 42a–42q — all referee probes locked in as regressions, including negative controls F5c-neg/F6c-neg and guard regressions F4 42g/42p/42q).

## Post-R10.2 hunting re-run

IDENTICAL, 0 new candidates — Fulcrom **15**, Amply **18**, RAAC **14**, Hyperbridge **6** (remaining D18 FA-002 `CallDispatcher.dispatch` = H3 confirmation, intact), Flow **0**; recall vs Kiro AMP remains 4/7. The `hasAccessGuard` changes (F4/F5) did not change any real-corpus result.

## New known limitations (residual)

- (R10.2-a) Same-arity overloads (different parameter types) remain ambiguous — the first matching record is used.
- (R10.2-b) `require(!isBlocked[msg.sender])` (negated blocklist) is not recognized as a guard.
- (R10.2-c) `abi.encode(...)` without a selector remains conservatively flagged (intentional).
- (R10.2-d) Full F5/F6 taint decode-flow is still not done (F10.1 only handles the recognized selector-pinned forms).
- Still applies: F10 two-hop, cross-file, named-args; F11 per-target label; plain `ident.balance`; `encodeWithSelector` 4-arg transferFrom; F8 swap-output rename.
