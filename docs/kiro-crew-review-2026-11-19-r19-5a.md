# Kiro crew review of R19.5 cast-assignment D19 — referee calibration R19.5a, session #34, 19 Nov 2026

- **Kiro session:** NEW "Audit R19.5 cast-assignment D19", ID 9bff4797-f78c-45dd-b4a9-65516426b201
  (https://app.kiro.dev/session/9bff4797-f78c-45dd-b4a9-65516426b201)
- **Model:** Claude Opus 5.5 selected explicitly, confirmed by the session footer — no MODEL_TIDAK_SESUAI flag.
- **Browser task:** 3102abed-3c65-5ec9-a49c-fab776eff10a, 04:59–05:07 WIB (±8 min, agent answer 3 min).
  Login: Google SSO Arslan with no password/2FA/account picker (the Google session was still active).
- **Dashboard:** before 311.96/4,000 → after **314.72/4,000** (delta **2.76**, session footer 2.75,
  difference 0.01 rounding; remaining 3,685.28, 44 days → pace ≈44/day since 12 Nov — below the 82/day line).
- **Harness:** Kiro built its own in /projects/sandbox/r195-harness/ (harness.js, cases.js, perf.js),
  from a verbatim paste of the R19.5 block — the frankenaudit repo is NOT in the sandbox, no repo code was changed.
  28 cases + a stress test; each case validated with solc-js 0.8.28. Kiro's stubs: parameter parser, declaration regex
  (replacing addrRe), shadow-removal loop, isAddressTypeName with an 8-name allowlist, maskStringLiterals,
  the ident.balance branch from isFullBalanceExpr; sinks not modelled (what was tested is the direct amount expression).
  The referee noted these stub limitations in the disposition of each finding.

## Verdict

- **R19.5: NEEDS WORK** — F1–F6 (below).

## Referee disposition per finding (all verified with probes against the ORIGINAL code + local solc 0.8.20)

### F1 — TERBUKTI, FIXED (R19.5a: contract arm removed + whole-cast check)
The cast branch only checked that the RHS starts with `T(`, without ensuring the cast is the entire RHS —
`T(v).method()` was also counted as a cast. Case 5b `Info memory info = IVault(v).getInfo();` then
`info.balance` (VALID code, solc passes) → 1 pre-fix; 5c/5d the same; 12b
`uint256 bal = IERC20(t).balanceOf(a);` shows the set was polluted (Kiro's own probe was invalid —
the flag there came from the generic `.balanceOf(` rule, not from contamination; the whole-RHS
side effect still cleans `bal` from the set). Two-layer fix: (1) the contract-type arm
REMOVED from the cast branch (see F6 — every F1 instance on valid code flowed through that arm);
(2) the cast must be the entire RHS — jump to the closing `)` (balanced parentheses, new helper
`matchingParenEnd`) and accept only if the next non-space character is `;`, `,` or `)`.
Post probe: 5b/5c → 0. Section 54 tests (54-1/54-2/54-3).

### F2 — TERBUKTI, FIXED (R19.5a: walk-back skips whitespace)
The lookbehind `(?<![\w$.])` only looks at one character before the name; a space between `.` and the member name
slips through. Case 7b `s . x = payable(a);` and 7c `s.` + newline + `x = payable(a);` (both
VALID code, solc passes) → 1 pre-fix. Kiro's suggestion `(?<!\.\s*)` was NOT used — variable-length
lookbehind is not valid in JavaScript. Fix: when collecting evMatches, walk back from
the match position past whitespace; if the previous non-space character is `.`, the match is discarded.
Post probe: 7b/7c → 0 (case 7 without spaces was already 0 before). Section 54 tests (54-4/54-5/54-6).

### F3 — TERBUKTI, FIXED (R19.5a: self-alias unwrap widened)
`castArgIsSelf` only unwrapped `payable(`/`address(`. Case 6d
`r = payable(address(uint160(address(this))));` (VALID code, solc passes) → 1 pre-fix.
Fix: unwrap at most 6 layers over {payable, address, uint/int/bytes, contract types cts/allowlist}
+ plain `(...)` groups; arbitrary function names (e.g. `foo(`) are NOT unwrapped — conservative.
Post probe: 6d → 0; 6a/6b/6c/6e stay 0. Section 54 tests (54-7/54-8).
Referee note: F3 has no observed valid-code instance via the declaration path
(`address r;` already catches `r` first) — its fix is defence-in-depth over the documented
intent of the self-check branch; verified via a mechanism probe (multi-decl scaffolding).

### F4 — TERBUKTI with a FORMULATION CORRECTION, FIXED (R19.5a: bound 4 -> 8)
The fixpoint stopped after 4 rounds; a reversed chain loses names. Kiro's formulation (case 4c
`x5=x4; ...; x1=payable(a);` → 0) is a STUB ARTEFACT: in the original code, `x1` already enters the set via
its declaration (`address x1, ...` — the first var of a multi-declaration is caught by addrRe), so a depth-5 chain
was already 1 pre-fix. The REAL bound issue: a chain root whose declaration is MISSED (the second var
of a multi-declaration) — chains of depth 5 and 6 → 0 pre-fix (referee probe /tmp/probe-f4b.js).
Fix: bound 4 → 8 iterations (linear cost; Kiro's stress test: 80,000 links 44 ms at bound 4).
Post probe: depth 5/6 → 1; depth 9 → 0 (documented limit). Section 54 tests (54-9/54-10/54-11).

### F5 — TERBUKTI, NOT FIXED (known limit)
Ternary `r = cond ? payable(a) : b;` → 0; the regex captures `cond` as the RHS. Kiro itself rated
this "acceptable for a Low detector". Referee: a conservative FN (a miss, not an FP); a fix would need
ternary parsing — out of scope for this session. Documented as a limit; section 54 test (54-12)
locks in the 0 behaviour.

### F6 — TERBUKTI (local solc 0.8.20), FIXED (R19.5a: contract arm removed)
Much of R19.5's motivation was invalid Solidity code — verified by the referee directly
with solc 0.8.20 (not just Kiro's claim): (1) multi-declaration `address a, b;` → Error
"Expected ';' but got ','"; (2) `.balance` on a contract-typed var → Error "Member \"balance\"
not found ... Use \"address(v2).balance\""; (3) `address x = IVault(a);` → Error "Type contract
IVault is not implicitly convertible to expected type address". Consequence: this session's P1/P2 probes
used invalid scaffolding; the contract-type arm of the cast branch was REMOVED — on valid 0.8 code
that arm could only flag invalid code or FPs (F1); R19.5's real value on valid code
comes from the `payable`/`address` casts + plain assignment `x = y` (Kiro cases 1v/3/4a/4b).
Section 53 tests updated (53-2 now 0) + 54-13 locks in `second = IERC20(a)` → 0.
Referee note: Kiro's claim "case 14d declaration path also 1" is a STUB ARTEFACT — in the original code,
the cts loop only iterates types defined in the file/corpus (the ERC allowlist is only used by
isAddressTypeName, not the cts loop); `IERC20 r;` with no definition in the corpus stays 0 in single-file mode.

## Additional referee findings during calibration (not from Kiro)

- **W1 — chained assignment `a = b = T(...)` swallows the second link:** the `/g` regex is non-overlapping —
  the match `a = b` swallows `b`, the link `b = T(...)` is never seen. Fix: rewind
  `assignEvRe.lastIndex = em.index + 1` at the start of each iteration (also for matches skipped by F2).
  Section 54 test (54-14).
- **W2 — the plain-assignment branch needs a terminator:** `x = y` in `x = (y == z)` once
  added `x` (rhs `y` address-typed, `==` passed the negative check). Fix: helper
  `isRhsTerminator` — accept `;`/`,`/`)`/end of string, or a single `=` (chained assignment);
  `==` is rejected. Section 54 tests (54-14 + regression 53-3).
- **W3 — an old D19 limit (not R19.5a):** assignRe `[^;]*` in `detectFullBalanceSweep` swallows
  the following statement if the assignment sits in a condition with no `;` of its own
  (`if ((r = payable(a)) != ...)` + `bal = r.balance` outside the if → 0). R19.5a itself works
  on that path (direct amount `r.balance` → 1, test 54-3). Documented; not fixed
  this session (needs a statement separator, out of scope).

## Final result

- **Tests 694/694 PASS** (680 old + 14 new section 54; 53-2 expectation changed 1 → 0).
- **Hunting re-run on 6 surfaces post-R19.5a: IDENTICAL** — Fulcrom 15, Amply 18, RAAC 14,
  Hyperbridge 7, Flow 0, Veno 2; 0 new candidates.
- **Kiro credits this session: 2.76** (311.96 → **314.72/4,000**; remaining 3,685.28, 44 days → pace ≈44/day
  since 12 Nov — below the 82/day line, safe). Model Opus 5.5, no MODEL_TIDAK_SESUAI flag.
- **Detector backlog stays EMPTY; remaining residuals:** F10 one-hop, F5/F6 taint, F11 per-target label,
  `encodeWithSelector` transferFrom 4-arg, F8 swap-output rename + the new R19.5a limits (F5 ternary,
  reversed chain >8, assignRe swallowing in conditions, `x = T(addr)` with T outside the corpus/allowlist)
  + Kiro's note SP1Beefy headers=[] (an open question from the BB session).
