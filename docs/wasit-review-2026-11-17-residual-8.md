# Review wasit R8 — kalibrasi wrapper transitif (residual 8)

Sesi: Frankenstein #21, 17 Nov 2026 00:38 WIB.
Status: **R8 BERTAHAN (13/13 kasus wasit sesudah kalibrasi lanjutan R8.1).**

## Catatan proses: pass Kiro GAGAL (bukan vonis)

Pass Kiro crew yang direncanakan untuk kalibrasi ini **tidak berjalan**:
browser task 1f7c63f7 (00:50–00:52 WIB) terhenti di sign-in — sesi login
Kiro Web (cloud browser) kedaluwarsa saat membuka Agent Config, dan agen
login tidak bisa masuk kembali: tidak ada login tersimpan untuk kiro.dev,
tidak ada kanal chat di jendela cron untuk memasukkan kredensial.
Dashboard sempat terbaca sebelum sesi mati: **144,55/4.000 kredit, sisa
46 hari, plan 0/50, reset 01/12** — delta 0 sesi ini (tidak ada pass Kiro).

**Tindak lanjut yang dibutuhkan (bukan beban sesi ini):** Toufik perlu
login ulang ke Kiro Web (app.kiro.dev, Google SSO Arslan) — idealnya dari
Chrome PC-nya, jalur resmi untuk aksi akun sensitif. Sampai login pulih,
pass Kiro crew (review silang maupun hunting) TERTUNDA; sesi Frankenstein
berikutnya memakai review wasit lokal seperti sesi ini, atau menunggu
login pulih. Jangan retry browser task Kiro sebelum ada sinyal login hidup
(akan gagal dengan cara yang sama).

Sebagai pengganti, review adversarial dijalankan jack-wasit lokal dengan
probe atas kode asli (metodologi sama seperti kalibrasi wasit R5/R6.1:
klaim hanya diterima bila probe atas kode nyata membuktikannya).

## Kalibrasi awal (R8, sebelum review)

`collectWrappers` + pola baca (a2) kind=`wrapper` + gerbang relevansi
transitif. Probe awal 6 bentuk: 5 FP diperbaiki (internal, IVault, base
inherited, berantai, member), kontrol unrelated TETAP. Dikunci tes
seksi 29 (10 tes).

## Kasus wasit (13) — hasil awal 9/13

| # | Kasus | Harapan | Awal | Sesudah R8.1 |
|---|-------|---------|------|--------------|
| W-A | wrapper return via assembly | HILANG | TETAP (FN) | HILANG |
| W-B | wrapper berargumen | HILANG | HILANG | HILANG |
| W-C | wrapper return parameter | HILANG | HILANG | HILANG |
| W-D | wrapper di library | HILANG | HILANG | HILANG |
| W-E | argumen parens bersarang | HILANG | HILANG | HILANG |
| W-F | rantai 3 level | HILANG | HILANG | HILANG |
| W-G | `return this;` dari turunan | HILANG | HILANG | HILANG |
| W-H | state var via alias (`V private vault;`) | HILANG | TETAP (FN) | HILANG |
| W-I | free function wrapper | HILANG | HILANG | HILANG |
| W-J | lokal fungsi lain (terisolasi) | TETAP | TETAP* | TETAP |
| W-K | `super.getVault()` | HILANG | HILANG | HILANG |
| W-L | return tuple `(Vault, uint256)` | HILANG | TETAP (FN) | HILANG |
| W-M | `return helper.vault;` (member, tanpa call) | TETAP | TETAP | TETAP (batas) |
| W-N | state var WARISAN | HILANG | TETAP (FN) | HILANG |

\* W-J probe pertama cacat: fungsi `other()` di fixture ikut membaca
`vault.fee()` langsung (getter sah) sehingga kandidat ter-drop via
getter — bukan via wrapper. Fixture diperbaiki (W-J2, terisolasi:
`other()` hanya mendeklarasi lokal tanpa baca fee) dan TETAP sesudah
R8.1. Pelajaran wasit: fixture kontrol harus bebas dari jalur baca lain.

## Kalibrasi lanjutan R8.1 (diterapkan + dites)

1. **W-A — assembly return:** bila badan wrapper (string di-mask)
   mengandung assembly `return(...)`, itu bukti badan. Alasan: fungsi
   mendeklarasi `returns` tipe pemilik — jalur keluar assembly
   mengembalikan instance tipe itu menurut ABI.
2. **W-H — alias pada deklarasi:** `typedNamesOfType` kini menerima
   alias yang mengarah ke tipe pemilik (dari `aliasMap` file
   pendefinisi) sebagai nama tipe.
3. **W-L — tuple unwrap:** ekspresi return yang diawali `(` diurai
   seimbang sampai koma top-level pertama / kurung tutup — elemen
   pertama dipakai (sesuai tipe pertama `returns`); rantai bersarang
   diurai bertahap (maks. 3 lapis). Menggantikan strip-kurung tunggal.
4. **W-N + W-J — scoping typed-set (perbaikan prinsipil):** helper baru
   `ownerTypedStateVars(index, ct, baseTypeNames)` — state var
   bertipe pemilik di kontrak pendefinisi + leluhurnya (transitif),
   hanya deklarasi level-kontrak (badan fungsi + blok struct
   dikeluarkan — pola yang sama dengan `findDeadConfigVars`), tipe
   diambil dari token terakhir sebelum nama (jendela 2 baris) +
   resolve alias per file. `typed` kini = state var (dihitung sekali
   per kandidat) + param/named-return/lokal di badan wrapper itu
   sendiri. Sebelumnya `scopeText` = span kontrak penuh: terlalu lebar
   (lokal fungsi lain, W-J) DAN terlalu sempit (state var warisan, W-N).

## Batas yang didokumentasikan (tidak diperbaiki)

- Ternary (`return cond ? vault : Vault(address(0));`) — tidak ada
  bukti badan (dikunci tes 29i).
- `return helper.vault;` — akses member tanpa pemanggilan (W-M,
  dikunci tes 30f).
- Deklarasi state var yang tipenya terpisah >2 baris dari namanya
  (gaya format ekstrem) bisa terlewat oleh jendela 2 baris
  `ownerTypedStateVars`.
- `return` assembly yang mengembalikan 0 byte / revert tetap dihitung
  bukti (sesuai ABI — fungsi mendeklarasi returns tipe pemilik).

## Verifikasi

- Test suite: **307/307 PASS** (298 lama + 9 baru seksi 30).
- Probe wasit: 13/13 (file `/tmp/probe-w8.js`, `/tmp/probe-wn.js`,
  `/tmp/probe-wj2.js` — scratch, tidak di-commit).
- Hunting re-run 5 permukaan pasca-R8.1: lihat STATUS.md sesi #21
  (Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2, Flow 0 — identik).

## Residual terkait

- Residual (8) wrapper transitif: **SELESAI** sesi ini.
- Residual (10) alias berantai via file perantara (11a/11b) — masih
  TERBUKA (calon sesi berikut).
- Residual (3) heuristik abstract+internal, (4) risiko overfit kasus
  Kiro, (9) localDeclRe scope blok — masih TERBUKA.
