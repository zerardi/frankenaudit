# Review Kiro crew atas detektor ke-18/ke-19 + kalibrasi wasit R18.1/R19.1

- Sesi Kiro: "Audit Detectors 18-19 H3" — https://app.kiro.dev/session/f2ea3494-60f2-4106-8815-96d0b113f925
- Waktu: 17 Nov 2026, 20:51–21:05 WIB (browser task faf2eceb, 14 mnt).
- Model: **Claude Opus 5.5 eksplisit, tanpa penolakan, tanpa flag MODEL_TIDAK_SESUAI** (footer UI tetap Opus 5.5; tidak ada "refused; answered by Opus 4.8").
- Kredit: dashboard 178,92 → **182,29/4.000, delta 3,37** (footer "Est. Credits Used: 3.37, Elapsed Time: 3m 44s" — cocok).
- Login: akun sudah masuk sebagai jjijundaq@gmail.com; tanpa klik Google, tanpa password/2FA.
- Metode Kiro: harness Node atas detektor (33 kasus menurut jawabannya).
- Vonis Kiro: **NEEDS WORK** untuk kedua detektor (F1–F20).

## Disposisi wasit (jack) — tiap klaim diverifikasi probe ke pipeline ASLI

Probe: `/tmp/wasit1819/probe.js` + `/tmp/wasit1819/debug.js` (node, atas `app/pipeline.js` v1 pre-kalibrasi).

### Detektor 18 — permissionless-dispatcher

| Klaim Kiro | Vonis wasit | Bukti probe |
|---|---|---|
| (a1) onlyGateway tak dikenali → FN | **TERBUKTI — tapi label salah: ini FP, bukan FN** (fungsi ber-guard ikut ter-flag) | P-a1: `onlyGateway` + dispatch → 1 (flagged). F1 diadopsi. |
| (a2) require(msg.sender == gateway) → CORRECT; pola itu juga menangkap `!= address(0)` | **SEBAGIAN BENAR**: (a2) CORRECT; klaim `!=` SALAH untuk regex `require` (`!=` tak cocok `==`) — tapi `require(msg.sender == address(0))` BENAR ikut dihitung guard | P-a2a: `== address(0)` → 0 (dianggap guard). F2-narrow diadopsi (RHS harus identifier, bukan `address(0)`). |
| (a2b) guard `if (msg.sender != X) revert` | **TERBUKTI** (temuan wasit dari prioritas F1/F2 Kiro) | P-a2b: if-revert → 1 (flagged). Pengenalan if-revert ditambahkan. |
| (a3) delegatecall → CORRECT | **BENAR** | Sudah tes 38c. |
| (a4) functionCall → CORRECT | **BENAR** | Sudah tes 38f. |
| (a5) `calls[i].target.call(...)` terlewat (F4) | **TERBUKTI** | P-a5/P-a5b → 0. Akar: capture `[\w.$()]+?` menelan `.target` diawali titik → ditolak validasi, `.call` sudah terkonsumsi (debug: satu match recv=`.target`). F4 diadopsi: receiver harus diawali identifier + segmen `[..]`/member/call. |
| (a6) target immutable + data caller → CORRECT, label/severity bedakan (F11) | **BENAR flag-nya; F11 DITUNDA** | Detektor function-scoped tak tahu tipe state var; label seragam Medium. Batas diketahui, wasit men-triase. |
| (b) `.call{value:}("")` — pengecualian benar, tapi drain ETH-only terlewat → aturan saudara F8 | **TERBUKTI** | P-f8: bare drain `(bool ok,)=to.call{value:amt}("")` → 0 di D18+D19. F8 diadopsi sebagai detektor ke-20 `permissionless-value-send`; F9 dipatuhi (D18 tetap hanya data non-empty). Catatan: contoh Kiro "withdraw msg.sender.call" keliru — itu withdraw sah (receiver msg.sender dikecualikan F8). |
| (e) assembly call/delegatecall terlewat (F3) | **TERBUKTI** | P-asm: assembly `call(gas(), target, ...)` → 0. F3 diadopsi (sink assembly dasar; staticcall dilewati — view-only). |
| (e) internal dispatcher + external forwarder lolos (F10) | **DITUNDA** | Butuh call-graph satu hop lintas fungsi (di luar cakupan function-scoped). Batas diketahui, bukan dikerjakan sesi ini. |
| F5 taint receiver / F6 taint data | **DITOLAK (sementara)** | Taint nama-param naif akan MENOLAK target utama: `call.data` di CallDispatcher tak menyebut param `encoded` (alir via `abi.decode`) — butuh taint decode-flow penuh. Perilaku konservatif (flag) dipertahankan; wasit men-triase kasus data-tetap. |
| F7 sink diperluas | **DIADOPSI** | `functionDelegateCall`, `functionCallWithValueAndGas`, `functionDelegateCallWithGas` ditambahkan; varian staticcall SENGAJA dikecualikan. |

