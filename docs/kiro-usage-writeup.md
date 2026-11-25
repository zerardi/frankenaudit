# FrankenAudit — How we used Kiro (DRAF write-up pemakaian Kiro)

> Draf untuk seksi "Built with Kiro" di Devpost 1298511 (M5).
> Status: DRAF — belum diisi ke Devpost. Angka kredit per 24 Nov 2026
> 16:39 WIB: terpakai 762,68 / 4.000 (sisa 3.237,32; 38 hari).

## Steering (`.kiro/steering/`)

- **`bug-bounty.md`** — persona pemburu bug bounty yang ditanam di Kiro:
  kandidat-bukan-verdict, hipotesis yang bisa difalsifikasi, severity
  gate Medium ke atas, PoC fork sebelum klaim, larangan submit tanpa
  persetujuan manusia. Ini "otak" yang sama dipakai sesi audit harian
  kami, dibawa ke dalam proyek sebagai steering repo.
- **`product.md`** — apa itu FrankenAudit, siapa pemakainya, prinsip
  candidate-not-verdict.
- **`tech.md`** — stack (aplikasi statis + pipeline Node + Slither +
  Foundry) dan aturan main repo.

## Specs (`.kiro/specs/frankenaudit/`)

- **`requirements.md` / `design.md` / `tasks.md`** — spesifikasi M1–M5:
  scaffold → MVP pipeline → URL live → aset submission → isi draf
  Devpost. Milestone dikerjakan sesi demi sesi mengikuti tasks.md.

## Hooks (`.kiro/hooks/`)

- **`candidate-format-check.json`** — hook format kandidat: setiap
  kandidat yang ditulis ke laporan wajib membawa lokasi
  (file:fungsi), hipotesis, precondition, dampak, dan cara verifikasi.
  Format ini yang dipakai pipeline (`report.js`) dan laporan hunting.

## Custom agents / agent crew

Tidak ada file custom-agent terpisah — crew-nya adalah **sesi Kiro
dengan steering bug-bounty.md yang sama, dijalankan dengan peran
berbeda** (pass lebar → pass final → cek silang), sesuai cara kerja
tim kami. Model standar crew: **Claude Opus 5.5, dipilih eksplisit di
awal tiap pass** (pemilih model pernah bergeser sendiri ke Opus 4.8 —
lebih mahal — jadi model aktual dicatat tiap sesi).

