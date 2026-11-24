# Review Kiro crew — Kalibrasi R18.4 dust-by-design (D18)

Sesi Frankenstein #30, 18 Nov 2026 12:38 WIB. Pass Kiro: browser task bbd99d68,
sesi baru "Audit R18.4 Dust-by-Design D18" (31cd692b), **Opus 5.5 eksplisit,
tanpa flag MODEL_TIDAK_SESUAI**, 1 mnt 48 dtk, footer 1,87 kredit.
Login aktif tanpa sign-in ulang.

## Konteks

R18.4 (backlog detektor, sesi BB pagi 18 Nov): H3 gugur di pass SERANG-DULU
Opus 5.5 — mekanisme PoC-verified tapi kelas dampak gugur karena residu
dispatcher terdokumentasi sebagai dust protokol
(`intent-gateway/overview.mdx:162`). Kalibrasi v1: sinyal dust (identifier
`DustCollected`/`_sweepDust` atau baris prosa dust + kata konteks) yang
terikat ke dispatcher menurunkan kandidat D18 Medium → Low (kandidat tetap
ada). Tes 570/570 sebelum review.

## Harness H1–H9: 9/9 PASS

H1 IntentsBase asli → sinyal ≥3 · H2 mentionsDispatcher true ·
H3 "dust is everywhere" → 0 · H4 `uint256 dust;` → 0 ·
H5 kutipan overview.mdx:162 → sinyal + mentionsDispatcher ·
H6 dispatch Medium + sinyal terikat → Low + bukti ·
H7 sinyal tak-terikat → Medium · H8 detektor lain tak disentuh ·
H9 kandidat sudah Low tak diubah.

## Serangan adversarial: F1 BENAR, F2–F15 SALAH — vonis NEEDS WORK

Wasit jack memverifikasi tiap klaim ke kode ASLI via probe Node
(seperti pola sesi-sesi sebelumnya: klaim Kiro tidak ditelan mentah).
Ringkasan Kiro menyebut "9 kasus yang salah" sementara daftar rinci
F1–F15 berisi 1 BENAR + 14 SALAH — ketidakselarasan hitungan dicatat
apa adanya, tidak disamakan; yang dipakai wasit adalah daftar rinci.

| # | Klaim Kiro | Verifikasi wasit | Perbaikan (R18.4b) |
|---|-----------|------------------|-------------------|
| F1 | `withdrawDust` tanpa sweep/collect → 0 sinyal (FN konservatif) | BENAR — arah aman (severity tidak turun) | Tanpa fix; dicatat batas diketahui |
| F2 | String literal `"amount is dust, nothing left to dispatch"` → 1 sinyal, Medium → Low | TERBUKTI — pindai per baris tak bedakan string/kode | Prosa HANYA dari komentar (extractCommentBlocks) + docs |
| F3 | Docs multi-baris, dust & konteks beda baris → 0 | TERBUKTI — pindai per baris | Prosa per KALIMAT (baris di-join dulu) |
| F4 | "are swept ... as dust" → 0; `sweep\w*` tak cocok "swept" | TERBUKTI | Tambah `swept` ke DUST_CONTEXT_RE |
| F5 | "dust leftover" / "remainder" / "excessive" → 0 | TERBUKTI | Tambah `leftover\w*`, `remainder`, `refund\w*`, `excess\w*` |
| F6 | SwapRouter impor IDispatcher + komentar dust AMM → Low (paling berbahaya) | TERBUKTI — mentionsDispatcher per-file | Ikatan PER SINYAL, nama kontrak eksak (bukan generik per file) |
| F7 | "Dispatcher" di baris lain mengikat sinyal dust | TERBUKTI — akar sama dengan F6 | Ikatan (c) hanya dari konteks sinyal sendiri |
| F8 | `import {DustCollector}` → 1 sinyal identifier | TERBUKTI | Baris `import ...;` di-mask (newline dipertahankan) |
| F9 | "does NOT sweep dust" + `DustSweepNotSupported` → 2 sinyal | TERBUKTI — makna terbalik | Tolak negasi (kalimat + identifier) |
| F10 | MockDispatcher.t.sol `test_sweepDust` → sinyal | TERBUKTI — tanpa filter path | Kecualikan test/tests/mocks?/script, `.t.sol`, `Mock*` |
| F11 | Komentar identik 4x → 5 sinyal; teks sama di 3 file → 3 sinyal | TERBUKTI — hanya identifier di-dedup | Dedup per snippet; kalimat yang buktinya hanya dari identifier tak dihitung dua kali |
| F12 | "shift left by 8 to avoid dust" → 1 sinyal ("left") | TERBUKTI | "left" telanjang dihapus; hanya "left over/in/behind/there" |
| F13 | Sinyal CallDispatcher mengikat kandidat BridgeDispatcher | TERBUKTI — nama tak diperiksa | Ikatan nama eksak (prefix I- opsional) |
| F14 | Kandidat tanpa toVerify → crash, mutasi parsial, batch berhenti | TERBUKTI | Default field dulu; severity diubah PALING AKHIR |
| F15 | evidence/impact undefined → "undefined [..." | TERBUKTI | Sama dengan F14 |

