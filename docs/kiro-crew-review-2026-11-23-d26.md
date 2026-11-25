# Kiro crew review of the 26th detector `unbounded-loop-inflatable-set-accounting` (D26)

- Kiro session: new, https://app.kiro.dev/session/c053d68c-6c89-4487-90d5-ab8341cd94bf
  ("Review Unbounded Loop Pattern Detector"), 23 Nov 2026 12:53–13:01 WIB.
- Model: Claude Opus 5.5 set explicitly, Autonomous OFF — NOT rejected,
  no MODEL_TIDAK_SESUAI flag. Credits: 5.13 (session footer = dashboard delta:
  430.22 -> 435.35/4,000, remaining 3,564.65, 40 days).
- Verdict: **NEEDS WORK** — 58 cases tested in Node (detector code copied
  verbatim; pipeline helpers replaced with stubs by Kiro following the description
  of `hasAccessGuard` — finding F11 depends on that stub): **26 CORRECT,
  12 FP, 20 FN**. Kiro's real-code verification (original Somm files @07efdfa9)
  ALL CORRECT: (A) `deposit()` grower keyParam=receiver; (B)
  `vestedBalanceOf()` FLAG Medium; (C) `totalBalanceOf()` FLAG Medium;
  (D) `withdrawAll`/`withdrawAnyFor`/`userDepositIds`/`vestedBalanceOfDeposit`/
  `userVestingInfo` not flagged. No files were changed / submitted by
  the browser task.
