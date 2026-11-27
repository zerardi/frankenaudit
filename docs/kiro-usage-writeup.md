# FrankenAudit — How we used Kiro

> Text for the "Built with Kiro" / Additional info field of Devpost
> 1298511 (M5). Status: FINAL (27 Nov 2026, corrected after the hostile
> re-review and re-check) — Devpost draft 1298511 was re-filled with
> this version on 27 Nov 2026.
> Credit figures as of 27 Nov 2026 15:30 WIB: used 854.12 / 4,000
> (remaining 3,145.88; 35 days).

## Steering (`.kiro/steering/`)

- **`bug-bounty.md`** — the bug-bounty hunter persona defined in the repo for Kiro:
  candidate-not-verdict, falsifiable hypotheses, a severity gate of
  Medium and up, a fork PoC before any claim, no submission without human
  approval. This is the same "brain" our daily audit sessions use, brought
  into the project as repo steering.
- **`product.md`** — what FrankenAudit is, who its users are, the
  candidate-not-verdict principle.
- **`tech.md`** — the stack (static app + Node pipeline + Slither +
  Foundry) and the repo's rules of play.

## Specs (`.kiro/specs/frankenaudit/`)

- **`requirements.md` / `design.md` / `tasks.md`** — the M1–M5 spec:
  scaffold → MVP pipeline → live URL → submission assets → filling the
  Devpost draft. Milestones were worked session by session following
  tasks.md.

## Hooks (`.kiro/hooks/`)

- **`candidate-format-check.json`** — a candidate-format hook (v1 schema): every
  candidate written into a report must carry a location (file:function),
  a hypothesis, preconditions, impact, and a verification method. This is
  the format the pipeline (`report.js`) and the hunting reports use.

## Custom agents / agent crew

There is no separate custom-agent file — the crew is **Kiro sessions with
the same bug-bounty.md steering, run in different roles** (wide pass →
final pass → cross-check), matching how our team works. The crew's
standard model: **Claude Opus 5.5, selected explicitly at the start of
a pass** (one early pass ran on Auto, and the model picker once drifted
on its own to Opus 4.8 — more expensive — so the actual model is
recorded every session).

| Pass | Model | Result |
| --- | --- | --- |
| Audit of 18 Amply files (Cronos zkEVM) | Auto | 7 candidates AMP-01…AMP-07 (afternoon BB session 13 Nov; delta 4.91 credits) |
| Cross-review of trap-vault vs ground truth | Opus 5.5 | 3/7 CONFIRMED, 2 raised to Critical (setOwner, payFee — the referee later set both to High in the ground truth); 4 downgraded with reasons; 4 new bugs the pipeline had missed (findings A–D) → 2 became new detectors (replay-signature, share-accounting) |
| Review of detectors 13/14 (oracle passthrough, free-mem-pointer) | Opus 5.5 | 5/5 CONFIRMED + guard/coverage calibration |
| Review of detector 15 (eth-locked receive) | Opus 5.5 | 26 adversarial cases → calibration v3/v3.1 (ETH-exit idioms, proxy, test paths) |
| Review of detector 16 (vacuous identity check) | Opus 5.5 | v1 correct 6/30 → calibration v2/v2.1 (tail-scoped gate, polarity) |
| Review of detector 17 (dead config) + project-pass | Opus 5.5 | 15/36 → calibration v2; the cross-file project-pass was born from this review |
| Review of Intake & Gate (M2.5) | Opus 5.5 → 4.8 | 95/99 cases correct, 0 security FPs → calibration R1 |
| Review of detectors 18/19/20 (dispatcher, sweep, value-send) | Opus 5.5 | NEEDS WORK F1–F20 → referee calibration R18.1/R19.1/R18.2/R20.1 |
| Review of detector 21 (empty-sublist proof) | Opus 5.5 | 42 cases → calibration R21.1/R21.1b |
| Review of detector 22 (JIT reward accrual) | Opus 5.5 | NEEDS WORK F1–F18 → calibration R22 (28/28 referee probes) |
| Review of detector 23 (refund-locked middleware) | Opus 5.5 | NEEDS WORK F1–F18 → calibration R23 + F19 (37/37 referee probes) |
| Review of detector 24 (variant-branch no-payload-consume) | Opus 5.5 | NEEDS WORK, 36 cases (9 correct, 15 FP, 11 FN, 1 ambiguous) → calibration R24 (20/20 referee probes, severity Low → Info) |
| Residual calibration reviews (R5/R6/R8/R9/R10/R19.x) | Opus 5.5 | Each pass: an adversarial Node harness + referee calibration over claims verified against the real code |
| Calibration R-DIV-1 (division-no-guard guard) | — (local referee, no Kiro pass) | 5/5 Medium Resupply FPs killed (early-return/assignment/else/if-positive) → 9 tests in Section 59, suite 832/832 |
| Calibration R18.5 + R-COF-2 (D18 permission-record guard + "Equivalent to require") | — (local referee, no Kiro pass) | 3/3 Medium Resupply FPs killed (Core.execute + 2× FixedPointMathLib) → 10 tests in Section 60, suite 842/842 |
| Calibration R20.3 + R20.3a (D20 F8 swap-output) | Opus 5.5 | NEEDS WORK F1–F7 → F1 rejected (transport artifact), F2–F6 proven + fixed → 9 tests in Section 61 + 11 tests in Section 62, suite 862/862 |
| Calibration R20.3b (D20 residual F7 tuple + F5 data binding c2) | — (local referee, no Kiro pass — the morning BB session used Kiro) | Probes 6/6 (4/6 failed pre-fix) → 6 tests in Section 63, suite 868/868 |
| Calibration R20.3c over Kiro review R20.3b (D20) | Opus 5.5 | NEEDS WORK 20/22 + 11 findings → F1/F3/F8/F11/T5 + referee's F2b proven + fixed; F2/F4/F5/F6/F10 rejected (artifact/invalid); F7/F9 limits documented → 11 tests in Section 64, suite 879/879 |
| Calibration R-COF-3 + R-COF-3a over a Kiro review (commented-out-check: live `if + revert` counterpart) | Opus 5.5 | NEEDS WORK 35 cases + 12 findings → F2/F3/F5/F6/F9/F11 proven + fixed (the literal rule REMOVED; strings masked; revert arguments not counted; else-revert + live require recognized); F1 rejected (harness artifact); F8 per conservative design; F4/F10/F12 limits documented → 9 tests in Section 65 + 9 tests in Section 66, suite 899/899 |
| Review of detector 25 (guard-asymmetry nav readers) | Opus 5.5 | NEEDS WORK, 11 findings F1–F11 → referee calibration R25: 11/11 PROVEN + fixed (guard propagation through closures, guard via helper/modifier *reentr*, matchAll, uint/getter/member guard forms, trap-name rejection, direct state reads, member calls ignored, overload multimap, cross-span resolution, paren-balanced if-revert scanner, signature paren stripping) → 13 tests in Section 67 + 20 tests in Section 67b, suite 932/932 |
| Review of detector 26 (unbounded-loop inflatable-set accounting) | Opus 5.5 | NEEDS WORK, 58 cases (26 correct, 12 FP, 20 FN) + 12 findings F1–F12 → referee calibration R26: 11/12 PROVEN + fixed (F10 rejected — sybil, intentional) → 33 tests in Section 68b, suite 977/977 |
| Hostile review of the final submission package (26 Nov) | Opus 5.5 | NEEDS WORK F1–F11 → critical fixes merged in PR #7 (trap-vault compile, clean-clone suite, honest wording) |
| Hostile re-review of the fixed package (27 Nov) | Opus 5.5 | NEEDS WORK F1–F10 → fixes applied in this write-up (hook v1 schema, label honesty, privacy scrub, English UI strings) |
| Hostile re-check of the synced package (27 Nov) | Opus 5.5 | NEEDS WORK → text fixes applied (README aligned with the corrected description, 977 figure qualified, video errata note added); two claims rejected by the referee (the negative controls are 26 entries; the referee name in the docs is the agent's, not the owner's) |
| MiniPerp test (persona check) | — | Steering + persona verified working |

