# Review Kiro crew atas detektor ke-25 `guard-asymmetry-nav-readers` (D25)

- Sesi Kiro: baru, https://app.kiro.dev/session/58f67ca0-a347-4e74-84ae-0ead4e0ded96
  ("Detect Unguarded NAV Readers in Smart Contracts"), 22 Nov 2026 20:46–20:51 WIB.
- Model: Claude Opus 5.5 disetel eksplisit, Autonomous OFF — TIDAK ditolak,
  tanpa flag MODEL_TIDAK_SESUAI. Kredit: 1,49 (footer sesi = delta dashboard).
- Vonis: **NEEDS WORK** — pola bekerja untuk bentuk verbatim Cellar.sol,
  tapi guard tidak diteruskan lewat call graph dan guard hanya dikenali dari
  teks body entry itu sendiri, per pola hanya kecocokan pertama.
- Kalibrasi wasit: **R25** (sesi Frankenstein #56, malam yang sama) —
  11/11 temuan TERBUKTI dari kode asli, semua diperbaiki + dikunci tes
  (Seksi 67b, 20 tes baru). Suite 932/932. Cellar.sol verbatim tetap 7 Low;
  hunting re-run 11 permukaan pasca-R25 IDENTIK (Somm 32, lainnya tetap).

## Temuan + vonis wasit

- **F1 — FP, guard tidak diteruskan lewat sibling yang dipanggil.**
  `convertToShares` memanggil `totalAssets()` (ber-guard) tapi di-flag.
  TERBUKTI. Perbaikan: guard status = bentuk sendiri ATAU ada fungsi
  ber-guard di closure transitif entry itu. Probe 67b-1 -> 0.
- **F2 — FP/FN, guard lewat helper internal / modifier kustom.**
  `_checkNotLocked()` + modifier `nonReentrantView` (gaya Euler EVK) tidak
  dikenali; `\bnonReentrant\b` tidak cocok dengan `nonReentrantView`.
  TERBUKTI. Perbaikan: propagasi closure (F1) + modifier bernama `*reentr*`
  di kepala signature. Catatan Kiro diterima: nonReentrant OZ menulis storage
  sehingga praktis tidak ada di fungsi view — cabang modifier untuk gaya EVK.
  Probe 67b-2 -> 0.
- **F3 — FN, hanya kecocokan pertama per pola.**
  `require(!isShutdown); require(!locked);` — exec tanpa /g menangkap
  isShutdown, filter nama gagal, totalAssets dianggap tanpa guard.
  TERBUKTI. Perbaikan: semua pola guard memakai /g + iterasi semua match.
  Probe 67b-3 -> 1 @ previewDeposit.
- **F4 — FN, bentuk guard umum tidak tertangkap.**
  `_status != _ENTERED`, `unlocked == 1`, `slot0.unlocked`,
  `if (_reentrancyGuardEntered()) revert`, `require(!locked && x > 0)`.
  TERBUKTI (pola v1 hanya negasi bool). Perbaikan: pola dua sisi, polaritas
  positif (unlocked/_status == 1), getter, `!X && ...`. Probe 67b-4 (7 varian).
- **F5 — FP, substring `lock` menangkap flag bukan-kunci.**
  `depositsLocked` (juga timelocked, lockedUntil, unlocked polaritas-terbalik)
  lolos /lock/i. TERBUKTI. Perbaikan: `d25GuardNameOk` menolak
  deposit/timelock/until; `unlocked` hanya sah pada polaritas positif.
  Probe 67b-5 -> 0.
- **F6 — FN, NAV dibaca langsung dari state tanpa helper.**
  `totalAssets` return `_held`, `convertToShares` baca `_held` langsung —
  closure kosong, tidak ada union. TERBUKTI. Perbaikan: baca state langsung
  jadi kunci kelompok, TAPI hanya bila var itu juga dibaca langsung saudara
  ber-guard — tanpa batas ini maxMint Cellar ikut ter-flag lewat
  shareSupplyCap dan getCreditPositions lewat creditPositions (diverifikasi
  helper NAV Cellar tidak membaca kedua var itu). Probe 67b-6 -> 1.
- **F7 — FP, tabrakan nama dengan external call.**
  `asset.balanceOf(...)` ditangkap sebagai panggilan `balanceOf` lalu
  diresolusi ke balanceOf kontrak sendiri. TERBUKTI. Perbaikan: panggilan
  member `x.f(` diabaikan di `d25CalledNames`. Probe 67b-7 -> 0.
- **F8 — FN, overload first-wins di byName.**
  Dua `_calc` (pure + view); first-wins mengambil yang pure. TERBUKTI.
  Perbaikan: byName multimap, telusuri semua overload, pengecualian-diri
  per objek (bukan per nama). Probe 67b-8 -> 1.
- **F9 — FN, helper di base contract / span lain.**
  `_nav` di `abstract contract Base`, Vault `is Base` — byName per-span
  tidak menemukannya. TERBUKTI. Perbaikan: resolusi lintas-span satu file
  (unik, atau induk warisan; ambigu -> konservatif lewati). Probe 67b-9 -> 1.
- **F10 — FN, blok `if (locked) { ... }`.**
  Struct literal (`Info({a: 1})`) memotong `[^}]`; emit panjang >120 karakter
  gagal. TERBUKTI. Perbaikan: pemindai kurung-seimbang + batas 600 karakter;
  `else` bukan bagian if. Probe 67b-10/10b -> 1. Catatan wasit: polaritas
  if-form TERBALIK dari require (`if (A == ENTERED) revert` = guard) —
  bug ini ditemukan saat probe 67b-4 gagal pertama kali, diperbaiki sebelum
  suite hijau.
- **F11 — FP potensial, parameter function-type.**
  `function _apply(function(uint256) external view returns (uint256) f)`
  lolos sebagai entry/helper view karena signature mengandung kata
  external/view. TERBUKTI. Perbaikan: kepala signature dikupas dari isi
  kurung sebelum uji visibility/mutabilitas. Probe 67b-11 -> 0.

## Catatan Kiro yang tidak diadopsi utuh

- Line number dari `clean`: Kiro meragukan bila stripComments membuang newline.
  DITOLAK wasit — `stripComments` mengganti isi komentar dengan spasi dan
  mempertahankan newline (dicek langsung di `app/pipeline.js`), jadi nomor
  baris dari `clean` sama dengan source asli.
- "Batasi helper bersama ke yang benar-benar membaca state NAV": diterapkan
  SEBAGIAN — panggilan member diabaikan (F7) + helper pure dikecualikan
  (v1); helper view trivial yang membaca state (mis. `decimals()` view)
  masih bisa jadi kunci kelompok — residual diketahui, didokumentasikan di
  komentar detektor, tidak dikejar 2 hari sebelum freeze 24 Nov.

## Residual pasca-R25

- Helper view trivial pembaca state masih bisa mengelompokkan (lihat atas).
- Panggilan `super.`/`this.` tidak ditelusuri.
- Shadowing lokal senama state var bisa salah-hitung baca (F6).
- Guard via require di constructor/initializer tidak diteruskan.
- Resolusi lintas-span ambigu (helper sama di 2+ kontrak tak-berinduk)
  konservatif dilewati.
