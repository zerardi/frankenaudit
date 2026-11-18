# Review Kiro atas kalibrasi R5 (residual struct-field over-shadow) — 16 Nov 2026

Sesi Frankenstein #19 (16:38 WIB). Browser task 330daa56 (16:52–17:44 WIB),
sesi Kiro 9bf915c9 "Audit Bug Bounty Kontrak Solidity", akun Arslan.
Model: Opus 5.5 dipilih manual — menjawab Bagian 1–2, lalu GAGAL menjawab
permintaan tinjauan (trafik tinggi, Request ID b4f5de1e-92d6-45ac-956d-4b84a98146f1);
beralih ke Opus 4.8 (sekali, tanpa loop), tinjauan selesai.
Repo tidak disentuh Kiro (git status bersih di sandbox-nya).

## Yang di-review (ditempel verbatim)

Kalibrasi R5 atas residual (5): `findBlockSpans` membawa indeks char
`start`/`end`; `scanStateVarDecls` sadar-struct; `analyzeStateVar` melewati
isi blok struct; `nonExpressionSpans` memasukkan blok struct.
Ditempel runnable: STATE regexes + `lineOfSrc` + `findBlockSpans` +
`scanStateVarDecls` + `nonExpressionSpans` + smoke driver (66 baris).
Read-only: diff `analyzeStateVar` (skip struct) + pemakaian
`nonExpressionSpans` di cabang inheritance `findCrossFileReads`.

## Hasil Kiro

- Smoke driver utuh: decls A `["fee"]`, decls B `[]`, structSpans B `[[27,43]]`.
- 11 kasus adversarial di Node: **10 lulus, 1 gagal**.
  - Lulus: R5-1 shadowing var warisan; R5-2 struct di owner; R5-3 nested
    struct; R5-4 `params.fee` vs bare (sebagian — lihat wasit);
    R5-5 field mapping; R5-6 struct senama kontrak; R5-7a fee dalam string;
    R5-8 multi-struct; R5-9 event/error/modifier; R5-10 off-by-one `}`.
  - Gagal: **R5-7b** — string `"uint256 ghost;"` → decls `["fee","ghost"]`,
    phantom `ghost` (bersyarat: hanya bila pemanggil tak mem-mask string).
- Vonis Kiro: **FIX R5 BERTAHAN** untuk unit yang ditempel. FP terbukti:
  hanya R5-7b (dampak kecil — ghost 0 tulis, bukan kandidat). FN terbukti:
  tidak ada. Yang tidak bisa diputuskan Kiro (kode konsumen tak ditempel):
  (i) off-by-one DIFF 1; (ii) kelengkapan DIFF 1 event/error/modifier;
  (iii) basis indeks inSkip DIFF 2; (iv) `params.fee` vs bare di
  `classifyVarOccurrence`.

## Verifikasi wasit jack ke kode ASLI (bukan rekonstruksi)

1. **R5-7b TERBUKTI BERDAMPAK NYATA — DIPERBAIKI.** Probe wasit:
   owner `ghost` (dead) + Child baca `return ghost;` + string
   `"uint256 ghost;"` → kandidat TETAP (baca tak dikenali — phantom
   men-shadow Child); kontrol tanpa string → HILANG. Perbaikan:
   `scanStateVarDecls` kini mem-mask string dulu (`maskStringLiterals`,
   panjang/offset dipertahankan) sebelum memindai — menutup phantom di
   ketiga pemanggil (detektor, `buildProjectIndex`, `classifyUpstreamDiff`).
   Tes baru seksi 26 (2 tes). **Test 277/277 PASS.**
2. **DIFF 1 "tidak lengkap" — KLAIM KIRO TIDAK BERLAKU.** `analyzeStateVar`
   memakai `skipSpansForDeadConfig` yang SUDAH mencakup event/error +
   signature fungsi-tanpa-badan + modifier + interface; tambahan span
   struct melengkapinya, bukan meninggalkannya. DIFF 1 LENGKAP.
3. **Off-by-one DIFF 1 — TERJAWAB.** Konsumen skip memakai batas atas
   eksklusif (`idx < s.end`, `analyzeStateVar` baris 1739) — `end+1` aman.
4. **Basis indeks inSkip DIFF 2 — TERBUKTI BENAR.** Pemanggil memakai
   `inSkip(bm.index)` (relatif-span) dan `skipSpans` dari
   `nonExpressionSpans(span)` (relatif-span juga) — konsisten.
5. **R5-4 — TERJAWAB OLEH TES LOKAL.** `classifyVarOccurrence`:
   `params.fee` → `skip`/`member-call` (bukan baca), bare `fee` → `read`;
   dikunci tes seksi 25c/25d.
6. **FN lama yang disebut Kiro** (cast `VaultV2(a).fee()`, alias di klausa
   `is`) — di luar lingkup R5, bukan regresi, tanpa snippet pembuktian;
   tidak ditindaklanjuti sesi ini.

## Dampak korpus nyata

Hunting re-run 5 permukaan pasca-kalibrasi lanjutan: IDENTIK —
Fulcrom 15, Amply 18, RAAC 14, Hyperbridge 2, Flow 0; 0 kandidat baru.

## Kredit

Footer R5: Bagian 1: 0,60; Bagian 2/smoke: 1,32; tinjauan Opus 4.8: 7,59;
**total sesi ini 9,51**. Dashboard 17:42 WIB: **141,15/4.000 terpakai,
sisa 3.858,85, 46 hari** → tempo ≈83,9/hari — pas garis. (Kenaikan dashboard
sejak 16:37 WIB = 25,24; 9,51 dari sesi ini, sisanya ±15,73 dari pass
retrospektif SERANG-DULU sesi BB sore di lane yang sama.)
