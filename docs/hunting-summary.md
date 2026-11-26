# FrankenAudit — Hunting summary (dogfooding log)

> Product-testing runs of the pipeline over real bug-bounty surfaces.
> Counts are from the latest re-run (26 Nov 2026 08:38 WIB, session #76,
> suite 977/977). Raw per-surface JSON/MD reports live in the team's
> internal logs, not in this repo; the counts below are the summary the
> Devpost description cites.

## Surfaces (11 runs, 10 programs — Veno counted twice, once per chain)

| Surface | Candidates | Note |
| --- | --- | --- |
| Fulcrom | 15 | FA-FUL-01 confirms the FUL-REF-01 class (not a new submission) |
| Amply (Cronos zkEVM) | 18 | Pipeline recall vs Kiro crew candidates: 4/7 (0/7 baseline per internal logs, before the commented-out-check / commented-out-function / enum-shift / eth-locked-receive detectors) |
| RAAC | 14 | |
| Hyperbridge | 7 | FA-004 confirms the K-1 class; FA-005 confirms the H3 dispatch class; FA-002/FA-003 are the H3b sweep class |
| Flow | 0 | |
| Veno (Ethereum) | 6 | FA-004 confirms the VENO-C1 class; FA-005 confirms the VENO-C2 class |
| Veno (Cronos zkEVM) | 0 | |
| LCROBridge | 0 | |
| Resupply | 12 | |
| EFP | 1 | |
| Somm | 34 | 10 Medium / 20 Low / 4 Info; FA-009 confirms the H-SOMM-19 class, FA-010 is a detector find |

**0 new submission candidates.** Every candidate above is either a
confirmation of a finding class the Kiro crew had already found by hand,
a by-design pattern (verified against the upstream baseline), or a
referee-refuted suspect. That is the point of the tool: candidates, not
verdicts — each one still needs a fork-level proof-of-concept before
anyone calls it a bug.
