# FrankenAudit — Naskah video demo (DRAF, target < 3 menit)

> Draf naskah + shot list untuk video demo YouTube publik (M4).
> Status: DRAF — belum direkam. Target durasi: ±2:30. Bahasa: Inggris
> (juri Devpost) dengan subtitle bila perlu.

## Struktur (±150 detik)

| # | Waktu | Visual | Narasi (draf) |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | Judul + logo FrankenAudit; potongan kode kontrak | "Bug-bounty scanners give you noise. FrankenAudit gives you candidates you can falsify — a hypothesis, the on-chain preconditions, and a verification checklist." |
| 2 | 0:15–0:45 | App: tempel alamat kontrak / upload `trap-vault.sol`; klik Run | "Paste a contract address, or upload a Solidity file. The pipeline runs twenty pattern detectors plus Slither — here on a curated trap contract with twenty-four planted bugs." |
| 3 | 0:45–1:20 | Halaman laporan: kandidat FA-001…; buka satu kandidat (setOwner, Critical) | "Every candidate is a hypothesis, not a verdict. Location, mechanism, preconditions, impact, and exactly how to verify it. No finding is called proven until a fork proof-of-concept runs." |
| 4 | 1:20–1:50 | Lookup on-chain: pilih chain Cronos zkEVM, tempel alamat Pool Amply → 6.304 byte | "Then the live check. The app reads deployment state — read-only, no wallet, no transaction — to kill candidates that exist in code but are dead on-chain." |
| 5 | 1:50–2:15 | Terminal Foundry: `forge test` PoC 4/4 PASS | "The survivors get a fork-level proof-of-concept. Four out of four pass here — including a drain through missing access control." |
| 6 | 2:15–2:30 | Repo `.kiro/` (steering/specs/hooks) + penutup | "Built with Kiro: a bug-bounty steering persona, specs, and hooks — the same discipline our crew hunts with every day. FrankenAudit. Candidate, not verdict." |

## Catatan produksi

- Rekam layar 1080p, app lokal (atau URL live bila M3 sudah live saat
  rekam — lebih baik URL live).
- Trap-vault: JANGAN sebut "aman" — tegaskan ini kontrak sampel yang
  sengaja berisi bug, jangan deploy.
- Musik latar: bebas lisensi, pelan. Subtitle Inggris bila narasi
  beraksen.
- Upload: YouTube publik, unlisted TIDAK cukup (syarat: publik).
- Sebelum rekam: pastikan URL repo publik sudah live (butuh persetujuan
  Toufik untuk push) — bila belum, rekam versi lokal dulu, ganti shot
  repo di akhir bila URL sudah ada.
