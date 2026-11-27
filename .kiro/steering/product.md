# Product — Steering

## What FrankenAudit is

FrankenAudit is an open-source smart-contract audit assistant for beginner
bug bounty hunters. The user uploads a `.sol` file (a pasted address gets
a read-only bytecode check only), the app runs the analysis pipeline on
the uploaded source, and the result is a report page
of **bug-bounty-formatted finding candidates** — not verdicts. Every
candidate carries a falsifiable hypothesis, state preconditions, a severity
guess, and a verification checklist for a referee agent.

## The stitching ("Frankenstein")

1. **Static analysis** — 26 hand-built pattern detectors (classic
   patterns: reentrancy, uninitialized state, shadowing, etc), plus an
   offline Slither cross-check.
2. **Kiro agent crew** — several Kiro agents with a bug-bounty persona
   (see `steering/bug-bounty.md`) read the same code from different angles:
   accounting, access control, oracle, liquidation. The crew's detector
   reviews are cross-checked by a referee agent before any calibration
   is adopted.
3. **Read-only on-chain lookup** — checks whether a pasted address is a
   deployed contract (`eth_getCode`). The referee agent falsifies
   candidates against live state using that check plus each candidate's
   verification checklist. No transactions, no wallet.

## Product principles

- **Candidate, not verdict.** No finding is called "proven" before a local
  Foundry PoC by a referee.
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
