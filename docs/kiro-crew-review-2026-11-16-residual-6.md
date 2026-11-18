# Review Kiro crew atas kalibrasi R6 (residual import transitif) — 16 Nov 2026

Sesi Kiro: "Audit Solidity Import Closure Calibration R6", sesi baru
1de01aca-6f81-4233-b679-fa448a7245cf, model **Claude Opus 5.5** (disetel
eksplisit, tanpa penolakan; bukan sesi lama 9bf915c9). Browser task
347d2c12, 20:48–20:57 WIB. Biaya: **3,40 kredit** (footer = dashboard
141,15 → 144,55; cocok persis). 1 pesan review + 1 jawaban, 3m 40d.

## Kode yang di-review (verbatim)

`buildImportClosure` (BFS atas import langsung) + Hook 1 (cakupan
P9b-3: file pendefinisi boleh di closure transitif) + Hook 2 (validasi
alias P7-6: alias sah bila path menunjuk file pendefinisi ATAU file
yang mengimpornya transitif) + `resolveImportPath`. Fixture R6a–R6e
(seksi 27) ditempel verbatim. Kiro membangun harness Node sendiri
(r6-harness/harness.js + cases.js di sandbox sesinya) dengan stub
minimal di sekitar kode R6.

## Vonis Kiro: R6 BELUM BERTAHAN

Fixture R6a–R6e tereproduksi PASS semua. Closure-nya sendiri benar
(siklus, rantai 5 hop, duplikat, self-import aman; rantai 3.000 file
549 ms). Temuan per kasus:

| Kasus | Vonis Kiro | Verifikasi wasit (kode ASLI) |
|---|---|---|
| 1. Siklus import | PASS | — (diadopsi) |
| 2a. Basename kembar, relatif | PASS | — |
| 2b. Basename kembar, gaya Foundry non-relatif | FAIL (baca terlewat, urutan file) | **TERBUKTI** (probe W2b): `import "src/Child.sol"` dari src/ resolve jadi `src/src/Child.sol`, fallback basename ambil file pertama → salah file |
| 3a. Remap "@" via closure | FAIL, **BARU dari R6** | **TERBUKTI** (probe W3a): `"@app/Child.sol"` → null dari resolver tapi lolos fallback basename → closure berisi Child.sol → false drop |
| 3b. Remap "@", Hook 2 tak konsisten | FAIL | **TERBUKTI** (mekanisme): closure menerima via basename, Hook 2 menolak karena resolved=null |
| 4. Namespace NS.Child | PASS (stub) | **SUDAH BENAR** di kode asli (typedIdRe mengizinkan prefix satu segmen; probe W4 HILANG) |
| 5a/5b. Shadowing lokal | FAIL (pre-R6) | **TERBUKTI** (probe W5b): Reader mendefinisikan `Child` sendiri (bukan turunan) + named import `{Mid}` → `c.fee()` dianggap bukti |
| 6a. Alias ke file salah | FAIL (pre-R6) | **ARTEFAK STUB**: typeFiles kode asli hanya berisi definisi terverifikasi — alias ditolak (probe W6a TETAP) |
| 6b. Alias via perantara palsu | FAIL, **BARU dari R6** | **ARTEFAK STUB**: mekanisme yang sama — probe W6b TETAP di kode asli |
| 7. Named import di Mid | PASS | — |
| 8. Cast `Child(addr).fee()` | PASS (stub) | **SUDAH BENAR** di kode asli (probe W8 HILANG) |
| 9. Rantai 5 hop | PASS | — |
| 10. Self-import/duplikat | PASS | — |
| 11a/11b. Alias berantai (K via Mid) | FAIL (baca terlewat) | **DIKONFIRMASI sebagai batas**: butuh peta alias per file yang disebar bersama closure — TIDAK dikerjakan sesi ini (residual baru (10)) |
| 11c. Alias path non-relatif | FAIL | **TERBUKTI** (probe W11c): Hook 2 memakai resolved mentah `test/src/Mid.sol` yang tak ada di indeks |
| 11d. String berisi teks import | RISIKO | **TERBUKTI** (probe W11d, kutip tunggal): tepi palsu Doc→Child → false drop |
| 11e. Beda huruf besar-kecil path | RINGAN | Tidak dikerjakan (sistem file case-sensitive; konservatif = TETAP) |
| 11f. Performa | OK | — |

