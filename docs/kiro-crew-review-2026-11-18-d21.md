# Review Kiro crew atas detektor ke-21 `empty-sublist-proof-advances-height` (R21.1)

- Sesi Kiro: BARU "Audit D21 empty-sublist-proof" 8da7a082-8233-4094-a69d-702d269dccdd
- Model: Claude Opus 5.5 eksplisit, tanpa penolakan, tanpa flag MODEL_TIDAK_SESUAI
- Waktu: 18 Nov 2026 20:47–20:59 WIB (±12 mnt, pengerjaan 6 mnt 7 dtk)
- Kredit: dashboard 293,24 → 298,67 (delta 5,43; footer sesi 5,43, cocok)
- Bahan: detektor v1 ditempel verbatim (versi ringkas — hypothesis/evidence/toVerify dipangkas di tempelan) + fixture BEEFY48; helper stripComments/extractFunctions/normalizeCandidate di-require dari repo main @ 360209b; harness Node di /projects/sandbox/harness/ (detector.js + run.js)

## Vonis Kiro: NEEDS WORK — 42 kasus: 8 benar, 15 FP, 19 FN

- Uji dasar lolos: C00 fixture → tepat 1 Low di verifyParachainHeaders; C01 EcdsaBeefy.sol asli → 1 di verifyParachainHeaderProof; C02 fixture di test/ → 0; scan 95 file evm/**/*.sol Hyperbridge → 1 hit (EcdsaBeefy saja), 0 FP di korpus itu.
- FP (harap 0, dapat 1): G03 require(list.length>0); G04 gerbang .length>0 + require(.length>0); G05 assert(len>0); G06 if(len==0){revert}; G07 require(len!=0); G08 if(len<1) revert; G09 guard di caller verify(); G10 else revert tanpa kurawal; G11 else + komentar; G12 var len$ (RegExp tak di-escape); G13 height maju DI DALAM gerbang (perbaikan benar); G15 daftar kosong terikat komitmen (hash); G16 tiga fungsi tak berhubungan; G17 emit VerifyRequested(len).
- FN (harap 1, dapat 0): N01 if(len!=0); N02 if(len>=1); N03 if tanpa kurawal; N04 0<.length; N05 calculateRoot == headsRoot; N06 paras(proof).length; N07–N09 latestBlock/currentHeight/lastHeight; N10 var newHeight = proof.blockNumber; N11 stale if-revert tanpa kurawal; N12 require(blockNumber>latestHeight); N13 stale terbalik `<=`; N14 `+= 1` (ambigu); N15 if(ok) latestHeight=...; N16 struct literal; N17 if(ok){...}; N18 gerbang di modifier (dapat 1, tapi function = nama kontrak); N19 verifikasi di file lain (desain level-file); N20 `&&` gabungan; N21 p.length 1-huruf.
- Benar: G01 require(len>0); G02 if(len==0) revert; G14 stale `>` saja → 0 (blok sama lolos).

## Temuan Kiro (F1–F16) + vonis wasit

- F1 gerbang `.length > 0` tak dicek guard (lenVar null) — TERBUKTI, diperbaiki (guard dari listExpr).
- F2 guard terlalu sempit (require list.length, assert, `if==0 {revert}`, `!= 0`, `< 1`, `$` tak di-escape) — TERBUKTI semua, diperbaiki.
- F3 guard di caller tak terlihat — TERBUKTI, diperbaiki (guard dicari di fungsi pemanggil gerbang, bentuk listExpr).
- F4 else rapuh (40 karakter, wajib `{`, komentar, else-return) — TERBUKTI, diperbaiki (parsing else + kurawal/tanpa-kurawal + revert/return).
- F5 A/B/C tak dikaitkan (G16 tiga fungsi; G13 perbaikan benar tetap flag) — TERBUKTI, diperbaiki (keterkaitan jalur (D) + advance di dalam badan gerbang dikecualikan).
- F6 daftar kosong sah terikat komitmen — BATAS HEURISTIK, didokumentasikan: bullet baru di toVerify ("cek apakah sub-daftar kosong terikat ke komitmen"); tanpa perubahan kode.
- F7 regex verifikasi cocokkan event (`emit VerifyRequested`) — TERBUKTI, diperbaiki (`emit` dikecualikan).
- F8 filter deklarasi advRe tak pernah bekerja (before selalu "") — TERBUKTI, diperbaiki (filter berbasis statement).
- F9 bentuk gerbang terbatas (!=, >= 1, tanpa kurawal, 0 < .length, `&&`) — TERBUKTI, diperbaiki (evaluator false-at-0 + `ifParts` satu-statement + belah `&&` level-teratas).
- F10 lenDeclRe (1-huruf, panggilan fungsi) — TERBUKTI, diperbaiki (`*` + paren diizinkan).
- F11 verifikasi wajib bernama *verify* — TERBUKTI, diperbaiki (`calculate/compute/check*Root` ikut dihitung).
- F12 latestHeight di-hardcode — TERBUKTI, diperbaiki (allowlist 5 nama height).
- F13 stale-check terbatas (tanpa kurawal, require, terbalik, var blockNumber) — TERBUKTI, diperbaiki (ifParts satu-statement + require `B > H`/`H < B` ketat + var blockNumber + qualifier member `s.latestHeight` — dua miss terakhir ditemukan probe wasit pasca-R21.1, R21.1b).
- F14 penugasan height terbatas (`+=`, storage tak di awal baris, struct-literal) — TERBUKTI, diperbaiki.
- F15 lingkup level-file (N19) — SESUAI DESAIN, didokumentasikan di header detektor; tidak diubah.
- F16 evidence generik + function = nama kontrak bila gerbang di modifier — DITOLAK SEBAGIAN sebagai artefak: tempelan review memangkas evidence/toVerify detektor (evidence ASLI memuat nomor baris gerbang/advance/stale + keterkaitan jalur — terverifikasi di kode); bagian modifier (function fallback ke nama kontrak) BENAR dan dicatat sebagai batas diketahui.

## Kalibrasi wasit R21.1 (+ R21.1b)

- Probe wasit /tmp/probe-d21.js (24 kasus Kiro): pra-perbaikan 22/24 MISS (N15 sudah lolos); pasca-R21.1 22/24 OK, tersisa N12/N13 (qualifier member di stale-check) → R21.1b memperbaikinya → probe 24/24.
- Test suite: seksi 48b baru (34 tes: 14 FP + 17 FN + G14 + F6 + N18) — total **641/641 PASS** (607 lama + 34 baru).
- Verifikasi korpus nyata: EcdsaBeefy.sol verbatim tetap 1 Low (tes 48j); scan Hyperbridge Kiro 95 file tetap 1 hit.
- Catatan Kiro (bukan temuan detektor): SP1Beefy.sol punya stale-check `>=` + height maju tanpa syarat, tanpa gerbang len > 0; daftar header masuk public input SNARK — Kiro TIDAK memverifikasi apakah circuit SP1 menerima headers=[]. Diteruskan sebagai pertanyaan terbuka ke sesi BB (bukan backlog detektor).
