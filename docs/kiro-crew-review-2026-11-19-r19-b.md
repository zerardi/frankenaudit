# Review kalibrasi R19-b — D19 `encodeWithSelector` transferFrom (sesi #35, 19 Nov 2026)

## Konteks
Residual dari review Kiro detektor 18/19 (17 Nov 2026, `kiro-crew-review-2026-11-17-detectors-18-19.md`,
bagian "Batas diketahui", R19-b): di detektor ke-19 `full-balance-sweep`,
`encodeWithSelector(...transfer.selector...)` mengambil jumlah dari argumen
ke-3 (posisi transfer). Untuk `transferFrom` (4 argumen) jumlah sebenarnya
ada di argumen ke-4 — pola itu terlewat (konservatif, tanpa FP).

## Pass Kiro crew: DITUNDA sesi ini
Sesi BB pagi 19 Nov 2026 (08:08 WIB) berjalan paralel dan rencananya memakai
Kiro Web untuk klaster Veno — pass Kiro atas R19-b ditunda untuk menghindari
tabrakan login Arslan (preseden sesi #21/#25/#29/#31). Review wasit lokal
sebagai pengganti (probe Node atas pipeline asli, bukan stub).

## Probe wasit (pra-perbaikan, `/tmp/probe-r19b.js`, dihapus sesudah pakai)
| Kasus | Harapan | Pra | Pasca |
|---|---|---|---|
| P1 transferFrom-selector + `balanceOf(pool)` langsung di args[3] | 1 | 0 (FN TERBUKTI) | 1 |
| P2 transferFrom-selector + var sweep `bal` di args[3] | 1 | 0 (FN TERBUKTI) | 1 |
| P3 transfer-selector + balanceOf di args[2] (regresi) | 1 | 1 | 1 |
| P4 transferFrom-selector + amount literal | 0 | 0 | 0 |
| P5 transferFrom-selector + balanceOf di args[2] (posisi `to`) + amount deklarasi | 0 | 0 | 0 |
| P6 selector variabel | 0 | 0 | 0 |
| P7 transferFrom langsung + balanceOf (regresi) | 1 | 1 | 1 |
| P8 transferFrom-selector + `pool.balance` (address state var) | 1 | 0 (FN TERBUKTI) | 1 |

Pra-perbaikan: 5/8. Pasca-perbaikan: **8/8**.

## Perbaikan (kalibrasi R19-b, `app/pipeline.js`, `detectFullBalanceSweep` langkah 2)
Cabang `encodeWithSelector` kini membedakan selector sebelum mengambil
posisi jumlah:

```js
if (args[0] && /\.transferFrom\.selector/.test(args[0])) amount = args[3];
else if (args[0] && /\.transfer\.selector/.test(args[0])) amount = args[2];
```

Catatan wasit:
- Urutan cek (transferFrom dulu) bersifat defensif; kedua regex saling
  lepas — `/\.transfer\.selector/` tidak cocok dengan
  `.transferFrom.selector` (ada `From` di tengah), begitu pula sebaliknya.
- P5 adalah kunci negatif: bila jumlah diambil dari args[2] secara buta,
  `to` yang berupa balance akan ter-flag palsu. Kalibrasi ini TIDAK
  mengubah perilaku transfer (P3 tetap 1) dan tidak menyentuh cabang
  `transferFrom` langsung (P7 tetap 1, jumlah = args[2] di sana karena
  pemanggilan langsung hanya punya 3 argumen: from, to, amount).
- `args[3]` yang tidak ada (pemanggilan malformed) aman: `isAmount`
  mengembalikan false untuk ekspresi kosong.

## Tes
Seksi 55 baru di `tests/run-m2-tests.js` (8 tes: 55-1..55-8, salinan
kasus probe P1–P8). **Test 702/702 PASS** (694 lama + 8 baru).
Commit lokal `5b48a35`.

## Batas diketahui (baru)
- Selector bentuk hash `keccak256("transferFrom(address,address,uint256)")`
  tanpa anggota `.selector` tidak dikenali — konservatif, tanpa FP.
- `safeTransferFrom` (library SafeERC20) bukan selector antarmuka token;
  tidak ditangani, sesuai desain.

## Hunting
Re-run 6 permukaan pasca-R19-b — lihat log sesi #35 di `STATUS.md`.