## Keputusan wasit (di luar daftar Kiro, dengan alasan)

- **Aturan dua-sumber (saran Kiro 3) DITERIMA.** Penurunan severity butuh
  ≥2 sinyal terikat dengan snippet berbeda. Hyperbridge (kasus pemicu)
  punya 7+ sinyal berbeda, jadi tetap Low. Biaya: proyek dengan satu
  baris dokumentasi saja kini tidak turun — arah konservatif, benar
  untuk fungsi yang MENURUNKAN severity.
- **Cabang same-file sebagai pengikat (saran Kiro 2: hapus) DITAHAN
  dengan alasan tercatat.** FP same-file yang ditemukan (F2 string
  literal, F12 "shift left") sudah mati di akarnya masing-masing
  (prosa-dari-komentar, "left" diperketat) — bukan karena same-file.
  Menghapusnya akan membunuh kasus sah: file dispatcher yang
  mendokumentasikan dust-nya sendiri di NatSpec.
- **"stay/stuck/trapped/locked/remain"-ish sebagai negasi (tambahan
  wasit).** Kalimat "dust leftovers stay in the contract" mendokumentasikan
  dust yang TINGGAL, bukan di-sweep — ditolak sebagai sinyal. Kata
  "remaining" sengaja TIDAK masuk daftar ini (`\bremain\b` tak cocok
  "remaining", jadi kutipan overview.mdx:162 aman).
- **F1 didokumentasikan sebagai batas, bukan diperbaiki.** Identifier
  `withdrawDust` (dust tanpa sweep/collect) memang mekanisme dust,
  tapi bukan dokumentasi bahwa residu dispatcher adalah dust protokol.

## Hasil pasca-R18.4b

- **Test 588/588 PASS** (570 lama + 18 baru seksi 46: F2–F15 + F1).
  Seksi 45 diperbarui mengikuti aturan dua-sumber (45b/45c/45i kini
  2 sinyal; 45g memakai kontrak `CallDispatcher` — docs tentang
  CallDispatcher tidak mengikat kontrak bernama lain).
- Hunting re-run pasca-R18.4b: Hyperbridge FA-005 `CallDispatcher.dispatch`
  TETAP Low dust-by-design (7+ sinyal terikat berbeda); permukaan lain
  identik — lihat entri log sesi #30 di STATUS.md.

## Batas diketahui (baru)

- Identifier `withdrawDust` / `dustBalance` tanpa sweep/collect bukan
  sinyal (F1, konservatif).
- Ikatan (b) menghitung impor nama dispatcher sebagai referensi
  struktural — file yang hanya mengimpor ICallDispatcher + punya sinyal
  dust terikat (dinilai sah: file itu berinteraksi dengan dispatcher).
- Nama kandidat diambil dari SEMUA kontrak di file kandidat (bukan hanya
  kontrak pemilik fungsi) — file multi-kontrak bisa mengikat longgar.
- Prosa multi-kalimat dengan negasi di kalimat lain tetap lolos bila
  kalimat dust-nya sendiri bersih (negasi dinilai per kalimat).
