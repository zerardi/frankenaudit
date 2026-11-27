# FrankenAudit — Devpost description (updated 27 Nov 2026)

> Text for Devpost draft 1298511 (M5). English (the judges' language).
> Status: FINAL (27 Nov 2026, corrected after the hostile re-review and
> re-check) — Devpost draft 1298511 was re-filled with this version on
> 27 Nov 2026. Final click needs the owner's approval.

## Project name

FrankenAudit

## Tagline (≤ 120 characters, draft)

Smart-contract audit assistant: static analysis + Kiro crew + on-chain lookup, producing falsifiable candidates.

## Description (draft)

**What it does**

FrankenAudit is an open-source audit assistant for beginner bug-bounty
hunters. Upload a `.sol` file, run the pipeline, and get a report page of
**bug-bounty-formatted candidates** — not verdicts. Every candidate carries
a falsifiable hypothesis, the on-chain preconditions that would make it
real, a severity guess, and a verification checklist for a referee agent.
A pasted contract address is only checked read-only for deployed bytecode
(see below) — the pipeline itself runs on uploaded source.

It is stitched ("Frankenstein") from three parts:

1. **Static analysis** — 26 hand-built pattern
   detectors and an upstream-diff classifier that labels candidates
   against fork baselines: reentrancy, missing access control, division
   without zero guard, ecrecover without zero check, tx.origin auth,
   unchecked call, replay signature, share accounting, commented-out
   check, commented-out function, enum semantic shift, oracle passthrough
   without staleness check, free-memory-pointer without 32-byte rounding,
   eth-locked receive, vacuous identity check, dead config storage,
   permissionless dispatcher, one-hop forwarder, full-balance sweep,
   permissionless value send, empty-sublist proof advancing height, JIT
   reward-accrual sandwich, refund-locked middleware, variant branch
   without payload consume, guard-asymmetry nav readers, and
   unbounded-loop inflatable-set accounting, plus an offline Slither cross-check (see `docs/slither-crosscheck-2026-11-13.md`).
2. **Kiro agent crew** — Kiro agents running under a repo-defined bug-bounty
   persona (`.kiro/steering/bug-bounty.md`) read the same code from
   different angles and reviewed detectors before they shipped.
   Every crew claim is re-verified by a referee agent (jack) against the real
   code before it becomes a calibration.
3. **Read-only on-chain lookup** — the app checks whether a pasted address
   is a deployed contract (`eth_getCode`, read-only). It does not fetch
   source and does not run the pipeline on an address; the referee agent
   falsifies candidates against live state using the app's bytecode check
   plus each candidate's verification checklist. No transactions, no
   wallet.

On top of the pipeline sits an **Intake & Gate** stage: candidate
bounty programs are scored (public scope, payout structure, freshness,
detector fit, competition, responsiveness, novelty) and gated
(LAYAK = eligible / KONFIRMASI = needs human confirmation / TOLAK =
rejected) before any hunting run starts, so the
tool hunts where a beginner can actually submit.

**Why it matters**

New hunters drown in scanner noise and cannot tell a real finding from a
false positive. FrankenAudit's discipline is *candidate, not verdict*:
every finding starts as a hypothesis that must survive a local Foundry
proof-of-concept before anyone calls it a bug. That is the same
discipline professional auditors use — packaged so a beginner can run
it in a browser.

**What we tested while building it (dogfooding)**

- A curated trap contract (regression fixture) with 30 expected candidates:
  the pipeline finds all 30, with 977 automated tests (960 passed in a
  clean clone; 17 skipped — they need the private real-world corpus, see
  `docs/hunting-summary.md`).
- Live hunting runs as product testing across 11 real surfaces
  (Fulcrom, Amply, RAAC, Hyperbridge, Flow, Veno on Ethereum and
  Cronos zkEVM, LCROBridge, Resupply, EFP, Somm — Veno counted twice,
  once per chain; counts in `docs/hunting-summary.md`): the pipeline
  reproduces the pattern classes behind real candidates the Kiro crew had
  found by hand (each candidate's own status — submitted by the human hunter,
  refuted, or latent — is recorded in the sample data and the hunting log) —
  commented-out guards, enum shifts,
  oracle passthrough, eth-locked receive, permissionless dispatchers,
  empty-sublist consensus proofs, JIT reward-accrual sandwiching,
  refund-locked bridge middleware, unconsumed variant payloads, and
  guard asymmetry between NAV-reading functions. Recall against the crew's Amply
  candidates rose from 0/7 to 4/7 as detectors were added (0/7 baseline
  per our internal hunting logs).
- Four local Foundry PoCs on the trap contract confirm the pipeline's top
  candidates end-to-end, including a drain via missing access control and
  a signature-replay mint.

**Built with Kiro**

See `docs/kiro-usage-writeup.md` in this repo — the same text is pasted
in full into this submission's "Additional info" field.

**What's next**

- Two-hop and cross-file taint tracking for the value-send and
  commented-out-check detectors (documented limits today).
- More curated samples beyond TrapVault, including a negative-only pack.
- Intake & Gate: open-internet program discovery (today it scores a
  known list of programs).
- The demo video stays v3 (public since 26 Nov 2026); its narration
  errata are listed in the "Video errata (v3)" section below.

## Inspiration (draft, 1–2 sentences)

Beginner bounty hunters get scanner noise, not findings. We wanted the
auditor's discipline — hypothesis first, proof in a local PoC, verdict last —
inside a tool a beginner can actually run.

## What we learned (draft)

- A readable gate function read differentially is decisive proof; a
  reverted call is not.
- Preview numbers lie; only the delivery mechanism (and a local PoC)
  proves a finding.
- Most "findings" die on live state — that is why every candidate
  carries a live-state verification checklist.
- A detector is only as good as its referee: every Kiro crew verdict
  is attacked before it is adopted, and several "proven" claims turned
  out to be stub artifacts.

## Challenges (draft)

- Real code breaks naive extractors (multi-line signatures swallowed
  most functions until the scanner was rewritten).
- Comments fool pattern matchers (a `// totalSupply` comment once
  flagged a division bug that did not exist).
- Keeping the Kiro crew's verdicts honest: every crew claim is
  re-checked by a referee agent before it becomes a candidate.
- Cross-file reasoning (dead config read in another file, wrappers,
  chained import aliases) needed a project-level pass on top of
  per-file detectors.

## How to run (draft)

Static app — serve the `app/` folder (e.g. `python3 -m http.server`
inside `app/`); opening `index.html` via file:// breaks the sample fetch. Tests:
`node tests/run-m2-tests.js` (977/977 with the full corpus; 960 passed +
17 skipped in a clean clone — the skipped checks need the private
real-world corpus under `work/`, which is not in the repo; the suite
prints the skip count). Slither cross-check needs
`slither-analyzer` + `solc` (see `docs/slither-crosscheck-2026-11-13.md`).

## Video errata (v3)

The public demo video (v3, https://www.youtube.com/watch?v=AtwaC5bD6XU,
177 s) is final and will not be re-recorded. Some narration lines predate
the corrected texts above; read them as corrected here:

- Shot 2: a pasted address gets a read-only bytecode check only — the
  pipeline runs on uploaded source; Slither is an offline cross-check,
  not part of a pipeline run; "thirty planted bugs" = thirty expected
  candidates.
- Shot 3: setOwner is High, not Critical; "a fork proof-of-concept" =
  a local Foundry proof-of-concept.
- Shot 4: "kill candidates that exist in code but are dead on-chain" =
  the referee agent falsifies candidates against live state using the
  bytecode check plus each candidate's verification checklist; the app
  itself only checks that an address is a deployed contract.
- Shot 5: "fork-level proof-of-concept" = local Foundry proof-of-concept
  (no chain fork).
- Shot 6: "everything is driven by Kiro" = Kiro was the review crew
  (steering, specs, hooks, adversarial detector reviews); implementation
  was done locally. "Nine hundred seventy-seven tests, all passing" =
  977 tests: 960 passed + 17 skipped in a clean clone.
- Shot 6: "found twelve issues" = the crew raised 12 findings on the
  newest detector; 11 were proven and fixed, 1 was rejected as
  intentional.

The screen capture was recorded on 26 Nov 2026 from the live app;
wording-only UI text fixes landed on 27 Nov (no layout or flow changes).

## License

MIT. Public repo: `zerardi/frankenaudit` (live since 25 Nov 2026).
