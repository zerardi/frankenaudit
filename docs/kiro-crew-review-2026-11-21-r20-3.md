# Review Kiro crew atas kalibrasi R20.3 / R20.3a (D20 swap-output)

Sesi Frankenstein #46 (lanjutan), 21 Nov 2026. Pass Kiro: browser task
d6ab4fa5, sesi baru "Audit R20.3 swap-output D20"
(https://app.kiro.dev/session/f443d373-c1c6-43bd-8e48-1bad54678fa6),
**Opus 5.5 eksplisit tanpa penolakan — tanpa flag MODEL_TIDAK_SESUAI**,
Autonomous OFF, 2m 8s, footer 2,12 kredit. Dashboard awal pass:
363,45/4.000 (tidak berubah sejak 20 Nov 20:40 WIB); total sesudah pass
(dari footer, tidak dibaca ulang dashboard): 365,57/4.000, sisa 3.634,43.

## Konteks

R20.3 (sesi #46 blok 1, wasit lokal): D20 `permissionless-value-send`
mengenali swap-output sebagai dana caller — syarat (i) pull dari
msg.sender / msg.value di badan, (ii) nilai ditugaskan dari panggilan
swap (c1) atau dari `abi.decode` atas hasil multicall swap (c2). Kasus
pemicu: `UniV3UniswapV2Wrapper.swapExactTokensForETH` (FA-002
Hyperbridge, Medium, gugur wasit sesi #26).

## Hasil harness Kiro: 7/20 lolos, vonis NEEDS WORK (F1–F7)

Kasus wasit: P1 THROW, P2/P3 lolos, N1/N2/N3/N5 lolos, N4 THROW.
Adversarial Kiro A1–A12: lolos hanya A4/A5 (A4 = batas F7 yang sudah
didokumentasikan).

## Disposisi wasit (probe ke kode ASLI, /tmp/probe-d20-r203a.js)

### F1 — DITOLAK sebagai artefak transport (KRITIS menurut Kiro, BUKAN bug)

Klaim Kiro: `decRe` tidak bisa dikonstruksi (`\w` → `w`, `\[` → `[`,
kelas karakter tak tertutup) sehingga c2 selalu melempar SyntaxError dan
P1 tidak pernah ter-suppress.

Verifikasi wasit: **SALAH untuk kode asli.** Byte mentah file
(`app/pipeline.js` baris decRe): semua run backslash panjang 2 —
string RegExp escape-nya benar. Probe lokal: P1 → 0 via c2 tanpa
throw; suite 851/851 lolos sebelum R20.3a. Yang rusak adalah SALINAN
yang diterima Kiro — backslash terpotong separuh di suatu titik
transport tugas browser → Kiro (pelajaran: tempelan kode ke Kiro
rentan halving backslash; verifikasi wasit WAJIB dari file asli, dan
harness Kiro yang crash = sinyal artefak, bukan vonis).

Konsekuensi: semua hasil THROW Kiro (P1, N4, A3, A7, A12) tidak
berlaku; A8 dievaluasi Kiro pada salinan /tmp yang escape-nya
diperbaiki — temuan itu tetap diuji ulang wasit (lihat F5).

### F2 — TERBUKTI (A1, A9)

Syarat (i) diperiksa di level body: `require(msg.value == FEE)` (A1)
dan `transferFrom(msg.sender, treasury, 1)` (A9) ikut memenuhi.
Perbaikan R20.3a: (i) kini mensyaratkan pull KE `address(this)`
dengan jumlah berupa identifier yang dipakai lagi di badan, DAN pull
harus mendahului penugasan swap; cabang `msg.value` telanjang DIHAPUS
(output swap ETH butuh input token, bukan msg.value). Probe pasca:
A1/A9 → 1 (ter-flag). Batas sisa: pull jumlah kecil ke address(this)
dengan identifier yang dipakai ulang sebagai input swap lain masih
lolos — butuh pelacakan aliran dana penuh (ranah taint, di luar
skop pola ini).

### F3 — TERBUKTI (A2, A11)

Penanda swap c1 terlalu longgar (`[\w$.]*(?:swap|...)`, flag `i`):
`quoter.quoteExactInputSingle(` (A2) dan `viewer.previewSwap(` (A11)
lolos sebagai output swap. Perbaikan R20.3a: segmen callee terakhir
harus DIAWALI `swap`/`exactInput`/`exactOutput` (case-sensitive,
didahului `^`/spasi/`.`/`(`). Probe pasca: A2/A11 → 1.

### F4 — TERBUKTI (A6, A10)

c1 hanya melihat penugasan pertama; `amountOut = address(this).balance`
sesudah swap (A6) diabaikan, dan `cache.amountOut = router.swap(...)`
(A10) dibaca sebagai penugasan lokal (batas `\b` sesudah titik).
Perbaikan R20.3a: semua penugasan V sebelum kirim dikumpulkan,
penugasan member (karakter sebelum `V` adalah `.`) dilewati, yang
dipakai = TERAKHIR; `isCallerFunded` kini menerima `beforeIdx`
(posisi kirim) sehingga penugasan sesudah kirim tak dihitung. Probe
pasca: A6/A10 → 1.

### F5 — TERBUKTI (A8)

c2 tidak mengaitkan penanda swap / target multicall dengan swap yang
sebenarnya: multicall ke oracle + selector swap di variabel tak
terpakai ikut ter-suppress (Kiro membuktikan ini pada salinan
escape-fixed; wasit mereproduksi di kode asli: A8 → suppressed).
Perbaikan R20.3a: receiver multicall harus mengandung `swap`/`router`
(`IMulticallExtended(_params.swapRouter)` lolos, `IOracle(oracle)`
tidak). Probe pasca: A8 → 1. Batas sisa: penanda swap di variabel tak
terpakai + multicall ke swapRouter untuk data non-swap masih lolos —
butuh ikatan variabel data (didokumentasikan, tidak dikerjakan sesi
ini).

### F6 — TERBUKTI (cabang lama (b), di luar skop R20.3)

`pullRe` menyamakan token ERC20 dengan ETH: pull token junk lalu
kirim ETH jumlah sama ikut ter-suppress. Perbaikan R20.3a: (b) kini
mensyaratkan token yang ditarik WETH-ish (receiver mengandung `weth`,
dibaca jalan-mundur dari titik `.transferFrom` — hindari regex
paren-bersarang untuk `IERC20(WETH())`) ATAU badan memuat
`.withdraw(`. Probe pasca: F6 → 1; kontrol Gnosis (pull WETH +
withdraw) → 0. Pelajaran implementasi: percobaan pertama memakai
grup receiver regex dengan paren bersarang — pola itu gagal total
(`[^)]*` tak menangani `IERC20(WETH())`, 2 level) dan sempat
merusak suite (regresi 40e); diganti jalan-mundur karakter — lebih
sederhana dan benar.

### F7 — batas yang sudah didokumentasikan, DIPERBAIKI (A4)

`amounts[1]` (indeks) ditolak di awal `isCallerFunded`. Perbaikan
R20.3a: nilai bentuk `IDENT[...]` diuji via basisnya untuk c1/c2
(tidak memakai (b)). Probe pasca: A4 → 0; tes 61-9 diperbarui
(1 → 0). Batas sisa: tuple-destructure `(a, b) = swap(...)` belum
dikenali.

## Hasil akhir

- Probe wasit pasca-R20.3a: **14/14** (A1–A12 + F6 + F6-kontrol).
- Suite: **851 → 862/862 PASS** (Seksi 61 diperbarui + Seksi 62 baru,
  11 tes). Verifikasi negatif: tepat 9 tes gagal di kode pra-R20.3a
  (61-9 + 62-1/62-2/62-4/62-5/62-6/62-7/62-8/62-10).
- Hunting re-run 9 permukaan pasca-R20.3a: (lihat STATUS.md sesi #46
  lanjutan).

## Batas yang diketahui (R20.3a)

- Ikatan data multicall c2 (F5 residual): penanda swap di var tak
  terpakai + multicall ke swapRouter untuk data non-swap.
- (i) pull kecil ke address(this) yang dipakai ulang sebagai input
  swap lain (F2 residual — butuh taint).
- Tuple-destructure `(a, b) = swap(...)` belum dikenali (F7 residual).
- (b) pull-forward: token variabel bernama bukan-WETH tanpa
  `.withdraw(` di badan fungsi yang sama tetap ter-flag (konservatif;
  unwrap di helper lain tak terlihat).
