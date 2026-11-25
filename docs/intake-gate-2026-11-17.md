# Intake & Gate (M2.5) — 17 Nov 2026, sprint session #22

Module: `frankenaudit/app/intake.js` (+ section 31 in `tests/run-m2-tests.js`).
Methodology: SUPERAGENT v10 `references/v10/security/autonomy/` — program-discovery.md
(record schema + passive rules), program-qualifier.md (drop filter + 0–100 scoring),
authorization-gate.md (5 gate tests + verdict matrix + strict/auto/paused modes),
memory-dedupe.md (dedupe per id + re-open when the policy changes). ONLY the
methodology was adopted; the module is NATIVE — no v10 engine Python code was
pasted in or used.

## Functions

- `normalizeProgram(raw)` — record normalization; `invites_testing` / `pays_bounty` /
  `automatedTestingAllowed` that are not true/false → `"unknown"`.
- `scoreProgram(raw, now)` — qualifier weights: scope 25, payout 20, freshness 15,
  fit 15, competition 10, responsiveness 10, novelty 5. Scope sub-score: 0 assets → 0;
  1–2 → 0.4; 3–9 → 0.7; ≥10 → 1.0 (or `scopeAssetCount`). Payout bands
  <100 → 0.2; <1k → 0.4; <10k → 0.6; <100k → 0.8; ≥100k → 1.0;
  unknown value → 0.3; `pays_bounty: false` → 0. Freshness: ≤7 days → 1.0;
  ≤30 → 0.8; ≤90 → 0.5; ≤180 → 0.3; >180 → 0.1; none → 0.2.
  Competition: low → 1.0; medium → 0.6; high → 0.2; unknown → 0.5.
- Drop filter (`qualifierDropReasons`, 6): invitation false; empty scope without
  a security.txt; RoE forbids automation; status exhausted/blacklisted; excluded-tests
  ban all agent techniques (a blanket phrase "all/any testing" OR all four
  `AGENT_TECHNIQUES` banned); deadline passed.
- `gateProgram(raw, mode)` — 5 tests: publicInvitation, scopeExplicit, notExcluded,
  agenticAllowed, noConflictingSignal. Each test is true/false/"unknown". Verdict:
  any fail → TOLAK; a security.txt without an explicit invitation → KONFIRMASI;
  any unknown/ambiguous → KONFIRMASI; all pass + strict mode → KONFIRMASI;
  all pass + auto mode → LAYAK; paused mode → KONFIRMASI.
- `routeProgram(raw)` — surface → detectors: evm-solidity/contest → all-17;
  defi-lending → oracle/commented-out/enum/MAC/dead-config; defi-perps →
  vacuous/dead-config/share-accounting/MAC/division; bridge → eth-locked/
  tx-origin/MAC/free-mem-pointer. Plus queue + baseline.
- `dedupePrograms(existing, candidates)` — per id; re-open when the
  `policyHash` changes; blacklisted entries are never re-queued.
- `intakeRun(programs, existing, opts)` — dedupe → score → gate → routing;
  sorted by score descending, ties → higher scope sub-score first (safer,
  not bigger payout). `ranked` = not dropped + not TOLAK;
  `blacklisted` = not dropped + TOLAK.

## Design correction (found during testing)

A qualifier drop ≠ a gate FAIL. Candidates whose scope is not yet verified
(Kiln, Tokenize.it, VeChain) do NOT enter the blacklist — they stay
candidates for re-verification, not forbidden targets. `intakeRun`
separates `dropped` from `blacklisted` for this reason.

## Intake results over 7 known targets (auto mode, now 17 Nov 04:38 WIB)

| Program | Score | Verdict | Notes |
|---|---|---|---|
| RAAC (Guardian) | 86.3 | LAYAK | 20 contracts, $100k seasonal pool, deadline 9 Dec 2026 |
| Cronos zkEVM (HackenProof) | 84.0 | LAYAK | 103 assets, max $50k, fee $0, reputation gate 0 |
| Nado (HackenProof) | 78.0 | KONFIRMASI | agentic permission not yet proven; reputation gate ≥100 (a note, not a gate test) |
| Aktionariat (self-hosted) | 57.0 | KONFIRMASI | agentic permission not yet proven; reward 3 ETH (USD not counted) |
| Kiln V2 (Cantina) | 60.8 | DROP | scope not yet verified — not a blacklist |
| Tokenize.it (HackenProof) | 34.0 | DROP | scope/status/pool not yet verified — not a blacklist |
| VeChain Stargate (HackenProof) | 34.0 | DROP | scope/status/pool not yet verified — not a blacklist |

Strict mode (the v10 default): Cronos + RAAC → KONFIRMASI (needs human
confirmation — Cronos was already confirmed by Toufik in chat 12 Nov, the
ACTIVE queue keeps running; RAAC is still in the QUEUE, not confirmed).

## UI

`index.html` section "3. Intake & Gate" + a mode picker + a button
→ `app.js` calls `intakeRun(knownPrograms(), [], {mode})` →
`renderIntakeReport` (a card per program: per-criterion score + verdict +
reasons + routing). Static serve over local HTTP 200 (index/intake.js/app.js).

