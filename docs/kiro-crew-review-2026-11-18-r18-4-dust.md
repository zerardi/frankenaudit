# Kiro crew review — R18.4 dust-by-design calibration (D18)

Frankenstein session #30, 18 Nov 2026 12:38 WIB. Kiro pass: browser task bbd99d68,
new session "Audit R18.4 Dust-by-Design D18" (31cd692b), **Opus 5.5 explicit,
no MODEL_TIDAK_SESUAI flag**, 1 min 48 sec, footer 1.87 credits.
Active login with no re-sign-in.

## Context

R18.4 (detector backlog, BB session on the morning of 18 Nov): H3 fell in the hostile-first
Opus 5.5 pass — the mechanism was PoC-verified but the impact class fell because dispatcher residue
is documented as protocol dust
(`intent-gateway/overview.mdx:162`). v1 calibration: a dust signal (identifier
`DustCollected`/`_sweepDust` or a dust prose line + a context word) that is
bound to the dispatcher downgrades a D18 candidate from Medium → Low (the candidate
remains). Tests 570/570 before the review.

## Harness H1–H9: 9/9 PASS

H1 real IntentsBase → signal ≥3 · H2 mentionsDispatcher true ·
H3 "dust is everywhere" → 0 · H4 `uint256 dust;` → 0 ·
H5 overview.mdx:162 quote → signal + mentionsDispatcher ·
H6 dispatch Medium + bound signal → Low + evidence ·
H7 unbound signal → Medium · H8 other detectors untouched ·
H9 an already-Low candidate is unchanged.

## Adversarial attacks: F1 CORRECT, F2–F15 WRONG — verdict NEEDS WORK

Referee jack verified each claim against the REAL code via Node probes
(as in the pattern of previous sessions: Kiro's claims are not swallowed raw).
Kiro's summary mentioned "9 wrong cases" while the detailed list
F1–F15 contains 1 CORRECT + 14 WRONG — the count mismatch is recorded
as-is, not reconciled; what the referee used is the detailed list.

| # | Kiro claim | Referee verification | Fix (R18.4b) |
|---|-----------|------------------|-------------------|
| F1 | `withdrawDust` with no sweep/collect → 0 signals (conservative FN) | CORRECT — safe direction (severity does not drop) | No fix; recorded as a known limit |
| F2 | String literal `"amount is dust, nothing left to dispatch"` → 1 signal, Medium → Low | TERBUKTI — a per-line scan does not distinguish string/code | Prose ONLY from comments (extractCommentBlocks) + docs |
| F3 | Multi-line docs, dust & context on different lines → 0 | TERBUKTI — a per-line scan | Prose per SENTENCE (lines joined first) |
| F4 | "are swept ... as dust" → 0; `sweep\w*` does not match "swept" | TERBUKTI | Add `swept` to DUST_CONTEXT_RE |
| F5 | "dust leftover" / "remainder" / "excessive" → 0 | TERBUKTI | Add `leftover\w*`, `remainder`, `refund\w*`, `excess\w*` |
| F6 | SwapRouter imports IDispatcher + AMM dust comment → Low (most dangerous) | TERBUKTI — mentionsDispatcher was per-file | Binding PER SIGNAL, exact contract name (not generic per file) |
| F7 | "Dispatcher" on another line binds a dust signal | TERBUKTI — same root as F6 | Binding (c) only from the signal's own context |
| F8 | `import {DustCollector}` → 1 identifier signal | TERBUKTI | `import ...;` lines masked (newlines preserved) |
| F9 | "does NOT sweep dust" + `DustSweepNotSupported` → 2 signals | TERBUKTI — reversed meaning | Reject negations (sentence + identifier) |
| F10 | MockDispatcher.t.sol `test_sweepDust` → signal | TERBUKTI — no path filter | Exclude test/tests/mocks?/script, `.t.sol`, `Mock*` |
| F11 | An identical comment 4x → 5 signals; the same text in 3 files → 3 signals | TERBUKTI — only identifiers were de-duplicated | De-duplicate per snippet; a sentence whose evidence is only from an identifier is not counted twice |
| F12 | "shift left by 8 to avoid dust" → 1 signal ("left") | TERBUKTI | Bare "left" removed; only "left over/in/behind/there" |
| F13 | A CallDispatcher signal binds a BridgeDispatcher candidate | TERBUKTI — the name was not checked | Exact name binding (optional I- prefix) |
| F14 | A candidate with no toVerify → crash, partial mutation, batch stops | TERBUKTI | Default the fields first; severity changed LAST |
| F15 | evidence/impact undefined → "undefined [..." | TERBUKTI | Same as F14 |

## Referee decisions (outside Kiro's list, with reasons)

- **The two-source rule (Kiro suggestion 3) ACCEPTED.** A severity downgrade needs
  ≥2 bound signals with different snippets. Hyperbridge (the triggering case)
  has 7+ different signals, so it remains Low. Cost: a project with only one
  line of documentation now does not drop — a conservative direction, correct
  for a function that LOWERS severity.
- **The same-file branch as a binder (Kiro suggestion 2: remove it) RETAINED
  with a recorded reason.** The same-file FPs found (F2 string
  literal, F12 "shift left") already died at their respective roots
  (prose-from-comments, "left" tightened) — not because of same-file.
  Removing it would kill a legitimate case: a dispatcher file that
  documents its own dust in NatSpec.
- **"stay/stuck/trapped/locked/remain"-ish as negation (a referee
  addition).** The sentence "dust leftovers stay in the contract" documents
  dust that STAYS, not dust that is swept — rejected as a signal. The word
  "remaining" deliberately does NOT enter this list (`\bremain\b` does not match
  "remaining", so the overview.mdx:162 quote is safe).
- **F1 documented as a limit, not fixed.** The identifier
  `withdrawDust` (dust with no sweep/collect) really is a dust mechanism,
  but it is not documentation that dispatcher residue is protocol dust.

## Results after R18.4b

- **Tests 588/588 PASS** (570 old + 18 new in section 46: F2–F15 + F1).
  Section 45 updated to follow the two-source rule (45b/45c/45i now
  have 2 signals; 45g uses the `CallDispatcher` contract — docs about
  CallDispatcher do not bind a differently named contract).
- Hunting re-run after R18.4b: Hyperbridge FA-005 `CallDispatcher.dispatch`
  REMAINS Low dust-by-design (7+ different bound signals); other surfaces
  identical — see the session #30 log entry in STATUS.md.

## Known limits (new)

- The identifier `withdrawDust` / `dustBalance` with no sweep/collect is not
  a signal (F1, conservative).
- Binding (b) counts an import of the dispatcher name as a structural
  reference — a file that only imports ICallDispatcher + has a bound
  dust signal (judged legitimate: that file interacts with the dispatcher).
- Candidate names are taken from ALL contracts in the candidate file (not only
  the function's owner contract) — a multi-contract file can bind loosely.
- Multi-sentence prose with a negation in another sentence still passes if
  the dust sentence itself is clean (negation is judged per sentence).
