# Tasks — FrankenAudit MVP

Execution checklist (tick `[x]` when done + record the date in STATUS.md).

## M1 — Scaffold (session 13 Nov 12:38 WIB)

- [x] Repo structure + MIT `LICENSE` + `.gitignore` (`.kiro/` NOT ignored)
- [x] `.kiro/steering/bug-bounty.md` — hunter persona (from the team brief)
- [x] `.kiro/steering/product.md` + `tech.md`
- [x] `.kiro/specs/frankenaudit/` — requirements, design, tasks
- [x] `.kiro/hooks/` — draft hook (format check on save)
- [x] `app/` static skeleton (index + pipeline stub + report stub)
- [x] Initial `README.md` + local `git init` (not pushed yet — a public
      push needs Toufik's approval)

## M2 — MVP pipeline (target hunting-ready 17–18 Nov 2026)

- [x] `app/samples/` — curated trap contract #1 + `.analysis.json`
      ground truth (7 bugs + 3 negative controls) — DONE 13 Nov 2026
      (session 16:38 WIB)
- [x] `app/pipeline.js` — real pattern scan (6 detectors: reentrancy,
      missing-access-control, division-no-guard, ecrecover-no-zero-check,
      tx-origin, unchecked-call) + candidate normalization +
      normalizeSlither()
- [x] `app/report.js` — candidate card rendering + closing (mapped/unmapped
      areas + 3 strongest hypotheses) + disclaimer
- [x] `app/app.js` — UI orchestration: pick a sample / paste an address /
      upload a `.sol` → run → show the report (M1 wiring done; samples
      now registered in samples/index.json)
- [x] Local end-to-end test: trap sample → complete report, no errors
      (tests/run-m2-tests.js — 11/11 PASS, 13 Nov 2026 session 16:38 WIB)
- [x] Slither mode: install `slither-analyzer` (local venv or Daytona),
      add `normalizeSlither()` + test on the same sample
      — DONE 13 Nov 2026 (session 16:38 WIB): Slither 0.11.6 + solc 0.8.20
      in `.venv-slither/` (not committed); 16 findings on trap-vault;
      cross-check in `docs/slither-crosscheck-2026-11-13.md` — Slither
      matched 3/7 ground truth directly, 2 partially, 2 not detected
      (division without a guard, ecrecover without a zero check), + noise
      on the negative control withdrawSafe (reentrancy-events/low-level-calls).
      `normalizeSlither()` over the real JSON → 16 candidates SL-001..016 correct.
- [x] Baseline wiring into the app UI (session 00:38 WIB 15 Nov 2026):
      multi-file upstream `.sol` upload → `buildBaselineMap()` (first-wins
      per basename, collisions recorded) → `runPipeline(..., {baseline})`;
      candidate cards show the Upstream-diff line, the closing shows the
      baseline status; tests 54/54 PASS (9 new).
- [ ] Read-only on-chain lookup: `eth_getCode` via public RPC for a pasted
      address (optional, the report still runs if it fails)
      (fetchBytecodeReadOnly() exists; address → lookup UI wiring not yet
      — scheduled for a later session)
- [ ] Kiro crew pass (Opus 5.5 / GPT 5.6) over the trap sample:
      cross-review of pipeline candidates vs ground truth; record
      false +/- in STATUS.md (scheduled for the 20:38 WIB session — avoid
      colliding with the afternoon BB session's browser)

## M2.5 — HUNTING MODE (active once M2 runs)

- [ ] Run the pipeline over the reputation-queue targets (first Cronos
      zkEVM Smart Contracts; then Hyperbridge / Flow Protocol)
- [ ] Write candidates to `bb-log.md` as "KANDIDAT FRANKENSTEIN"
      (standard BB format) for jack's verification (fork PoC)
- [ ] Record practice results (supported/dead) in STATUS.md as material
      for improving the steering/checklist

## M3 — Live URL (target ±19 Nov 2026)

- [ ] Pick a static deploy path (no new approval needed if one is available)
- [ ] Deploy + verify the URL opens (judges: no login/setup)
- [ ] Record the URL in STATUS.md + README.md

## M4 — Submission assets

- [ ] Devpost description text
- [ ] Kiro usage write-up (specs, steering, hooks, agents, MCP)
- [ ] Demo video script < 3 minutes + recording (public YouTube)
- [ ] (Optional) Bonus blog post + social post #KiroweenHackathon26

## M5 — Fill Devpost draft 1298511

- [ ] Fill the draft from the prepared texts
- [ ] Final submit ONLY with Toufik's explicit approval in chat
