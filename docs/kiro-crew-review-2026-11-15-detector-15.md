# Review silang Kiro crew atas detektor ke-15 (eth-locked-receive)

Tanggal: 15 Nov 2026, 12:39–12:47 WIB (sesi Frankenstein sprint #12).
Model: Claude Opus 5.5 (dipilih manual di sesi "Audit Bug Bounty Kontrak Solidity"
9bf915c9-a01e-4675-a9bb-b92f0a1c418a; pemilih awal menunjukkan Sonnet 5.5).
Kredit: 32,68 → 36,74 (delta 4,06; Est. Credits Used pada jawaban: 4.06;
elapsed 3m 34s). Kode detektor ditempel verbatim + konteks + 5 pertanyaan.

## Hasil uji Kiro (26 kasus di Node, stub stripComments sederhana)

- 14 dari 26 kasus = false positive, 7 = false negative (sebelum kalibrasi).
- Hampir semua FP berasal dari idiom keluar-ETH yang tidak dikenali.

## 1. Idiom keluar-ETH yang terlewat (semua terbukti FP di uji Kiro)

- Cast payable bersarang: `payable(owner()).transfer(x)` — `[^)]*` berhenti
  di `)` pertama. Bug paling sering menurut Kiro.
- `address payable` + immutable/constant: declRe lama menangkap kata
  `immutable` sebagai nama variabel.
- Array `address payable[]`: `rs[i].transfer(x)` — declRe mewajibkan spasi
  setelah `payable`, regex variabel tidak mengizinkan `[i]`.
- Solady/Solmate/Uniswap: `SafeTransferLib.safeTransferETH`,
  `forceSafeTransferETH`, `trySafeTransferETH`,
  `TransferHelper.safeTransferETH` — biasanya diimpor, isi call tidak ada
  di file.
- OZ Address: `Address.functionCallWithValue(t, data, x)` — hanya `sendValue`
  yang dikenali.
- Call option `{value:}` di luar `.call`: `IWETH(w).deposit{value: x}()`,
  `entryPoint.depositTo{value: msg.value}(…)`,
  `router.swapExactETHForTokens{value: x}(…)`, `new B{value: x}()`.
- Sintaks lama (≤0.6): `to.call.value(x)("")`.
- `msg.sender` / `tx.origin` (≤0.7): `msg.sender.transfer(x)` — aman
  ditambahkan karena di 0.8 kode itu tidak ter-compile untuk ERC20.
- Assembly: `call(gas(), to, v, 0, 0, 0, 0)`, `create(v, …)`,
  `create2(v, …)`.
- Koreksi premis: `WETH.withdraw()` adalah ETH MASUK, bukan keluar
  (WETH mengirim ETH ke kontrak); idiom keluarnya `deposit{value:}`.
  `delegatecall` bukan idiom keluar-ETH — itu kasus FP proxy (poin 2).

## 2. False positive

- Proxy delegatecall (OZ Proxy v4, ERC1967, Transparent, Beacon, Diamond,
  Safe proxy): kasus uji OZ Proxy menghasilkan 2 hit (receive + fallback);
  logika keluar-ETH ada di implementasi (file lain). Proxy hampir selalu
  ada di repo target.
- Outflow warisan dari file lain (`contract X is Rescuable`,
  `BasePaymaster`…) — tidak bisa diselesaikan di level file.
  SimplexPaymaster aman hanya karena `withdrawTo` kebetulan ada di file
  yang sama.
- Deklarasi tanpa body: `abstract contract A { receive() external payable
  virtual; }` → 1 hit; interface yang mendeklarasikan `receive` juga kena.
- `receive` yang langsung meneruskan ETH (`ep.depositTo{value:
  msg.value}(…)`, `IWETH.deposit{value:}`) — FP turunan dari gap
  `{value:}` poin 1; pola umum di paymaster.
- `receive` yang revert atau hanya menerima dari satu pengirim:
  `receive() external payable { revert(); }` → 1 hit; router Uniswap
  (`assert(msg.sender == WETH)` + `TransferHelper.safeTransferETH`).
- Mock/test: `mocks/`, `test/`, `*.t.sol`, `Mock*`, `Harness*` —
  HostManager hanya bisa dikenali lewat komentar "test-only", dan komentar
  itu sudah dibuang `stripComments`; filter path lebih andal.
- WETH sendiri aman dan sudah benar menghasilkan 0 (withdraw di dalamnya
  memakai `call{value:}`).

## 3. False negative (koreksi premis + yang terbukti)

- Premis yang SALAH: `fallback(bytes calldata d) external payable returns
  (bytes memory)` TETAP ter-flag (`[^)]*` menangani parameter dengan
  benar); `receive() external payable onlyX` tetap ter-flag; `receive` di
  interface menghasilkan FP, bukan FN.
- FN terbukti: `receive() payable external {}` (urutan modifier bebas);
  `receive() virtual external payable {}` + `override` di depan;
  `receive() onlyX external payable {}`; `function() external payable {}`
  dan `function() payable public {}` (≤0.5, fallback tanpa nama).
- Suppression oleh DEKLARASI, bukan pemanggilan: `function
  withdrawTo(address,uint)` di kontrak sendiri yang hanya mengirim ERC20
  (gaya OZ ERC20Wrapper) ikut menekan; `withdrawTo` di interface
  `IEntryPoint` dalam file yang sama juga menekan walau tidak pernah
  dipanggil. Pola `sendValue\s*\(` punya masalah yang sama.
- Outflow di kontrak LAIN dalam file yang sama: `contract B { …transfer…
  } contract A { receive… }` membuat A ikut tertekan.
- Batas desain (tidak diuji Kiro): `call{value: 0}` atau `call{value:
  msg.value}` yang hanya meneruskan nilai tetap menekan, padahal ETH dari
  receive tidak pernah bisa keluar.

## 4. Severity

- Info sudah tepat sebagai default.
- Varian layak naik ke Low (ETH masuk lewat alur normal protokol, bukan
  kesalahan pengguna): file memanggil `IWETH(…).withdraw(…)` tetapi tidak
  punya jalur keluar-ETH; kontrak menjadi `refundAddress` / `refundTo =
  address(this)` untuk fee bridge/messaging (LayerZero, CCIP,
  Hyperbridge); fungsi payable yang menerima `msg.value` lebih dari yang
  dipakai tanpa refund (di luar regex receive, kelas sama).
- Tetap Info/turun: kontrak di balik proxy upgradeable (rescue bisa
  ditambah lewat upgrade); `receive` dengan guard `msg.sender == WETH`.

## 5. Usulan perbaikan Kiro (urut prioritas) + status penerapan

1. Perlebar idiom keluar-ETH — **DITERAPKAN v3** (call option `{value:}`
   umum, cast bersarang, declRe immutable/constant/array, safeTransferETH
   family, `functionCallWithValue`, `.value(` legacy, `msg.sender`/
   `tx.origin` transfer/send, assembly `call(gas(),…)`). Dua regex panjang
   Kiro terpotong tampilannya di halaman (declRe lengkap + regex
   receive/fallback) — diterapkan versi jack yang diuji sendiri 116/116.
   `create`/`create2` assembly BELUM diterapkan (batas diketahui).
2. Tangani proxy terpisah — **DITERAPKAN v3**: file memuat
   `delegatecall(`/`_delegate(`/`_fallback(` → tidak ada hit.
3. Regex receive/fallback baru (hanya bila ada body, modifier urutan apa
   pun, fallback lama) — **DITERAPKAN v3**; `receive()` yang langsung
   `revert()` BELUM diturunkan ke skip (batas diketahui).
4. Cakupan per-kontrak + hitung pemanggilan, bukan deklarasi —
   **SEBAGIAN DITERAPKAN v3**: `withdrawTo`/`withdrawStake`/`sendValue`
   kini pola pemanggilan (`(?<!function\s)`). Pemecahan per-contract +
   pass proyek (rantai `is`) BELUM dikerjakan — butuh desain, dicatat
   sebagai batas diketahui di pipeline.js.
5. Filter path + kalibrasi severity — **DITERAPKAN v3/v3.1**: path
   test/mock dilewati; naik Low bila `IWETH.withdraw` / `refund=
   address(this)`. v3.1: `.withdraw(` polos TIDAK cukup — HostManager
   Hyperbridge (`IHostManager(...).withdraw()`, tarik revenue bridge)
   sempat ter-elevasi palsu ke Low; wajib ada WETH di receiver.

## Verifikasi pasca-kalibrasi (sesi ini)

- Test suite: **116/116 PASS** (94 lama + 22 baru seksi 15/15b).
- Hunting re-run 15 detektor (+ baseline): Amply 18 (identik, FA-AMP-18/19
  tetap Info), RAAC 8 (identik), Hyperbridge 2 (FA-HYP-07 kembali Info
  sesudah v3.1; FA-HYP-04 tx-origin High tetap), Flow 0. **0 kandidat
  baru; tidak ada entri KANDIDAT FRANKENSTEIN baru sesi ini.**
- Ground truth trap-vault tetap 16 kandidat (TrapVault punya
  `call{value:}` → tertekan dengan benar).