### Detektor 19 — full-balance-sweep

| Klaim Kiro | Vonis wasit | Bukti probe |
|---|---|---|
| (c1) var-form ERC20 → CORRECT | **BENAR** | Sudah tes 38h. |
| (c2) balanceOf inline → CORRECT | **BENAR** | Sudah tes 38i. |
| (c3) Call-struct `value:` terlewat | **DITOLAK — artefak** | P-c3: bentuk murni `Call({..., value: balance, ...})` → 1 (ter-flag). Diduga harness Kiro memakai replika / varian lain. Dikunci tes 39n. |
| (c4) rescue saldo sendiri FP | **TERJAWAB — sudah ditangani v1** | P-c4a var-form own-balance → 0; 38l direct-form → 0. F15 (pengecualian recipient address(this)/msg.sender) **DITOLAK**: membunuh target H3b — P-c4c placeOrder (recipient address(this)) → 1, harus tetap ter-flag. |
| (c5) `balance = balance - fee` tetap flag → CORRECT | **BENAR** | P-c5 → 1. F14 literal ("reassign = bukan full-balance") **DITOLAK** karena bertentangan dengan (c5); F18 diadopsi (assignment terakhir: turunan-dari-diri mempertahankan status, reassign penuh menghapus). |
| (c6) assignment multi-baris terlewat (F19) | **DITOLAK — artefak** | P-c6 → 1. `\s*` sesudah `=` sudah menelan newline (debug: rhs tertangkap utuh). F19 tak perlu. Dikunci tes 39n3. |
| (d) d1/d2 lazy-span FP "TERKONFIRMASI" | **SEBAGIAN SALAH**: contoh literal d1 (dua statement) **TIDAK FP** — flag berasal dari call kedua yang memang sweep (P-d1 → 1, benar); tapi mekanisme cross-paren **TERBUKTI** via d1b | P-d1b: `emit Log(transfer(a, 1), balance)` → 1 (FP nyata — balance bukan jumlah transfer). F12 diadopsi: posisi argumen via paren seimbang. |
| (d) transferFrom var sbg `from` → FP (F13) | **SUDAH BENAR di v1 untuk transferFrom** (prefix `[^,]+,` melindungi posisi); **TERBUKTI untuk encodeWithSelector** | P-d1c transferFrom(balance, to, amount) → 0 (sudah benar). P-d1d encodeWithSelector balance sbg recipient → 1 (FP). F13 diadopsi penuh via arg extraction posisional. |
| F14/F18 reassignment | **F18 DIADOPSI, F14 DITOLAK** (lihat (c5)) | P-c5b `balance = required` → 1 di v1 (FP); pasca-F18 → 0 (tes 39i). |
| F16 `ident.balance` / `payable().balance` / assembly `balance(x)` | **DIADOPSI SEBAGIAN (lite)**: `payable(X).balance` ditambahkan; `ident.balance` polos **TIDAK** dikenali (ambigu field struct — by-design); assembly `balance(x)` tidak dikerjakan (tak ada kasus korpus). | Tes 39l. |
| F17 `==` tertangkap assignment | **TERBUKTI** | P-e17: `x == balanceOf(pool)` lalu `transfer(to, x)` → 1 (FP). `=(?!=)` diadopsi. |
| F20 `value:` di directRe terlalu lebar | **DIADOPSI** (via rewrite F12/F13) | Nilai field `value:` kini dibaca sampai koma/`}` top-level saja. |

## Yang diterapkan (kalibrasi R18.1/R19.1 + F8)

1. `hasAccessGuard`: +13 modifier only* (F1: onlyGateway, onlyDispatcher, onlyIntentGateway, onlyExecutor, onlyCaller, onlyTrusted, onlyBridge, onlyMessenger, onlyAdapter, onlyModule, onlySafe, onlyMultisig, onlyTimelock); `require(msg.sender == X)` hanya bila RHS identifier (bukan `address(0)`); guard `if (msg.sender != X) revert` dua arah (F2).
2. Detektor 18: receiver capture F4 (identifier-anchored + segmen `[..]`); sink F7; sink assembly F3 (`call`/`delegatecall`/`callcode`, target argumen ke-2; staticcall dikecualikan).
3. Detektor 19: tulis ulang — argumen posisional via `splitTopLevelArgs` (F12/F13/F20); assignment `=(?!=)` + semantik assignment-terakhir (F17/F18); `payable(X).balance` (F16-lite).
4. Detektor ke-20 `permissionless-value-send` (F8, Medium): `.call{value:}(...)` data kosong + `.transfer`/`.send` satu argumen, target pilihan caller; receiver msg.sender/owner/beneficiary/address(this) + value 0 dikecualikan; ERC20 transfer (2 argumen) dikecualikan via hitung argumen.
5. Fixture: BUG 21 `drainValue` + kontrol N (withdrawToOwner/withdrawSelf) + O (payToken); ground truth 22 → **24 kandidat**; negative control 17 → **21**.
6. Tes: **482/482 PASS** (457 lama + 25 baru seksi 39 — semua probe wasit dikunci sebagai regresi).

