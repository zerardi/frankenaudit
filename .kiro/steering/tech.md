# Tech — Steering

## Stack MVP

- **Frontend:** aplikasi web statis (HTML + CSS + vanilla JS, tanpa
  framework berat) di `app/`. Alasan: gampang di-deploy statis untuk juri,
  nol build step, nol server wajib.
- **Pipeline analisis (MVP):** dua mode.
  - **Mode sampel terkurasi** (selalu tersedia, tanpa backend): kontrak
    sampel + hasil analisis yang sudah dikurasi manusia; pipeline lokal
    (pattern scan ringan di JS) menandai pola klasik dan memetakan ke
    format kandidat.
  - **Mode Slither** (bila tersedia): backend kecil / CLI lokal
    menjalankan Slither atas file `.sol` yang diunggah, hasilnya
    dinormalisasi ke format kandidat yang sama. Slither TIDAK termasuk
    di repo; dipasang terpisah (`pip install slither-analyzer`).
- **Lookup on-chain:** read-only via RPC publik (eth_call / getCode /
  getStorageAt). Tanpa kunci, tanpa transaksi.
- **Kiro agent crew:** agen-agen Kiro (specs di `.kiro/specs/`, steering
  di `.kiro/steering/`) berperan sebagai reviewer kode; output mereka
  adalah teks kandidat yang masuk ke laporan. Crew TIDAK mengeksekusi
  kode target dan TIDAK menyentuh jaringan selain baca publik.

## Struktur repo

```
frankenaudit/
  .kiro/
    steering/        # persona & konteks tetap (bug-bounty, product, tech)
    specs/           # spec fitur ala Kiro (requirements/design/tasks)
    hooks/           # automation hooks Kiro
  app/               # aplikasi web statis (MVP)
    samples/         # kontrak .sol sampel terkurasi + analisisnya
  docs/              # catatan desain & keputusan
  LICENSE            # MIT
  README.md
```

## Konvensi

- Bahasa UI & laporan: Indonesia ringkas (pengguna utama tim lokal);
  istilah teknis Solidity/keamanan tetap Inggris.
- Format kandidat SELALU mengikuti `.kiro/steering/bug-bounty.md`
  (ID, lokasi, hipotesis, prasyarat, dampak+severity, bukti, verifikasi).
- Tidak ada kredensial di repo. `.env` dan kunci di-gitignore.
- `.kiro/` TIDAK BOLEH di-gitignore (syarat submission Kiroween).
