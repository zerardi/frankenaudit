# Design — FrankenAudit MVP

## Architecture

```
┌─────────────┐   pick a sample /       ┌──────────────────┐
│  app/       │   paste an address /    │  pipeline.js     │
│  index.html │ ──► upload .sol ──────► │  - pattern scan  │
│  + app.js   │                         │  - candidate     │
└─────────────┘                         │    normalization │
       ▲                                └──────┬───────────┘
       │ candidate report                      │
       │ (BB format rendering)                 ▼
       │                              ┌──────────────────┐
       │                              │  report.js       │
       │                              │  rendering +     │
       └──────────────────────────────┴──────────────────┘
                                        closing summary

Slither mode (optional, late M2):
  uploaded .sol ──► slither CLI (local/Daytona) ──► JSON ──► normalization ──► candidates
On-chain lookup (read-only):
  address ──► public RPC eth_getCode/eth_call ──► deployment info ──► candidate context
```

## Components

### app/index.html
One page: header + candidate disclaimer, an input panel (sample dropdown,
address field, `.sol` upload), an analysis button, a report area.

### app/app.js
UI orchestration: load samples, validate addresses, call the pipeline,
render the report. No framework.

### app/pipeline.js
- `scanPatterns(source)`: regex/light-AST for classic patterns
  (call-before-update, division without a guard, function without a
  modifier, ecrecover without a zero check). Each hit → a raw candidate.
- `normalizeSlither(json)`: map Slither detectors → the candidate format.
- `enrichCandidate(raw)`: attach the hypothesis + preconditions +
  verification narrative template per the bug-bounty steering.

### app/report.js
Renders candidates into report cards + the closing section (mapped /
unmapped areas / 3 strongest hypotheses). Default sorting: severity guess
descending, then steering priority class.

### app/samples/
Curated sample `.sol` contracts + an `.analysis.json` file containing
curated candidates (ground truth for the judge demo + product
testing). First sample: a small trap contract the team uses for audit
practice — containing 2–3 real bugs + 1 safe pattern that is often
false-flagged (a negative control).

## Candidate data format (JSON)

```json
{
  "id": "FA-001",
  "title": "…",
  "location": { "file": "Vault.sol", "function": "withdraw" },
  "hypothesis": "…",
  "preconditions": "…",
  "impact": "…",
  "severityGuess": "Medium",
  "evidence": "code quote …",
  "toVerify": ["…"],
  "source": "pattern-scan | slither | kiro-crew | curated"
}
```

## Design decisions

- **Static first, backend later.** Judges must be able to open the URL
  without a server; Slither is an offline cross-check, not a demo prerequisite.
- **Curated ground truth > raw detectors.** The sample report uses the
  curated crew-and-referee analysis as the reference; the pattern scan
  is only the initial trigger.
- **No server state / accounts.** Everything runs in the user's browser.
- **The Kiro crew is a review layer, not an executor.** Crew output is
  candidate text; the crew does not run target code.

## Risks

- Regex pattern scans can false-positive → mitigation: clear source
  labels + a negative control in the sample.
- Public RPCs can rate-limit → mitigation: the on-chain lookup is
  optional; the report still runs without it.
- Slither is not installed on this VM (checked 13 Nov: absent) →
  mitigation: sample mode first; Slither installation scheduled in M2
  via venv/Daytona.
