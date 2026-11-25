# Kiro crew review of detectors 13 & 14 — 15 Nov 2026 (Frankenstein session 04:38 WIB)

Kiro pass: browser task, steering session d9d77979, model Claude Opus 5.5
(started on Sonnet 5.5, manually switched to Opus 5.5; GPT 5.6 not used).
3 files pasted verbatim (the pipeline.js detector code, the trap-vault fixture
BUG 10/11 + control H, RedStone ProxyConnector._prepareMessage) + the review
request verbatim. Kiro tested the regexes with `node -e` (pipeline.js is not
in Kiro's workspace — the `fn.body` parser was not tested).
Credits: 24.51 → 29.14 / 4,000 (delta 4.63; per-message sum 4.62,
difference 0.01 dashboard rounding). No files were changed by Kiro.

Note: "24.51 before the pass" already includes +4.02 from the BB session on the afternoon of 14 Nov
(dashboard lag from 20.49). Remaining after the pass: 3,970.86; 48 days →
pace ≈82.7/day.

## 1. Detector 13 oracle-passthrough — CONFIRMED, with FN and FP

| # | Kiro finding | Jack's disposition |
|---|---|---|
| 1a | Parenthesised guard `(block.timestamp - updatedAt) <= MAX_AGE` not recognised by P1 | FIXED — P1 accepts optional parentheses. New test. |
| 1b | Guard via a variable `age = block.timestamp - updatedAt; require(age <= MAX)` not recognised | FIXED — 2-step tracking (P5). New test. |
| 1c | `updatedAt < block.timestamp - MAX_AGE` and `block.timestamp > updatedAt + MAX_AGE` (revert forms) have no pattern | FIXED — new P3/P4. New test. |
| 1d | Other age variable names (`lastUpdate`) not recognised | FIXED — `TS_VAR_RE` (updatedAt/lastUpdate/lastUpdated/updated_at). New test. |
| 1e | `updatedAt > block.timestamp` (future-only check) wrongly treated as a guard by P2 | FIXED — P2 now requires `block.timestamp - ...` on the right-hand side. New test. |
| 1f | `answeredInRound == roundId` treated as a guard, even though the field is deprecated & does not guarantee data age | FIXED — pattern removed from the guards. Old test section 10 updated (getPriceRound now 1 candidate) + new test. |
| 1g | The comment `// TODO: add stale check later` suppresses the finding (keyword regex runs on comments) | REFEREE CORRECTION — Kiro is wrong in the pipeline context: `runPipeline` strips comments before function extraction (verified: the snippet is still flagged). No fix; a new test locks in this behaviour. |
| 1h | `getPriceUnsafe` (Pyth), `getUnderlyingPrice` (Compound), `getRoundData` not recognised by `PRICE_READ_RE` | FIXED — all three added. `getPriceNoOlderThan` DELIBERATELY not added (built-in guard). New test. |
| 1i | `isBorrowAllowed` counted as a guard — a sequencer sentinel, not a price-age check; its result is inconsistent (validateBorrow suppressed, the liquidation path flagged) | FIXED — removed from the guard keywords. Consequence: `validateBorrow` is now flagged (FA-AMP-17, `live-identical`, by design) — consistent with the liquidation path. |
| 1j | `require(updatedAt != 0)` not counted as a guard — already correct | No change. |
| 1k | `latestRound()` returns a round id, not a price — false positive | FIXED — removed from `PRICE_READ_RE`. New test. |
| 1l | Price reads only for events/views are also flagged | DEFERRED — function-scoped, cannot distinguish valuation vs emit/view. Documented as a known limit. |
| 1m | Aave fork: `getAssetPrice` without a staleness check is upstream design → tag known-issue, not a candidate | ENCODED as `toVerify` guidance (live-identical → by-design/known-issue). No auto-tag — the referee decides. |
| 1n | The variable `m` in `detectOraclePassthrough` is unused | NOT APPLICABLE — Kiro reviewed a paste that jack had simplified; the original code uses `m` in the hypothesis. No change. |

## 2. Detector 14 free-mem-pointer — CONFIRMED, with FN and FP

| # | Kiro finding | Jack's disposition |
|---|---|---|
| 2a | `SIZE_IDENT_RE` without word boundaries matches wrongly: `account` (contains "count"), `WORD_SIZE` (the constant 32) | FIXED — case-sensitive + word boundaries/camelCase endings (`\bsize\b`, `Size\b`, `\bcount\b`, `Count\b`, `\blen\b`). RedStone `_prepareMessage` still flagged (verified). New test. |
| 2b | `ROUNDING_RE` misses common idioms: `mul(div(add(len,31),32),32)`, hex `0x1f/0x20`, `and(add(len,0x1F),not(0x1F))`, mask `sub(0,32)`; the old div pattern (`add(...,32)`) almost never matches | FIXED — div accepts 31/0x1f/0x20/32 + nested parentheses, regex case-insensitive, added `sub(0,32)`. New test. |
| 2c | `mstore(64, ...)` (decimal literal) not recognised by `writeRe` | FIXED — `writeRe` accepts `64`. New test. |
| 2d | A value passed via a variable (`let end := add(ptr, len); mstore(0x40, end)`) is skipped | FIXED — 1-step `let` tracking (sizedVars). New test. |
| 2e | A size from `mload(data)` with no size identifier (the most common Yul idiom — `.length` does not exist in Yul) | FIXED — `mload(` counts as a size signal, EXCEPT `mload(0x40/64/FREE_MEMORY_PTR)` (reads the pointer, not a size). New test. |
| 2f | Rounding in a variable (`let roundedSize := and(add(len,31),not(31))` then `add(ptr, roundedSize)`) still flagged because of the word "size" | FIXED — already-rounded variables are blanked from the expression before testing (roundedVars). New test. |
| 2g | `_prepareMessage` flagged, `initByteArray` flagged, the `_securelyExtract...` reset not flagged — all three as the detector intends | Re-verified post-calibration: `_prepareMessage` + `_extractDataPackage` still flagged. |

## 3. Fixture BUG 10/11 + control H — CONFIRMED, with gaps

| # | Kiro finding | Jack's disposition |
|---|---|---|
| 3a | H passes for 2 reasons at once (P1 + the string `"stale price"` matching a keyword) — the test cannot detect a P1 regression | FIXED — the string changed to `"old price"` (exactly Kiro's test) + keywords are now tested on the body without string literals (`stripStrings`). H now passes only via P1. Ground truth stays 16. |
| 3b | The fixture comment "TANPA STALENESS CHECK" above BUG 10/11 could suppress the finding if the parser included comments in `fn.body` | REFEREE CORRECTION — a comment above a function does not enter `fn.body` (extraction starts at the `function` keyword); comments inside the body are stripped by `runPipeline`. Verified. No change. |
| 3c | Fixture coverage is lacking (none of the point 1 idioms) | FIXED — those idioms are now inline fixtures in section 14 of `run-m2-tests.js` (trap-vault was not enlarged so the ground truth stays 16). |

## 4. `_prepareMessage` Info classification — CONFIRMED

Kiro agrees there is no data-corruption path: an over-read `mload` of ≤31 bytes
is harmless; an over-write `mstore` lands in an area overwritten by
`calldatacopy` or above the new free pointer (not guaranteed clean,
but not corruption); EVM memory is byte-addressable; the function is not
`"memory-safe"` so the optimiser does not assume alignment. In line
with PoC HYP-01 (8/8 PASS). Limit: analysis from reading code only,
with no new PoC; the callers of `_prepareMessage` were not examined.

## 5. Severity calibration — CONFIRMED Low as the default

Stays Low / known-issue: Aave forks (upstream design without a check),
a wrapper that already validates outside the function, reads that are only view/UI/event.
Rises to Medium if all three are met: (1) the price is used for collateral/debt
valuation, liquidation, mint, or redeem; (2) realistic staleness
(a long feed heartbeat, deprecated `latestAnswer`, L2 without a
sentinel); (3) no guard on another path (fallback/sentinel/
circuit breaker). High only if a PoC shows a stale-price difference
can be turned into excess borrowing. These Medium requirements are encoded into
detector 13's `toVerify`; there is no auto-escalation (function-scoped
code does not know the valuation context).

## Hunting impact post-calibration (re-run 15 Nov 04:58 WIB)

- Amply 15 → **16 candidates**: new **FA-AMP-17** `ValidationLogic.validateBorrow`
  (oracle-passthrough, Low) — a consequence of 1i; `live-identical`, GUGUR
  by the referee (by design, same as FA-AMP-14..16). The 15 old candidates
  are unchanged.
- RAAC stays 8, Hyperbridge stays 1 (FA-HYP-04 tx-origin by design),
  Flow stays 0. Test suite 82/82 PASS (58 + 24 new).

## DEFERRED items (not BB-session backlog — recorded here)

- Staleness guards in helpers/modifiers/callees (cross-function analysis).
- Event-only / view-only price reads (distinguish from valuation).
- Assembly variable chains > 1 step in detector 14.
