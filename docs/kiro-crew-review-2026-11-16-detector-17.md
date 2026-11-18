# Review silang Kiro — detektor ke-17 `dead-config-storage` (v2)

- **Tanggal:** 16 Nov 2026, 00:41–01:21 WIB (browser task, 43 mnt)
- **Model:** Claude Opus 5.5 (sudah terpilih di sesi Kiro)
- **Sesi Kiro:** 9bf915c9-a01e-4675-a9bb-b92f0a1c418a ("Audit Bug Bounty Kontrak Solidity")
- **Metode:** kode ditempel verbatim (repo GitHub main 8c3c079 TIDAK berisi
  detektor #15/#16/#17 — hanya ada di repo lokal 225243b..fdbc819; push
  branch tidak bisa karena push via connector dijeda atas penolakan Toufik).
  Kiro menjalankan review dari tempelan itu di sandbox-nya (dengan jaringan:
  clone shallow GMX/Aave/Uniswap).
- **Kredit:** dashboard 58,28 → **76,74/4.000 (delta 18,46)**; sisa 3.923,26,
  47 hari → tempo ≈83,5/hari (sedikit di atas garis ±82–84).
- **Aturan read-only dipatuhi:** repo tidak diubah (`git status` bersih),
  folder scratch di luar repo dihapus Kiro.

## Vonis

| | v1 (sebelum) | v2 prototipe Kiro |
|---|---|---|
| Kasus adversarial | 36 | 33 deteksi |
| Benar | **15/36** | **29/33** |
| Salah | 6 FP + 13 FN + 2 salah-klasifikasi upstream | 4 sisa tetap ter-flag tapi turun ke Info (F1, F3, F6, F14) |

Validasi harness Kiro: replika seksi 18 lolos 15/15; cuplikan trap-vault
menghasilkan persis {configDead, feeBps, thresholdDead}; liveCounter dan
traderReferralCodes tidak di-flag; trap-vault.sol versi main (tanpa BUG 18)
menghasilkan hit feeBps@payFee. Batasan dicatat Kiro sendiri: kasus uji
ditulis Kiro (risiko overfit pada v2); suite 172 tes lokal tidak dijalankan
karena kodenya tidak ada di main.

## Kasus FP (harap 0 hit; YA = detektor salah mem-flag)

| # | Pola | v1 | Perbaikan v2 |
|---|---|---|---|
| F1 | baca getter kontrak lain file sama (`cfg.paused()`) | YA | P1: tetap ter-flag, turun ke Info |
| F2 | `assembly { sload(fee.slot) }` | benar | — |
| F3 | `assembly { sload(0) }` (slot mentah) | YA | P10: tetap ter-flag, turun ke Info |
| F4 | `this.flag()` | benar | — |
| F5 | dibaca kontrak turunan file sama | benar | P7: baca turunan (transitif) tetap dihitung |
| F6 | base abstrak, var internal, pembaca di file lain | YA | P2: heuristik abstract+internal → Info (project-pass penuh ditunda) |
| F7–F11 | `emit E(fee)`, argumen external call, `delegatecall`, `abi.encode`, `keccak256` | benar | — |
| F12–F13 | storage ref ke helper, struct field read `cfg.fee` | benar | — |
| F14 | `uint256 public override fee` (getter interface) | YA | P1: tetap ter-flag, turun ke Info |
| F15–F16 | baca di modifier, rantai `super.quote()` | benar | super dihitung baca (tambahan jack — v2 Kiro juga 0 di sini) |
| F17 | lokal senama di blok `if`, state var dibaca sesudah blok | YA | P5: shadowing per-blok, bukan per-fungsi |
| F18 | lokal di `receive()` diperlakukan sebagai state var | YA | receive/fallback dikeluarkan dari decl state var |

## Kasus FN (harap 1 hit; TIDAK = detektor salah melewatkan)

| # | Pola | v1 | Perbaikan v2 |
|---|---|---|---|
| N1 | tulis via `sstore(fee.slot, v)` | TIDAK | P6: sstore → tulis |
| N2 | param modifier `check(uint256 fee)` dibaca | TIDAK | param modifier menutupi |
| N3 | var senama di kontrak lain (file sama) | TIDAK | P7: cakupan per-kontrak |
| N4 | `infos[u].limit = v` (tulis field dihitung baca) | TIDAK | P6: rantai member-assign → tulis |
| N5 | array hanya `list.push(a)` | TIDAK | P6: push/pop → tulis |
| N6 | tuple `(fee, cap) = abi.decode(...)` | TIDAK | P6: tuple LHS → tulis |
| N7 | named return `returns (uint256 fee)` | TIDAK | P5: nama return menutupi |
| N8 | nama hanya di string literal `"fee too high"` | TIDAK | P8: string di-mask sebelum analisis |
| N9 | lokal di fungsi satu baris | TIDAK | P5: regex lokal dilonggarkan |
| N10 | lokal di header for | TIDAK | P5: sama |
| N11 | `event FeeUpdated(uint256 fee);` | TIDAK | P4: skip deklarasi event/error |
| N12 | `error FeeTooHigh(uint256 fee);` / fungsi interface tanpa badan | TIDAK | P4: skip + span interface |
| N13 | tuple lokal `(uint256 fee, ) = ...` | TIDAK | P5: sama |
| N14 | baca hanya di NatSpec/komentar | benar (di-flag) | — |
| N15 | hanya `fee += v` | benar (di-flag) | — |

