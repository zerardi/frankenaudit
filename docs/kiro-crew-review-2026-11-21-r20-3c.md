# Kalibrasi R20.3c atas review Kiro R20.3b (D20 swap-output)

Sesi Frankenstein #48, 21 Nov 2026. **Pass Kiro crew + kalibrasi wasit.**

## Pass Kiro crew

- Sesi BARU "Audit R20.3b D20 swap-output" (74ec0a1c-14e9-4aec-8a16-de7a34a57d64),
  browser task c407f520, 12:48–13:07 WIB, **Opus 5.5 eksplisit tanpa
  penolakan — tanpa flag MODEL_TIDAK_SESUAI**; login SSO Arslan hidup
  tanpa hambatan. Kredit pass: 5,14 (footer 0,50 + 0,20 + 4,44;
  dashboard 380,44 → 385,58/4.000).
- Lampiran file d20-r203b-kiro.js DILAPORKAN attached 2× tapi Kiro 2×
  bilang pesan tiba tanpa lampiran — fallback: kode ditempel verbatim
  (blok ```js) di pesan ketiga; harness Node jalan tanpa crash regex,
  tidak ada artefak transport sebagai temuan. Pelajaran: lampiran file
  ke sesi Kiro Web TIDAK andal — paste verbatim tetap jalur utama.
- Vonis Kiro: **NEEDS WORK — 20/22 kasus lolos** (C4 gagal, T5
  report-only) + 11 temuan baru F1–F11.

## Disposisi wasit (probe kode ASLI /tmp/probe-d20-r203c.js + r203c2.js)

| Temuan | Vonis wasit | Alasan / bukti |
|---|---|---|
| F1 (C4 push) | **TERBUKTI** (mekanisme dikoreksi) | Capture push `([^;]*)` menelan `)` penutup → nilai `swapCall)` gagal marker + one-hop. Klaim Kiro "fills kosong" SALAH — fills terisi, nilainya terpolusi. Perbaikan: capture `[^;)]` + `[^;]*;`. |
| F2 (dua fill) | **DITOLAK sbg artefak harness** | Kode memeriksa SEMUA fill (loop `for...of fills`, return true bila salah satu lolos). Probe lokal: data[0]=swap + data[1]=quote → 0. Klaim "hanya fill terakhir dibaca" bertentangan dengan kode. |
| F2b (encodeCall) | **TERBUKTI — temuan wasit** | `abi.encodeCall(ISwapRouter.exactInputSingle, (...))` — segmen diikuti `,`, bukan `(`/`.selector` → marker gagal → 1. Perbaikan: terminator `,` ditambahkan ke penanda c2 (bukan c1 — RHS encodeCall adalah bytes, bukan output swap). |
| F3 (def pertama) | **TERBUKTI** | `defRe.exec` tanpa /g hanya mengambil definisi PERTAMA — reassign quote→swap tak terlihat → 1. Perbaikan: loop /g atas SEMUA definisi, true bila salah satu ber-marker. |
| F4 (struct literal) | **DITOLAK sbg artefak** | Klaim "capture berhenti di `{` struct" SALAH — regex backtracking: capture menyusut ke `)` tuple sendiri sebelum `=`. Probe lokal: tuple + ExactInputSingleParams({...}) → 0. |
| F5 (assign sesudah kirim) | **DITOLAK sbg artefak** | `cut = body.slice(0, beforeIdx)` — penugasan sesudah kirim tak terlihat. Probe lokal (tuple + plain, sesudah kirim) → 1. Bertentangan dengan T8 yang lolos di harness Kiro sendiri — badan probe F5 mereka pasti berbeda. |
| F6 (pull sesudah assign) | **DITOLAK — bukan bug** | Kiro sendiri mengakui "no bug here": guard `pullPos >= lastAssignIdx` berperilaku benar (pull harus mendahului assignment). Invarian SUDAH tertulis di komentar kode. |
| F7 (fallback sebutan) | **TERBUKTI — batas terdokumentasi, TIDAK diubah** | Fallback `/exactInput\|exactOutput/.test(cut)` memang global — itu perilaku lama pra-R20.3b yang sengaja dipertahankan bila data tak diisi lokal. Mengetatkannya 3 hari sebelum freeze berisiko FP baru atas multicall param-data nyata. Residual. |
| F8 (swapFee) | **TERBUKTI** | `swap\w*` meloloskan `swapFee(`/`swapFee.selector` di c1 + c2 → 0. Perbaikan: `isSwapEntryPoint` — `swap` telanjang, atau berawalan `swap` + mengandung `Exact`, atau exactInput/exactOutput. Kontrol: `swapTokensForExactTokens` + bare `swap` tetap 0. |
| F9 (scope) | **TERBUKTI — batas, TIDAK diubah** | Fill regex global tanpa pelacakan scope: `data` blok-dalam (swap) membebaskan payout `data` blok-luar (quote). Perbaikan butuh analisis scope — terlalu besar 3 hari sebelum freeze 24 Nov. Residual. |
| F10 (tuple bracket) | **DITOLAK — snippet invalid** | `(uint256 amountOut[2], ...)` bukan sintaks deklarasi Solidity yang valid; bentuk valid `(amountOut[0], used) = swap(...)` + kirim `amountOut[0]` → 0 dengan BENAR (elemen ITU output swap). Strip bracket dipertahankan. |
| F11 (cap 200) | **TERBUKTI** | Tuple 226 karakter → 1 (terbuang cap). Perbaikan: cap 200 → 400. |
| T5 (nested tuple) | **TERBUKTI — batas terdokumentasi** | Elemen `uint256 amountOut)` (sisa kurung dalam) tak cocok kata terakhir. Perbaikan: kupas `)` akhir dari token terakhir elemen. |

Catatan kejujuran Kiro (diteruskan apa adanya): F1 menyebut fallback
tetap membebaskan C4 padahal tabel harness mencatat C4 actual 1;
F2 dilabel "false negative" padahal prosanya menggambarkan
over-flagging; label FN/FP di kesimpulan Kiro tertukar di beberapa
tempat (T5 actual 1 = over-flag, bukan "drain missed"). Wasit
memakai angka actual + kode asli sebagai otoritas, bukan label Kiro.

## Perbaikan R20.3c

- Helper baru `isSwapEntryPoint` + `hasSwapMarker` (dipakai c1 + c2).
- c1: segmen ditangkap + divalidasi helper (bukan test mentah).
- c2 marker: `hasSwapMarker` di dataArg, fills, dan definisi; terminator
  `,` ditambahkan (encodeCall).
- Push fill: capture `[^;)]` + `[^;]*;`.
- Def lookup: loop /g atas semua definisi var.
- Tuple: cap 200 → 400; kupas `)` akhir token terakhir elemen.
- Suite: **868 → 879/879 PASS** (Seksi 64, 11 tes baru). Verifikasi
  negatif: tepat 7 tes perbaikan gagal di kode lama (64-1/3/4/5/6/9/10);
  4 kontrol lolos di kode lama juga.

## Batas yang diketahui (R20.3c)

- Fallback c2 bila data param/helper lain: uji global (perilaku lama
  dipertahankan; F7).
- Fill `data` nama-sama lintas scope: tanpa pelacakan scope (F9).
- Tuple bersarang >2 level / elemen dengan `)` ganda di tengah: belum diuji.
- (b) pull-forward: token variabel bukan-WETH tanpa `.withdraw(` di
  badan yang sama tetap ter-flag (unwrap di helper lain tak terlihat).
- F11 label-per-target + F10 two-hop tetap DITUNDA (lihat STATUS.md
  sesi #47: F11 berisiko salah-nilai severity; F10 two-hop terlalu
  besar 3 hari sebelum freeze 24 Nov).
