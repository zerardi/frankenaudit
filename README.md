# FrankenAudit

An open-source smart-contract audit assistant for beginner bug bounty hunters —
built for **Kiroween 2026 (Frankenstein category)**.

**Live app: https://zerardi.github.io/frankenaudit/**

## What this is

Upload a `.sol` file, run the analysis pipeline,
and get a report page of **bug-bounty-formatted finding candidates** — not
verdicts. A pasted contract address is only checked read-only for deployed
bytecode (`eth_getCode`) — the pipeline itself runs on uploaded source. Every candidate carries a falsifiable hypothesis, state
preconditions, a severity guess, and a verification checklist for a human
referee.

The stitching ("Frankenstein"):

1. **Static analysis** — 26 hand-built pattern detectors, plus an offline
   Slither cross-check.
2. **Kiro agent crew** — Kiro agents with a bug-bounty persona
   (`.kiro/steering/bug-bounty.md`) read the same code from different angles
   and reviewed the detectors before they shipped; every crew claim is
   re-verified by a human referee against the real code.
3. **Read-only on-chain lookup** — checks whether a pasted address is a
   deployed contract (`eth_getCode`); the human referee falsifies candidates
   against live state using that check plus each candidate's verification
   checklist. No transactions, no wallet.

## Principles

- **Candidate, not verdict.** No finding is called "proven" before a local
  Foundry PoC by a referee.
- **Hypothesis-first.** Every candidate starts from a hypothesis that can
  be refuted.
- **Read-only, always.** No private key, seed, `.env`, or mainnet
  transaction on any path.
- **Usable in 2 minutes:** open the URL → pick a sample contract → read
  the report. No login, no setup.

## Try it locally

```bash
cd app
python3 -m http.server 8000
# open http://localhost:8000
```

The curated sample mode runs fully in the browser. The offline Slither
cross-check needs `slither-analyzer` installed separately (`pip install slither-analyzer`) —
see `.kiro/specs/frankenaudit/design.md`.

## Structure

```
frankenaudit/
  .kiro/
    steering/        # persistent personas & context (bug-bounty, product, tech)
    specs/           # Kiro-style feature specs (requirements/design/tasks)
    hooks/           # Kiro automation hooks
  app/               # static web app (MVP)
    samples/         # curated sample .sol contracts + their analyses
  tests/             # Node test suite (tests/run-m2-tests.js)
  poc/               # local Foundry PoCs for the trap contract
  docs/              # design notes & decisions
  LICENSE            # MIT
```

## Status

- M1 scaffold — done 13 Nov 2026
- M2 MVP pipeline — done: 26 pattern detectors + 30 expected candidates,
  977 tests (960 passed + 17 skipped in a clean clone — the skipped checks
  need the private real-world corpus)
- M2.5 Intake & Gate — done: bug-bounty program scoring (0–100) with
  LAYAK / KONFIRMASI / TOLAK gate verdicts

> **Verdict vocabulary** (Indonesian product terms, kept as code
> constants): gate verdicts — **LAYAK** = eligible, **KONFIRMASI** =
> needs human confirmation, **TOLAK** = rejected. Hunting verdicts —
> **TERBUKTI** = proven, **KANDIDAT** = candidate, **GUGUR** = refuted.
- M3 live URL — done 25 Nov 2026: https://zerardi.github.io/frankenaudit/
- Devpost submission deadline: 5 Dec 2026 05:00 WIB (4 Dec 2026 14:00 PT)

This project NEVER submits bug bounty reports — candidates produced while
testing the product are handed to a human referee for verification (local Foundry PoC).

## License

MIT — see `LICENSE`.
