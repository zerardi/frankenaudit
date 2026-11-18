# Review silang Kiro — kalibrasi project-pass P4/P7/P9 (v2)

- **Tanggal:** 16 Nov 2026, 12:58–13:16 WIB (browser task, 17 mnt)
- **Model:** Claude Opus 5.5 (dipilih ulang manual — sesi sempat beralih ke
  Opus 4.8 di pass sebelumnya; kali ini TIDAK ada penolakan model)
- **Sesi Kiro:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak
  Solidity") — dilanjutkan, tidak perlu chat baru.
- **Metode:** kode kalibrasi (`findCrossFileReads` + `collectAncestorNames`)
  ditempel verbatim; helper (`classifyVarOccurrence`, `ancestorChain`,
  `contractSpans`, `isTestOrMockFile`, pembangun indeks) HANYA dijelaskan
  kontrak perilakunya — Kiro menguji REKONSTRUKSI helper-helper itu di Node,
  bukan kode asli. Vonis di bawah ini TIDAK ditelan mentah (lihat
  "Analisis wasit jack").
- **Kredit:** dashboard 103,4 → **115,91/4.000 (delta 12,51)**; sisa 3.884,09,
  47 hari → tempo ≈82,6/hari (pas garis). Est.CreditsUsed pass ini 12,51
  (footer UI; Kiro sendiri menulis "tidak tersedia").
- **Aturan read-only dipatuhi:** repo tidak diubah, folder scratch dihapus.

## Vonis Kiro (Opus 5.5, atas rekonstruksi)

32 kasus adversarial: kode kalibrasi benar **18/32**, kode lama 9/32.
Kalibrasi memperbaiki 11 kasus, memperkenalkan 2 FP baru, net +9.
Dengan tiga patch kecil yang diusulkan Kiro, skor pada rekonstruksi
menjadi 23/32 tanpa regresi.

| Item | Vonis Kiro |
|---|---|
| P4 (tulis vs baca di turunan) | TERPERBAIKI |
| P7 (alias import + namespace) | SEBAGIAN |
| P9a (interface bernama lain) | SEBAGIAN |
| P9b (receiver bertipe turunan) | TERPERBAIKI (dengan 1 FP baru) |

Kasus Kiro (ringkas; "Ideal" = hasil benar; "Baru" = keputusan kode baru):
- P4: tulis-murni ok; `delete` ok; `o.fee()` ok; `this.fee()` ok;
  `fee += 1` ok (write, konsisten detektor); `fee = fee + 1` ok;
  modifier body ok; cucu transitif ok; `sstore` ok. GAGAL: struct field
  (P4-5), param event (P4-10), string literal (P4-11), key named-arg
  (P4-12), param modifier (P4-13), deklarasi-lokal-setelah-pakai
  (P4-14, FN).
- P7: alias pemilik ok; namespace ok; GAGAL: alias interface (P7-3),
  alias turunan (P7-4), alias di `is` (P7-5), alias ke file lain
  basename sama (P7-6, **FP baru**).
- P9a: Fulcrom IVaultPriceFeed ok; interface tak terkait ok; GAGAL:
  interface warisi getter (P9a-4), receiver kontrak leluhur abstrak
  (P9a-6).
- P9b: turunan langsung/cucu ok; GAGAL: nama turunan bertabrakan
  (P9b-3, **FP baru**), receiver cast (P9b-4).
- Bukan masalah baru menurut Kiro: prefix namespace generik redundan
  (9/9 sampel identik tanpa prefix — tidak menambah FP maupun
  kemampuan); aturan lineage interface tanpa FP baru; `+=` sebagai
  write konsisten dengan detektor.

Patch yang diusulkan Kiro (teruji pada rekonstruksi saja, 23/32):
helper `resolveImportPath`/`samePath`, pencatatan file setiap turunan
(`descendantFiles`), interface mewarisi deklarasi getter dari interface
leluhur, alias berlaku untuk semua `baseTypeNames` dan divalidasi dengan
path import yang di-resolve, nama turunan kembar hanya berlaku bila file
pembaca mengimpor file turunan aslinya.

## Analisis wasit jack — vonis TIDAK ditelan mentah

Kiro menguji rekonstruksi helper, bukan kode asli. Tiap kasus yang
diperselisihkan diverifikasi ulang jack ke kode asli (probe Node langsung
+ tes seksi 24). Hasil:

**Kiro SALAH pada 2 kasus (kode asli sudah benar):**
1. **P4-5 (field struct di turunan):** kode asli KEEP, bukan drop.
   `scanStateVarDecls` menangkap `uint256 fee;` di dalam struct sebagai
   "var" kontrak, sehingga cek shadowing rantai menelan seluruh kontrak
   turunan. Perilaku benar lewat mekanisme yang salah — over-shadow ini
   konservatif (menahan kandidat, bukan menjatuhkan) dan didokumentasikan
   sebagai batas, bukan diperbaiki di sesi ini (butuh bedah
   `scanStateVarDecls` yang dipakai bersama detektor).
