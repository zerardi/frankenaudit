# Tasks — FrankenAudit MVP

Checklist eksekusi (centang `[x]` saat selesai + catat tanggal di STATUS.md).

## M1 — Scaffold (sesi 13 Nov 12:38 WIB)

- [x] Struktur repo + `LICENSE` MIT + `.gitignore` (`.kiro/` TIDAK di-ignore)
- [x] `.kiro/steering/bug-bounty.md` — persona pemburu (dari brief tim)
- [x] `.kiro/steering/product.md` + `tech.md`
- [x] `.kiro/specs/frankenaudit/` — requirements, design, tasks
- [x] `.kiro/hooks/` — hook draft (format-check saat simpan)
- [x] `app/` skeleton statis (index + pipeline stub + report stub)
- [x] `README.md` awal + `git init` lokal (belum push — push publik
      butuh persetujuan Toufik)

## M2 — MVP pipeline (target siap-hunting 17–18 Nov 2026)

- [x] `app/samples/` — kontrak trap terkurasi #1 + `.analysis.json`
      ground truth (7 bug + 3 negative control) — SELESAI 13 Nov 2026 (sesi 16:38 WIB)
- [x] `app/pipeline.js` — pattern scan nyata (6 detektor: reentrancy,
      missing-access-control, division-no-guard, ecrecover-no-zero-check,
      tx-origin, unchecked-call) + normalisasi kandidat + normalizeSlither()
- [x] `app/report.js` — render kartu kandidat + penutup (area
      terpetakan/belum + 3 hipotesis terkuat) + disclaimer
- [x] `app/app.js` — orkestrasi UI: pilih sampel / tempel alamat /
      unggah `.sol` → jalankan → tampilkan laporan (sudah wiring M1; sampel
      kini terdaftar di samples/index.json)
- [x] Uji ujung-ke-ujung lokal: sampel trap → laporan lengkap, tanpa error
      (tests/run-m2-tests.js — 11/11 PASS, 13 Nov 2026 sesi 16:38 WIB)
- [x] Mode Slither: pasang `slither-analyzer` (venv lokal atau Daytona),
      tambah `normalizeSlither()` + uji atas sampel yang sama
      — SELESAI 13 Nov 2026 (sesi 16:38 WIB): Slither 0.11.6 + solc 0.8.20
      di `.venv-slither/` (tidak di-commit); 16 temuan atas trap-vault;
      cross-check di `docs/slither-crosscheck-2026-11-13.md` — Slither
      cocok 3/7 ground truth langsung, 2 sebagian, 2 tidak terdeteksi
      (divisi tanpa guard, ecrecover tanpa cek nol), + noise pada
      negative control withdrawSafe (reentrancy-events/low-level-calls).
      `normalizeSlither()` atas JSON asli → 16 kandidat SL-001..016 benar.
- [x] Wiring baseline ke UI app (sesi 00:38 WIB 15 Nov 2026): upload
      multi-file `.sol` upstream → `buildBaselineMap()` (first-wins per
      basename, tabrakan dicatat) → `runPipeline(..., {baseline})`;
      kartu kandidat menampilkan baris Upstream-diff, penutup menampilkan
      status baseline; test 54/54 PASS (9 baru).
- [ ] Lookup on-chain read-only: `eth_getCode` via RPC publik untuk
      alamat yang ditempel (opsional, laporan tetap jalan bila gagal)
      (fetchBytecodeReadOnly() sudah ada; wiring UI alamat → lookup
      belum — dijadwalkan sesi berikut)
- [ ] Pass Kiro crew (Opus 5.5 / GPT 5.6) atas sampel trap: review
      silang kandidat pipeline vs ground truth; catat false +/- di STATUS.md
      (dijadwalkan sesi 20:38 WIB — hindari tabrakan browser sesi BB sore)

## M2.5 — MODE HUNTING (aktif begitu M2 jalan)

- [ ] Jalankan pipeline atas target antrean reputasi (pertama Cronos
      zkEVM Smart Contracts; lalu Hyperbridge / Flow Protocol)
- [ ] Tulis kandidat ke `bb-log.md` sebagai "KANDIDAT FRANKENSTEIN"
      (format BB baku) untuk verifikasi jack (fork PoC)
- [ ] Catat hasil latihan (terdukung/gugur) di STATUS.md sebagai bahan
      perbaikan steering/checklist

## M3 — URL live (target ±19 Nov 2026)

- [ ] Pilih jalur deploy statis (tanpa persetujuan baru bila tersedia)
- [ ] Deploy + verifikasi URL bisa dibuka (juri: tanpa login/setup)
- [ ] Catat URL di STATUS.md + README.md

## M4 — Aset submission

- [ ] Teks deskripsi Devpost
- [ ] Write-up pemakaian Kiro (specs, steering, hooks, agents, MCP)
- [ ] Naskah video demo < 3 menit + rekaman (YouTube publik)
- [ ] (Opsional) Blog post bonus + post sosial #KiroweenHackathon26

## M5 — Isi draf Devpost 1298511

- [ ] Isi draf dari teks yang sudah disiapkan
- [ ] Submit final HANYA dengan persetujuan eksplisit Toufik di chat
