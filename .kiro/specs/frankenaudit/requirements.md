# Requirements — FrankenAudit MVP

## Introduction

An open-source smart-contract audit assistant for beginner bug bounty
hunters. Input: a contract address or a `.sol` file. Output: a report page
of bug-bounty-formatted finding candidates. Target: pipeline running
end-to-end 17–18 Nov 2026; live URL ±19 Nov 2026.

## Requirements

### 1. Contract input

- **R1.1** The user can pick one of the curated sample contracts from a
  list in the app.
  - *Acceptance:* picking a sample displays its `.sol` source and the
    "Run analysis" button is active.
- **R1.2** The user can paste a contract address (EVM, 0x…) for a
  read-only lookup.
  - *Acceptance:* an invalid address is rejected with a clear message; a
    valid address triggers a bytecode/source fetch (when publicly
    available) with no transaction.
- **R1.3** The user can upload a `.sol` file.
  - *Acceptance:* the file is read in the browser; its contents are
    displayed; sample-mode analysis still runs when Slither is not yet
    available.

### 2. Analysis pipeline

- **R2.1** Sample-mode pipeline: a light pattern scan (classic patterns:
  external call before state update, division without a zero guard,
  critical function without a modifier, ecrecover without an address(0)
  check) over the entered source.
  - *Acceptance:* each matching pattern produces one raw candidate with a
    file:function location + a code quote.
- **R2.2** Slither-mode pipeline (when a backend/CLI is available):
  Slither results are normalized into the same candidate format as R2.1.
  - *Acceptance:* Slither output appears as candidates with Slither's
    severity mapped to the Low/Medium/High scale.
- **R2.3** Kiro-agent review: each raw candidate is completed with a
  hypothesis narrative + preconditions + "what must be verified",
  following the format of `.kiro/steering/bug-bounty.md`.
  - *Acceptance:* no candidate in the report appears without a hypothesis
    and a verification list.

### 3. Audit report

- **R3.1** The report page shows the candidate list (ID, title, severity
  guess, location, hypothesis, preconditions, impact, code evidence,
  verification).
  - *Acceptance:* the sample report is complete and readable by a judge
    with no additional explanation.
- **R3.2** The report closes with: mapped areas, unmapped areas, and the
  3 strongest hypotheses.
  - *Acceptance:* all three sections are always present at the end of the
    report.
- **R3.3** The report states explicitly: "candidates, not verdicts — a
  fork PoC by a referee is required".
  - *Acceptance:* the disclaimer appears at the top of the report.

### 4. Read-only on-chain lookup

- **R4.1** For a contract address, the app reads public bytecode / state
  via public RPC (eth_getCode, eth_call).
  - *Acceptance:* no transaction is sent; no wallet prompt; no private
    key is requested.

### 5. Deployment & submission

- **R5.1** The app can be deployed as a static site (no mandatory server)
  and opened by judges via a URL.
- **R5.2** The public repo contains all source + a detected MIT LICENSE +
  the `/.kiro` directory at the root (not gitignored).
