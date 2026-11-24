# Review Kiro crew atas kalibrasi R-COF-3 / R-COF-3a — 21 Nov 2026 (sesi #50)

- Pass Kiro: browser task 854dc36f, 20:51–20:57 WIB, sesi BARU "Audit R-COF-3 commented-out-check" d1075178, **Claude Opus 5.5 eksplisit tanpa penolakan — tanpa flag MODEL_TIDAK_SESUAI**. Kode ditempel verbatim (tanpa lampiran). Elapsed Kiro 2m 42s.
- Kredit: dashboard 387,89 → **390,62/4.000 (delta 2,73; footer sesi 2,73, cocok persis)**; sisa 3.609,38, 41 hari; Free 0/50.
- **Vonis Kiro: NEEDS WORK** — 35 kasus: klaim (a)–(f) penulis semua lolos; 17 lolos / 20 gagal menurut hitungan ulang tabel (ringkasan Kiro sendiri inkonsisten: "17 lolos dan 18 gagal: 11 FP dan 11 FN" — 11+11=22, bukan 18; angka per kasus di bawah yang dipakai).

## Konteks

R-COF-3 (bangun sesi #50): commented-out-check menekan kandidat bila fungsi yang sama memuat live guard `if + revert` dgn token bersama (aturan awal: identifier bersama >= 2 DAN (literal bersama >= 1 ATAU >= 3 identifier ATAU token panggilan/member bersama)). Kasus pemicu: FA-001 EFP (`_claimListManager`, require dikomentari baris 190, padanan hidup `if + revert SlotAlreadyClaimed` baris 191–196).

## Temuan Kiro F1–F12 + disposisi wasit

Disposisi diverifikasi dgn probe atas pipeline ASLI (`/tmp/probe-cof3a.js` — runPipeline, fn.body dari source comment-stripped): pra-R-COF-3a 1 lolos / 7 gagal; pasca-R-COF-3a **8/8**.

| # | Temuan Kiro | Disposisi wasit |
|---|---|---|
| F1 | Komentar di fnBody ikut dibaca sbg guard hidup (X4/X5) — cek menekan dirinya sendiri | **DITOLAK sbg artefak harness.** Pipeline mengirim fn.body dari source yg SUDAH comment-stripped; probe W-F1: 1 kandidat (tidak ter-suppress). Kiro sendiri memberi caveat yg sama. |
| F2 | String di body tidak dibuang (X6/X7/N8) — `if/revert`/kurawal di string menyuntik guard palsu | **TERBUKTI + diperbaiki.** String kini di-mask (`cof3MaskStrings`) sebelum pindai guard. Probe W-F2: 0 → 1. |
| F3 | Argumen revert dihitung sbg bukti kondisi (X3) | **TERBUKTI + diperbaiki.** Token guard kini HANYA dari kondisi if (terluar + bersarang); `cof3RevertArgs` dihapus. Probe W-F3: 0 → 1. EFP tetap ter-suppress (3 identifier dari kondisi saja). |
| F4 | Pencocokan token buta-operator/arah/struktur (X2/X9) | **TERBUKTI, DITUNDA/didokumentasikan (batas).** Perlu perbandingan kondisi ternormalisasi (negasi + urut operand) — redesign, terlalu besar 3 hari sebelum freeze 24 Nov. Tes 66-9 mengunci perilaku ini sbg batas yg diketahui. |
| F5 | Literal umum 0/1 dianggap bukti kuat (X1) | **TERBUKTI + diperbaiki.** Aturan "literal bersama" DIHAPUS seluruhnya (bukan cuma 0/1): X8 membuktikan literal bersama bisa over-suppress (`price >= 1e18` vs `fee > 1e18`). Aturan tekan baru: identifier bersama >= 3, ATAU >= 2 dgn token panggilan/member bersama. Tes 65-9 diubah ekspektasi 0 → 1. |
| F6 | Satuan + notasi angka salah ditokenisasi (X8/E6b: `ether`, `1e18` → ident palsu `e18`) | **TERBUKTI + diperbaiki.** Angka di-mask sebelum ekstraksi identifier (regex literal diperlebar: hex/underscore/eksponen); satuan ether/wei/gwei/finney/szabo/detik/menit/jam/hari/minggu/tahun masuk stoplist. **DITOLAK sebagian:** `length`/`balance` TIDAK masuk stoplist — keduanya sinyal struktural member-access (kasus EFP bergantung pada `length`). |
| F7 | Literal tidak dinormalisasi (N7g hex beda kapital, N7h `1_000` vs `1000`) | **MOOT pasca-F5** (literal tidak lagi dipakai sbg bukti). Tidak ada perbaikan terpisah. |
| F8 | Ambang terlalu ketat utk refactor kanonik (N1 amount/balance, N2 `!paused`, N6 ident 1–2 huruf) | **DITOLAK sbg desain.** Sesuai klaim konservatif (d); under-suppress itu disengaja dan aman. Kiro sendiri mencatat N1/N2/N6 sesuai desain. |
| F9 | Revert di else-branch tidak dikenali (N3) | **TERBUKTI + diperbaiki.** Cabang `else` yg memuat revert ikut dihitung sbg guard (token dari kondisi if + kondisi bersarang di else). Probe W-F9: 1 → 0. |
| F10 | Guard Yul di assembly tidak dikenali (N4) | **DITUNDA/didokumentasikan (batas).** Sintaks Yul berbeda (`if or(...)`, `revert(0,0)`) — di luar cakupan detektor ini. |
| F11 | Padanan require/assert hidup tidak dikenali (N5) | **TERBUKTI + diperbaiki.** Helper baru `cof3LiveRequireGuards` — require/assert hidup di badan fungsi ikut dihitung dgn aturan token yg sama. Probe W-F11: 1 → 0. |
| F12 | Helper yg revert + pola ternary tidak dikenali (N9) | **DITUNDA/didokumentasikan (batas).** Butuh analisis antar-fungsi — di luar cakupan. |

## Hasil kalibrasi R-COF-3a

- Probe wasit `/tmp/probe-cof3a.js`: **8/8 PASS** (pra-perbaikan 1/8).
- Suite: **890 → 899/899 PASS** (Seksi 65: 9 tes; Seksi 66: 9 tes baru — 66-1..66-9 mengunci F1/F2/F3/F5/F6/F9/F11 + batas F4).
- Verifikasi negatif: tepat 6 tes gagal di kode pra-R-COF-3 (65-1/5/8, 66-7/8/9 — ketiganya butuh mekanisme R-COF-3); utk 66-2..66-6, verifikasi negatifnya adalah run probe pra-perbaikan (7 gagal) — tes-tes itu lolos vakum di kode lama karena mekanisme suppress belum ada sama sekali.
- Kasus EFP `_claimListManager` tetap ter-suppress (3 identifier bersama dari kondisi); hunting re-run menyusul sesi ini.

## Batas yg diketahui (pasca-R-COF-3a)

- F4: guard dgn identifier sama tapi satu perbandingan terbalik bisa over-suppress (tes 66-9).
- F10: guard Yul tidak dikenali. F12: helper/ternary yg revert tidak dikenali.
- F8: refactor kanonik 2-identifier tanpa panggilan bersama (N1 amount/balance, N2 `!paused`, N6 nama pendek) SENGAJA tidak dikenali — konservatif.
- Live require/assert duplikat kini dikenali (F11); duplikat di file lain (bukan fungsi sama) tidak terlihat — function-scoped.
