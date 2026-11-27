# Tech — Steering

## MVP stack

- **Frontend:** a static web app (HTML + CSS + vanilla JS, no heavy
  framework) in `app/`. Reason: easy to deploy statically for judges,
  zero build step, no mandatory server.
- **Analysis pipeline (MVP):** two modes.
  - **Curated sample mode** (always available, no backend): sample
    contracts + curated analysis results; a local pipeline (light
    pattern scan in JS) flags classic patterns and maps them to the
    candidate format.
  - **Offline Slither cross-check** (not part of the app): Slither is run
    locally over sample contracts and its output compared against the
    pipeline's (see `docs/slither-crosscheck-2026-11-13.md`). Slither is
    NOT included in the repo; it is installed separately
    (`pip install slither-analyzer`).
- **On-chain lookup:** read-only via public RPC (eth_getCode).
  No keys, no transactions.
- **Kiro agent crew:** Kiro agents (specs in `.kiro/specs/`, steering in
  `.kiro/steering/`) act as code reviewers; their output is candidate text
  that goes into the report. The crew does NOT execute target code and does
  NOT touch any network besides public reads.

## Repo structure

```
frankenaudit/
  .kiro/
    steering/        # persistent personas & context (bug-bounty, product, tech)
    specs/           # Kiro-style feature specs (requirements/design/tasks)
    hooks/           # Kiro automation hooks
  app/               # static web app (MVP)
    samples/         # curated sample .sol contracts + their analyses
  docs/              # design notes & decisions
  LICENSE            # MIT
  README.md
```

## Conventions

- UI & report language: English; Solidity/security technical terms stay in
  English.
- The candidate format ALWAYS follows `.kiro/steering/bug-bounty.md`
  (ID, location, hypothesis, preconditions, impact+severity, evidence,
  verification).
- No credentials in the repo. `.env` and keys are gitignored.
- `.kiro/` must NOT be gitignored (a Kiroween submission requirement).
