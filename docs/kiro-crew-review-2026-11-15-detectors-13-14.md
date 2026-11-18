# Review Kiro crew atas detektor 13 & 14 — 15 Nov 2026 (sesi Frankenstein 04:38 WIB)

Pass Kiro: browser task, sesi steering d9d77979, model Claude Opus 5.5
(awal Sonnet 5.5, diganti manual ke Opus 5.5; GPT 5.6 tidak dipakai).
3 file ditempel verbatim (kode detektor pipeline.js, fixture trap-vault
BUG 10/11 + kontrol H, RedStone ProxyConnector._prepareMessage) + review
request verbatim. Kiro menguji regex dengan `node -e` (pipeline.js tidak
ada di workspace Kiro — parser `fn.body` tidak ikut teruji).
Kredit: 24,51 → 29,14 / 4.000 (delta 4,63; jumlah per pesan 4,62,
selisih 0,01 pembulatan dashboard). Tidak ada file diubah Kiro.

Catatan: "24,51 sebelum pass" sudah mencakup +4,02 sesi BB sore 14 Nov
(dashboard lag dari 20,49). Sisa sesudah pass: 3.970,86; 48 hari →
tempo ≈82,7/hari.

## 1. Detektor 13 oracle-passthrough — KONFIRM, ada FN dan FP

| # | Temuan Kiro | Disposisi jack |
|---|---|---|
| 1a | Guard berkurung `(block.timestamp - updatedAt) <= MAX_AGE` tidak dikenali P1 | DIPERBAIKI — P1 terima kurung opsional. Tes baru. |
| 1b | Guard lewat variabel `age = block.timestamp - updatedAt; require(age <= MAX)` tidak dikenali | DIPERBAIKI — pelacakan 2 langkah (P5). Tes baru. |
| 1c | `updatedAt < block.timestamp - MAX_AGE` dan `block.timestamp > updatedAt + MAX_AGE` (bentuk revert) tidak ada polanya | DIPERBAIKI — P3/P4 baru. Tes baru. |
| 1d | Nama variabel umur lain (`lastUpdate`) tidak dikenali | DIPERBAIKI — `TS_VAR_RE` (updatedAt/lastUpdate/lastUpdated/updated_at). Tes baru. |
| 1e | `updatedAt > block.timestamp` (cek masa depan saja) salah dianggap guard oleh P2 | DIPERBAIKI — P2 kini mensyaratkan `block.timestamp - ...` di sisi kanan. Tes baru. |
| 1f | `answeredInRound == roundId` dianggap guard, padahal field deprecated & tidak menjamin umur data | DIPERBAIKI — pola dihapus dari guard. Tes lama seksi 10 diperbarui (getPriceRound kini 1 kandidat) + tes baru. |
| 1g | Komentar `// TODO: add stale check later` menekan temuan (keyword regex jalan di komentar) | KOREKSI WASIT — Kiro salah dalam konteks pipeline: `runPipeline` men-strip komentar sebelum ekstraksi fungsi (terverifikasi: snippet tetap ter-flag). Tidak ada perbaikan; tes baru mengunci perilaku ini. |
| 1h | `getPriceUnsafe` (Pyth), `getUnderlyingPrice` (Compound), `getRoundData` tidak dikenali `PRICE_READ_RE` | DIPERBAIKI — ketiganya ditambah. `getPriceNoOlderThan` SENGAJA tidak ditambah (guard bawaan). Tes baru. |
| 1i | `isBorrowAllowed` dihitung guard — sentinel sequencer, bukan cek umur harga; hasilnya tidak konsisten (validateBorrow tertekan, jalur likuidasi ter-flag) | DIPERBAIKI — dihapus dari keyword guard. Konsekuensi: `validateBorrow` kini ter-flag (FA-AMP-17, `live-identical`, by-design) — konsisten dengan jalur likuidasi. |
| 1j | `require(updatedAt != 0)` tidak dihitung guard — sudah benar | Tidak ada perubahan. |
| 1k | `latestRound()` mengembalikan round id, bukan harga — false positive | DIPERBAIKI — dihapus dari `PRICE_READ_RE`. Tes baru. |
| 1l | Pembacaan harga hanya untuk event/view ikut ter-flag | DITUNDA — function-scoped, tidak bisa membedakan valuasi vs emit/view. Didokumentasikan sebagai batas diketahui. |
| 1m | Fork Aave: `getAssetPrice` tanpa cek staleness adalah desain upstream → tag known-issue, bukan kandidat | DIKODEKAN sebagai panduan `toVerify` (live-identical → by-design/known-issue). Tidak ada auto-tag — wasit yang memutuskan. |
| 1n | Variabel `m` di `detectOraclePassthrough` tidak dipakai | TIDAK BERLAKU — Kiro me-review paste yang disederhanakan jack; kode asli memakai `m` di hipotesis. Tidak ada perubahan. |

## 2. Detektor 14 free-mem-pointer — KONFIRM, ada FN dan FP