2. **P9a-4 (`IVault is IFee`, reader `IVault v`):** kode asli DROP, bukan
   keep. `IVault` = `"I" + "Vault"` — aturan `I`+nama pemilik yang sudah
   ada sejak v1 menangkapnya secara kebetulan. Bentuk UMUM kasus ini
   (interface bernama lain yang mewarisi getter, mis. `IFeed is IPrice`)
   TERBUKTI celah nyata dan diperbaiki.

**Kiro BENAR pada 12 kasus (semua diverifikasi ke kode asli):**
- FP baru kalibrasi: P7-6 (alias basename-only), P9b-3 (nama turunan
  per-nama, bukan per-file) — keduanya TERBUKTI dan DIPERBAIKI.
- FN: P7-3 (alias interface), P7-4 (alias turunan), P7-5 (alias di
  `is`), P9a-6 (receiver leluhur abstrak), P9b-4 (receiver cast),
  P9a-4 umum (closure interface).
- FP lama: P4-10 (param event), P4-11 (string literal), P4-12 (key
  named-arg), P4-13 (param modifier) — semuanya TERBUKTI dan DIPERBAIKI.
- FN lama: P4-14 (deklarasi lokal setelah pemakaian) — TERBUKTI dan
  DIPERBAIKI (shadow kini prefix-based, bukan seluruh body).

## Kalibrasi jack (diterapkan sesi ini — seksi 24, 16 tes)

- **P7-6 + P7-3/P7-4:** alias kini berlaku untuk semua `baseTypeNames`
  dan divalidasi dengan path import yang di-resolve (`resolveImportPath`)
  terhadap file pendefinisi tipe (peta per-entri `typeFiles`; nama pemilik
  dipin ke `owner.file`). Path tak ter-resolve (remapping `@/`, `..`
  melewati root) ditolak — konservatif.
- **P9b-3:** nama turunan/interface/leluhur hanya berlaku bila file
  pembaca mengimpor file pendefinisinya (atau mendefinisikannya sendiri)
  — peta per-entri, bukan per-nama.
- **P9a-4 umum:** `ifaceDeclaresGetter` per-entri (interface itu atau
  interface leluhurnya mendeklarasi getter).
- **P9a-6:** kontrak leluhur pemilik yang mendeklarasi `function fee(`
  masuk `baseTypeNames`.
- **P9b-4:** regex cast (`Type(a).fee()`) di cabang getter.
- **P7-5:** `buildProjectIndex` menormalisasi parent via alias import
  per-file + memangkas prefix namespace di `is`.
- **P4-10/P4-13:** `nonExpressionSpans` (deklarasi event/error +
  signature modifier) dilewati di cabang inheritance.
- **P4-11:** `maskStringLiterals` di cabang inheritance (hanya di sana —
  path import adalah string literal dan harus tetap terbaca).
- **P4-12:** key named-arg (`{fee: 5}`) dilewati di cabang inheritance.
- **P4-14:** shadow lokal kini prefix-based (deklarasi setelah pemakaian
  tidak men-shadow).
- **Tidak diadopsi dari usulan Kiro:** penghapusan prefix namespace
  generik (redundan tapi tidak berbahaya — dibiarkan, tanpa churn).

Hasil: **test 268/268 PASS** (252 lama + 16 baru seksi 24; 14 tes baru
GAGAL di kode pra-kalibrasi, 2 tes kunci lolos — P4-5 dan P9a-4-IVault).
Hunting re-run 5 permukaan pasca-kalibrasi: IDENTIK (Fulcrom 15, Amply
18, RAAC 14, Hyperbridge 2, Flow 0) — 0 kandidat baru.

## Batas yang diketahui (residual)

- Over-shadow struct-field: field struct senama var dead membuat seluruh
  kontrak turunan ter-skip di cabang inheritance (konservatif; baca asli
  di kontrak yang sama ikut tertahan). Perlu `scanStateVarDecls` yang
  sadar scope struct — bedah bersama detektor, bukan sesi ini.
- Visibilitas import transitif: file yang memakai tipe turunan lewat
  rantai import tak langsung (tanpa import langsung) tidak dikenali —
  konservatif (kandidat dipertahankan, sama seperti v1).
- Cast bersarang >1 level (`Type(f(a)).fee()` dengan struct literal di
  argumen) tidak cocok regex cast — FN sisa.
- Wrapper transitif (fungsi publik memanggil wrapper internal yang
  membaca var) belum terindeks — FN sisa.
- `localDeclRe` prefix-based masih mengabaikan scope blok bersarang
  (deklarasi di blok `if` yang sudah tertutup sebelum pemakaian ikut
  dihitung shadow — konservatif).
- Tabrakan basename/nama kontrak antar file tetap batas yang
  didokumentasikan (gerbang relevansi + `I`+nama + nama pemilik).
- Heuristik abstract+internal (residual #3 review detektor #17) dan
  risiko overfit kasus Kiro (residual #4) tetap terbuka.

## Langkah berikut

- Pass Kiro berikut: pilih ulang Opus 5.5 manual; tempel JUGA helper
  yang dirujuk bila review menyangkut mereka (pelajaran sesi #17 —
  review atas rekonstruksi menghasilkan 2 klaim salah dari 14).
- M2 tetap: 17 detektor, ground truth 20 kandidat, test 268/268.
