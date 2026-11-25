# Kiro crew review of detector #21 `empty-sublist-proof-advances-height` (R21.1)

- Kiro session: NEW "Audit D21 empty-sublist-proof" 8da7a082-8233-4094-a69d-702d269dccdd
- Model: Claude Opus 5.5 explicit, no refusal, no MODEL_TIDAK_SESUAI flag
- Time: 18 Nov 2026 20:47–20:59 WIB (±12 min, work took 6 min 7 sec)
- Credits: dashboard 293.24 → 298.67 (delta 5.43; session footer 5.43, matches)
- Material: detector v1 pasted verbatim (a condensed version — hypothesis/evidence/toVerify trimmed in the paste) + the BEEFY48 fixture; helpers stripComments/extractFunctions/normalizeCandidate required from the main repo @ 360209b; a Node harness in /projects/sandbox/harness/ (detector.js + run.js)

## Kiro verdict: NEEDS WORK — 42 cases: 8 correct, 15 FP, 19 FN

- Basic tests passed: C00 fixture → exactly 1 Low in verifyParachainHeaders; C01 the real EcdsaBeefy.sol → 1 in verifyParachainHeaderProof; C02 fixture in test/ → 0; a scan of 95 evm/**/*.sol files in Hyperbridge → 1 hit (EcdsaBeefy only), 0 FP in that corpus.
- FP (expected 0, got 1): G03 require(list.length>0); G04 a .length>0 gate + require(.length>0); G05 assert(len>0); G06 if(len==0){revert}; G07 require(len!=0); G08 if(len<1) revert; G09 a guard in the caller verify(); G10 else revert without braces; G11 else + a comment; G12 a variable len$ (RegExp not escaped); G13 height advances INSIDE the gate (the correct fix); G15 an empty list bound to a commitment (hash); G16 three unrelated functions; G17 emit VerifyRequested(len).
- FN (expected 1, got 0): N01 if(len!=0); N02 if(len>=1); N03 if without braces; N04 0<.length; N05 calculateRoot == headsRoot; N06 paras(proof).length; N07–N09 latestBlock/currentHeight/lastHeight; N10 a variable newHeight = proof.blockNumber; N11 stale if-revert without braces; N12 require(blockNumber>latestHeight); N13 reversed stale `<=`; N14 `+= 1` (ambiguous); N15 if(ok) latestHeight=...; N16 a struct literal; N17 if(ok){...}; N18 a gate in a modifier (got 1, but function = contract name); N19 verification in another file (file-level design); N20 a combined `&&`; N21 p.length 1-letter.
- Correct: G01 require(len>0); G02 if(len==0) revert; G14 stale `>` only → 0 (same block passes).

## Kiro findings (F1–F16) + referee verdicts

- F1 a `.length > 0` gate was not checked as a guard (lenVar null) — TERBUKTI, fixed (guard from listExpr).
- F2 the guard was too narrow (require list.length, assert, `if==0 {revert}`, `!= 0`, `< 1`, `$` not escaped) — TERBUKTI for all, fixed.
- F3 a guard in the caller was invisible — TERBUKTI, fixed (the guard is looked for in the gating caller function, in listExpr form).
- F4 a fragile else (40 characters, braces required, comments, else-return) — TERBUKTI, fixed (else parsing + with/without braces + revert/return).
- F5 A/B/C were not linked (G16 three functions; G13 the correct fix still flagged) — TERBUKTI, fixed (path linkage (D) + an advance inside the gate body is excepted).
- F6 a legitimately empty list bound to a commitment — HEURISTIC LIMIT, documented: a new bullet in toVerify ("check whether the empty sub-list is bound to a commitment"); no code change.
- F7 the verification regex matched an event (`emit VerifyRequested`) — TERBUKTI, fixed (`emit` excepted).
- F8 the advRe declaration filter never worked (before was always "") — TERBUKTI, fixed (statement-based filter).
- F9 limited gate forms (!=, >= 1, without braces, 0 < .length, `&&`) — TERBUKTI, fixed (a false-at-0 evaluator + one-statement `ifParts` + split a top-level `&&`).
- F10 lenDeclRe (1-letter, function calls) — TERBUKTI, fixed (`*` + parens allowed).
- F11 verification had to be named *verify* — TERBUKTI, fixed (`calculate/compute/check*Root` also counted).
- F12 latestHeight was hardcoded — TERBUKTI, fixed (an allowlist of 5 height names).
- F13 a limited stale-check (without braces, require, reversed, a blockNumber variable) — TERBUKTI, fixed (one-statement ifParts + strict require `B > H`/`H < B` + a blockNumber variable + a member qualifier `s.latestHeight` — the last two misses were found by a referee probe after R21.1, R21.1b).
- F14 limited height assignment (`+=`, storage not at line start, a struct literal) — TERBUKTI, fixed.
- F15 file-level scoping (N19) — AS DESIGNED, documented in the detector header; not changed.
- F16 generic evidence + function = contract name if the gate is in a modifier — PARTIALLY REJECTED as an artifact: the review paste trimmed the detector's evidence/toVerify (the REAL evidence contains the gate/advance/stale line numbers + path linkage — verified in the code); the modifier part (function falls back to the contract name) is CORRECT plus recorded as a known limit.

## Referee calibration R21.1 (+ R21.1b)

- Referee probe /tmp/probe-d21.js (24 Kiro cases): before the fix 22/24 MISS (N15 already passed); after R21.1 22/24 OK, leaving N12/N13 (a member qualifier in the stale-check) → R21.1b fixed it → probe 24/24.
- Test suite: new section 48b (34 tests: 14 FP + 17 FN + G14 + F6 + N18) — total **641/641 PASS** (607 old + 34 new).
- Real-corpus verification: verbatim EcdsaBeefy.sol remains 1 Low (test 48j); Kiro's Hyperbridge scan of 95 files remains 1 hit.
- Kiro note (not a detector finding): SP1Beefy.sol has a `>=` stale-check + height advances unconditionally, with no len > 0 gate; the incoming header list is a public input to the SNARK — Kiro did NOT verify whether the SP1 circuit accepts headers=[]. Forwarded as an open question to the BB session (not detector backlog).
