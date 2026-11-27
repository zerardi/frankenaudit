# Kiro crew review of the 25th detector `guard-asymmetry-nav-readers` (D25)

- Kiro session: new
  ("Detect Unguarded NAV Readers in Smart Contracts"), 22 Nov 2026 20:46–20:51 WIB.
- Model: Claude Opus 5.5 set explicitly, Autonomous OFF — NOT refused,
  no MODEL_TIDAK_SESUAI flag. Credits: 1.49 (session footer = dashboard delta).
- Verdict: **NEEDS WORK** — the pattern works for the verbatim Cellar.sol shape,
  but guards are not propagated through the call graph and guards are only recognized from
  the text of that entry's own body, first match only per pattern.
- Referee calibration: **R25** (Frankenstein session #56, the same evening) —
  11/11 findings TERBUKTI from the original code, all fixed + locked in by tests
  (Section 67b, 20 new tests). Suite 932/932. Verbatim Cellar.sol still 7 Low;
  hunting re-run on 11 surfaces after R25 IDENTICAL (Somm 32, the rest unchanged).

## Findings + referee verdicts

- **F1 — FP, guard not propagated through a called sibling.**
  `convertToShares` calls `totalAssets()` (guarded) but is flagged.
  TERBUKTI. Fix: guard status = its own shape OR a guarded function exists
  in that entry's transitive closure. Probe 67b-1 -> 0.
- **F2 — FP/FN, guard via an internal helper / custom modifier.**
  `_checkNotLocked()` + the `nonReentrantView` modifier (Euler EVK style) were not
  recognized; `\bnonReentrant\b` does not match `nonReentrantView`.
  TERBUKTI. Fix: closure propagation (F1) + a modifier named `*reentr*`
  in the signature head. Kiro's note accepted: OZ nonReentrant writes storage
  so it practically never appears in view functions — the modifier branch is for the EVK style.
  Probe 67b-2 -> 0.
- **F3 — FN, first match only per pattern.**
  `require(!isShutdown); require(!locked);` — exec without /g captures
  isShutdown, the name filter fails, totalAssets is treated as unguarded.
  TERBUKTI. Fix: all guard patterns use /g + iterate all matches.
  Probe 67b-3 -> 1 @ previewDeposit.
- **F4 — FN, common guard shapes not captured.**
  `_status != _ENTERED`, `unlocked == 1`, `slot0.unlocked`,
  `if (_reentrancyGuardEntered()) revert`, `require(!locked && x > 0)`.
  TERBUKTI (the v1 pattern was bool negation only). Fix: two-sided patterns, positive
  polarity (unlocked/_status == 1), getters, `!X && ...`. Probe 67b-4 (7 variants).
- **F5 — FP, the substring `lock` captures non-lock flags.**
  `depositsLocked` (also timelocked, lockedUntil, reversed-polarity unlocked)
  passed /lock/i. TERBUKTI. Fix: `d25GuardNameOk` rejects
  deposit/timelock/until; `unlocked` is only valid on positive polarity.
  Probe 67b-5 -> 0.
- **F6 — FN, NAV read directly from state without a helper.**
  `totalAssets` returns `_held`, `convertToShares` reads `_held` directly —
  empty closure, no union. TERBUKTI. Fix: a direct state read becomes a
  group key, BUT only if that variable is also read directly by a guarded
  sibling — without this boundary, Cellar's maxMint gets flagged via
  shareSupplyCap and getCreditPositions via creditPositions (verified
  that Cellar's NAV helpers read neither of those variables). Probe 67b-6 -> 1.
- **F7 — FP, name collision with an external call.**
  `asset.balanceOf(...)` was captured as a `balanceOf` call and then
  resolved to the contract's own balanceOf. TERBUKTI. Fix: member calls
  `x.f(` are ignored in `d25CalledNames`. Probe 67b-7 -> 0.
- **F8 — FN, first-wins overloads in byName.**
  Two `_calc` (pure + view); first-wins took the pure one. TERBUKTI.
  Fix: byName multimap, traverse all overloads, self-exclusion
  per object (not per name). Probe 67b-8 -> 1.
- **F9 — FN, helper in a base contract / another span.**
  `_nav` in `abstract contract Base`, Vault `is Base` — per-span byName
  did not find it. TERBUKTI. Fix: cross-span resolution within one file
  (unique, or an inheritance parent; ambiguous -> conservatively skip). Probe 67b-9 -> 1.
- **F10 — FN, `if (locked) { ... }` blocks.**
  A struct literal (`Info({a: 1})`) truncated `[^}]`; emits longer than 120 characters
  failed. TERBUKTI. Fix: a balanced-brace scanner + a 600-character limit;
  `else` is not part of the if. Probe 67b-10/10b -> 1. Referee note: the if-form polarity
  is REVERSED from require (`if (A == ENTERED) revert` = a guard) —
  this bug was found when probe 67b-4 failed the first time, and fixed before
  the suite went green.
- **F11 — potential FP, function-type parameters.**
  `function _apply(function(uint256) external view returns (uint256) f)`
  passed as a view entry/helper because the signature contains the words
  external/view. TERBUKTI. Fix: the signature head is stripped of the contents
  of its parens before the visibility/mutability test. Probe 67b-11 -> 0.

## Kiro notes not adopted in full

- Line numbers from `clean`: Kiro doubted them in case stripComments removed newlines.
  REJECTED by the referee — `stripComments` replaces comment contents with spaces and
  preserves newlines (checked directly in `app/pipeline.js`), so line
  numbers from `clean` match the original source.
- "Limit shared helpers to those that truly read NAV state": applied
  PARTIALLY — member calls ignored (F7) + pure helpers excluded
  (v1); a trivial view helper that reads state (e.g. a `decimals()` view)
  can still become a group key — a known residual, documented in
  the detector comments, not chased 2 days before the 24 Nov freeze.

## Residuals after R25

- Trivial view helpers that read state can still group (see above).
- `super.`/`this.` calls are not traversed.
- A local shadowing a state variable's name can miscount reads (F6).
- Guards via require in a constructor/initializer are not propagated.
- Ambiguous cross-span resolution (the same helper in 2+ unrelated contracts)
  is conservatively skipped.
