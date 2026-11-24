# Review R19.4 — tipe kontrak/interface dari import di D19 (residual A17/A19) — sesi 16:38 WIB 18 Nov 2026

## Pass Kiro crew: TIDAK JALAN (tabrakan login — preseden sesi #21/#25/#29)

- Sesi BB sore 18 Nov berjalan paralel (checkpoint 3 ±17:00 WIB — pass
  Kiro #10 atas konsensus Hyperbridge sedang berjalan, browser task
  88bc7304, Sonnet 5.5). Sesi ini TIDAK memakai Kiro Web sama sekali;
  dashboard TIDAK dicek ulang (terakhir 268,03/4.000, sisa 3.731,97,
  45 hari → tempo ≈82,9/hari — pas garis). Kredit Kiro sesi ini: 0.
- **Pengganti: review wasit lokal** — probe 8 kasus atas pipeline
  lokal (`/tmp/probe-wasit-r194.js`, dihapus sesudah pakai, dikunci
  jadi tes seksi 47 di `tests/run-m2-tests.js`).

## Celah yang dibuktikan probe (pra-perbaikan)

| Kasus | Bentuk | Harap | Dapat | Vonis |
|---|---|---|---|---|
| P1 | proyek: `IERC20` di file lain, param `IERC20 token` + `token.balance` | 1 | 0 | **FN TERBUKTI (A19 literal)** |
| P2 | kontrol: param `address token` + `token.balance` | 1 | 1 | Benar (bentuk probe valid) |
| P3 | proyek: `IVault` di file lain, param `IVault vault` + `vault.balance` | 1 | 0 | **FN TERBUKTI (A17)** |
| P4 | proyek: param `IERC20[] tokens` + `tokens[0].balance` | 1 | 0 | **FN TERBUKTI (bentuk terindeks, kelas yang sama)** |
| P5 | proyek: struct lokal `IERC20` menutupi interface file lain | 0 | 0 | Benar (penjaga struct) |
| P6 | single-file: `IVault vault` tanpa definisi di file | 0 | 0 | Benar (konservatif) |
| P7 | single-file: `IERC20 token`, interface tidak ada di korpus | 1 | 0 | **FN TERBUKTI (kasus nyata: IERC20 dari OZ, dependencies dikecualikan dari korpus hunting)** |
| P8 | single-file: struct lokal `IERC20` + `info.balance` | 0 | 0 | Benar (penjaga struct) |

Catatan probe: bentuk `payable(to).transfer(x)` (ETH 1-arg) TIDAK
memicu D19 — detektor membaca `.transfer(` sebagai ERC20 2-arg
(`args[1]` = jumlah). Bukan cacat probe R19.4; bentuk itu di luar
cakupan D19 saat ini (batas diketahui, tidak dikerjakan sesi ini).

## Kalibrasi R19.4 (wasit jack)

1. **Gabungan nama tipe proyek** — `runProjectPipeline` menghitung
   union nama kontrak/interface + struct dari SEMUA file korpus
   (`contractSpans` + `structNamesOf` per file) lalu meneruskannya
   via `opts.projectContractTypeNames` / `opts.projectStructNames`;
   `runPipeline` menggabungkannya ke ctx. Mode single-file (tanpa
   opts) tetap memakai set lokal saja — konservatif.
2. **Allowlist interface standar ERC** — `WELL_KNOWN_INTERFACE_TYPES`
   (21 nama: `IERC20`, `IERC20Metadata`, `IERC721`,
   `IERC721Metadata`, `IERC721Enumerable`, `IERC721Receiver`,
   `IERC1155`, `IERC1155MetadataURI`, `IERC1155Receiver`, `IERC4626`,
   `IERC165`, `IERC777`, `IERC2981`, `IERC3156FlashBorrower`,
   `IERC3156FlashLender`, `IWETH`, `IWETH9`, `ERC20`, `ERC721`,
   `ERC1155`) di `isAddressTypeName`, dicek SESUDAH struct-guard —
   struct/enum senama di file ini tetap menang. Ini yang memperbaiki
   P7: di korpus hunting nyata, `IERC20` berasal dari OZ yang
   dikecualikan dari korpus, jadi union proyek saja TIDAK cukup.
3. **Satu jalur penilaian tipe elemen** — kedua helper `elemIsAddress`
   (R19.3, `collectIndexedAddressBases` + `scanIndexedAddressStateBases`)
   kini mendelegasikan ke `isAddressTypeName` (sebelumnya menduplikasi
   logika address/struct/kontrak). Perilaku sama kecuali allowlist.
4. **`dispatcherNames` R18.4b tetap dari set LOKAL** — sengaja TIDAK
   memakai gabungan proyek: nama kontrak file lain tidak boleh
   mengikat sinyal dust ke kandidat D18 file ini. Dikunci tes 47i
   (dua sinyal dust di file B menyebut `DustVault` → kandidat D18
   di file A tetap Medium; bila set gabungan dipakai, keduanya
   terikat → Low palsu).

## Hasil pasca-kalibrasi

- **Probe 8/8 PASS**; suite **597/597 PASS** (588 lama + 9 baru
  seksi 47: 47a–47i).
- **Hunting re-run 5 permukaan IDENTIK, 0 kandidat baru** —
  Fulcrom **15**, Amply **18**, RAAC **14**, Hyperbridge **6**,
  Flow **0**; recall vs Kiro AMP tetap 4/7. FA-005
  `CallDispatcher.dispatch` tetap **Low dust-by-design**.
  Artinya: di korpus nyata saat ini tidak ada `ident.balance` /
  `BASE[i].balance` baru yang terungkap oleh R19.4 — kalibrasi
  menutup kelas FN tanpa menambah noise.

## Batas diketahui (sesudah R19.4)

- `x = T(addr)` (cast-assignment tanpa deklarasi) belum melacak tipe.
- `.transfer(x)` 1-arg (ETH) belum dibaca D19 sebagai jumlah sweep.
- Tipe kontrak dari file di LUAR korpus (bukan allowlist) tetap 0
  di mode proyek — mis. interface proyek lain yang tidak ikut
  ter-clone; single-file tetap konservatif kecuali allowlist.
- F5/F6 taint, F11 label-per-target, `encodeWithSelector`
  transferFrom 4-arg, F8 swap-output rename — residual terbuka lain,
  tidak dikerjakan sesi ini.