## Klasifikasi upstream (U)

- **U1:** baseline hanya punya param event senama → v1 live-divergent (salah),
  ideal live-identical → diperbaiki P4.
- **U2:** baseline var senama dibaca di kontrak lain (file baseline) → v1
  live-divergent (salah), ideal live-identical → diperbaiki P7.
- **U3:** baseline membaca lewat modifier → sudah benar (live-divergent).
- **Celah lain (saran Kiro, DIKERJAKAN sesi ini):** lookup baseline berbasis
  nama file — file/kontrak yang di-rename dianggap baseline tidak ada.
  **Fallback nama kontrak ditambahkan di `classifyUpstreamDiff`:** bila
  basename miss, cari baseline yang nama kontraknya sama sesudah normalisasi
  sufiks versi (`VaultPriceFeedV2` → `VaultPriceFeed`). Hasil: FA-FUL-02/03
  (`favorPrimaryPrice`/`spreadThresholdBasisPoints`) kini teranotasi
  `live-divergent; baseline VaultPriceFeed.sol` oleh pipeline sendiri
  (sebelumnya hanya verifikasi manual wasit); Fulcrom tanpa-baseline 9 → 3.

## Temuan tambahan Kiro (helper bersama)

`stripComments` tidak mengenali string kutip tunggal — `'ipfs://cid'`
memotong sisa baris; pada uji Kiro, `uint256 public fee;` dan getter di baris
yang sama ikut hilang. **Diperbaiki sesi ini (P8):** stripComments kini
menangani `'...'` seperti `"..."` — mengenai SEMUA detektor, bukan hanya #17.

## Kalibrasi v2 yang diterapkan jack (di repo lokal)

P6 + P5 + P4 dulu (menutup 10/13 FN), lalu P1 + P3, P7, P8, P10, P11,
fallback rename. Penyimpangan/pilihan implementasi vs sketsa Kiro:

- **Urutan member-call:** `.name(` dihitung SEBELUM filter cakupan kontrak —
  kalau tidak, F1 tidak pernah tercatat (member-call selalu di luar span
  pemilik). Ditemukan saat 2 tes awal gagal.
- **`super.x()` = baca** (bukan member-call): getter kontrak induk via super
  adalah baca yang sah (F16).
- **Skip fungsi-tanpa-badan diperketat:** regex Kiro bisa menelan badan fungsi
  yang berisi `;` — versi jack mensyaratkan tidak ada `{` antara `)` dan `;`.
- **Shadowing lokal per-blok** dihitung via indeks char (cari `{` pembuka blok
  terdalam mundur + `}` penutup maju), bukan per-baris.
- **P2 project-pass lintas-file TIDAK diimplementasikan** (butuh pipeline
  multi-file) — diganti heuristik abstract+internal → Info; F6 penuh tetap
  residual.
- **P10 kasar di level file:** ada `sload/sstore` slot angka di file → semua
  hit file itu turun ke Info (bukan per-var).
- **P11 mensyaratkan file menyebut ERC20** (`/ERC20/` di source).

## Hasil tes lokal

**212/212 PASS** (172 lama + 40 baru: 36 kasus Kiro F/N/U + P3 + P11 +
2 tes fallback rename). Ground truth trap-vault tetap 20 kandidat.

## Verifikasi korpus nyata (jack, lokal)

Pipeline v2 atas GMX v1 `contracts/` lokal (154 file): **10 hit, 0 Low,
10 Info** — 8 param fee/leverage `public override` di Vault.sol + 2
ReferralStorage (`referrerTiers`, `referrerDiscountShares`, override).
Kiro atas clone penuh (610 file, 5 repo): v1 22 hit GMX v1; v2 file-scope 17
hit (10 Info) → 7 sesudah project-pass. Selisih hitungan dijelaskan: korpus
lokal hanya `contracts/` (tanpa duplikat `artifacts-v2`), P11 sudah menghapus
4 hit metadata ERC20, dan `ChainReader.latestBlockHash` tidak ada di baseline
lokal. Kesimpulan sama: **0 dari semua hit adalah bug kelas R-02.**

## Hunting re-run pasca-v2 (sesi ini)

Fulcrom **29 → 30** (baru FA-FUL-04 `PositionManager.feeAdmin`, Low — lihat
bb-log; 15 var Vault Low → Info via `override`); Amply **18**, RAAC **14**,
Hyperbridge **3**, Flow **0** — identik, 0 kandidat submit baru.

## Residual (untuk sesi berikut)

1. Project-pass lintas-file (P1 bagian kedua + P2 penuh): pembaca getter /
   kontrak turunan di file lain masih hanya heuristik.
2. Fallback rename memakai kontrak PERTAMA di file; file multi-kontrak bisa
   salah pasang bila kontrak pertamanya bukan yang dicari.
3. Heuristik abstract+internal bisa over-downgrade (var internal di kontrak
   abstract yang memang dead tetap Info, bukan Low).
4. Kasus uji 36 Kiro ditulis Kiro sendiri — risiko overfit; bila ada FP/FN
   baru dari hunting nyata, tambahkan sebagai regresi.
