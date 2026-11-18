# Review R19.2 `ident.balance` polos (D19) — sesi 04:38 WIB 18 Nov 2026

## Pass Kiro crew: TERBLOKIR (bukan ditolak — prasyarat repo tidak terpenuhi)

- Browser task d5e201fa (04:49–05:01 WIB, 11 mnt). Sesi Kiro baru
  "Audit R19.2 ident.balance D19", URL
  https://app.kiro.dev/session/7e99e3cc-79b4-4fe0-9e3d-12018e54a6e8.
- Dashboard START 185,28/4.000 (45 hari) → END 186,67/4.000; delta sesi
  **1,39** (footer 0,74 + 0,65). Model: **Opus 5.5 di kedua turn**,
  tanpa flag MODEL_TIDAK_SESUAI. Login sempat kedaluwarsa di tengah
  jalan, masuk lagi via tombol Google akun Arslan tanpa password/2FA.
- **Penyebab blokir (TERBUKTI, bukan asumsi):** workspace Kiro
  meng-clone GitHub `zerardi/frankenaudit` main 8c3c079 — state M2 awal
  (pipeline.js 730 baris, 9 detektor, suite 22 test). Fungsi
  `detectFullBalanceSweep` / `isFullBalanceExpr` / `listContractNames` /
  `contractSpans` / `scanStateVarDecls` / `functionParams` /
  `splitTopLevelArgs` TIDAK ADA di repo itu maupun di seluruh riwayat
  git-nya (`git log --all -S` kosong). Verifikasi jack: repo lokal
  `frankenaudit/` TIDAK PUNYA remote sama sekali (41 commit lokal,
  HEAD f366b1f → a26e84b); sinkronisasi lokal→GitHub memang tugas chat
  jack sebelum freeze 24 Nov, BUKAN tugas sesi ini. Jadi pass Kiro
  TIDAK BISA menerapkan patch — bukan cacat patchnya.
- **Pengganti (preseden sesi #21/#25): review wasit lokal** atas
  kasus A1–A20 penugasan Kiro, dieksekusi via Node atas pipeline
  lokal (probe `/tmp/probe-wasit-r192.js`, dihapus sesudah pakai).

## Hasil wasit lokal (semua dibuktikan eksekusi, bukan penalaran)

| Kasus | Bentuk | Harap | Dapat | Vonis |
|---|---|---|---|---|
| A1–A6, A10–A15 | (kasus penugasan, sudah dikunci tes seksi 43) | — | — | Lolos di suite (43a–43m) |
| A16 | `pools[0].balance` (address[] state var) | ? | 0 | **FN terdokumentasi** — akses terindeks tak ditangani; butuh pelacakan tipe elemen (di luar R19.2) |
| A17 | param tipe kontrak dari import (`IVault`) | 0 | 0 | **Sesuai desain** — tipe lintas-file tak dikenali (konservatif) |
| A18 | lokal struct `Info pool` menutupi state var `address pool` | ? | 1 → **0 sesudah R19.2a** | **FP TERBUKTI → DIPERBAIKI (R19.2a)** |
| A19 | param `IERC20 token` + `token.balance` | ? | 0 | **FN terdokumentasi** — IERC20 dari import, bukan deklarasi file ini (batas yang sama dengan A17) |
| A20a | `pool.balance - fee` (ekspresi lebih besar) | 1 | 1 | Benar |
| A20b | nama sama beda fungsi (g: address, f: struct) | 1 dari g | 1 dari g | Benar — cakupan per-fungsi |
| A20c | `payable(escrow).balance` | 1 | 1 | Benar |
| A20d | lokal `address pool` menutupi state var uint256 | 1 | 1 | Benar |
| A20e | `deposits[id].balance` (mapping uint) | 0 | 0 | Benar (bukan alamat; `.balance` atas uint tak valid) |

## Kalibrasi R19.2a (dari A18)

- `collectAddressTypedIdents` kini menghitung set `shadowed`: nama yang
  dideklarasikan param/lokal dengan tipe NON-address (param loop +
  pindai deklarasi `<Tipe> [lokasi] <nama>` atas badan yang string
  literal-nya di-mask), lalu menghapusnya dari set address-typed.
  Pengecualian: `return X;` / `delete X;` BUKAN deklarasi (probe wasit:
  `return pool;` sempat menghapus state var dari set — dikunci tes 43r).
- Tes baru seksi 43n–43r (5 tes): 43n lokal-struct → 0, 43o
  param-struct → 0, 43p lokal-address menutupi uint256 → 1, 43q nama
  sama beda fungsi → 1 dari g, 43r `return pool;` bukan bayangan → 1.
- **Test 548/548 PASS** (530 lama + 18 baru seksi 43). Commit lokal:
  `f366b1f` (R19.2) + `a26e84b` (R19.2a).

## Batas diketahui (sesudah R19.2/R19.2a)

- `arr[i].balance` / `map[k].balance` (akses terindeks) tidak dikenali
  (A16 — FN; butuh tipe elemen).
- Tipe kontrak/interface dari file lain (import) tidak dikenali (A17/A19
  — FN konservatif; `IERC20 token` param ikut kena).
- `x = T(addr)` (cast-assignment tanpa deklarasi) belum melacak tipe.
- Pindai bayangan memakai regex deklarasi — `return`/`delete`
  dikecualikan; string literal di-mask.

## Hunting re-run pasca-R19.2a (sesi #28, 2×)

IDENTIK, 0 kandidat baru — Fulcrom **15**, Amply **18**, RAAC **14**,
Hyperbridge **6**, Flow **0**; recall vs Kiro AMP tetap 4/7.
