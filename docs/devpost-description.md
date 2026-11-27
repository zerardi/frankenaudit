# FrankenAudit — Devpost description (DRAFT, updated session #57, 23 Nov 2026)

> Draft to fill into Devpost draft 1298511 (M5). English (the judges'
> language). Status: FINAL (26 Nov 2026, corrected after the hostile
> pass) — Devpost draft 1298511 was filled 26 Nov with the previous
> version; re-fill with this version before submit (27 Nov).
> Final click needs the owner's approval.

## Project name

FrankenAudit

## Tagline (≤ 120 characters, draft)

Smart-contract audit assistant: static analysis + Kiro crew + on-chain checks, producing falsifiable candidates.

## Description (draft)

**What it does**

FrankenAudit is an open-source audit assistant for beginner bug-bounty
hunters. Upload a `.sol` file, run the pipeline, and get a report page of
**bug-bounty-formatted candidates** — not verdicts. Every candidate carries
a falsifiable hypothesis, the on-chain preconditions that would make it
real, a severity guess, and a verification checklist for a human referee.
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
2. **Kiro agent crew** — Kiro agents running under a planted bug-bounty
   persona (`.kiro/steering/bug-bounty.md`) read the same code from
   different angles and reviewed detectors before they shipped.
   Every crew claim is re-verified by a human referee against the real
   code before it becomes a calibration.
3. **Read-only on-chain lookup** — the app checks whether a pasted address
   is a deployed contract (`eth_getCode`, read-only). It does not fetch
   source and does not run the pipeline on an address; the human referee
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

**What we proved while building it (dogfooding)**

- A curated trap contract with 30 expected candidates: the pipeline finds all
  30, with 977 automated tests passing (960 in a clean clone; 17 skipped —
  they need the private real-world corpus, see `docs/hunting-summary.md`).
- Live hunting runs as product testing across 11 real surfaces
  (Fulcrom, Amply, RAAC, Hyperbridge, Flow, Veno on Ethereum and
  Cronos zkEVM, LCROBridge, Resupply, EFP, Somm — Veno counted twice,
  once per chain; counts in `docs/hunting-summary.md`): the pipeline
  reproduces real finding classes the Kiro crew had found by hand — commented-out guards, enum shifts,
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

See `kiro-usage-writeup.md` (Kiro usage write-up) in this repo.

**What's next**

- Code freeze 24 Nov 2026; public repo + live demo URL 25 Nov 2026
  (done — https://zerardi.github.io/frankenaudit/).
- Video demo < 3 min: see `video-script.md` (voice-over recorded;
  final screen capture from the live English UI).
- Submit target 27 Nov 2026 (final click needs owner approval).

## Inspiration (draft, 1–2 sentences)

Beginner bounty hunters get scanner noise, not findings. We wanted the
auditor's discipline — hypothesis first, proof on a fork, verdict last —
inside a tool a beginner can actually run.

## What we learned (draft)

- A readable gate function read differentially is decisive proof; a
  reverted call is not.
- Preview numbers lie; only the delivery mechanism (and a local PoC)
  proves a finding.
- Most "findings" die on live state — that is why the on-chain lookup
  exists.
- A detector is only as good as its referee: every Kiro crew verdict
  is attacked before it is adopted, and several "proven" claims turned
  out to be stub artifacts.

## Challenges (draft)

- Real code breaks naive extractors (multi-line signatures swallowed
  most functions until the scanner was rewritten).
- Comments fool pattern matchers (a `// totalSupply` comment once
  flagged a division bug that did not exist).
- Keeping the Kiro crew's verdicts honest: every crew claim is
  re-checked by a human referee before it becomes a candidate.
- Cross-file reasoning (dead config read in another file, wrappers,
  chained import aliases) needed a project-level pass on top of
  per-file detectors.

## How to run (draft)

Static app — open `index.html` or serve the `app/` folder. Tests:
`node tests/run-m2-tests.js` (977/977 with the full corpus; 960 passed +
17 skipped in a clean clone — the skipped checks need the private
real-world corpus under `work/`, which is not in the repo; the suite
prints the skip count). Slither cross-check needs
`slither-analyzer` + `solc` (see `docs/slither-crosscheck-2026-11-13.md`).

## License

MIT. Public repo: `zerardi/frankenaudit` (live since 25 Nov 2026).
