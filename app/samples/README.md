# Kontrak sampel terkurasi

Folder ini berisi kontrak `.sol` sampel + analisis ground truth manusia
(`.analysis.json`) untuk demo juri dan pengujian produk.

Format tiap sampel:
- `<nama>.sol` — source kontrak
- `<nama>.analysis.json` — kandidat yang sudah dikurasi (format kandidat
  baku, lihat `../../.kiro/steering/bug-bounty.md`), termasuk 1 negative
  control (pola yang tampak mencurigakan tapi AMAN, supaya pipeline tidak
  dihargai atas false positive)
- Daftar sampel didaftarkan di `index.json`:
  `[{"name": "…", "file": "….sol"}]`

## Sampel yang direncanakan (M2)

1. **Trap vault** — simple withdrawal vault with 30 planted bugs
   (reentrancy, 2× missing-access-control, division without zero guard,
   ecrecover without zero check, tx.origin, unchecked call) + 3 safe patterns
   sebagai negative control (withdrawSafe, sharePriceSafe,
   claimWithSignatureSafe). Ground truth: trap-vault.analysis.json.
   Pipeline M2: 11/11 test lolos (tests/run-m2-tests.js).
2. (menyusul) Kontrak dari target antrean reputasi yang sudah publik,
   dipakai untuk pengujian produk mode hunting.

Status M2 (13 Nov 2026, sesi 16:38 WIB): sampel pertama SELESAI — trap-vault.sol + .analysis.json + index.json.
