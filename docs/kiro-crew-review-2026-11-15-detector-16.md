# Kiro Crew Review — Detector #16 `vacuous-identity-check` (kalibrasi v2 + v2.1)

**Tanggal:** 15 Nov 2026 (sesi 20:38 WIB) · **Reviewer:** Kiro crew, Opus 5.5, sesi "Audit Bug Bounty Kontrak Solidity" (`9bf915c9-a01e-4675-a9bb-b92f0a1c418a`), 20:49–21:10 WIB, Est. Credits Used **6.05** · **Target review:** detektor #16 v1 + fixture `trap-vault.sol` BUG 17.
**Hasil review Kiro:** fixture lolos; v1 benar hanya **6/30** kasus uji Kiro (7 FP + 22 FN); 0 hit / 0 FP di 2.549 fungsi (GMX v1/v2, Aave v3 core/periphery, Uniswap v3-periphery); gerbang menyala di 8 fungsi saja.
**Tindak lanjut wasit (jack):** kalibrasi v2 diterapkan penuh dari temuan Kiro, lalu v2.1 dari triase hunting RAAC sesi yang sama. Semua perubahan diuji (`tests/run-m2-tests.js` **172/172 PASS**).

## 1. Temuan Kiro (ringkas)

### 1.1 False positive v1
| # | Kelas FP | Contoh |
|---|----------|--------|
| F1 | Operand adalah identitas perantara itu sendiri | `msg.sender == router` — cek memilih perantara mana yang berhak |
| F2 | Guard juga mengizinkan panggilan langsung | modifier dengan `\|\|` yang membuka jalur EOA |
| F3 | `tx.origin` sebagai operand | `other = "tx"` |
| F4 | Fungsi bernama `restrict` | gerbang v1 match nama fungsi, bukan modifier |
| F5 | Nama role substring | `GHOST_ROLE`, `NON_ROUTER_ADMIN` |

### 1.2 False negative v1
| # | Kelas FN | Contoh |
|---|----------|--------|
| N1 | Modifier suffix/prefix | `onlyHandlerOrOwner`, `onlyHandlers`, `onlyRouterPlugin`, `onlyPositionRouter` |
| N2 | Nama role lain | `onlyController` (91× di GMX v2), `onlyTrustedForwarder`, `onlyAllowedCaller`, `onlyBridge`/`onlyGateway` |
| N3 | Varian `onlyRole` | `onlyRoles`, `Roles.ROUTER`, `keccak256("HANDLER_ROLE")`, `handlerRole` |
| N4 | Guard di body | `isHandler[msg.sender]`, `_checkRole` |
| N5 | Bentuk sender | `_msgSender()`, alias lokal `address caller = msg.sender` |
| N6 | Bentuk operand | `address(a)`, operand kiri terindeks, `msg.sender == address(codeOwners[c])` |
| N7 | Bug first-match-only | `address(this)` pertama menyembunyikan perbandingan asli |
| N8 | Perbandingan di helper internal | gaya GMX `_setCode` |

### 1.3 Severity & konteks
- Severity **Medium** benar untuk kasus Fulcrom (FA-FUL-01).
- Polarity-based: bypass → Medium; DoS → Low/Medium; operand = identitas perantara → Info.
- Kiro: korpus tanpa true positive → recall v2 tidak terukur; prototipe v2 Kiro lolos 30/30 kasusnya sendiri (risiko overfit dicatat).
- Konteks: `ReferralStorage.setTraderReferralCode` GMX v1 (baris 73) **tidak punya** cek self-referral — bug Fulcrom adalah cek jalur user yang disalin ke jalur handler; detektor ini utamanya heuristik fork-diff.

## 2. Disposisi wasit — yang diterapkan (v2)

| Temuan | Disposisi |
|---|---|
| F4 | Gerbang diuji **hanya pada tail signature setelah `)` params** (`vicSignatureTail`) — `function restrict(` tidak lagi FP |
| N1–N3 | Gerbang diperlebar: modifier camel prefix/suffix, `onlyRoles` (Solady), `onlyRole(Roles.ROUTER)`, `onlyRole(keccak256("HANDLER_ROLE"))`, `onlyRole(handlerRole)` (case-insensitive), role baru Controller/Forwarder/Gateway/Bridge/Plugin/Executor/Adapter |
| N4 | Guard body dikenali di 400 karakter pertama body (`isHandler[msg.sender]`, `_checkRole(HANDLER_ROLE)`) |
| N5 | Alias sender dikenali (`_msgSender()`, `address X = msg.sender`) |
| N6 | Operand dinormalisasi (unwrap `address(...)`, skip `this`/`0`/`0x0+`/`msg.sender`/`address`/`tx.origin`) |
| N7 | Semua perbandingan diperiksa (`matchAll`), satu kandidat per fungsi, severity tertinggi menang |
| F1, F3 | Operand = identitas perantara → **Info**; `tx.origin` di-skip |
| Polarity | `require(x == sender)` → Low/dos; `if (x != sender)` → Low/dos; `require(x != sender)` / `if (x == sender)` / lain → Medium/bypass |
| F5 | `onlyRole(GHOST_ROLE)` ditolak via aturan non-huruf sebelum kata role; `onlyRole(NON_ROUTER_ADMIN)` **masih match (residual, diketahui)** |
| — | `onlyHandlerAndAbove` dikecualikan (admin/EOA); `onlyRole(ADMIN_ROLE)`/`KEEPER_ROLE` tetap dikecualikan |
| — | `restrict(` **DITAHAN** di tail (penyimpangan dari saran Kiro "buang") — Hyperbridge `HostManager.onAccept` membuktikan itu modifier perantara asli; scoping tail sudah menutup FP nama-fungsi |

