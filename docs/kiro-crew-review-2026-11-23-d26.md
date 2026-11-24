# Review Kiro crew atas detektor ke-26 `unbounded-loop-inflatable-set-accounting` (D26)

- Sesi Kiro: baru, https://app.kiro.dev/session/c053d68c-6c89-4487-90d5-ab8341cd94bf
  ("Review Unbounded Loop Pattern Detector"), 23 Nov 2026 12:53–13:01 WIB.
- Model: Claude Opus 5.5 disetel eksplisit, Autonomous OFF — TIDAK ditolak,
  tanpa flag MODEL_TIDAK_SESUAI. Kredit: 5,13 (footer sesi = delta dashboard:
  430,22 -> 435,35/4.000, sisa 3.564,65, 40 hari).
- Vonis: **NEEDS WORK** — 58 kasus diuji di Node (kode detektor disalin
  verbatim; helper pipeline diganti stub oleh Kiro mengikuti deskripsi
  `hasAccessGuard` — temuan F11 bergantung pada stub itu): **26 BENAR,
  12 FP, 20 FN**. Verifikasi kode nyata Kiro (file asli Somm @07efdfa9)
  SEMUA BENAR: (A) `deposit()` grower keyParam=receiver; (B)
  `vestedBalanceOf()` FLAG Medium; (C) `totalBalanceOf()` FLAG Medium;
  (D) `withdrawAll`/`withdrawAnyFor`/`userDepositIds`/`vestedBalanceOfDeposit`/
  `userVestingInfo` tidak ter-flag. Tidak ada file diubah / submit oleh
  browser task.
