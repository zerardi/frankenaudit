# Review Kiro crew atas detektor ke-22 jit-reward-accrual-sandwich (D22) — kalibrasi wasit R22, sesi #36, 19 Nov 2026

- **Sesi Kiro:** BARU "Audit D22 JIT Reward Accrual", ID f4578d1e-60ef-470d-973e-8eb31e3ae8ac
  (https://app.kiro.dev/session/f4578d1e-60ef-470d-973e-8eb31e3ae8ac)
- **Model:** Claude Opus 5.5 dipilih eksplisit di UI sebelum kirim pesan (sebelumnya Sonnet 5.5);
  Kiro menjawab "Saya Claude Opus 5.5. Konteks sesi melaporkan model aktif Claude Opus 5.5" —
  tanpa flag MODEL_TIDAK_SESUAI.
- **Browser task:** 8dbcefa6-9afb-5dac-857c-bf1ae86e56c5, 12:54–13:08 WIB (13 mnt).
  Login: sesi Google Arslan sudah hidup, halaman sign-in tidak pernah muncul, tanpa
  password/2FA/konfirmasi HP.
- **Dashboard:** sebelum 319,43/4.000 → sesudah **325,12/4.000** (delta **5,69**, footer sesi
  5,69 — cocok persis; sisa 3.674,88, 44 hari → tempo ≈44/hari sejak 12 Nov — di bawah
  garis 82/hari).
- **Harness:** Kiro membangun sendiri di /projects/sandbox/d22-harness/ (detector.js, cases.js,
  run.js; `node run.js`), dari tempelan verbatim blok D22 + harness K1–K15 — repo frankenaudit
  TIDAK ada di sandbox, tidak ada kode repo diubah. 15 kasus K1–K15 + 28 kasus adversarial
  buatan Kiro (A1–A28). Stub Kiro: stripComments (panjang/newline dipertahankan, string tidak
  disentuh), extractFunctions (hanya `function NAME(`/`constructor(` — receive/fallback/modifier
  TIDAK diekstrak), scanStateVarDecls (statement `;` kedalaman 1, constant = ada kata kunci
  constant, immutable TIDAK dihitung constant), paramNamesOf (nama dari kurung pertama),
  normalizeCandidate = identitas. Wasit mencatat keterbatasan stub ini di disposisi tiap temuan.

## Vonis

- **D22: NEEDS WORK** — F1–F18 (di bawah). Prioritas Kiro: F1 dan F2 dulu, lalu F15/F16,
  lalu F8–F11; F4 dan F17 BUTUH-VERIFIKASI terhadap helper asli.

## Disposisi wasit per temuan (semua diverifikasi probe ke kode ASLI)

Probe wasit: /tmp/probe-d22-r22.js — 28 probe, pra-kalibrasi 1/28 PASS, pasca-kalibrasi
**28/28 PASS**; suite penuh 721 → **746/746** (Seksi 56b, 25 tes baru).

### F1 — TERBUKTI, DIPERBAIKI (R22: denominator fee boleh literal)
Regex fee mewajibkan pembagi identifier, sehingga `(total * unbondingFee) / 100000`
persis gaya YbEth (di mana pembagi literal dipakai di varian K8b/K15b) terbaca "absent" →
fee nonzero → Medium, fee tak terdeklarasi → Medium, evidence K2 salah.
Perbaikan: denominator = identifier ATAU literal numerik (`100000`, `1e5`, `100_000`) ATAU
ekspresi dalam paren. Tes 56b-1.
**Koreksi wasit atas framing Kiro:** klaim "pada kode YbEth asli logika severity sama
sekali tidak berjalan" GUGUR — YbEth verbatim memakai pembagi identifier
(`UNBONDING_FEE_DENOMINATOR`) sehingga regex lama SUDAH cocok: test 56-2 (single-file → Low,
fee "unknown") dan 56-2b (project-mode → Medium via projectStateVarInits) membuktikan jalur
fee + projectInits bekerja di kode asli. Yang nyata adalah celah denominator literal-nya.

### F2 — TERBUKTI, DIPERBAIKI (R22: nama fee bare/kapital)
Pola nama mewajibkan ≥1 karakter sebelum "fee" dan huruf kecil "ee", sehingga `fee`,
`feeBps`, `FEE`, `UNBOND_FEE` tidak tertangkap (A4, A5). Perbaikan: feeVar =
`(?:[A-Za-z_][A-Za-z0-9_$]*[Ff][Ee][Ee][A-Za-z0-9_$]*|[Ff][Ee][Ee][A-Za-z0-9_$]*)`.
Tes 56b-2/56b-3.
**DITOLAK sebagian:** `commission`/`tax` sebagai nama fee TIDAK diadopsi — terlalu luas
(`tax` bertabrakan dengan banyak konteks non-fee); dicatat sebagai batas v2.

### F3 — TERBUKTI, DIPERBAIKI (R22: operand terbalik)
Urutan operand terbalik `(unbondingFee * total) / D` tidak cocok (A6). Perbaikan: pola fee
memecah numerator pada `*` dan memeriksa feeVar di operand mana pun. Tes 56b-4.

### F4 — TERBUKTI, DIPERBAIKI (R22: constant ikut dinilai)
Fee constant nonzero dilewati `continue` lalu jatuh ke "absent" → Medium (A7).
Verifikasi wasit: perilaku scanStateVarDecls asli memang mengisi `constant=true`, jadi klaim
berdiri di kode asli (bukan artefak stub). Perbaikan: constant TIDAK lagi dilewati — nilai
init-nya dipakai (nonzero → Low, nol → Medium). Tes 56b-5.

### F5 — TERBUKTI, DIPERBAIKI (R22: assignment ctor/initialize menang)
Fee yang diset di constructor/initialize()/setter dibaca "default-0" → Medium (A8);
relevan karena YbEth upgradeable. Perbaikan (sempit): assignment LITERAL di constructor /
fungsi `initialize*` meng-override initializer — literal nonzero → nonzero, literal 0 →
zero, RHS non-literal (param) → unknown. Assignment di setter biasa TIDAK dipakai (nilai
live admin-controlled — ditutup cek live di toVerify); YbEth tidak punya assignment
ctor/init ke unbondingFee, jadi 56-2b tetap Medium. Tes 56b-6.

### F6 — TERBUKTI, DIPERBAIKI (R22: skor fee per fungsi)
Vonis fee file-wide, var pertama urutan sumber menentukan; fee tak terkait (mintFee)
bisa menutupi unbondingFee = 500 (A10). Perbaikan: tiap fee var diskoring — dipakai di
fungsi exit (+2), dipakai di fungsi yang menyebut `exchangeRate` (+1), sisanya 0; skor
tertinggi menang, seri → urutan sumber. Tes 56b-7.

### F7 — TERBUKTI, DIPERBAIKI (R22: zero-init diperluas)
`d22IsZeroInit` terlalu sempit — `0x00`, `0 ether`, `0e18` dibaca nonzero → Low (A28).
Perbaikan: normalisasi (buang `_`/spasi) + pola `0x0+ | 0(.0+)?(eN)?( ether|wei|gwei|…)`.
Dipakai juga di `initAssignment`. Tes 56b-8.

### F8 — TERBUKTI, DIPERBAIKI (R22: formula rate ditulis ulang)
Formula rate tidak menangkap paren bersarang (A1), pembagi dalam paren (A2), mulDiv (A27),
atau pembagi `_totalSupply`/`getTotalShares()` (A24). Perbaikan: rateFormula ditulis ulang —
cari situs pembagian `/ TOTAL`, jalan mundur menyeimbangkan paren untuk mengambil numerator
(precedence-aware untuk bentuk datar), cabang mulDiv (`POOL.mulDiv(F, TOTAL)` /
`Math.mulDiv(POOL, F, TOTAL)`), pembagi diperluas (`_totalSupply`, `_totalShares`,
`_?getTotalShares()`, `_?getTotalSupply()`). Tes 56b-9/56b-10/56b-11/56b-12.
**F8-A3 GUGUR (artefak stub):** alias lokal `supply = totalSupply()` SUDAH ditangani regex
asli — probe pra-kalibrasi PASS. Klaim Kiro berasal dari rekonstruksi harness-nya, bukan
dari kode asli.

### F9 — TERBUKTI, DIPERBAIKI (R22: mint/burn gaya Lido)
Mint/burn hanya mengenal `_mint(`/`.mint(`/`_burn(`/`.burn(` — `_mintShares` gaya Lido
menghilangkan kaki stake (A24). Perbaikan: `\b_?mint[A-Za-z0-9_$]*\s*\(` +
`\.mint[A-Za-z0-9_$]*\s*\(` (dan burn analog). Tes 56b-12.

### F10 — TERBUKTI, DIPERBAIKI (R22: accrual `POOL = POOL + X` + alias lokal)
Accrual hanya mengenal `POOL += param|msg.value` — `POOL = POOL + amount` (A12) dan alias
lokal `net = amount - amount/10; POOL += net` (A13) lolos. Perbaikan: terima ketiga bentuk
(`+=`, `= POOL + X`, `= X + POOL`) + himpunan param-derived (fixpoint ≤3 iterasi, termasuk
turunan dari `msg.value`; var pool sendiri dikeluarkan dari himpunan). Tes 56b-13/56b-14.

### F11 — TERBUKTI, DIPERBAIKI (R22: kunci rate digeneralisasi)
Penguncian hanya dikenali lewat nama `exchangeRate` atau rateVar yang dikalikan — jumlah
terkunci yang disimpan sebagai `amountOwed` (pola antrean withdrawal, A16) tidak terdeteksi.
Perbaikan: kunci = (i) field struct/member APA PUN (`field: rateVar` / `.field = ...rateVar`,
diakhiri `,`/`}` agar ternary tidak ikut), (ii) `* rateVar` (lama), (iii) rateVar sebagai
nilai payout (`call{value: rateVar}` / `transfer(` / `send(`). Tes 56b-15.
**Catatan cakupan Kiro (DITANGANI):** varian stake → accrual → withdraw instan (K5, exit
tanpa kunci rate) kini TERTANGKAP lewat cabang (iii) — redeem langsung yang menghitung rate
dan membayarnya di fungsi yang sama adalah pola JIT yang sama dengan langkah lebih sedikit.
Tes 56b-25; test 56-5 (rate dihitung tapi tidak disimpan/dipakai sama sekali) tetap 0.

### F12 — TERBUKTI, DIPERBAIKI (R22: alias lokal pool + saring state var sejati)
`D22_POOL_NAME_RE` menerima variabel lokal sebagai pool, lalu kaki dicari dengan nama lokal
itu padahal state var-nya bernama lain (A23). Perbaikan dua lapis: (1) `resolvePool` —
bila identifier pool adalah lokal/param, selesaikan aliasnya (`lokal = STATEVAR;`, nama
lokal boleh netral); tanpa alias → situs dilewati. (2) **Temuan wasit saat debugging:**
`scanStateVarDecls` (regex tanpa filter kedalaman) ikut membaca lokal fungsi sebagai state
var — lokal `uint256 totalPooledEth = totalStaked;` membuat `stateVarNames` mengandung
`totalPooledEth` sehingga cabang alias tidak pernah jalan (probe V1/V2 gagal, V3 lolos).
Perbaikan: helper baru `d22TrueStateDecls` (saring deklarasi di luar semua badan fungsi,
dipakai `stateVarNames` + `d22StateVarInitMap` — termasuk project map). `scanStateVarDecls`
sendiri TIDAK diubah (dipakai banyak detektor; perilaku lokal-nya di luar lingkup D22).
Efek samping terverifikasi: lokal `unbondingFee = 0` di dalam fungsi kini TIDAK lagi
terbaca sebagai state var (fee → unknown → Low, sesuai semantik). Tes 56b-16.

### F13 — TERBUKTI, DIPERBAIKI (R22: emit bukan gate + sufiks berbatas)
`hasHoldingGate` menganggap pernyataan apa pun yang memuat `block.timestamp` + nama holding
sebagai gate, termasuk emit (A20 — FN); prefiks tanpa `\b` di akhir membuat `stakeTimeout`
ikut terhitung. Perbaikan: statement emit dilewati — dicek lewat `(^|{) emit` karena
statement pertama `fn.body` memuat signature + `{` (perbaikan pertama `startsWith("emit")`
gagal di probe — dideteksi wasit, bukan Kiro); nama holding = nama terurut terpanjang dulu +
sufiks opsional `{At,Time,Timestamp,Date}` + `\b`. Tes 56b-17/56b-18.

### F14 — TERBUKTI, DIPERBAIKI (R22: nama holding + gate modifier)
Gate dengan nama di luar daftar (`depositedAt`, A18) atau gate di modifier/helper (A19)
tidak terlihat. Perbaikan: daftar nama + `depositedAt`, `depositAt`, `stakeAt`; gate di
badan modifier yang menempel pada fungsi exit ikut menggugur (helper `modifierNamesOf` +
`scanModifiers` — `scanModifiers` kini ikut mengembalikan `name`, tambahan aditif).
Gate di helper yang DIPANGGIL exit (bukan modifier) tetap di luar cakupan — batas v2.
Tes 56b-19/56b-20.

### F15 — TERBUKTI, DIPERBAIKI (R22: kaki satu kontrak)
Tidak ada pemisahan per contract — tiga kaki dari kontrak berbeda dalam satu file digabung
(A22). Perbaikan: `contractOf` via `contractSpans` (interface dikecualikan); stake +
accrual harus di kontrak yang sama dengan exit; dedup per kontrak+pool; file tanpa
kontrak / fungsi bebas → fallback file-wide lama. Tes 56b-21.

### F16 — TERBUKTI, DIPERBAIKI (R22: mint/burn tak langsung via helper)
Fungsi payable yang mint lewat helper internal (`_issueShares`) dianggap kaki accrual
(A26). Perbaikan: himpunan mint-helper/burn-helper per kontrak (fungsi yang badannya
mengandung panggilan mint/burn); `hasMintAny`/`hasBurnAny` = langsung ATAU via helper —
accrual menolak mint tak langsung, stake MENERIMA mint tak langsung (jadi `submit()`
terklasifikasi benar sebagai stake, bukan accrual). Tes 56b-22.

### F17 — TERBUKTI, DIPERBAIKI (R22: receive()/fallback() sbg accrual)
Accrual lewat `receive()`/`fallback()` (A25) — Kiro menandai BUTUH-VERIFIKASI. Verifikasi
wasit: `extractFunctions` memang TIDAK mengekstrak keduanya (tanpa kata kunci `function`) —
klaim berdiri di kode asli. Perbaikan: helper baru `d22SpecialFns` membangun pseudo-fn
(`receive() external payable` + badan via `blockEndIndex`) yang ikut dicari kakinya.
Tes 56b-23.

### F18 — SEBAGIAN DITERIMA (R22: F18b diperbaiki; F18a ditolak)
- (a) **DITOLAK:** "lineOf didefinisikan tapi tidak dipakai" — SALAH di kode asli: `lineOf`
  DIPAKAI di hypothesis/evidence (`baris N`). Location tanpa nomor baris adalah konvensi
  proyek (semua detektor begitu), bukan bug D22.
- (b) **TERBUKTI, DIPERBAIKI:** pengecualian nama file `(Mock|Harness)…\.sol` case-insensitive
  — file produksi `harnessRouter.sol` (lowercase) ikut terlewat. Perbaikan: bagian
  Mock|Harness case-sensitive; direktori test/mocks tetap case-insensitive. `HarnessRouter.sol`
  (kapital-H) TETAP dilewati — itu konvensi harness (mis. harness Certora OZ), bukan
  produksi. Tes 56b-24. Catatan: D21 memakai guard identik (belum diubah — residual,
  di luar lingkup kalibrasi D22).

## Hunting ulang pasca-kalibrasi (7 permukaan, 19 Nov 2026)

Identik dengan pra-kalibrasi — 0 kandidat baru, 0 D22 baru di luar Veno:

| Permukaan | File | Kandidat | D22 |
|---|---|---|---|
| Fulcrom | 15 | 15 | 0 |
| Amply | 18 | 18 | 0 |
| RAAC | 14 | 14 | 0 |
| Hyperbridge | 7 | 7 | 0 |
| Flow | 0 | 0 | 0 |
| Veno (Ethereum) | 262 | 7 | 1 (FA-005, konfirmasi VENO-C2) |
| Veno zkEVM | 10 | 0 | 0 |

FA-005 tetap: `ybETH_IMPL/src_YbEth.sol` @ `accrueReward`, Medium — konfirmasi pipeline
atas VENO-C2 (bukan kandidat submit baru; draft BB sudah ada, PoC-verified, menunggu
serang-dulu sesi BB sore 19 Nov).

## Ringkasan perubahan (R22)

- `app/pipeline.js`: `scanModifiers` +nama; D22 — header v2, `d22IsZeroInit` (F7),
  `d22SpecialFns` (F17), `d22TrueStateDecls` (F12), `rateFormula` tulis ulang (F8/F12),
  `hasHoldingGate` + `modifierNamesOf` (F13/F14), `exitLeg` kunci digeneralisasi (F11),
  `stakeLeg`/`accrualLeg` (F9/F10/F16), `feeVerdict` tulis ulang (F1–F6), loop utama
  per-kontrak (F15), guard file case-sensitive (F18b).
- `tests/run-m2-tests.js`: Seksi 56b, 25 tes baru → **746/746**.
- Ground truth fixture trap-vault tetap 26 kandidat (kalibrasi memperluas recall D22,
  bukan menambah detektor); D22 tetap 1 dari 22 detektor.
- Residual v2: nama fee `commission`/`tax` tidak diadopsi; gate di helper yang dipanggil
  exit tidak dilacak; fee var lokal di dalam fungsi tidak diselesaikan nilainya
  (unknown → Low); guard Mock|Harness di D21 masih case-insensitive; rate dua langkah
  via helper convertToShare tidak dilacak.
