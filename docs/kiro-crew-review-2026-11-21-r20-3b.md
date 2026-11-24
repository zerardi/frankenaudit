# Kalibrasi R20.3b atas residual R20.3a (D20 swap-output)

Sesi Frankenstein #47, 21 Nov 2026. **Wasit lokal, TANPA pass Kiro** —
sesi BB pagi sedang memakai Kiro Web (browser task 894b1001, pass
ronde 2 Resupply); review silang Kiro atas R20.3b DITUNDA ke sesi
berikut bila slot Kiro kosong. Probe wasit ke kode ASLI:
`/tmp/probe-d20-r203b.js`, 6 kasus.

## Celah yang dibuktikan probe (pra-perbaikan)

### F7 residual — tuple-destructure tidak dikenali c1 (TERBUKTI)

`isCallerFunded` hanya mengumpulkan penugasan polos `V = RHS;`.
Tiga bentuk tuple lolos sebagai swap-output sehingga D20 memberi
Medium palsu atas swap-forward yang sah:

- `(amountOut, amountInUsed) = ISwapRouter(router).swapExactTokensForETH(...)` → 1 (harap 0)
- `(uint256 amountOut, uint256 amountInUsed) = ISwapRouter(router).exactInputSingle(...)` → 1 (harap 0)
- `(, uint256 amountOut) = ISwapRouter(router).swap(...)` → 1 (harap 0)

Kontrol negatif benar: tuple dari `getReserves` (bukan swap) tetap 1.

### F5 residual — ikatan data multicall c2 (TERBUKTI)

c2 hanya menguji `/exactInput|exactOutput/.test(cut)` secara global,
jadi penanda swap di variabel TAK TERPAKAI + multicall ke swapRouter
yang datanya QUOTE ikut ter-suppress:

- `swapCall = encodeWithSelector(exactInputSingle)` (tak pernah dipakai)
  + `data[0] = quoteCall` (`quoteExactInputSingle`) +
  `IMulticallExtended(router).multicall(deadline, data)` +
  `amountOut = abi.decode(results[0], ...)` → 0 (harap 1)

Kontrol c2 lama benar: `data[0] = swapCall` (terpakai) tetap 0.

## Perbaikan R20.3b

1. **Tuple-destructure:** penugasan `(...) = RHS;` ikut dikumpulkan
   sebagai penugasan V — digabung dengan penugasan polos, diurutkan
   menurut posisi, yang dipakai tetap TERAKHIR. Elemen tuple diuji
   per koma (kata terakhir elemen sesudah buang tipe harus V);
   elemen member (mengandung `.`) dilewati (konservatif). Batas:
   tuple bersarang `(a, (b, c))` hanya tertangkap bila V muncul
   sebagai kata terakhir salah satu potongan koma (cukup untuk
   bentuk 1 level yang umum).
2. **Ikatan data c2:** penanda swap kini harus TERIKAT ke argumen
   data multicall — literal di argumen, pengisian `data[i]`/`push`,
   atau RHS var yang diisikan (satu hop). Penanda diuji ber-segmen:
   callee DIAWALI `exactInput`/`exactOutput`/`swap` + `(` atau
   `.selector` — `quoteExactInputSingle` dan `previewSwap` TIDAK
   lolos. Bila data tidak diisi lokal (param/helper lain), fallback
   ke uji global lama supaya perilaku bentuk itu tidak berubah
   (batas yang didokumentasikan, bukan celah baru).

## Hasil akhir

- Probe wasit pasca-R20.3b: **6/6 PASS** (pra-perbaikan 2/6).
- Suite: **862 → 868/868 PASS** (Seksi 63 baru, 6 tes).
  Verifikasi negatif: tepat 4 tes baru gagal di kode pra-R20.3b
  (63-1/63-2/63-4/63-5).
- Hunting re-run 9 permukaan pasca-R20.3b: **IDENTIK** dengan
  baseline pasca-R20.3a — Fulcrom 15, Amply 18, RAAC 14,
  Hyperbridge 7, Flow 0, Veno 6, Veno zkEVM 0, LCROBridge 0,
  Resupply 12; recall vs Kiro AMP tetap 4/7; **0 kandidat baru.**

## Batas yang diketahui (R20.3b)

- Ikatan data multicall c2 bila data param/helper lain: fallback
  uji global (perilaku lama dipertahankan).
- (i) pull kecil ke address(this) yang dipakai ulang sebagai input
  swap lain (F2 residual — butuh taint penuh).
- Tuple-destructure bersarang >1 level belum diuji.
- (b) pull-forward: token variabel bernama bukan-WETH tanpa
  `.withdraw(` di badan fungsi yang sama tetap ter-flag
  (konservatif; unwrap di helper lain tak terlihat).
- F11 label-per-target + F10 two-hop tetap DITUNDA (lihat STATUS.md
  sesi #47: F11 berisiko salah-nilai severity; F10 two-hop terlalu
  besar 3 hari sebelum freeze 24 Nov).