- Kalibrasi wasit: **R26** (sesi Frankenstein #59, siang yang sama) —
  probe wasit `/tmp/probe-r26.js` (34 kasus, detektor ASLI): baseline
  **5/34 lolos** — SEMUA klaim Kiro TERBUKTI pada kode asli kecuali F10
  (perilaku disengaja, DITOLAK sebagai perbaikan). Pasca-R26: **34/34**.
  Dua perbaikan tambahan di luar klaim Kiro yang terungkap saat perbaikan:
  regex mappedSet/mappedArr dukung mapping bersarang (K3), dan syarat ≥2
  fungsi per span dihapus (T3 — span Base/Child masing-masing 1 fungsi).
  Tes permanen Seksi 68b: 33 tes baru. Suite **977/977** (944 + 33).
  Hunting re-run 11 permukaan pasca-R26 IDENTIK dengan baseline (Fulcrom
  15, Amply 18, RAAC 14, Hyperbridge 7, Flow 0, Veno 6, Veno zkEVM 0,
  LCROBridge 0, Resupply 12, EFP 1, Somm 34 — D26 tetap 2: FA-009 +
  FA-010); 0 kandidat submit baru.

## Temuan + vonis wasit

- **F1 — FP (7 sub-kasus), `d26HasEntryCap` terlalu sempit.** C2
  `require(MAX > ids[r].length())` (operand terbalik); C3
  `if (ids[r].length() >= MAX) { revert TooMany();}` (regex `\)\s*revert`
  gagal karena `{`); C6 `require(ids[r].length() + 1 <= MAX)`; C11
  `uint n = ids[r].length(); require(n < MAX);`; C4 cap di modifier
  `capped(r)`; C5 cap di helper `_checkCap(r)`; C10
  `if (ids[r].length() < MAX) { ids[r].add(a);}`. TERBUKTI. Perbaikan:
  rewrite `d26HasEntryCap` — bentuk terbalik, `revert` di dalam blok `{}`
  (pemindai kurung-seimbang ala D25-F10), aritmetika `+1`, alias panjang,
  cap di badan modifier, cap di helper internal satu hop; plus
  `d26AddIsGuarded` untuk C10. Probe 68b-1 (8 varian) -> 0.
- **F2 — FN, cap palsu.** `require(!ids[r].contains(a) && batch.length < 10)`
  — `[^;]{0,100}?` melompat dari `ids` ke `batch.length <`. TERBUKTI (bug
  regex nyata). Perbaikan: panjang harus ekspresi set persis
  (`d26ExprIsSetLength` — akses harus menutupi seluruh ekspresi).
  Probe 68b-2 -> 1.
- **F3 — FN (4 kasus), bentuk loop reader tak dikenali.** L3
  `while (i < d.length)`; L4 loop mundur `for (i = d.length; i > 0; i--)`;
  L5 kondisi terbalik `n > i`; L8 idiom EnumerableSet paling umum
  `uint n = ids[u].length(); for (i < n) ids[u].at(i)` (lenAliases hanya
  dari `arr.length` hasil `.values()`, bukan `set.length()`). TERBUKTI.
  Perbaikan: `d26Loops` mencakup `while`; loop mundur (init `i = <LEN>` +
  kondisi `i > 0`/`>= 0`/`!= 0`); kondisi terbalik (`LEN > i`); alias dari
  `set.length()` via `d26LengthAliases` yang juga mengenali RHS berupa
  set-length. Probe 68b-3 (4 varian) -> 1.
- **F4 — FN (2 kasus), semua `break` membatalkan loop.** L6 break
  bersyarat `if (d[i]==t) { f = true; break;}` (worst case tetap seluruh
  set); L11 break di loop dalam ikut membatalkan loop luar (cek
  `/\bbreak\b/` pada seluruh `lp.body`). L7 (break tanpa syarat) sudah
  benar tidak di-flag. TERBUKTI. Perbaikan: `d26HasUnconditionalBreak` —
  break di kedalaman kurawal ≥1 (dalam blok `if` / loop dalam) atau bentuk
  `if (cond) break;` tanpa kurawal = bersyarat, tetap di-flag; hanya break
  tanpa syarat di kedalaman 0 yang menekan. Tes 68-7 diperbarui ke break
  tanpa syarat. Probe 68b-4 -> 1.
- **F5 — FP, cap sisi reader.** `n = d.length; if (n > 50) n = 50;
  for (i < n)`. TERBUKTI. Perbaikan: `d26ClampedAliases` mendeteksi clamp
  alias sebelum loop (`if (a > N) a =...`, `a = min(a, N)`, ternary) —
  alias yang di-clamp dikeluarkan dari `lenAliases` untuk loop itu.
  Probe 68b-5 -> 0.
- **F6 — FN (5 kasus), parsing kunci/grower.** K4
  `ids[receivers[i]].add(...)` (`[^\]]+` berhenti di `]` pertama); K3
  mapping bersarang `mapping(address => mapping(uint => EnumerableSet.UintSet))`
  + `ids3[r][pid].add`; K9 set di dalam struct `users[r].ids.add(a)`; K5
  `address k = receiver; ids[k].add(a)`; K10 `deposit(r)` memanggil helper
  internal `_deposit(r)` berisi `.add`. TERBUKTI (K4/K3/K5/K10; K9 = batas
  didokumentasikan). Perbaikan: parsing akses set dengan kurung seimbang
  (`d26SetAccesses`, `d26ValuesBase` + `d26MatchingOpenBracket`); regex
  deklarasi mapped dukung mapping bersarang; alias lokal satu langkah
  `k = <param>` (fixpoint ≤3 ronde); delegasi grower satu hop ke helper
  internal dengan pemetaan argumen→parameter (pakai `splitTopLevelArgs`,
  substitusi nama parameter helper dengan argumen pemanggil dalam badan
  helper). Probe 68b-6 (4 varian) -> 1.
- **F7 — FP, kunci campuran msg.sender.**
  `ids2[keccak256(abi.encode(msg.sender, receiver))].add(a)` (penyerang
  hanya bisa isi namespace miliknya sendiri). TERBUKTI. Perbaikan: kunci
  mengandung `msg.sender`/`_msgSender()` di mana pun → lewati akses itu.
  Probe 68b-7 -> 0.
- **F8 — FN, nama tipe set di-hardcode `EnumerableSet.`.** A1
  `import { EnumerableSet as ES}` lalu `ES.UintSet`; A2
  `EnumerableSetUpgradeable.UintSet`. Dinilai Kiro celah terbesar kategori
  ini. TERBUKTI. Perbaikan: pola tipe set digeneralisasi menjadi
  `(?:[A-Za-z_][\w$]*\.)?(?:UintSet|AddressSet|Bytes32Set)`.
  Probe 68b-8 -> 1.
- **F9 — FP, shadowing.** Parameter `address[] memory holders` (M1) atau
  lokal `address[] memory holders = new address[](3)` (M2) diperlakukan
  sebagai state `holders`. TERBUKTI. Perbaikan: `d26IsShadowed` — lewati
  fungsi untuk var itu bila namanya ada di parameter atau deklarasi lokal
  (`<type> [memory|calldata|storage] <nama> [=|;|,]`). Probe 68b-9 -> 0.
- **F10 — FP (M4), DITOLAK sebagai perbaikan.** Cabang plainSet/plainArr
  mengabaikan syarat kunci parameter: `members.add(msg.sender)` di-flag,
  padahal cabang mapped menolak kunci `msg.sender`. Perilaku SENGAJA:
  plain shared set bisa digelembungkan via sybil (banyak alamat) — tetap
  di-flag, didokumentasikan di komentar detektor + 68b-10. Probe -> 1.
- **F11 — FN, modifier `only*` generik dianggap guard.** `onlyWhenNotPaused`,
  `onlyEOA`, `onlyValidReceiver(receiver)`. TERBUKTI (atas stub
  `hasAccessGuard` Kiro — perilaku sama pada helper asli: `hasAccessGuard`
  menganggap pola `only[A-Z]` generik sebagai guard). Perbaikan:
  `d26HasCallerGuard` — `hasAccessGuard(fn)` dulu; bila true, tentukan
  modifier bukan-guard (`d26NonGuardModifierNames`: keadaan/waktu/jenis —
  `onlyWhenNotPaused`/`onlyPaused`/`onlyUnpaused`/`onlyAfter*`/`onlyBefore*`/
  `onlyEOA`; validator parameter `/^onlyValid[A-Z]/` yang semua argumennya
  parameter fungsi — pola `^onlyValid[A-Z]` sengaja supaya `onlyValidator`
  tidak ikut), strip modifier itu dari salinan signature, uji ulang
  `hasAccessGuard` pada salinannya. `hasAccessGuard` global TIDAK diubah
  (dipakai detektor lain). Probe 68b-11 -> 1 (kontrol onlyOwner tetap 0).
- **F12 — FN, cakupan.** L13 reader `internal view` (`_sum`) yang dipanggil
  view public; T3 warisan satu file (set+reader di `Base`, grower di
  `Child is Base`); X1 lintas file (keterbatasan file-scoped yang sudah
  dinyatakan). TERBUKTI (L13/T3; X1 = batas didokumentasikan). Perbaikan:
  reader internal view yang dipanggil view public ikut dihitung, kandidat
  dijangkarkan pada pemanggil public (evidence menyebut "via internal
  <helper>"); restrukturisasi `detectUnboundedLoopInflatableSet`:
  kumpulkan var per span + closure leluhur via `span.parents` (transitif),
  pasangkan grower/reader lintas span yang melihat var yang sama, dedupe
  kandidat per (varName, readerFn). Probe 68b-12 -> 1.

## Batas diketahui (tetap)

- Minimum deposit tidak diperiksa (biaya bloat per entri = toVerify — cap
  ekonomi vs cap jumlah entri berbeda).
- Rantai panggil ke totalAssets/balanceOf lintas-file tidak dibuktikan
  statis di sini (toVerify).
- `.add(` dengan argumen konstanta tetap ter-flag (kasus langka — wasit
  men-triase).
- Set di dalam FIELD STRUCT (K9) belum dikenali; lintas-file (X1) di luar
  cakupan; cap di kontrak INDUK (modifier/helper di luar span) tidak
  ditelusuri; grower yang menambah lewat helper >1 hop tidak ditelusuri.