| # | Temuan Kiro | Disposisi jack |
|---|---|---|
| 2a | `SIZE_IDENT_RE` tanpa batas kata salah cocok: `account` (mengandung "count"), `WORD_SIZE` (konstanta 32) | DIPERBAIKI — case-sensitive + batas kata/akhiran camelCase (`\bsize\b`, `Size\b`, `\bcount\b`, `Count\b`, `\blen\b`). RedStone `_prepareMessage` tetap ter-flag (terverifikasi). Tes baru. |
| 2b | `ROUNDING_RE` melewatkan idiom umum: `mul(div(add(len,31),32),32)`, hex `0x1f/0x20`, `and(add(len,0x1F),not(0x1F))`, mask `sub(0,32)`; pola div lama (`add(...,32)`) hampir tak pernah cocok | DIPERBAIKI — div terima 31/0x1f/0x20/32 + paren bersarang, regex case-insensitive, tambah `sub(0,32)`. Tes baru. |
| 2c | `mstore(64, ...)` (literal desimal) tidak dikenali `writeRe` | DIPERBAIKI — `writeRe` terima `64`. Tes baru. |
| 2d | Nilai lewat variabel (`let end := add(ptr, len); mstore(0x40, end)`) dilewati | DIPERBAIKI — pelacakan `let` 1 langkah (sizedVars). Tes baru. |
| 2e | Ukuran dari `mload(data)` tanpa identifier ukuran (idiom Yul paling umum — `.length` tidak ada di Yul) | DIPERBAIKI — `mload(` dihitung sinyal ukuran, KECUALI `mload(0x40/64/FREE_MEMORY_PTR)` (membaca pointer, bukan ukuran). Tes baru. |
| 2f | Pembulatan di variabel (`let roundedSize := and(add(len,31),not(31))` lalu `add(ptr, roundedSize)`) tetap ter-flag karena kata "size" | DIPERBAIKI — variabel yang sudah dibulatkan di-blank dari ekspresi sebelum diuji (roundedVars). Tes baru. |
| 2g | `_prepareMessage` ter-flag, `initByteArray` ter-flag, reset `_securelyExtract...` tidak ter-flag — ketiganya sesuai maksud detektor | Terverifikasi ulang pasca-kalibrasi: `_prepareMessage` + `_extractDataPackage` tetap ter-flag. |

## 3. Fixture BUG 10/11 + kontrol H — KONFIRM, ada celah

| # | Temuan Kiro | Disposisi jack |
|---|---|---|
| 3a | H lolos karena 2 alasan sekaligus (P1 + string `"stale price"` cocok keyword) — tes tidak bisa mendeteksi regresi P1 | DIPERBAIKI — string diubah jadi `"old price"` (persis tes Kiro) + keyword kini diuji atas body tanpa string literal (`stripStrings`). H kini lolos hanya via P1. Ground truth tetap 16. |
| 3b | Komentar fixture "TANPA STALENESS CHECK" di atas BUG 10/11 bisa menekan temuan bila parser memasukkan komentar ke `fn.body` | KOREKSI WASIT — komentar di atas fungsi tidak masuk `fn.body` (ekstraksi mulai dari kata kunci `function`); komentar di dalam badan di-strip `runPipeline`. Terverifikasi. Tidak ada perubahan. |
| 3c | Cakupan fixture kurang (tidak ada idiom poin 1) | DIPERBAIKI — idiom-idiom itu kini fixture inline di seksi 14 `run-m2-tests.js` (trap-vault tidak diperbesar supaya ground truth tetap 16). |

## 4. `_prepareMessage` klasifikasi Info — KONFIRM

Kiro setuju tidak ada jalur korupsi data: over-read `mload` ≤31 byte
tidak berbahaya; over-write `mstore` jatuh di area yang ditimpa
`calldatacopy` atau di atas free pointer baru (tidak dijamin bersih,
tapi bukan korupsi); memori EVM byte-addressable; fungsi tidak
`"memory-safe"` sehingga optimizer tidak berasumsi alignment. Sejalan
dengan PoC HYP-01 (8/8 PASS). Batas: analisis dari membaca kode saja,
tanpa PoC baru; pemanggil `_prepareMessage` tidak dilihat.

## 5. Kalibrasi severity — KONFIRM Low sebagai default

Tetap Low / known-issue: fork Aave (desain upstream tanpa cek),
wrapper sudah validasi di luar fungsi, pembacaan hanya view/UI/event.
Naik ke Medium bila ketiganya terpenuhi: (1) harga dipakai valuasi
agunan/utang, likuidasi, mint, atau redeem; (2) staleness realistis
(feed heartbeat panjang, `latestAnswer` deprecated, L2 tanpa
sentinel); (3) tidak ada guard di jalur lain (fallback/sentinel/
circuit breaker). High hanya bila PoC menunjukkan selisih harga basi
bisa diubah menjadi borrow berlebih. Syarat Medium ini dikodekan ke
`toVerify` detektor 13; tidak ada auto-escalation (function-scoped
tidak tahu konteks valuasi).

## Dampak hunting pasca-kalibrasi (re-run 15 Nov 04:58 WIB)

- Amply 15 → **16 kandidat**: baru **FA-AMP-17** `ValidationLogic.validateBorrow`
  (oracle-passthrough, Low) — konsekuensi 1i; `live-identical`, GUGUR
  wasit (by-design, sama seperti FA-AMP-14..16). 15 kandidat lama
  tidak berubah.
- RAAC tetap 8, Hyperbridge tetap 1 (FA-HYP-04 tx-origin by-design),
  Flow tetap 0. Test suite 82/82 PASS (58 + 24 baru).

## Item DITUNDA (bukan backlog sesi BB — dicatat di sini)

- Guard staleness di helper/modifier/callee (analisis antar-fungsi).
- Pembacaan harga event-only / view-only (bedakan dari valuasi).
- Rantai variabel assembly > 1 langkah di detektor 14.