Full detail of each review: `docs/kiro-crew-review-2026-11-*.md`
(20+ review documents, one per detector/calibration). The review
documents use the hunting verdict tokens (Indonesian product terms, kept
as code constants): **TERBUKTI** = proven, **KANDIDAT** = candidate,
**GUGUR** = refuted; gate verdicts: **LAYAK** = eligible,
**KONFIRMASI** = needs human confirmation, **TOLAK** = rejected.

**How the reviews work (the "referee" pattern):** Kiro tests a detector
with an adversarial Node harness over cases it invents; jack verifies
every Kiro claim against the ORIGINAL pipeline code via probes before
adopting it — claims that turn out to be stub artifacts (Kiro tested a
replica, not the real code) are rejected and documented. This pattern is
what keeps 26 detectors at 977 tests (960 passed + 17 skipped in a
clean clone) with no new false positives on the real corpus.

What Kiro produced directly: the steering files, the spec set, the
hook, and — through the crew reviews — the calibration decisions
behind every detector. Implementation code (scaffold, pipeline, tests,
fork PoCs) was written locally against those specs.

## MCP servers

**Not used.** The on-chain lookup is done read-only directly from the app
(a fetch of `eth_getCode` via public RPC), without MCP. If the judges
ask: there is no MCP claim in this project.

## Kiro as the product under test (dogfooding)

The Frankenstein build sessions also used Kiro as **product testing**:
Kiro audit passes over real bug-bounty targets (Amply, RAAC, Fulcrom,
Hyperbridge, Flow, Veno, LCROBridge, Resupply, EFP, Somm) are the pipeline's training
material — Kiro candidates became ground truth for measuring pipeline
recall (0/7 → 4/7 over the Amply candidates after the commented-out-check,
commented-out-function, enum-shift, and eth-locked-receive detectors;
the 0/7 baseline is per our internal hunting logs, see
`docs/hunting-summary.md`), and
Kiro findings that escaped the pipeline became the next detector backlog
(the H3, K-1, VENO-C2, VENO-C1 classes — caught by the pipeline
as detectors 18/19, 21, 22, and 23 respectively).

## Credits

A Kiroween grant of 4,000 credits (expires 31 Dec 2026). Used up to this
session: **854.12 credits** (remaining 3,145.88; 35 days) — spent only on
real work (audit passes + cross-reviews), no junk prompts. Kiro was used
as the adversarial review crew and the spec/steering source; implementation
(scaffold, pipeline, tests, fork PoCs) was done locally. Tempo since
12 Nov ≈57 credits/day, below the recomputed line
(3,145.88 ÷ 35 ≈ 90/day).