## Tests

Section 31, 41 new tests: sub-score bands, the 6 drop filters (+ 2 negative
controls), the gate matrix (auto/strict/paused/security.txt-only/private/
login-wall/empty-scope/RoE-ban), routing, dedupe, an intake run over the
7 known targets, card + report rendering. **Tests 348/348 PASS.**

## Kiro crew review

An adversarial review pass over intake.js via browser task 2f2eb33e
(17 Nov 04:53–05:13 WIB measured runtime, 20 min; a fresh Kiro session
"Audit Intake Gate M2.5", ID 9c87a853-c5d6-41e9-ac6d-622d24506bcc; the code
pasted verbatim in 3 parts + 1 data message; a Node harness from a
byte-for-byte copy in a scratch sandbox, since deleted; no repo
changes/commits/pushes).
**MODEL_TIDAK_SESUAI:** the picker was set explicitly to Opus 5.5, the
first answer was Opus 5.5, then it drifted on its own to **Opus 4.8**
("refused; answered by Opus 4.8") — the whole review was done by Opus 4.8.
**Verdict: 95/99 cases correct, 0 security FPs** (the gate fails safe; no
forbidden program passed). 4 mismatches: 1 of Kiro's own expectations was
wrong (#70 — securityTxtOnly=true forces KONFIRMASI whatever the
invitation is; the code is CORRECT); 3 score claims were off (Kiln/
Tokenize.it/VeChain — the DROP verdicts were still right).

### Calibration R1 (referee jack — every claim verified against the ORIGINAL code via Node)

| Item | Referee verdict | Fix |
|---|---|---|
| P1 HIGH — scopeAssetCount vs scope_assets.length | PROVEN (scope sub 1.0 but gate TOLAK + dropped) | canonical `scopeCount(p)`, used by scoring + drop filter + gate + reasons |
| P2 HIGH — empty scope + securityTxt → TOLAK/blacklist | PROVEN (qualifier does not drop, gate TOLAK, intakeRun blacklists) | `scopeExplicit` = "unknown" when scope is 0 + securityTxt → KONFIRMASI; the "scope not yet parsed" reason is now reachable (P9 fixed too) |
| P3 MED-HIGH — blanketExcluded substring | PROVEN ("casino testing" contains "no testing", "install testing" contains "all testing", "no testing on prod" contains "no testing") | `isBlanketBan`: a blanket phrase only when the entry is really a blanket ban (exact / starting with the phrase without a scope qualifier "on/in/against/...") |
| P4 MED — dedupe blacklist never re-opens | PROVEN (the blacklist check ran before policyHash) | compare policyHash first; re-open carries `wasBlacklisted: true` |
| P5 MED — unknown defaults raise the score | PARTIAL (a design trade-off, not a bug) | documented (a data-poor score = an upper bound) + `unknownFields` exposed in the result & the UI card |
| P6 MED — score claims Kiln 60.8 / Tokenize 34.0 | **REJECTED** — Kiro's 55.0/29.0 figures came from an incomplete fixture mapping (fit/novelty defaulted to 0.5, not the knownPrograms values 0.85/0.8/0.6); the code scores re-verified at 60.8/34.0/34.0 | lesson: future Kiro passes must include the full fixture code, not a text summary |
| P7 LOW-MED — future freshness → 1.0 | PROVEN | future → 0.2 (same as unverified) |
| P8 LOW — paused swallows hard verdicts | PROVEN (doNotTest + paused → KONFIRMASI) | a hard fail stays TOLAK in paused mode; KONFIRMASI only for the not-forbidden |
| P9 LOW — "scope not yet parsed" reason is dead code | PROVEN (unreachable before P2) | fixed via P2 |
| P10 LOW — Math.round half-up | documented (86.25 → 86.3) | a comment in the code |
| P11 LOW — scores computed for dropped entries | accepted (cosmetic) | `intakeRun`: a dropped entry's score = null; the card renders "— (drop — not a candidate)" |

**Post-R1 results (auto mode, now 17 Nov 04:38):** ranked stays RAAC 86.3 >
Cronos 84.0 > Nado 78.0 > Aktionariat 57.0; dropped Kiln/Tokenize.it/VeChain
(intakeRun score null; the raw arithmetic 60.8/34.0/34.0 is locked in the
scoreProgram tests); blacklist 0. Strict mode: all four KONFIRMASI.
**Tests: 380/380 PASS** (348 + 32 new in section 32). Hunting was not
re-run (the calibration touched only intake.js; the pipeline/detectors did
not change).

## Hunting re-run 17 Nov 04:38 WIB (post-M2.5, 17 detectors)

IDENTICAL, 0 new candidates — Fulcrom **15** (30 raw → 15 dropped),
Amply **18**, RAAC **14**, Hyperbridge **2**, Flow **0**; recall vs Kiro AMP
stays 4/7. Files: `fulcrom/amply/raac/hyperbridge/flow-hunt-2026-11-17.json/.md`.