## Batas diketahui baru (residual)

- (R18-a) F10: forwarder satu-hop (external → internal dispatcher) tak dilacak — butuh call-graph.
- (R18-b) F5/F6: taint receiver/data (decode-flow) belum ada — detektor konservatif (flag), wasit men-triase kasus data-tetap / target-immutable (F11: label seragam Medium).
- (R19-a) `ident.balance` polos tak dikenali (by-design, anti-FP struct-field); assembly `balance(x)` tak dikenali.
- (R19-b) `encodeWithSelector(...transferFrom.selector...)`: jumlah diambil argumen ke-3 (posisi transfer) — untuk transferFrom (4 argumen) jumlah sebenarnya argumen ke-4 → terlewat (konservatif, tanpa FP).
## Kalibrasi lanjutan dari hunting re-run (R18.2/R20.1, sesi yang sama)

Hunting re-run pasca-R18.1/R19.1 menemukan 4 FP RAAC + 4 FP wrapper Hyperbridge; semuanya dibedah ke kode nyata sebelum diperbaiki:

- **RAAC 4× `permissionless-dispatcher` (FA-003..006) — GUGUR, FP**: `LendingPool.initiateLiquidation/closeLiquidation/finalizeLiquidation` + `StabilityPool.liquidateBorrower` mendelegasikan ke proxy likuidasi TETAP (`liquidationProxy`/`liquidationStrategyProxy`, state var — diubah hanya via `onlyRole(PROTOCOL_ROLE)`) dengan selector TETAP (`abi.encodeWithSignature("initiateLiquidation(address,address,bytes)")`, dst.) — bukan arbitrary target/data. Akar FP: `hasAccessGuard` tak mengenal modifier majemuk (`onlyManagerOrOwner`, `onlyStabilityPool`, `onlySupportedAdapter` — `\bonlyManager\b` gagal karena `OrOwner` menempel). **Perbaikan R18.2**: pola only* dibuat GENERIK (`only[A-Z]...`) + `notBlacklisted`; pasca-perbaikan RAAC kembali **14** (0 D18). Batas: F5/F6 prinsipil (bedakan target-tetap vs arbitrer) tetap belum dikerjakan — penekanan kini lewat heuristik only*.
- **Hyperbridge 4× `permissionless-value-send` wrapper Uniswap — GUGUR, FP**: `swapETHForExactTokens` (`WETH().call{value: msg.value}` — wrap ETH caller sendiri ke alamat WETH tetap) + `swapExactTokensForETH` Gnosis/UniV3 (tarik `amountIn` dari msg.sender → unwrap → kirim ke `to`). **Perbaikan R20.1**: F8 mengecualikan (a) nilai persis `msg.value`, (b) receiver panggilan tanpa-arg (`WETH()` = alamat tetap), (c) nilai identifier yang ditarik dari msg.sender via `transferFrom` di fungsi yang sama. Pasca-perbaikan Hyperbridge 9 → **6**; tersisa 1 F8 (UniV3 `swapExactTokensForETH`, nilai `amountOut` — output swap dari deposit `amountIn` caller, variabel output ≠ variabel input → lolos cek (c); **GUGUR wasit, batas diketahui**: F8 tak melacak turunan swap-output).
- **Hyperbridge FA-005 `_execute` sweep (Low) — instance BARU kelas H3b**: `IntentsBase._execute` menyapu saldo penuh dispatcher sisi OUTPUT (`balanceOf(dispatcher)` / `dispatcher.balance` → gateway, `emit DustCollected`) — kelas yang sama dengan sweep input `placeOrder` (FA-004). Bukan kandidat submit baru; bahan untuk draf H3 (sisi output).
- **Tes akhir: 488/488 PASS** (482 + 6 baru seksi 40). Hunting akhir: Fulcrom **15**, Amply **18** (recall 4/7), RAAC **14**, Hyperbridge **6**, Flow **0**.
