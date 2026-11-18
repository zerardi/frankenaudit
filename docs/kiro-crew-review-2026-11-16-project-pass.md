# Review silang Kiro — project-pass lintas-file (v1)

- **Tanggal:** 16 Nov 2026, 08:52–09:39 WIB (browser task, 46 mnt)
- **Model:** Claude Opus 5.5 (review utama) — **BEPINDAH ke Opus 4.8 di tengah sesi**
  (saat minta kirim ulang v2: "Claude Opus 5.5 refused; answered by Claude
  Opus 4.8, now this conversation's model"). Fragmen F1–F112 ditulis Opus 4.8
  (hanya penyalinan ulang). **Sesi Kiro kini bermodel Opus 4.8 — pass
  berikut WAJIB pilih ulang Opus 5.5 manual atau mulai sesi baru.**
- **Sesi Kiro:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak
  Solidity") — dilanjutkan, tidak perlu chat baru.
- **Metode:** kode project-pass ditempel verbatim (repo GitHub main TIDAK
  berisi kode ini — hanya repo lokal; push branch dijeda atas penolakan
  Toufik). Kiro mereview dari tempelan + replika fungsi di sandbox-nya
  (dengan jaringan: clone contoh GMX v2).
- **Kredit:** dashboard 76,74 → **103,4/4.000 (delta 26,66)**; sisa 3.896,6,
  47 hari → tempo ≈82,9/hari (pas garis). Rincian per pesan Kiro: review
  utama 15,66; kirim ulang 14 bagian 2,62; fragmen F1–F112 2,46 (total
  perkiraan 20,74; selisih ~5,92 tak dijelaskan — kemungkinan percobaan
  model yang ditolak / pembulatan).
- **Aturan read-only dipatuhi:** repo tidak diubah, folder scratch dihapus.

## Vonis Kiro (Opus 5.5)

| | v1 | v2 prototipe Kiro |
|---|---|---|
| Kasus adversarial | 33 | 33 |
| Benar | **9/33** | **33/33** |
| Per kategori v1 | Getter 6/16; Inheritance 0/7; Mock/test 3/4; Dedupe 0/3; Sort 0/2; Non-dead-config 0/1 | — |

Validasi GMX v2 (26 file, 23 kandidat, 25 kasus uji): v2 benar 25/25;
v1 benar 9/25. Akar masalah menurut Kiro: "project-pass membaca kontrak
penerima, bukan pemilik."

## Daftar perubahan v2 Kiro (P1–P10, dari laporan browser)

- **P1.** Pisahkan indeks pemilik dari indeks penerima: pemilik diindeks dari
  lokasi kandidat, penerima diindeks dari seluruh file proyek. (v1 mencampur
  keduanya — kontrak penerima dibaca sebagai pemilik.)
- **P2.** `ppResolveImport`: selesaikan import relatif (`./`, `../`, `@/`)
  menjadi path kanonik. (v1 memakai nama file mentah.)
- **P3.** `ppIsTestFile`: abaikan file test/mock (`test/`, `mocks/`, `.t.sol`,
  `Mock*`, `Harness*`). (v1 menghitung read di file test sebagai bukti.)
- **P4.** `ppClassify`: bedakan read/write di dalam fungsi (`x = treasury()`
  adalah read, `treasury() = x` adalah write). (v1 menghitung semua
  kemunculan sebagai read.)
- **P5.** `ppShadowRanges`: deteksi shadowing oleh parameter/lokal di dalam
  fungsi. (v1 menghitung read di fungsi yang men-shadow var sebagai read.)
- **P6.** `ppCallables`: deteksi pemanggilan fungsi yang mengembalikan var
  (mis. `treasury()` di dalam `getTreasury()`).
- **P7.** `ppParseImports`: parsing import dan alias
  (`import { Config as Cfg } from "./Config.sol"`).
- **P8.** `ppAncestors`/`ppDescendants`: graf inheritance lengkap (bukan
  hanya parents langsung). (v1 hanya memeriksa parents langsung.)
- **P9.** `ppBaseType`/`ppTypeOfId`/`ppReceiverType`: selesaikan tipe receiver
  (mis. `cfg` bertipe `Config` atau `IConfig`). (v1 memakai nama variabel
  sebagai tipe.)
- **P10.** `ppDecls`: deklarasi var di dalam fungsi (mis.
  `uint treasury = ...`).

Temuan tambahan Kiro — bug sort: `candidates.sort((a, b) =>
rank[a.severityGuess] - rank[b.severityGuess])` — `rank[undefined]` = NaN
bila kandidat tanpa `severityGuess`; v2 memakai `ppRank` (default 2).

## Kode v2 verbatim — TIDAK BERHASIL DIPULIHKAN

Browser tidak bisa menempelkan blok kode panjang ke laporan (tampilan
memotong tiap blok; Ctrl+V tidak didukung). Artefak PDF yang dilampirkan
browser ternyata HANYA tangkapan layar sebagian halaman sesi (fragmen
F82–F84) — bukan kode lengkap, jadi tidak bisa dipakai sebagai sumber
salinan. Penyalinan ulang lewat screenshot TIDAK dilanjutkan (keputusan
jack: mahal + rawan OCR; nilai v2 ada pada idenya, P1–P10, yang sudah
tercatat di atas). **v2 TIDAK diadopsi utuh** — diwujudkan ulang secara
lokal hanya untuk celah yang terverifikasi (lihat "Kalibrasi jack").

## Analisis wasit jack — vonis 9/33 TIDAK bisa ditelan mentah

1. **Kiro menguji REPLIKA, bukan kode asli.** Tempelan hanya berisi 4
   fungsi project-pass; helper (`contractSpans`, `scanStateVarDecls`,
   `enclosingFunctionAt`, `hasParamNamed`, dst.) TIDAK ditempel — Kiro
   menulis ulang dari kira-kira. Perilaku replika bisa menyimpang dari
   v1 asli. Contoh: klaim "Inheritance 0/7 — v1 tidak mengenali
   inheritance" BERTENTANGAN dengan tes lokal seksi 20 (turunan langsung
   membaca `baseFee` → HILANG, lolos di v1 asli). Yang benar: v1 hanya
   memeriksa parents LANGSUNG (cucu terlewat — P8, terbukti di bawah).