## 3. Bug yang ketemu saat pengujian v2 (bukan dari Kiro)

**Grup regex operator alternatif sender-first salah nomor.** Regex gabungan punya grup: 1=operand (alt 1), 2=operator (alt 1), 3=operator (alt 2, sender-first), 4=operand (alt 2) — `S` non-capturing. Kode memakai `m[2] || m[5]` sehingga `op` selalu `undefined` untuk bentuk sender-first (`msg.sender != X`) dan polaritas jatuh ke default Medium. Bukti: RAAC `repayOnBehalf` tercatat "konteks if, kelas bypass" padahal `if` + `!=` seharusnya Low/dos. **Perbaiki:** `m[2] || m[3]` + tes polaritas sender-first. Pelajaran: tes polaritas v2 awal hanya menutup bentuk operand-first.

## 4. Kalibrasi v2.1 — dari triase hunting RAAC (sesi yang sama)

Dua kandidat vacuous baru dari hunt RAAC ternyata **keduanya FP**, dengan dua mekanisme berbeda:

### 4.1 FA-RAAC-02 `LendingPool.repayOnBehalf` — GUGUR
`onlySupportedAdapter(adapter)` memvalidasi **parameter**, bukan membatasi pemanggil — fungsi bisa dipanggil siapa pun (selain blacklist), jadi `msg.sender != onBehalfOf` bermakna (self-repay vs third-party). Tidak ada pemanggil in-repo (hanya definisi + interface + mock). **Perbaikan:** modifier `Supported*` yang semua argumennya nama parameter fungsi dikecualikan dari gerbang (`onlyRouter(router)` tetap dihitung gerbang — ambigu tanpa baca body modifier).

### 4.2 FA-RAAC-03 `RWAVault.poolDepositAsset` — GUGUR
`require(msg.sender == stabilityPool)` bermakna: StabilityPool memanggil proxy likuidasi via **delegatecall** (StabilityPool.sol:236) → msg.sender di RWAVault = StabilityPool → cek lolos dan berfungsi sebagai allowlist pemanggil. **Perbaikan:** `pool` ditambah ke daftar operand identitas perantara (kelas Info bila fungsi memang handler-only).

Dampak: hunt RAAC 16 → **14** (2 FP vacuous hilang); Fulcrom tetap 29.

## 5. Yang DITUNDA (known limits, bukan ditolak)

- **§5.3 Kiro — guard yang mengizinkan panggilan langsung** (modifier dengan `\|\|` membuka jalur EOA): butuh body modifier dari file yang sama; belum diimplementasi.
- **§5.4 Kiro — inlining helper 1 level** (perbandingan di helper internal gaya GMX `_setCode`): belum diimplementasi.
- **Residual:** `onlyRole(NON_ROUTER_ADMIN)` masih match (aturan non-huruf hanya menutup `GHOST_ROLE`); peran perantara yang dipegang EOA yang tumpang-tindih dengan end-user tidak bisa dibedakan tanpa call-graph.
- **Batas detektor #17 (konteks):** file-scoped — bacaan lintas-file via getter tidak terlihat (16 FP Fulcrom + 1 Hyperbridge sesi ini); variabel public bisa dibaca off-chain via getter (pola RAAC `s_last*`); `sload` assembly tidak dipetakan ke nama; shadowing lokal dihitung per-baris.

## 6. Verifikasi

- `tests/run-m2-tests.js`: **172/172 PASS** (termasuk regresi korpus asli Fulcrom `ReferralManager.sol` — `setTraderReferralCode` Medium, `setTraderReferralCodeByUser` tidak ter-flag — dan 4 tes regresi v2.1).
- Hunt ulang pasca-v2.1: Fulcrom **29**, Amply **18**, RAAC **14**, Hyperbridge **3**, Flow **0**. Recall vs Kiro AMP tetap **4/7**. **0 kandidat submit baru sesi ini.**