| Pass | Model | Hasil |
| --- | --- | --- |
| Audit 18 file Amply (Cronos zkEVM) | Auto | 7 kandidat AMP-01…AMP-07 (sesi BB sore 13 Nov; delta 4,91 kredit) |
| Review silang trap-vault vs ground truth | Opus 5.5 | 3/7 KONFIRM, 2 naik ke Critical (setOwner, payFee); 4 diturunkan dengan alasan; 4 bug baru yang dilewatkan pipeline (temuan A–D) → 2 jadi detektor baru (replay-signature, share-accounting) |
| Review detektor 13/14 (oracle passthrough, free-mem-pointer) | Opus 5.5 | 5/5 KONFIRM + kalibrasi guard/cakupan |
| Review detektor 15 (eth-locked receive) | Opus 5.5 | 26 kasus adversarial → kalibrasi v3/v3.1 (idiom keluar-ETH, proxy, test-path) |
| Review detektor 16 (vacuous identity check) | Opus 5.5 | v1 benar 6/30 → kalibrasi v2/v2.1 (gerbang tail-scoped, polaritas) |
| Review detektor 17 (dead config) + project-pass | Opus 5.5 | 15/36 → kalibrasi v2; project-pass lintas-file lahir dari review ini |
| Review Intake & Gate (M2.5) | Opus 5.5 → 4.8 | 95/99 kasus benar, 0 FP keamanan → kalibrasi R1 |
| Review detektor 18/19/20 (dispatcher, sweep, value-send) | Opus 5.5 | NEEDS WORK F1–F20 → kalibrasi wasit R18.1/R19.1/R18.2/R20.1 |
| Review detektor 21 (empty-sublist proof) | Opus 5.5 | 42 kasus → kalibrasi R21.1/R21.1b |
| Review detektor 22 (JIT reward accrual) | Opus 5.5 | NEEDS WORK F1–F18 → kalibrasi R22 (28/28 probe wasit) |
| Review detektor 23 (refund-locked middleware) | Opus 5.5 | NEEDS WORK F1–F18 → kalibrasi R23 + F19 (37/37 probe wasit) |
| Review detektor 24 (variant-branch no-payload-consume) | Opus 5.5 | NEEDS WORK, 36 kasus (9 benar, 15 FP, 11 FN, 1 ambigu) → kalibrasi R24 (20/20 probe wasit, severity Low → Info) |
| Review kalibrasi residual (R5/R6/R8/R9/R10/R19.x) | Opus 5.5 | Tiap pass: harness adversarial Node + kalibrasi wasit atas klaim yang terverifikasi ke kode asli |
| Kalibrasi R-DIV-1 (guard division-no-guard) | — (wasit lokal, tanpa pass Kiro) | 5/5 FP Medium Resupply gugur (early-return/assignment/else/if-positif) → 9 tes Seksi 59, suite 832/832 |
| Kalibrasi R18.5 + R-COF-2 (guard permission-record D18 + "Equivalent to require") | — (wasit lokal, tanpa pass Kiro) | 3/3 FP Medium Resupply gugur (Core.execute + 2× FixedPointMathLib) → 10 tes Seksi 60, suite 842/842 |
| Kalibrasi R20.3 + R20.3a (F8 swap-output D20) | Opus 5.5 | NEEDS WORK F1–F7 → F1 ditolak (artefak transport), F2–F6 terbukti + diperbaiki → 9 tes Seksi 61 + 11 tes Seksi 62, suite 862/862 |
| Kalibrasi R20.3b (residual F7 tuple + F5 ikatan data c2 D20) | — (wasit lokal, tanpa pass Kiro — sesi BB pagi memakai Kiro) | Probe 6/6 (4/6 gagal pra-perbaikan) → 6 tes Seksi 63, suite 868/868 |
| Kalibrasi R20.3c atas review Kiro R20.3b (D20) | Opus 5.5 | NEEDS WORK 20/22 + 11 temuan → F1/F3/F8/F11/T5 + F2b wasit terbukti + diperbaiki; F2/F4/F5/F6/F10 ditolak (artefak/invalid); F7/F9 batas didokumentasikan → 11 tes Seksi 64, suite 879/879 |
| Kalibrasi R-COF-3 + R-COF-3a atas review Kiro (commented-out-check: padanan hidup `if + revert`) | Opus 5.5 | NEEDS WORK 35 kasus + 12 temuan → F2/F3/F5/F6/F9/F11 terbukti + diperbaiki (aturan literal DIHAPUS; string di-mask; argumen revert tidak dihitung; else-revert + require hidup dikenali); F1 ditolak (artefak harness); F8 sesuai desain konservatif; F4/F10/F12 batas didokumentasikan → 9 tes Seksi 65 + 9 tes Seksi 66, suite 899/899 |
| Review detektor 25 (guard-asymmetry nav readers) | Opus 5.5 | NEEDS WORK, 11 temuan F1–F11 → kalibrasi wasit R25: 11/11 TERBUKTI + diperbaiki (propagasi guard lewat closure, guard via helper/modifier *reentr*, matchAll, bentuk guard uint/getter/member, tolak nama jebakan, baca state langsung, abaikan panggilan member, multimap overload, resolusi lintas-span, pemindai kurung-seimbang if-revert, kupas kurung signature) → 13 tes Seksi 67 + 20 tes Seksi 67b, suite 932/932 |
| Review detektor 26 (unbounded-loop inflatable-set accounting) | Opus 5.5 | NEEDS WORK, 58 kasus (26 benar, 12 FP, 20 FN) + 12 temuan F1–F12 → kalibrasi wasit R26: 12/12 TERBUKTI + diperbaiki (cap diperlebar, loop while/mundur/terbalik + alias set.length(), break bersyarat, clamp reader, parsing kunci kurung-seimbang + mapping bersarang + alias lokal + delegasi helper, kunci msg.sender, prefix tipe set, shadowing, guard khusus D26, reader internal + warisan satu file); F10 ditolak (sybil, disengaja) → 33 tes Seksi 68b, suite 977/977 |
| Tes MiniPerp (persona check) | — | Steering + persona terverifikasi jalan |

Detail lengkap tiap review: `docs/kiro-crew-review-2026-11-*.md`
(20+ dokumen review, satu per detektor/kalibrasi).

**Cara kerja review (pola "wasit"):** Kiro menguji detektor dengan
harness adversarial Node atas kasus-kasus buatannya; jack memverifikasi
tiap klaim Kiro ke kode pipeline ASLI lewat probe sebelum mengadopsi —
klaim yang terbukti artefak stub (Kiro menguji replika, bukan kode asli)
ditolak dan didokumentasikan. Pola ini yang membuat 26 detektor
bertahan di 977/977 tes tanpa false positive baru di korpus nyata.

## MCP servers

**Tidak dipakai.** Lookup on-chain dilakukan read-only langsung dari
aplikasi (fetch `eth_getCode` via RPC publik), tanpa MCP. Bila juri
menanyakan: tidak ada klaim MCP di proyek ini.

## Kiro sebagai produk yang diuji (dogfooding)

Sesi pembangunan Frankenstein juga memakai Kiro sebagai **pengujian
produk**: pass audit Kiro atas target bug-bounty nyata (Amply, RAAC,
Fulcrom, Hyperbridge, Flow, Veno, Resupply, EFP, Somm) adalah bahan latihan pipeline —
kandidat Kiro jadi ground truth untuk mengukur recall pipeline
(0/7 → 4/7 atas kandidat Amply sesudah detektor commented-out-check,
commented-out-function, enum-shift, dan eth-locked-receive), dan
temuan Kiro yang lolos dari pipeline jadi backlog detektor berikutnya
(kelas H3, K-1, VENO-C1, VENO-C2 — semuanya kini tertangkap pipeline
sebagai detektor 18/19, 21, 22, 23).

## Kredit

Hibah Kiroween 4.000 kredit (hangus 31 Des 2026). Terpakai s/d sesi ini:
**762,68 kredit** (sisa 3.237,32; 38 hari) — dipakai hanya untuk kerja
nyata (pass audit + review silang), tanpa prompt sampah. Pembangunan
lokal (scaffold, pipeline, test, PoC fork) dikerjakan tanpa pass Kiro.
Tempo sejak 12 Nov ≈64 kredit/hari, di bawah garis hitung ulang
(3.237,32 ÷ 38 ≈ 85/hari).
