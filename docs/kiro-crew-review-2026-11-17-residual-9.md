# Review Kiro crew atas perbaikan residual (9) — sesi 12:38 WIB 17 Nov 2026

Pass: browser task 257f2257, 12:50–13:04 WIB, sesi baru "Audit Residual 9"
bf90cd6f, model **Claude Opus 5.5 eksplisit tanpa penolakan** (tanpa flag
MODEL_TIDAK_SESUAI). Login aktif tanpa sign-in ulang. Kredit: 156,5 →
**160,3/4.000 (delta 3,80; footer 3,80 cocok)**. Pengiriman pertama gagal
("Service is temporarily unavailable"), kedua berhasil.

## Cara Kiro menguji

Kiro menjalankan helper di Node (fa-review/harness.js — salinan kedua helper
+ call site persis; stand-in untuk occurrence scanner, read/write
classifier, extractFunctions, hasParamNamed, lineOffs) dan oracle
(fa-review/oracle.js — kompilasi solc 0.8.28 + telusur AST; verdict
diharapkan dari oracle, bukan pembacaan bahasa). Child selalu
`contract Child is Vault { function readFee() ... }`, Vault umum
`uint256 public fee` + `setFee`.

## Vonis Kiro: 22/41 kasus benar (53,7%), 19 salah; 6 fixture (a)–(f) lolos

F10/F11 bergantung pada bagian pipeline.js yang tidak dimiliki Kiro;
F12 hanya penalaran (reasoning only).

## Disposisi wasit (verifikasi ke pipeline ASLI via probe)

| Temuan | Klaim Kiro | Verdict wasit | Perbaikan |
|---|---|---|---|
| F1 uint24/int24/uint160/bytes20 | FALSE DROP, tipe tak dikenal | **TERBUKTI** | LOCAL_DECL_HEAD_SRC: ukuran int/uint penuh + bytes1-32 |
| F2 address payable | FALSE DROP | **TERBUKTI** | `address(?:\s+payable)?` |
| F3 mapping storage lokal | FALSE DROP | **TERBUKTI** | alternatif `mapping(...)\s+storage` |
| F4 tipe huruf-kecil | FALSE DROP | **TERBUKTI** (probe ulang huruf-kecil `info`; probe awal Kiro pakai `Info` kapital — lolos) | alternatif lowercase + location wajib |
| F5a `fee$` | FALSE KEEP | **TIDAK TERBUKTI** (pipeline asli benar via jalan lain: nama-dekl `fee$` terhitung baca) — diperbaiki juga agar benar via alasan yang tepat | batas `(?![\w$])` di localDeclRe |
| F5b `$fee` | FALSE DROP | **TERBUKTI** (bareRe `\b` cocok di dalam `$fee`) | bareRe + occRe pakai `(?<![\w$])...(?![\w$])` |
| F6 for-init | FALSE KEEP | **TERBUKTI** (limit terdokumentasi) | paren-case: cakupan berakhir di blok/pernyataan berikut |
| F7 try/catch | FALSE KEEP | **TERBUKTI dgn mekanisme berbeda**: verdict Kiro KEPT salah — pipeline asli DROPPED tapi lewat kemunculan NAMA deklarasi yang dihitung baca | paren-case + isLocalDeclName |
| F8 self-init | FALSE KEEP | **TERBUKTI** | awal bayangan = `;` penutup pernyataan |
| F9 dua fungsi sebaris | FALSE KEEP | **TERBUKTI** (akar: enclosingFunctionAt berbasis baris mengembalikan fungsi tetangga) | enclosingFunctionAtIdx/ModifierAtIdx berbasis char + fn.startIndex sebagai lantai |
| F10 param fungsi Yul | FALSE DROP | **TERBUKTI** | blok assembly dilewati kecuali `.slot`/`.offset` |
| F11 param modifier | FALSE DROP | **TERBUKTI** (extractFunctions memang tak memindai modifier) | modifier sebagai cakupan bayangan (param + lokal badan) |
| F12 filter baris | FALSE DROP (penalaran) | **TERBUKTI** (end-to-end: detektor tak menghasilkan kandidat sama sekali untuk var sebaris fungsi) | indeks CHAR ganti baris di extractFunctions/scanModifiers/findSpecialFnSpans + findDeadConfigVars + buildProjectIndex |

## Ditemukan wasit (di luar daftar Kiro)

- **Nama-deklarasi lokal dihitung sebagai baca**: `uint256 fee;`,
  `returns (uint256 fee)`, catch-param — namanya diikuti `;`/`)`/`,`
  sehingga classifyVarOccurrence mengira "read". Diperbaiki dengan
  `isLocalDeclName` (project-pass + detektor).
- **Detektor buta state var uint24** (STATE_TYPE_SRC tak lengkap):
  diperbaiki — STATE_TYPE_SRC diperlebar ke ukuran penuh + bytes1-32.
- **Detektor: lokal di badan modifier + param Yul** menutupi baca:
  diperbaiki (modifier ikut cakupan shadowRanges; assembly dilewati).
- **F12 juga merusak detektor** (findDeadConfigVars): diperbaiki
  bersamaan (eksklusi char-based).

## Bentuk edge yang benar menurut Kiro (bukan temuan)

Unchecked blocks, braced for-bodies, sibling same-name blocks (kedua
urutan), for-init yang hanya dibaca di bagiannya, array locals,
contract-type locals, `Lib.Info memory fee`, nama tipe mengandung nama
variabel (`Fee fee`, `IFee fee`), named return variables, lokal tak
diinisialisasi diikuti write lalu read. `if (x) uint256 fee = 1;` tak
dapat dikompilasi — dari limit lama hanya for-init yang dapat terjadi,
kini tertangani (F6).

## Perbaikan yang TIDAK diambil mentah dari Kiro

- Regex longgar Kiro `u?int(?:[1-9]\d{0,2})?` (menerima uint7/uint999)
  diganti enumerasi ukuran valid kelipatan 8.
- Saran "jangan tambah bentuk ident huruf-kecil telanjang" dipatuhi:
  lowercase WAJIB disertai location keyword.
- F6/F7 tidak dibiarkan sebagai "limit terdokumentasi" — paren-case
  menyelesaikannya dengan benar.

## Hasil

**Test 425/425 PASS** (400 lama + 25 baru seksi 36). Hunting re-run
pasca-R9.1 IDENTIK: Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2,
Flow 0; recall vs Kiro AMP tetap 4/7. Commit lokal `b7f1f9d`
(sebelumnya `ec23da9` untuk perbaikan R9 awal).

## Batas tersisa

- Mapping bersarang >1 level dalam pola tipe lokal tak dikenali
  (konservatif = baca dihitung, kandidat dibuang).
- `(9)` kini SELESAI. Residual terbuka: (3) heuristik
  abstract+internal, (4) risiko overfit kasus Kiro, (j) namespace
  `import * as NS` lalu `NS.K` tak ditangani (FN diketahui).
