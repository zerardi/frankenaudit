# Review Kiro crew atas kalibrasi R10 (residual alias berantai) — 17 Nov 2026

Sesi Kiro: "Audit Chained Alias R10", sesi BARU
16484bf8-178a-4185-a8a9-0c6e1d5ac595, model **Claude Opus 5.5**
(disetel eksplisit, tanpa penolakan, tanpa flag MODEL_TIDAK_SESUAI).
Browser task 5299cef8, 08:46–08:54 WIB. Biaya: **2,89 kredit**
(dashboard 153,61 → 156,5; footer Kiro 2,90; 2 mnt 43 dtk).
Login Kiro Web aktif tanpa sign-in ulang.

## Kode yang di-review (verbatim)

`buildExportedTypeMap` (peta ekspor per file → tipe kanonik, rekursif N hop,
aman siklus) + loop alias `findCrossFileReads` (kanonik via peta ekspor,
import tanpa rename ikut dihitung, guard shadowing lokal W5b). Fixture
seksi 33 (11a/11b, rantai 3 hop, kontrol negatif, siklus, shadowing)
dijelaskan dalam prompt, bukan ditempel utuh — Kiro membangun harness
Node sendiri (harness/: run.js, stubs.js, under-test.js) dengan stub
buildFileMaps, resolveImportTarget, scanImports. Setup harness: owner
Vault, baseTypeNames = ["Vault","IVault"], legitKeys hanya
contracts/Vault.sol::Vault.

## Vonis Kiro: 9/10 kasus lolos + 3 temuan tambahan

| Kasus | Vonis Kiro | Verifikasi wasit (kode ASLI) |
|---|---|---|
| (a) 11a `{K as C}` | PASS | — (diadopsi) |
| (b) 11b `{K}` langsung | PASS | — |
| (c) rantai 3 hop | PASS | — |
| (d) alias berantai ke tipe salah | PASS | — |
| (e) nama tak dikenal (+e2 file tak ada) | PASS | — |
| (f) siklus import (+f2 siklus 3 file) | PASS | — |
| (g) shadowing lokal | PASS | — |
| (h) rantai lewat path "@" (+h2 hop tengah @) | PASS | — |
| (i) re-export tengah tanpa rename | PASS | — |
| (j) namespace `import * as NS`, lalu `NS.K` | FAIL (tak ditangani) | **DIKONFIRMASI sebagai batas**: `if (!im.names.length) continue;` melewatkan impor namespace — FN diketahui, tidak dikerjakan sesi ini |
| x1: Mid `{Other as Vault}` + `{Helper}` dari Vault.sol; Reader `{Vault as C}` | FAIL, FP | **TERBUKTI** (probe wasit): shortcut base-name melewatkan resolusi rantai — alias loop mengembalikan ["C"] |
| x1b: Mid sama, Reader `{Vault}` tanpa rename | FAIL, FP | **TERBUKTI** — tapi akar masalahnya di jalur getter (a), bukan loop alias: nama pemilik selalu ada di scopedTypeNames, jadi `Vault private v` cocok typedIdRe meski `Vault` di file itu = Other |
| x2: Vault tak terkait di Fake.sol, Reader `{Vault as C}` dari Fake | FAIL, FP (kondisional) | **ARTEFAK STUB** untuk nama pemilik: typeFiles asli mem-pin nama pemilik ke owner.file saja (P1-owner) — probe wasit TETAP. Varian x2-ivault (Fake IVault deklarasi fee, tak diimplementasi) **TERBUKTI FP** di kode asli |
| x2L: typeFiles dibatasi ke file legitKeys | PASS | — (menjadi F2) |
| x3: rantai lewat impor global (`import "./Vault.sol";` di Mid) | FAIL, FN | **TERBUKTI** (probe wasit): resolveIn hanya mengikuti impor bernama |
| x4: satu hop lewat impor global | PASS | — (kontrol regresi) |
| x5: path non-relatif basename unik | PASS | — |
| x6: daftar impor multi-baris, spasi di sekitar `as` | PASS | — |

Penyimpangan penempelan: stub scanImports Kiro mengembalikan names=[]
untuk `import "x";`, `import * as NS`, dan `import "x" as NS` — sama
dengan implementasi asli, jadi hasil (j) dan x3 berlaku di kode asli.

## Kalibrasi lanjutan wasit (R10.1) — DITERAPKAN sesi ini

1. **F1 (x1): kanonik dicek lewat peta ekspor target DULU** — formula
   Kiro diadopsi verbatim: `viaMap = exportedMap.get(target)?.get(mm[1])`;
   `canon = viaMap !== undefined ? viaMap : (baseTypeNames.includes(mm[1])
   ? mm[1] : null)`. Shortcut nama hanya bila target tak punya entri
   untuk nama itu (nama tersedia lewat impor global — x4).
2. **F1b (x1b): nama yang di-rebind file pembaca ke tipe lain
   dikeluarkan dari scopedTypeNames** — sesudah filter W5b: bila peta
   ekspor file pembaca mengikat nama ke kanonik berbeda
   (`ownExports.get(n) !== n`), nama itu bukan merujuk ke pemilik.
   Nama yang tak diikat file itu (impor global/transitif) tetap berlaku.
3. **F2 (x2-ivault): typeFiles["I"+owner] dipangkas ke ifaceFiles** —
   hanya interface yang diimplementasi pemilik/turunannya DAN
   mendeklarasi getter (langsung atau via leluhur, P9a-4). Dulu semua
   file pendefinisi I+nama masuk ("aturan lama" yang dilonggarkan).
4. **F3 (x3): resolveIn mengikuti impor global** — `scanImports` kini
   membawa `kind` ("named"/"global"/"namespace"/"other"); impor global
   mengekspor ulang semua simbol target, impor namespace tidak.
   Fallthrough global hanya bila impor bernama tak menemukan nama.

## Hasil

- Probe wasit pasca-kalibrasi (kode asli): x1 TETAP, x1b TETAP,
  x2-owner TETAP, x2-ivault TETAP, x3 HILANG (getter), x4 HILANG —
  **6/6 benar**. Probe R10 awal tetap benar (11a/11b/K3 HILANG, K2
  TETAP, K4 tanpa hang).
- **Test 394/394 PASS** (387 lama + 7 baru seksi 34).
- Hunting re-run pasca-R10.1: IDENTIK — Fulcrom 15, Amply 18,
  RAAC 14, Hyperbridge 2, Flow 0; 0 kandidat baru.

## Sisa / batas diketahui

- (j) **Namespace import tak ditangani**: `import * as NS from "./Mid.sol"`
  lalu `NS.K v; v.fee()` — FN diketahui. Perbaikan butuh resolusi
  `NS.<nama>` di typedIdRe/castRe + peta namespace per file; tidak
  dikerjakan (kasus langka di korpus nyata; semua hunting identik).
- (3) heuristik abstract+internal, (4) risiko overfit kasus Kiro,
  (9) localDeclRe scope blok — tetap terbuka (bukan dari review ini).
