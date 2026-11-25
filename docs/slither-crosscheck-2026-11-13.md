# Cross-check: Slither vs Pipeline vs Ground Truth — 13 Nov 2026

Sample: `app/samples/trap-vault.sol` (ground truth: 7 candidates, 3 negative controls).
Slither 0.11.6 + solc 0.8.20 (local venv `.venv-slither/`, not committed).
Command: `slither app/samples/trap-vault.sol --solc ~/.solc-select/artifacts/solc-0.8.20/solc-0.8.20 --json slither-trap-vault.json`
(the raw 172 KB JSON is not committed; this summary + STATUS.md are the record.)

## Results

| Ground truth (7) | Pipeline M2 | Slither 0.11.6 |
|---|---|---|
| reentrancy @ withdraw | ✅ FA (High) | ✅ reentrancy-eth [High] |
| missing-access-control @ setOwner | ✅ FA (High) | ⚠️ partial: missing-zero-check [Low] @ newOwner (not access) |
| division-no-guard @ sharePrice | ✅ FA (Medium) | ❌ no built-in detector |
| ecrecover-no-zero-check @ claimWithSignature | ✅ FA (Medium) | ❌ no built-in detector |
| tx-origin @ emergencyDrain | ✅ FA (High) | ✅ tx-origin [Medium] |
| unchecked-call @ payFee | ✅ FA (Medium) | ✅ unchecked-lowlevel [Medium] |
| missing-access-control @ payFee | ✅ FA (High) | ⚠️ partial: arbitrary-send-eth [High] @ payFee |

- Pipeline: **7/7 ground truth, 0 false positives** on the 3 negative controls.
- Slither: 16 findings total; 3/7 matched directly, 2 partially supported,
  2 not detected (division without a guard, ecrecover without a zero
  check — gaps closed by FrankenAudit's pattern detectors).
- Slither noise on the negative controls: `reentrancy-events [Low]` +
  `low-level-calls [Informational]` flagged `withdrawSafe` (a SAFE
  pattern, correct checks-effects-interactions). The pipeline did not
  fire on it.
  → Product lesson: Slither alone is not enough; the pattern layer + the
  Kiro crew review are what separate candidates from noise.

## Normalization notes

- `normalizeSlither()` over the real JSON produces 16 candidates
  SL-001..016 (tested in tests/run-m2-tests.js via a fixture; the
  verification over the real JSON was done manually this session —
  16 candidates, IDs/severities/detectors correct).
- Slither's Informational/Optimization impact is mapped to Low in M2
  (mapping refinement scheduled for M3 if needed).