Penyimpangan penempelan (dilaporkan browser): pada fixture R6c tertulis
koreksi inline (`import "./Mid.sol"` — maaf, `import "./Mid2.sol"`);
Kiro menafsirkan dengan benar sebagai Mid2.sol; hasil R6c tetap KEEP.

Batasan harness (diakui Kiro): findCrossFileReads, deteksi baca, dan
defsByType adalah stub buatannya (per nama, bukan per file); clean
stub hanya membuang komentar (string tetap ada) — jadi kasus 4 dan 8
lolos di stub tapi hasilnya di kode asli bergantung regex yang tidak
ia miliki. Wasit memverifikasi keduanya langsung ke kode asli (PASS).

## Kalibrasi lanjutan wasit (R6.1) — DITERAPKAN sesi ini

1. **`resolveImportTarget(fromName, importPath, byName, byBase)` baru**
   (dipakai closure + Hook 2): `"@..."` → null TANPA fallback basename
   (W3a); path non-relatif dicoba dulu sebagai path dari root korpus
   (semantik base path solc / gaya Foundry — W2b/11c); import relatif
   (`./`, `../`) TIDAK dapat fallback basename — path hasil resolve
   adalah lokasi eksplisit penulis (P7-6: `../legacy/Vault.sol` tetap
   ditolak); fallback basename hanya bila basename UNIK di korpus.
2. **`scanImports(src)` baru**: scanner yang melacak keadaan string
   (kutip ganda/tunggal + escape) dan hanya mengenali kata `import`
   di luar string — menggantikan regex mentah di closure,
   importedBasenames, dan loop alias (W11d). Pelajaran implementasi:
   mem-mask SEMUA string literal justru membunuh import asli (path
   import ITU string) — percobaan pertama itu menggagalkan 12 tes
   sebelum diganti scanner ini.
3. **Kunci legitimasi `legitKeys` (`file::nama`)**: definisi tipe yang
   terverifikasi sebagai anggota lineage pemilik (pemilik, turunan,
   interface getter, leluhur getter). Di loop per-file, nama tipe yang
   didefinisikan lokal oleh kontrak BUKAN anggota dikeluarkan dari
   `scopedTypeNames` (W5b). I+nama: legitimate bila mendeklarasi
   getter (aturan lama berbasis nama).
4. **Tidak diubah**: 6a/6b (artefak stub — tidak ada perbaikan yang
   dibutuhkan; dikunci tes kontrol 28f), importedBasenames untuk
   import langsung `"@"` (perilaku lama P2 — import langsung adalah
   pernyataan eksplisit penulis; yang ditutup hanya amplifikasi
   transitifnya via closure).

## Hasil

- Probe wasit pasca-kalibrasi (kode asli): W3a TETAP, W5b TETAP,
  W6a/W6b TETAP, W4 HILANG, W8 HILANG, W2b HILANG (pembaca di luar
  `test/` — varian di `test/` tetap TETAP karena P3 memang melewati
  file test sebagai pembaca), W11c HILANG, W11d TETAP.
- **Test 288/288 PASS** (282 lama + 6 baru seksi 28).
- Hunting re-run pasca-kalibrasi: IDENTIK — Fulcrom 15, Amply 18,
  RAAC 14, Hyperbridge 2, Flow 0; 0 kandidat baru.

## Sisa / residual baru

- (10) **Alias berantai via file perantara** (11a/11b): `Mid` impor
  `{Child as K}`, Reader impor `{K as C}` atau memakai `K` langsung —
  baca terlewat karena `K` tidak ada di baseTypeNames. Perlu peta
  alias per file yang disebar bersama closure. Belum dikerjakan.
- (3) heuristik abstract+internal, (4) risiko overfit kasus Kiro,
  (8) wrapper transitif, (9) localDeclRe scope blok — tetap terbuka.
- Catatan kecil (bukan residual): fixture Vault satu-baris
  (`contract Vault { uint256 public fee; ... }` sebaris) tidak memicu
  detektor dead-config — kemungkinan pemindai deklarasi butuh
  pemisah baris; kode nyata tak pernah ditulis sebaris begitu, tidak
  dikejar sesi ini.
