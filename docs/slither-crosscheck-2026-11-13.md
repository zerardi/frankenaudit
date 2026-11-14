# Cross-check Slither vs Pipeline vs Ground Truth — 13 Nov 2026

Sampel: `app/samples/trap-vault.sol` (ground truth: 7 kandidat, 3 negative control).
Slither 0.11.6 + solc 0.8.20 (venv lokal `.venv-slither/`, tidak di-commit).
Perintah: `slither app/samples/trap-vault.sol --solc ~/.solc-select/artifacts/solc-0.8.20/solc-0.8.20 --json slither-trap-vault.json`
(JSON mentah 172 KB tidak di-commit; ringkasan ini + STATUS.md adalah catatannya.)

## Hasil

| Ground truth (7) | Pipeline M2 | Slither 0.11.6 |
|---|---|---|
| reentrancy @ withdraw | ✅ FA (High) | ✅ reentrancy-eth [High] |
| missing-access-control @ setOwner | ✅ FA (High) | ⚠️ sebagian: missing-zero-check [Low] @ newOwner (bukan akses) |
| division-no-guard @ sharePrice | ✅ FA (Medium) | ❌ tidak ada detektor bawaan |
| ecrecover-no-zero-check @ claimWithSignature | ✅ FA (Medium) | ❌ tidak ada detektor bawaan |
| tx-origin @ emergencyDrain | ✅ FA (High) | ✅ tx-origin [Medium] |
| unchecked-call @ payFee | ✅ FA (Medium) | ✅ unchecked-lowlevel [Medium] |
| missing-access-control @ payFee | ✅ FA (High) | ⚠️ sebagian: arbitrary-send-eth [High] @ payFee |

- Pipeline: **7/7 ground truth, 0 false positive** pada 3 negative control.
- Slither: 16 temuan total; 3/7 cocok langsung, 2 didukung sebagian, 2 tidak
  terdeteksi (divisi tanpa guard, ecrecover tanpa cek nol — celah yang
  ditutup detektor pola FrankenAudit).
- Noise Slither pada negative control: `reentrancy-events [Low]` +
  `low-level-calls [Informational]` menandai `withdrawSafe` (pola AMAN,
  checks-effects-interactions benar). Pipeline tidak memicunya.
  → Pelajaran produk: Slither saja tidak cukup; lapisan pola + review
  crew Kiro yang membedakan kandidat dari noise.

## Catatan normalisasi

- `normalizeSlither()` atas JSON asli menghasilkan 16 kandidat SL-001..016
  (diuji di tests/run-m2-tests.js via fixture; verifikasi atas JSON asli
  dilakukan manual sesi ini — 16 kandidat, ID/severity/detektor benar).
- Impact Informational/Optimization Slither dipetakan ke Low di M2
  (penyempurnaan pemetaan dijadwalkan M3 bila perlu).