- Referee calibration: **R26** (Frankenstein session #59, the same afternoon) —
  referee probe `/tmp/probe-r26.js` (34 cases, the ORIGINAL detector): baseline
  **5/34 passed** — ALL of Kiro's claims TERBUKTI on the original code except F10
  (intentional behaviour, REJECTED as a fix). Post-R26: **34/34**.
  Two additional fixes beyond Kiro's claims that surfaced during the repair:
  the mappedSet/mappedArr regex supports nested mappings (K3), and the ≥2
  functions-per-span requirement was removed (T3 — the Base/Child spans each have 1 function).
  Permanent tests Section 68b: 33 new tests. Suite **977/977** (944 + 33).
  Hunting re-run on 11 surfaces post-R26 IDENTICAL to baseline (Fulcrom
  15, Amply 18, RAAC 14, Hyperbridge 7, Flow 0, Veno 6, Veno zkEVM 0,
  LCROBridge 0, Resupply 12, EFP 1, Somm 34 — D26 still 2: FA-009 +
  FA-010); 0 new submit candidates.

## Findings + referee verdicts

- **F1 — FP (7 sub-cases), `d26HasEntryCap` too narrow.** C2
  `require(MAX > ids[r].length())` (reversed operands); C3
  `if (ids[r].length() >= MAX) { revert TooMany();}` (the regex `\)\s*revert`
  fails because of `{`); C6 `require(ids[r].length() + 1 <= MAX)`; C11
  `uint n = ids[r].length(); require(n < MAX);`; C4 cap in the modifier
  `capped(r)`; C5 cap in the helper `_checkCap(r)`; C10
  `if (ids[r].length() < MAX) { ids[r].add(a);}`. TERBUKTI. Fix:
  rewrite `d26HasEntryCap` — reversed forms, `revert` inside a `{}` block
  (balanced-brace scanner in the style of D25-F10), `+1` arithmetic, length aliases,
  cap in a modifier body, cap in a one-hop internal helper; plus
  `d26AddIsGuarded` for C10. Probe 68b-1 (8 variants) -> 0.
- **F2 — FN, false cap.** `require(!ids[r].contains(a) && batch.length < 10)`
  — `[^;]{0,100}?` jumps from `ids` to `batch.length <`. TERBUKTI (a real
  regex bug). Fix: the length must be an exact set expression
  (`d26ExprIsSetLength` — the access must cover the entire expression).
  Probe 68b-2 -> 1.
- **F3 — FN (4 cases), reader loop forms not recognised.** L3
  `while (i < d.length)`; L4 reverse loop `for (i = d.length; i > 0; i--)`;
  L5 reversed condition `n > i`; L8 the most common EnumerableSet idiom
  `uint n = ids[u].length(); for (i < n) ids[u].at(i)` (lenAliases only
  came from `arr.length` produced by `.values()`, not `set.length()`). TERBUKTI.
  Fix: `d26Loops` covers `while`; reverse loops (init `i = <LEN>` +
  condition `i > 0`/`>= 0`/`!= 0`); reversed conditions (`LEN > i`); aliases from
  `set.length()` via `d26LengthAliases`, which also recognises an RHS that is a
  set-length. Probe 68b-3 (4 variants) -> 1.
- **F4 — FN (2 cases), every `break` cancels the loop.** L6 conditional break
  `if (d[i]==t) { f = true; break;}` (worst case is still the whole
  set); L11 a break in an inner loop also cancels the outer loop (the check
  `/\bbreak\b/` over the whole `lp.body`). L7 (unconditional break) was already
  correctly not flagged. TERBUKTI. Fix: `d26HasUnconditionalBreak` —
  a break at brace depth ≥1 (inside an `if` block / inner loop) or the form
  `if (cond) break;` without braces = conditional, still flagged; only an unconditional break
  at depth 0 suppresses. Test 68-7 updated to an unconditional break.
  Probe 68b-4 -> 1.
- **F5 — FP, reader-side cap.** `n = d.length; if (n > 50) n = 50;
  for (i < n)`. TERBUKTI. Fix: `d26ClampedAliases` detects an alias clamp
  before the loop (`if (a > N) a =...`, `a = min(a, N)`, ternary) —
  a clamped alias is removed from `lenAliases` for that loop.
  Probe 68b-5 -> 0.
- **F6 — FN (5 cases), key/grower parsing.** K4
  `ids[receivers[i]].add(...)` (`[^\]]+` stops at the first `]`); K3
  nested mapping `mapping(address => mapping(uint => EnumerableSet.UintSet))`
  + `ids3[r][pid].add`; K9 set inside a struct `users[r].ids.add(a)`; K5
  `address k = receiver; ids[k].add(a)`; K10 `deposit(r)` calls the internal helper
  `_deposit(r)` containing `.add`. TERBUKTI (K4/K3/K5/K10; K9 = documented
  limit). Fix: set-access parsing with balanced brackets
  (`d26SetAccesses`, `d26ValuesBase` + `d26MatchingOpenBracket`); the mapped
  declaration regex supports nested mappings; one-step local alias
  `k = <param>` (fixpoint ≤3 rounds); one-hop grower delegation to an internal helper
  with argument→parameter mapping (using `splitTopLevelArgs`,
  substituting the helper's parameter names with the caller's arguments in the helper
  body). Probe 68b-6 (4 variants) -> 1.
- **F7 — FP, mixed msg.sender key.**
  `ids2[keccak256(abi.encode(msg.sender, receiver))].add(a)` (an attacker
  can only fill their own namespace). TERBUKTI. Fix: a key
  containing `msg.sender`/`_msgSender()` anywhere → skip that access.
  Probe 68b-7 -> 0.
- **F8 — FN, set type name hardcoded as `EnumerableSet.`.** A1
  `import { EnumerableSet as ES}` then `ES.UintSet`; A2
  `EnumerableSetUpgradeable.UintSet`. Kiro rated this the largest gap in this
  category. TERBUKTI. Fix: the set type pattern was generalised to
  `(?:[A-Za-z_][\w$]*\.)?(?:UintSet|AddressSet|Bytes32Set)`.
  Probe 68b-8 -> 1.
- **F9 — FP, shadowing.** The parameter `address[] memory holders` (M1) or
  local `address[] memory holders = new address[](3)` (M2) treated
  as the state `holders`. TERBUKTI. Fix: `d26IsShadowed` — skip
  a function for that var if its name appears in a parameter or a local declaration
  (`<type> [memory|calldata|storage] <name> [=|;|,]`). Probe 68b-9 -> 0.
- **F10 — FP (M4), REJECTED as a fix.** The plainSet/plainArr branch
  ignores the parameter-key requirement: `members.add(msg.sender)` is flagged,
  even though the mapped branch rejects a `msg.sender` key. Intentional behaviour:
  a plain shared set can be inflated via sybil (many addresses) — it stays
  flagged, documented in the detector comment + 68b-10. Probe -> 1.
- **F11 — FN, generic `only*` modifiers treated as guards.** `onlyWhenNotPaused`,
  `onlyEOA`, `onlyValidReceiver(receiver)`. TERBUKTI (on Kiro's stub
  `hasAccessGuard` — the same behaviour in the original helper: `hasAccessGuard`
  treats the generic `only[A-Z]` pattern as a guard). Fix:
  `d26HasCallerGuard` — `hasAccessGuard(fn)` first; if true, determine the
  non-guard modifiers (`d26NonGuardModifierNames`: state/time/kind —
  `onlyWhenNotPaused`/`onlyPaused`/`onlyUnpaused`/`onlyAfter*`/`onlyBefore*`/
  `onlyEOA`; parameter validators `/^onlyValid[A-Z]/` whose arguments are all
  function parameters — the pattern `^onlyValid[A-Z]` is deliberate so that `onlyValidator`
  is not included), strip those modifiers from a copy of the signature, re-test
  `hasAccessGuard` on the copy. The global `hasAccessGuard` was NOT changed
  (used by other detectors). Probe 68b-11 -> 1 (onlyOwner control still 0).
- **F12 — FN, coverage.** L13 an `internal view` reader (`_sum`) called by
  a public view; T3 single-file inheritance (set+reader in `Base`, grower in
  `Child is Base`); X1 cross-file (a file-scoped limitation already
  stated). TERBUKTI (L13/T3; X1 = documented limit). Fix:
  an internal view reader called by a public view is now counted, the candidate
  is anchored on the public caller (evidence mentions "via internal
  <helper>"); restructuring of `detectUnboundedLoopInflatableSet`:
  collect vars per span + ancestor closure via `span.parents` (transitive),
  pair growers/readers across spans that see the same var, dedupe
  candidates per (varName, readerFn). Probe 68b-12 -> 1.

## Known limits (unchanged)

- Minimum deposit is not checked (bloat cost per entry = toVerify — an economic
  cap vs an entry-count cap are different).
- Call chains to totalAssets/balanceOf across files are not proven
  statically here (toVerify).
- `.add(` with a constant argument is still flagged (a rare case — the referee
  triages it).
- A set inside a STRUCT FIELD (K9) is not yet recognised; cross-file (X1) is out
  of scope; a cap in a PARENT contract (modifier/helper outside the span) is not
  traced; a grower that adds via a helper >1 hop is not traced.
