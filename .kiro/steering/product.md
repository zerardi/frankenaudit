# Product — Steering

## What FrankenAudit is

FrankenAudit is an open-source smart-contract audit assistant for beginner
bug bounty hunters. The user pastes a contract address (or uploads a `.sol`
file), the app runs the analysis pipeline, and the result is a report page
of **bug-bounty-formatted finding candidates** — not verdicts. Every
candidate carries a falsifiable hypothesis, state preconditions, a severity
guess, and a verification checklist for a human referee.

## The stitching ("Frankenstein")

1. **Slither / static analysis** — automated detectors as the first pass
   (classic patterns: reentrancy, uninitialized state, shadowing, etc).
2. **Kiro agent crew** — several Kiro agents with a bug-bounty persona
   (see `steering/bug-bounty.md`) read the same code from different angles:
   accounting, access control, oracle, liquidation. The crew cross-debates
   (inter-model review) before a candidate is written into the report.
3. **Read-only on-chain lookup** — reads live deployment state (not just
   code): asset weights, insurance balances, configuration — to falsify
   candidates that are alive "in code" but dead "in deployment".
   No transactions, no wallet.

## Product principles

- **Candidate, not verdict.** No finding is called "proven" before a fork
  PoC by a referee.
- **Hypothesis-first.** Every candidate starts from a hypothesis that can
  be refuted, not from blind pattern matching.
- **Read-only, always.** No private key, seed, `.env`, or mainnet
  transaction on any path.
- **Usable by a judge in 2 minutes:** open the URL → pick a sample contract
  → read the candidate report. No login, no setup.

## Primary users

Beginner bug bounty hunters (HackenProof / CodeHawks / Sherlock / Cantina)
who need a fast attack-surface map before a deep manual audit.

## What this product is not

- Not a report auto-submitter (FrankenAudit NEVER submits).
- Not a paid audit-as-a-service.
- Not an exploit tool / automated mainnet PoC runner.
