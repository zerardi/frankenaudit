# FrankenAudit — How we used Kiro (DRAF write-up pemakaian Kiro)

> Draf untuk seksi "Built with Kiro" di Devpost 1298511 (M5).
> Status: DRAF — belum diisi ke Devpost. Angka kredit per 14 Nov 2026
> 04:38 WIB: terpakai 6,75 / 4.000 (sisa 3.993,25; 49 hari).

## Steering (`.kiro/steering/`)

- **`bug-bounty.md`** — persona pemburu bug bounty yang ditanam di Kiro:
  kandidat-bukan-verdict, hipotesis yang bisa difalsifikasi, severity
  gate Medium ke atas, PoC fork sebelum klaim, larangan submit tanpa
  persetujuan manusia. Ini "otak" yang sama dipakai sesi audit harian
  kami, dibawa ke dalam proyek sebagai steering repo.
- **`product.md`** — apa itu FrankenAudit, siapa pemakainya, prinsip
  candidate-not-verdict.
- **`tech.md`** — stack (aplikasi statis + pipeline Node + Slither +
  Foundry) dan aturan main repo.

## Specs (`.kiro/specs/frankenaudit/`)

- **`requirements.md` / `design.md` / `tasks.md`** — spesifikasi M1–M5:
  scaffold → MVP pipeline → URL live → aset submission → isi draf
  Devpost. Milestone dikerjakan sesi demi sesi mengikuti tasks.md.

## Hooks (`.kiro/hooks/`)

- **`candidate-format-check.json`** — hook format kandidat: setiap
  kandidat yang ditulis ke laporan wajib membawa lokasi
  (file:fungsi), hipotesis, precondition, dampak, dan cara verifikasi.
  Format ini yang dipakai pipeline (`report.js`) dan laporan hunting.

## Custom agents / agent crew

Tidak ada file custom-agent terpisah — crew-nya adalah **sesi Kiro
dengan steering bug-bounty.md yang sama, dijalankan dengan peran
berbeda** (pass lebar → pass final → cek silang), sesuai cara kerja
tim kami:

| Pass | Model | Hasil |
| --- | --- | --- |
| Audit 18 file Amply (Cronos zkEVM) | Auto | 7 kandidat AMP-01…AMP-07 (sesi BB sore 13 Nov; delta 4,91 kredit) |
| Review silang trap-vault vs ground truth | Opus 5.5 | 3/7 KONFIRM, 2 naik ke Critical (setOwner, payFee); 4 diturunkan dengan alasan; 4 bug baru yang dilewatkan pipeline (temuan A–D) → 2 jadi detektor baru (replay-signature, share-accounting) |
| Tes MiniPerp (persona check) | — | Steering + persona terverifikasi jalan |

Detail lengkap: `docs/kiro-crew-review-2026-11-13.md`.

## MCP servers

**Tidak dipakai.** Lookup on-chain dilakukan read-only langsung dari
aplikasi (fetch `eth_getCode` via RPC publik), tanpa MCP. Bila juri
menanyakan: tidak ada klaim MCP di proyek ini.

## Kiro sebagai produk yang diuji (dogfooding)

Sesi pembangunan Frankenstein juga memakai Kiro sebagai **pengujian
produk**: pass audit Kiro atas target bug-bounty nyata (Amply, RAAC)
adalah bahan latihan pipeline — kandidat Kiro jadi ground truth untuk
mengukur recall pipeline (0/7 → 1/7 sesudah detektor commented-out-check,
14 Nov 2026), dan temuan Kiro yang lolos dari pipeline jadi backlog
detektor berikutnya.

## Kredit

Hibah Kiroween 4.000 kredit (hangus 31 Des 2026). Terpakai s/d sesi ini:
**6,75 kredit** — dipakai hanya untuk kerja nyata (pass audit + review
silang), tanpa prompt sampah. Pembangunan lokal (scaffold, pipeline,
test, PoC fork) dikerjakan tanpa pass Kiro.
