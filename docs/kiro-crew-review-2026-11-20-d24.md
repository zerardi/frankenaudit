# Review Kiro crew atas detektor ke-24 + kalibrasi wasit R24

Tanggal: 2026-11-20 (sesi Frankenstein #42, 12:38 WIB).
Detektor: `variant-branch-no-payload-consume` (kelas L-1 Hyperbridge
Codec.DecodeHeader — Info/design, BUKAN kandidat submit).
Pass Kiro: sesi BARU 40d58610-080d-44ca-86cf-44abc0f0df6f,
https://app.kiro.dev/session/40d58610-080d-44ca-86cf-44abc0f0df6f,
model Claude Opus 5.5 disetel eksplisit — TANPA penolakan, TANPA flag
MODEL_TIDAK_SESUAI. Footer sesi 3,52 kredit (est., belum posting saat
cek); dashboard 348,11/4.000 sebelum pass. Login Google SSO tanpa
hambatan (browser task 8f507e02, 12:57–13:05 WIB, 3m 36s).

## Vonis Kiro: NEEDS WORK (F1–F23)

Metode Kiro: detektor dijalankan di Node dengan helper yang
diimplementasi ulang dari deskripsi (stripComments, extractFunctions,
d24ParseIfChain, d24ParenEnd, blockEndIndex) — BUKAN kode proyek asli,
jadi sebagian vonis bisa jadi artefak re-implementasi. Hasil per
kasus: 36 kasus, 9 benar / 15 FP / 11 FN / 1 ambigu.

## Verifikasi wasit (probe kode ASLI, /tmp/probe-d24-r24.js)

Pra-kalibrasi: 16 dari 20 probe BERBEDA dari harapan wasit — klaim
Kiro sebagian besar terreproduksi di kode asli. Pasca-kalibrasi R24:
**20/20 PASS**; suite **796 → 823/823** (Seksi 58b, 27 tes baru —
F1–F23 dikunci regresi, termasuk bentuk nama-konstanta F13/F14 yang
di probe hanya berupa literal numerik).

### DITERIMA + DIPERBAIKI (R24)

- **F1 (cast di tag-read)** — TERBUKTI. `uint8(readByte(slice))`
  membuat cursor terbaca `readByte`, bukan `slice` (FN). Perbaikan:
  aturan panggilan terdalam — lewati panggilan yang argumen pertamanya
  sendiri berupa panggilan; ambil argumen identifier polos terakhir.
- **F1b (nested member call)** — TERBUKTI (bentuk sama, sudah OK di
  v1, dikunci tes 58b-2). `uint8(slice.data[slice.offset])` → cursor
  `slice` via aturan indeks.
- **F2 (cursor indeks)** — TERBUKTI. `uint8(enc[offset])` membuat
  cursor `enc`, bukan `offset` (FN). Perbaikan: aturan indeks —
  `X[plainIdent]` → identifier di dalam bracket adalah cursor.
- **F11 (sibling F2, cursor indeks di cabang konsumsi)** — TERBUKTI.
  Diperbaiki oleh aturan indeks yang sama (F2/F11).
- **F3 (cast di kondisi)** — TERBUKTI. `uint8(kind) == 0` tidak
  dikenali sebagai tag `kind` (FN). Perbaikan: tag var kini dari
  irisan identifier SEMUA kondisi rantai (minus nama tipe), bukan
  regex `TAG ==` di kondisi pertama.
- **F4 (Yoda)** — TERBUKTI. `OTHER == kind` tidak dikenali (FN).
  Diperbaiki oleh irisan identifier yang sama.
- **F5 (state-based, no-arg)** — TERBUKTI. `readByte()` /
  `decodeItem()` tanpa argumen membuat cursor null → v1 menolak
  seluruh rantai (FN). Perbaikan: cursor null = mode state-based —
  konsumsi dinilai dari kata kerja saja (panggilan decode*/read*/
  apa pun kecuali `abi.*`).
- **F6 (assembly)** — TERBUKTI. Blok `assembly` yang memajukan
  offset dihitung tidak-konsumsi (FP). Perbaikan: blok `assembly`
  yang menyebut cursor dihitung konsumsi (konservatif).
- **F7 (`abi.decode`)** — TERBUKTI. `abi.decode(...)` dihitung
  konsumsi (FN — `abi.decode` tidak memajukan offset). Perbaikan:
  panggilan `abi.*` dikecualikan dari konsumsi di semua jalur.
- **F8 (helper tak dikenal)** — TERBUKTI. `handleOther(slice)`
  dihitung tidak-konsumsi (FP — helper yang menerima cursor bisa
  memajukannya, struct memory by-reference). Perbaikan: panggilan
  APA PUN (kecuali `abi.*` + murni/view + `emit` + kata kunci)
  yang argumennya menyebut cursor/alias ATAU receiver-nya cursor
  dihitung konsumsi.
- **F9 (verb di luar daftar)** — TERBUKTI. `takeBytes` dll. tidak
  ada di daftar verb (FP). Diperbaiki oleh aturan (c) yang sama
  dengan F8 — daftar verb kini hanya dipakai mode state-based.
- **F10a (perbandingan offset)** — TERBUKTI. `slice.offset == ...`
  dihitung advance (FN). Perbaikan: advance offset kini HANYA
  `+=` / `++` / `= ...offset...` (RHS menyebut offset yang sama);
  `==` dan reset `= 0` tidak dihitung; guard `(?<!\.)` mencegah
  `slice.offset` cocok untuk cursor indeks bernama `offset`.
- **F10b (reset offset)** — TERBUKTI. `slice.offset = 0` dihitung
  advance (FN). Diperbaiki oleh aturan (a) yang sama.
- **F13 (hint substring)** — TERBUKTI. `DATA_CLEARED`,
  `WITHDRAW_ALL`, `EXTRACTED`, `ANOTHER`, `MOTHER`,
  `METADATA_HASH`, `BYTES32_ROOT` semuanya cocok substring
  `data`/`bytes`/`extra` (FP). Perbaikan: hint pindah ke operand
  konstanta SAJA (sisi `==` tanpa tag var, identifier pertama
  incl. dots) + pencocokan whole-token — strong {other, unknown,
  custom, generic, raw, opaque, extra, extension, arbitrary,
  payload}; `data`/`bytes` hanya bila token TERAKHIR nama.
  Bentuk literal numerik F13a sudah 0 di v1 (dikunci tes).
- **F14 (predikat allowOther)** — TERBUKTI. `kind == PING &&
  !cfg.allowOther` cocok karena teks kondisi mengandung
  `allowOther` (FP). Diperbaiki oleh operand-konstanta yang sama
  (PING → tanpa hint). Bentuk numerik sudah 0 di v1.
- **F15 (tag var bernama payload)** — TERBUKTI. Tag var bernama
  `payloadType` memicu hint `payload` (FP). Diperbaiki: yang diuji
  hanya operand konstanta, nama tag var tidak pernah diuji.
- **F16 (bare `else`)** — TERBUKTI. Cabang `else` polos tidak
  pernah di-flag (FN). Perbaikan: `else` flag-only dan
  non-terminating di-flag sebagai Info (condLabel catch-all).
- **F17 (alias cursor)** — TERBUKTI. `s = slice` lalu
  `readBytes(s)` tidak dikenali (FP). Perbaikan: kumpulkan alias
  `ALIAS = cursor;` sebelum rantai (2 putaran untuk rantai alias);
  konsumsi dihitung atas cursor + alias.
- **F18a/b (terminator)** — TERBUKTI. Cabang `revert` / `break`
  di-flag padahal tidak mungkin desync (FP). Perbaikan: cek
  terminator tingkat atas — strip blok `{...}` bersarang
  (string-aware), pecah per `;`, lewati cabang bila ada statement
  yang diawali `revert`/`break`/`return`. `revert` kondisional
  (`if (x) revert ...;`) TIDAK dihitung terminator. Bentuk
  `return` dikunci tes 58b-20.
- **F19 (do-while + braceless)** — TERBUKTI. `do { ... } while`
  dan loop tanpa kurawal dilewati (FN). Perbaikan: `d24FindLoopBodies`
  mencakup do-while ber-kurawal + for/while braceless yang badannya
  satu rantai if (gerbang tag dibatasi penugasan inline di kondisi
  pertama — batas didokumentasikan).
- **F20 (rantai bersarang)** — TERBUKTI. Rantai if di dalam badan
  cabang tidak dipindai (FN). Perbaikan: `d24ParseIfChain`
  mengembalikan posisi `else if` lanjutan; scanner memakai skip-set
  (bukan `ifRe.lastIndex = chain.end`), jadi rantai dalam
  dipindai; dikunci tes 58b-23 (tepat 1).
- **F21 (dedupe loop bersarang)** — TERBUKTI. Rantai yang sama
  dilaporkan 2× (loop luar + loop dalam). Perbaikan: kunci dedupe
  posisi absolut rantai di badan fungsi
  (`fn.name:loopBodyStart + im.index`); dikunci tes 58b-24.
- **F22 (tag = parameter / dibaca sekali)** — TERBUKTI. Tag yang
  merupakan parameter fungsi / dibaca sekali sebelum loop di-flag
  (FP — bukan dispatch per-item). Perbaikan: gerbang penugasan —
  tag harus punya penugasan di badan loop sebelum rantai, ATAU
  inline di kondisi pertama; dikunci tes 58b-25/26.
- **F23 (severity)** — TERBUKTI. Default Low terlalu tinggi untuk
  heuristik nama saja (kasus rujukan sendiri Info/design).
  Perbaikan: severity default **Low → Info** untuk semua kandidat
  D24 (pipeline.js, mappedAreas, trap-vault.analysis.json, tes
  58-1/58-2/58b-27).

### DITOLAK wasit / diterima sebagai batas

- **F12 (`Kind.A` / `Kind.B`, tanpa kata hint)** — DITERIMA SEBAGAI
  BATAS cakupan nama-only, tanpa perubahan kode (dikunci tes 58b-13
  = 0). Bila upstream memakai enum tanpa kata opaque, detektor
  butuh sinyal lain (tipe payload di wire format) — di luar pola
  ini.
- **F13a / F14 bentuk literal numerik** — sudah 0 di v1 (bukan
  temuan kalibrasi); bentuk nama-konstanta yang dikunci di 58b-14/15.

## Hasil hunting pasca-R24

8 permukaan, IDENTIK dengan pra-kalibrasi kecuali severity FA-005:
Fulcrom 15, Amply 18, RAAC 14, Hyperbridge **8** (FA-007 D24 **Info**
@ DecodeHeader baris 84 — konfirmasi pipeline atas L-1), Flow 0,
Veno 8 (FA-004 D23 = konfirmasi VENO-C1, FA-005 D22 = konfirmasi
VENO-C2), Veno zkEVM 0, LCROBridge 0. D24 tepat 1 hit di 8
permukaan, 0 FP korpus nyata. **0 kandidat submit baru.**

## Batas diketahui (baru)

- Switch-statement belum ditangani.
- Tag berupa literal numerik tanpa nama konstanta tidak ter-flag.
- Loop tanpa kurawal hanya bila badannya satu rantai if dengan
  penugasan tag inline di kondisi pertama.
- Format wire varian harus dikonfirmasi dari spec upstream
  (toVerify butir 1); severity naik ke Low hanya bila input stream
  terbukti bisa dikendalikan penyerang.
- `Kind.A`/`Kind.B` tanpa kata hint = FN by-design (F12).

## Catatan alat — koreksi aturan backslash (sesi #42)

Aturan transport yang dicatat sesi lalu ("ketik `\\` → file dapat
`\`") TERNYATA SALAH HITUNG — verifikasi sesi ini via `od -c`:
yang diketik mendarat VERBATIM di file (ketik 2 backslash → file 2).
Akibatnya edit kalibrasi R24 sempat menggandakan semua backslash
regex (39 baris) + menemukan 2 bug laten v1 (`/\w/` tertulis
`/\\w/` di `d24ParseIfChain` — baris `if`/`else` boundary check,
tidak pernah tertangkap suite karena input tanpa backslash lolos
saja). Perbaikan: skrip Python halving per-baris (ganti pasangan
`\\` → `\`, diverifikasi hitungan genap sebelum write) +
`node --check` + probe + suite hijau. Pelajaran: JANGAN percaya
tampilan output untuk hitungan backslash — verifikasi SELALU via
`od -c` / hitungan Python `chr(92)`, dan JANGAN andalkan ringkasan
"terverifikasi" tanpa byte mentah.