2. **Hitungan Kiro tidak konsisten.** 11 FP + 12 FN + 1 tidak dihitung =
   24, bukan 33; daftar rinci FP memuat butir yang Kiro sendiri labeli
   BUKAN FP (FP2, FP4) sehingga rinciannya melebihi 11. Skor per
   kategori (6+0+3+0+0+0 = 9) cocok dengan total, tapi rincian FP/FN
   tidak bisa direkonsiliasi — pakai sebagai sinyal, bukan ground truth.
3. **"Non-dead-config 0/1" BUKAN kegagalan.** `applyProjectPass` SENGAJA
   hanya memproses kandidat `dead-config-storage`; kandidat lain
   dipertahankan by-design. Kiro mengharapkan perilaku yang salah.
4. **"Dedupe 0/3" BERTENTANGAN dengan kode.** `runProjectPipeline`
   mendupe kandidat gabungan (kunci detector+file+fungsi+varName) —
   klaim "v1 tidak mengabaikan duplikat" tidak sesuai dengan kode yang
   ditempel. Kemungkinan Kiro menguji duplikat yang kuncinya memang
   berbeda (mis. var sama dari dua writer fn berbeda — itu dua kandidat
   berbeda, bukan duplikat).
5. **"Baris salah hitung" TIDAK terbukti pada v1 asli.** Verifikasi jack:
   bukti dropped `VaultUtils.sol:113 (getter)` untuk `maxLeverage`
   dicek ke file nyata — baris 113 persis
   `if (remainingCollateral * _vault.maxLeverage() < ...)` (baris 152
   juga cocok). Penomoran baris v1 BENAR; klaim Kiro ini artefak replika.
6. **Bug sort TIDAK bisa terpicu lewat jalur nyata.** `normalizeCandidate`
   selalu mengisi `severityGuess` (default `"Low"`), jadi `rank[undefined]`
   tidak pernah terjadi via `runPipeline`/`runProjectPipeline`. Tidak
   diperbaiki (perubahan tanpa tes = noise); dicatat di sini saja.

## Kalibrasi jack (diterapkan sesi ini — hanya celah TERBUKTI)

Tiap celah ditulis sebagai tes dulu (seksi 22), dibuktikan GAGAL di v1,
lalu diperbaiki. Hasil: **5/7 tes baru gagal di v1; sesudah perbaikan
test 238/238 PASS** (230 lama + 8 baru).

- **P3 — file test/mock bukan bukti (TERBUKTI, 2 tes gagal di v1):**
  `findCrossFileReads` kini melewati file test/mock
  (`isTestOrMockFile`, pola sama dengan detektor). Kontrol: baca di file
  biasa tetap menghapus kandidat.
- **P8 — inheritance transitif (TERBUKTI, 2 tes gagal di v1):**
  `ancestorChain` (BFS atas `contractsByName`) menggantikan cek
  `parents.includes` langsung; cucu/cicit ikut dihitung, dan shadowing
  diperiksa di SELURUH rantai (perantara yang mendeklarasi ulang var
  senama → baca merujuk ke var perantara, kandidat TETAP — tes 22b2).
- **P1-owner — resolusi pemilik via declLine (TERBUKTI, 1 tes gagal di v1):**
  `applyProjectPass` kini memin pemilik lewat `declLine` kandidat
  (var + baris deklarasi), bukan find pertama berdasarkan nama saja.
  Kasus: dua kontrak satu file mendeklarasi var senama, hanya satu yang
  dibaca — dulu keduanya terhapus, kini hanya yang dibaca.
- **P2, P4–P7, P9, P10 — BELUM dikerjakan** (butuh kasus uji lokal yang
  membuktikan celahnya pada kode asli; P2 gerbang relevansi sudah memakai
  basename sehingga `../` vs `./` tidak membedakan; P9 sudah tercakup
  sebagian oleh `typedIdRe` yang hanya menerima id bertipe pemilik).
- **Hunting re-run pasca-kalibrasi: IDENTIK** — Fulcrom 30 mentah → 15
  dropped → **15 final**; Amply **18**; RAAC **14**; Hyperbridge 3 → 1
  dropped → **2**; Flow **0**. 0 kandidat baru; recall vs Kiro AMP tetap
  4/7. (Tidak ada file test yang diumpankan runner; tidak ada baca cucu
  di korpus ini; tidak ada tabrakan var senama di kandidat yang
  ter-flag — jadi kalibrasi tidak mengubah hasil hunting saat ini, tapi
  menutup celah untuk korpus berikut.)

## Langkah berikut

- Kalibrasi P2/P4–P7/P9/P10 bila ada kasus uji lokal yang membuktikan
  celahnya (jangan adopsi buta dari daftar Kiro).
- Pass Kiro berikut: pilih ulang Opus 5.5 manual (sesi kini Opus 4.8);
  tempel JUGA helper yang dirujuk bila review menyangkut mereka, supaya
  Kiro menguji kode asli bukan replika.
- M2 tetap: 17 detektor, ground truth 20 kandidat, test 238/238.
