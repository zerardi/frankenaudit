# Review Kiro crew atas detektor ke-23 + kalibrasi wasit R23

Tanggal: 2026-11-19 (sesi Frankenstein #37, 16:38 WIB).
Detektor: `refund-locked-middleware` (kelas VENO-C1 BridgeMiddleware zkCRO).
Pass Kiro: sesi BARU e10bdb74-d30a-4e3a-9315-d7a13d02a61e,
https://app.kiro.dev/session/e10bdb74-d30a-4e3a-9315-d7a13d02a61e,
model Claude Opus 5.5 disetel eksplisit — TANPA penolakan, TANPA flag
MODEL_TIDAK_SESUAI. Footer sesi 7,95 kredit; dashboard 325,8 → 333,75.
Login Google SSO tanpa hambatan (browser task 2b3b400e, 16:47–16:57 WIB).

## Vonis Kiro: NEEDS WORK (F1–F18)

Metode Kiro: detektor dijalankan di Node 22 dengan stub helper tulis
sendiri (asumsi stub: body = isi dalam kurung kurawal — BERBEDA dari
`extractFunctions` proyek yang body-nya mulai dari kata kunci
`function`; C01 rekonstruksi, bukan BridgeMiddleware asli). Hasil per
kasus: 31 kasus, 9 lolos / 22 tidak sesuai harapan (10 FP + 12 FN).

## Verifikasi wasit (probe kode ASLI, /tmp/probe-d23-r23.js)

Pra-kalibrasi: **5/35 lolos** — semua temuan Kiro terreproduksi di kode
asli KECUALI F14. Pasca-kalibrasi: **35/35 PASS**; suite **758 → 781/781**
(Seksi 57b, 23 tes baru).

### DITERIMA + DIPERBAIKI (R23)

- **F1 (cast inline)** — TERBUKTI. `IBridgehub(x).requestL2...` tak
  cocok regex lama (identifier wajib sebelum titik). Perbaikan:
  `bridgeCallIn` kini memindai `.method(` lalu membaca objek mundur —
  identifier polos ATAU cast `Type(args)` (scan balik seimbang paren).
- **F2 (getter + first-match)** — TERBUKTI. `bridge\w*` tak berjangkar
  cocok `bridgehub()`/`bridgeFee()`; first-match membayangi panggilan
  asli. Perbaikan: regex method berjangkar `^...$`, daftar getter
  (`get*`/`is*`/`has*` + bridgehub/bridgeFee/baseToken/sharedBridge/dll.
  dieksklusi), SEMUA kecocokan dikumpulkan + skor (strong 3 / bridge-verb
  2 / deposit 2), terbaik menang.
- **F3 (substring objek)** — TERBUKTI. `l1` cocok di `pool1`,
  `gateway` di `wethGateway`, `messenger` di `tokenMessenger`.
  Perbaikan: cabang `deposit*` kini mensyaratkan token camelCase objek
  = `bridge*` ATAU `router` (awalan `I` antarmuka dibuang) — `pool1`/
  `wethGateway`/`tokenMessenger` gugur; `l1Bridge`/`router`/`IBridgehub`
  tetap.
- **F4 (`_msgSender()`)** — TERBUKTI. Inflow kini menerima
  `msg.sender` ATAU `_msgSender()`; lookahead rescue diperluas ke
  `_msgSender()` (fungsi bridge tak lagi dianggap rescue dirinya).
- **F5 (`to.transfer` ETH)** — TERBUKTI. `p.transfer` polos atas
  parameter `address` = transfer ETH, bukan rescue. Perbaikan: bare
  `p.transfer/safeTransfer` hanya bila `p` bertipe IERC20; bila `p`
  address, wajib bentuk `IERC20(p).transfer/safeTransfer`.
- **F6 (rescue di fn bridge)** — TERBUKTI. `findRescue` kini
  mengecualikan fungsi yang berisi panggilan bridge (dust di tx yang
  sama tidak menolong refund yang mendarat belakangan).
- **F7 (bentuk rescue)** — TERBUKTI. Ditambah: parameter bertipe
  IERC20 (`token.safeTransfer`), `SafeERC20.safeTransfer(IERC20(p),…)`,
  delegasi helper internal 1 hop, `execute(target,data)` arbitrer
  ber-guard (C31).
- **F8 (rescue palsu)** — TERBUKTI. `transferFrom` DIHAPUS dari pola
  rescue (revert tanpa self-allowance); `require(p == KONSTANTA)`
  (allowlist) membatalkan rescue.
- **F9 (rescue di parent)** — TERBUKTI. `findRescue` kini mencari di
  kontrak + leluhur file-lokal (transitif via `contractSpans.parents`).
- **F10 (delegatecall file-wide)** — TERBUKTI. Skip file hanya bila
  `receive()`/`fallback()` mendelegasikan (proxy); multicall ke
  `address(this)` tidak membungkam file.
- **F11 (library)** — TERBUKTI. Resolusi 1 hop ke fungsi library
  (`Lib.fn`) dengan indeks dikembalikan ke situs pemanggilan (nomor
  baris tetap benar).
- **F12 (semantik refund Direct)** — TERBUKTI, diverifikasi wasit ke
  SUMBER PRIMER era-contracts di korpus (bukan sekadar klaim Kiro):
  `Messaging.sol` — "refundRecipient … If the transaction fails, then
  this address will receive the `l2Value`" (di L2); `L1Bridgehub.sol`
  `requestL2TransactionDirect` — tanpa pencatatan nullifier (beda dari
  TwoBridges yang memanggil `bridgehubConfirmL2Transaction`);
  `L1AssetRouter.depositLegacyErc20Bridge` — "Save the deposited amount
  to claim funds on L1 if the deposit failed on L2" (jalur TwoBridges).
  Perbaikan: panggilan `requestL2TransactionDirect` hanya dihitung
  bila `refundRecipient = address(this)`; bila ke user lain → skip.
  DAMPAK: **FA-009 zkCROMintAndBridge GUGUR** (FP — refund kembali ke
  `_l2Receiver` di L2, bukan terkunci); VENO-C1 (TwoBridges) tak
  berubah.
- **F13 (receive revert/terbatas)** — TERBUKTI. `receive()` yang
  berisi `revert` / `require(msg.sender == …)` kini dihitung tak ada.
- **F15 (jangkar 2 hop)** — TERBUKTI. Jangkar kini BFS transitif
  ≤3 hop ke entrypoint external/public terdekat.
- **F16 (severity)** — DITERIMA. Low bila jalur hanya-ETH (tanpa
  tokenInflow) ATAU kontrak upgradeable (`*Upgradeable` di parents /
  `_authorizeUpgrade`).
- **F17 (teks bukti)** — TERBUKTI. Catatan ETH-revert hanya bila ada
  jalur ETH (`{value:}` ke bridge — payable + `msg.value` sebagai
  mintValue saja bukan jalur ETH); frasa hard-coded "token tertentu /
  ETH ke treasury" dihapus.
- **F18 (path filter)** — TERBUKTI. Ditambah: direktori `script/`,
  `.s.sol`, sufiks `Mock`/`Harness` sebelum `.sol`.
- **W1 (wasit, hunting pra-kalibrasi)** — Panggilan ke kontrak
  `*middleware*` lain (`bridgeMiddleware.bridge`) BUKAN bridge-forward
  (deposit sender-nya middleware itu). Perbaikan: callee bernama
  `*middleware*` dikecualikan. DAMPAK: **FA-005 ybETHBridge + FA-008
  ybUSDBridge GUGUR** (FP transitif).

### DITOLAK wasit

- **F14 (nomor baris salah)** — ARTEFAK STUB. Klaim Kiro (laporan
  baris 21 vs asli 24) berasal dari asumsi stub-nya (body = isi dalam
  kurung kurawal). `extractFunctions` proyek: `body` mulai dari kata
  kunci `function` = `startIndex`, jadi `startIndex + index-dalam-body`
  adalah offset absolut yang benar. Bukti: kandidat FA-004 atas
  BridgeMiddleware asli melaporkan "(baris 234)" dan `grep -n`
  memastikan `requestL2TransactionTwoBridges` memang di baris 234.
  Dikunci tes 57b-0. Tidak ada perubahan kode.

### DITERIMA + DIPERBAIKI (R23, lanjutan — dari hunting re-run)

- **F19 (wasit, hunting pasca-R23)** — Perbaikan F1 (cast inline)
  membuka hit baru yang ternyata FP: `L1Bridgehub.requestL2-
  TransactionDirect` memanggil `IAssetRouterShared.bridgehubDeposit-
  BaseToken` dan `AssetRouterBase._bridgehubDepositBaseToken` memanggil
  `IAssetHandler.bridgeBurn` — ketiganya adalah PLUMBING protokol
  (bridgehub/router/nullifier itu sendiri), bukan middleware penerus
  deposit user; refund tidak kembali ke kontrak-kontrak ini sebagai
  deposit sender. Perbaikan: kontrak bernama `*bridgehub*` /
  `*assetrouter*` / `*sharedbridge*` / `*nullifier*` dikecualikan dari
  D23. DAMPAK: **FA-009/010/011 (inti bridge) GUGUR**; Veno pasca-R23
  final = **8 kandidat, D23 tinggal FA-004** (konfirmasi VENO-C1).
  Batas: middleware yang kebetulan bernama `*SharedBridge*` ikut
  terkecuali (dinilai kecil kemungkinannya; tercatat).

## Hasil hunting pasca-R23

- Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 7, Flow 0, Veno zkEVM 0 —
  identik (0 D23 baru, 0 FP baru).
- Veno (Ethereum, 262 file) **11 → 8**: D23 tinggal **FA-004
  BridgeMiddleware#bridge = KONFIRMASI pipeline atas VENO-C1**; gugur:
  FA-005/FA-008 (transitif, W1), FA-009 zkCROMintAndBridge (Direct, F12),
  FA-009/010/011 inti bridge (F19). 0 kandidat submit baru.

## Batas diketahui (baru)

- `deposit*` pada objek tanpa token `bridge`/`router` (mis.
  `l1Messenger.deposit`) tidak ter-flag — FN konservatif.
- Rescue lewat `transferFrom` dari kontrak KETIGA (bukan
  `address(this)`) tidak dihitung — jarang, batas diketahui.
- `execute` arbitrer TANPA guard tidak dihitung rescue (itu ranah D18).
- Jangkar transitif dibatasi 3 hop; rantai lebih panjang jangkar ke
  fungsi bridge internal.
- Semantik refund non-zkSync (bridge lain) tetap diserahkan ke toVerify
  butir 1.
