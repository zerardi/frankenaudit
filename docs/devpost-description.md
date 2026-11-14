# FrankenAudit — Devpost description (DRAF, sesi 04:38 WIB 14 Nov 2026)

> Draf untuk diisi ke draf Devpost 1298511 (M5). Bahasa Inggris (bahasa juri).
> Status: DRAF — belum diisi ke Devpost, belum disubmit. Finalisasi + pengisian
> butuh persetujuan Toufik.

## Project name

FrankenAudit

## Tagline (≤ 120 karakter, draf)

A stitched-together smart-contract audit assistant: static analysis +
Kiro agent crew + live on-chain checks, producing falsifiable bug-bounty
candidates.

## Description (draf)

**What it does**

FrankenAudit is an open-source audit assistant for beginner bug-bounty
hunters. Paste a contract address or upload a `.sol` file, run the
pipeline, and get a report page of **bug-bounty-formatted candidates** —
not verdicts. Every candidate carries a falsifiable hypothesis, the
on-chain preconditions that would make it real, a severity guess, and a
verification checklist for a human referee.

It is stitched ("Frankenstein") from three parts:

1. **Static analysis** — Slither plus 9 hand-built pattern detectors
   (reentrancy, missing access control, division without zero guard,
   ecrecover without zero check, tx.origin auth, unchecked call, replay
   signature, share accounting, commented-out check).
2. **Kiro agent crew** — Kiro agents running under a planted bug-bounty
   persona (`.kiro/steering/bug-bounty.md`) read the same code from
   different angles and cross-review each other before a candidate
   reaches the report.
3. **Read-only on-chain lookup** — the app reads live deployment state
   (`eth_getCode` and state reads) to falsify candidates that exist
   "in code" but are dead "in deployment". No transactions, no wallet.

**Why it matters**

New hunters drown in scanner noise and cannot tell a real finding from a
false positive. FrankenAudit's discipline is *candidate, not verdict*:
every finding starts as a hypothesis that must survive a fork-level
proof-of-concept before anyone calls it a bug. That is the same
discipline professional auditors use — packaged so a beginner can run
it in a browser.

**What we proved while building it (dogfooding)**

- A curated trap contract with 13 planted bugs: the pipeline finds all
  13, with 18/18 automated tests passing.
- Live hunting runs as product testing: Amply on Cronos zkEVM (83 files)
  and RAAC Core Contracts (44 files, Guardian contest). The newest
  detector (commented-out check) reproduced a real finding class the
  Kiro crew had found by hand — a commented-out siloed-borrowing guard.
- Four fork-level PoCs (Foundry) confirm the pipeline's top candidates
  end-to-end, including a drain via missing access control and a
  signature-replay mint.

**Built with Kiro**

See `kiro-usage-writeup.md` (write-up pemakaian Kiro) in this repo.

**What's next**

- Public repo + live demo URL (pending owner approval to push).
- More detectors (commented-out functions, upstream diff vs fork
  baselines) and a Kiro-crew review pass inside the app itself.
- Video demo < 3 min: see `video-script.md`.

## Inspiration (draf, 1–2 kalimat)

Beginner bounty hunters get scanner noise, not findings. We wanted the
auditor's discipline — hypothesis first, proof on a fork, verdict last —
inside a tool a beginner can actually run.

## What we learned (draf)

- A readable gate function read differentially is decisive proof; a
  reverted call is not.
- Preview numbers lie; only the delivery mechanism (and a fork PoC)
  proves a finding.
- Most "findings" die on live state — that is why the on-chain lookup
  exists.

## Challenges (draf)

- Real code breaks naive extractors (multi-line signatures swallowed
  most functions until the scanner was rewritten).
- Comments fool pattern matchers (a `// totalSupply` comment once
  flagged a division bug that did not exist).
- Keeping the Kiro crew's verdicts honest: every crew claim is
  re-checked by a human referee before it becomes a candidate.

## How to run (draf)

Static app — open `index.html` or serve the `app/` folder. Tests:
`node tests/run-m2-tests.js` (18/18). Slither cross-check needs
`slither-analyzer` + `solc` (see `docs/slither-crosscheck-2026-11-13.md`).

## License

MIT. Repo publik (pending push): `zerardi/frankenaudit`.
