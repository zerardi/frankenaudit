# Review Kiro crew atas R19.5 cast-assignment D19 — kalibrasi wasit R19.5a, sesi #34, 19 Nov 2026

- **Sesi Kiro:** BARU "Audit R19.5 cast-assignment D19", ID 9bff4797-f78c-45dd-b4a9-65516426b201
  (https://app.kiro.dev/session/9bff4797-f78c-45dd-b4a9-65516426b201)
- **Model:** Claude Opus 5.5 dipilih eksplisit, dikonfirmasi footer sesi — tanpa flag MODEL_TIDAK_SESUAI.
- **Browser task:** 3102abed-3c65-5ec9-a49c-fab776eff10a, 04:59–05:07 WIB (±8 mnt, jawab agen 3 mnt).
  Login: Google SSO Arslan tanpa password/2FA/pemilih akun (sesi Google masih aktif).
- **Dashboard:** sebelum 311,96/4.000 → sesudah **314,72/4.000** (delta **2,76**, footer sesi 2,75,
  selisih 0,01 pembulatan; sisa 3.685,28, 44 hari → tempo ≈44/hari sejak 12 Nov — di bawah garis 82/hari).
- **Harness:** Kiro membangun sendiri di /projects/sandbox/r195-harness/ (harness.js, cases.js, perf.js),
  dari tempelan verbatim blok R19.5 — repo frankenaudit TIDAK ada di sandbox, tidak ada kode repo diubah.
  28 kasus + stress test; tiap kasus divalidasi solc-js 0.8.28. Stub Kiro: parser param, regex deklarasi
  (pengganti addrRe), loop penghapusan shadow, isAddressTypeName dgn allowlist 8 nama, maskStringLiterals,
  cabang ident.balance dari isFullBalanceExpr; sink tidak dimodelkan (yang diuji ekspresi amount langsung).
  Wasit mencatat keterbatasan stub ini di disposisi tiap temuan.

## Vonis

- **R19.5: NEEDS WORK** — F1–F6 (di bawah).

## Disposisi wasit per temuan (semua diverifikasi probe ke kode ASLI + solc 0.8.20 lokal)

### F1 — TERBUKTI, DIPERBAIKI (R19.5a: lengan kontrak dihapus + cek cast-utuh)
Cabang cast hanya memeriksa RHS diawali `T(`, tanpa memastikan cast adalah keseluruhan RHS —
`T(v).method()` ikut dihitung cast. Kasus 5b `Info memory info = IVault(v).getInfo();` lalu
`info.balance` (kode VALID, solc lolos) → 1 pra-perbaikan; 5c/5d sama; 12b
`uint256 bal = IERC20(t).balanceOf(a);` menunjukkan set tercemar (probe Kiro sendiri invalid —
flag di sana berasal dari aturan `.balanceOf(` generik, bukan dari kontaminasi; efek samping
whole-RHS tetap membersihkan `bal` dari set). Perbaikan dua lapis: (1) lengan tipe-kontrak
DIHAPUS dari cabang cast (lihat F6 — semua instans F1 pada kode valid mengalir lewat lengan itu);
(2) cast harus menjadi keseluruhan RHS — lompat ke `)` penutup (kurung seimbang, helper baru
`matchingParenEnd`) dan terima hanya bila karakter non-spasi berikutnya adalah `;`, `,` atau `)`.
Probe pasca: 5b/5c → 0. Tes seksi 54 (54-1/54-2/54-3).

### F2 — TERBUKTI, DIPERBAIKI (R19.5a: jalan-mundur lewati whitespace)
Lookbehind `(?<![\w$.])` hanya melihat satu karakter sebelum nama; spasi antara `.` dan nama member
lolos. Kasus 7b `s . x = payable(a);` dan 7c `s.` + baris-baru + `x = payable(a);` (keduanya kode
VALID, solc lolos) → 1 pra-perbaikan. Saran Kiro `(?<!\.\s*)` TIDAK dipakai — variable-length
lookbehind tidak valid di JavaScript. Perbaikan: saat mengumpulkan evMatches, jalan-mundur dari
posisi match melewati whitespace; bila karakter non-spasi sebelumnya adalah `.`, match dibuang.
Probe pasca: 7b/7c → 0 (kasus 7 tanpa spasi sudah 0 sebelumnya). Tes seksi 54 (54-4/54-5/54-6).

### F3 — TERBUKTI, DIPERBAIKI (R19.5a: unwrap self-alias diperlebar)
`castArgIsSelf` hanya meng-unwrap `payable(`/`address(`. Kasus 6d
`r = payable(address(uint160(address(this))));` (kode VALID, solc lolos) → 1 pra-perbaikan.
Perbaikan: unwrap max 6 lapis atas {payable, address, uint/int/bytes, tipe kontrak cts/allowlist}
+ grup `(...)` polos; nama fungsi sembarang (mis. `foo(`) TIDAK di-unwrap — konservatif.
Probe pasca: 6d → 0; 6a/6b/6c/6e tetap 0. Tes seksi 54 (54-7/54-8).
Catatan wasit: F3 tidak punya instans kode-valid yang teramati lewat jalur deklarasi
(`address r;` sudah menangkap `r` duluan) — perbaikannya defense-in-depth atas niat
terdokumentasi cabang self-check; diverifikasi via probe mekanisme (scaffolding multi-decl).

### F4 — TERBUKTI dgn KOREKSI formulasi, DIPERBAIKI (R19.5a: bound 4 -> 8)
Fixpoint berhenti setelah 4 ronde; rantai terbalik dalam kehilangan nama. Formulasi Kiro (kasus 4c
`x5=x4; ...; x1=payable(a);` → 0) adalah ARTEFAK STUB: di kode asli, `x1` sudah masuk set lewat
deklarasi (`address x1, ...` — var pertama multi-dekl ditangkap addrRe), jadi rantai kedalaman 5
sudah 1 pra-perbaikan. Isu batas NYATA: akar rantai yang deklarasinya TERLEWAT (var kedua
multi-dekl) — rantai kedalaman 5 dan 6 → 0 pra-perbaikan (probe wasit /tmp/probe-f4b.js).
Perbaikan: bound 4 → 8 iterasi (biaya linear; stress test Kiro: 80.000 tautan 44 ms pada bound 4).
Probe pasca: kedalaman 5/6 → 1; kedalaman 9 → 0 (batas terdokumentasi). Tes seksi 54 (54-9/54-10/54-11).

### F5 — TERBUKTI, TIDAK DIPERBAIKI (batas diketahui)
Ternary `r = cond ? payable(a) : b;` → 0; regex menangkap `cond` sebagai RHS. Kiro sendiri menilai
"dapat diterima untuk detektor Low". Wasit: FN konservatif (miss, bukan FP); perbaikan butuh
parsing ternary — di luar scope sesi ini. Didokumentasikan sebagai batas; tes seksi 54 (54-12)
mengunci perilaku 0.

### F6 — TERBUKTI (solc 0.8.20 lokal), DIPERBAIKI (R19.5a: lengan kontrak dihapus)
Motivasi R19.5 sebagian besar adalah kode Solidity yang tidak valid — diverifikasi wasit langsung
dengan solc 0.8.20 (bukan hanya klaim Kiro): (1) multi-deklarasi `address a, b;` → Error
"Expected ';' but got ','"; (2) `.balance` pada var bertipe kontrak → Error "Member \"balance\"
not found ... Use \"address(v2).balance\""; (3) `address x = IVault(a);` → Error "Type contract
IVault is not implicitly convertible to expected type address". Konsekuensi: probe P1/P2 sesi ini
memakai scaffolding tak-valid; lengan tipe-kontrak dari cabang cast DIHAPUS — pada kode 0.8 valid
lengan itu hanya bisa men-flag kode tak-valid atau FP (F1); nilai nyata R19.5 pada kode valid
berasal dari cast `payable`/`address` + assignment polos `x = y` (kasus Kiro 1v/3/4a/4b).
Tes seksi 53 diperbarui (53-2 kini 0) + 54-13 mengunci `second = IERC20(a)` → 0.
Catatan wasit: klaim Kiro "kasus 14d jalur deklarasi juga 1" adalah ARTEFAK STUB — di kode asli,
loop cts hanya mengiterasi tipe yang terdefinisi di file/korpus (allowlist ERC hanya dipakai
isAddressTypeName, bukan loop cts); `IERC20 r;` tanpa definisi di korpus tetap 0 di mode single-file.

## Temuan tambahan wasit selama kalibrasi (bukan dari Kiro)

- **W1 — chained assignment `a = b = T(...)` menelan taut kedua:** regex `/g` non-overlapping —
  match `a = b` menelan `b`, taut `b = T(...)` tak pernah terlihat. Perbaikan: rewind
  `assignEvRe.lastIndex = em.index + 1` di awal tiap iterasi (juga untuk match yang di-skip F2).
  Tes seksi 54 (54-14).
- **W2 — cabang plain-assignment butuh terminator:** `x = y` dalam `x = (y == z)` sempat
  menambah `x` (rhs `y` address-typed, `==` lolos cek negatif). Perbaikan: helper
  `isRhsTerminator` — terima `;`/`,`/`)`/akhir string, atau `=` tunggal (chained assignment);
  `==` ditolak. Tes seksi 54 (54-14 + regresi 53-3).
- **W3 — batas lama D19 (bukan R19.5a):** assignRe `[^;]*` di `detectFullBalanceSweep` menelan
  statement berikut bila assignment berada di kondisi tanpa `;` sendiri
  (`if ((r = payable(a)) != ...)` + `bal = r.balance` di luar if → 0). R19.5a sendiri bekerja
  di jalur itu (amount langsung `r.balance` → 1, tes 54-3). Didokumentasikan; tidak diperbaiki
  sesi ini (butuh pemisah statement, di luar scope).

## Hasil akhir

- **Test 694/694 PASS** (680 lama + 14 baru seksi 54; 53-2 diubah ekspektasi 1 → 0).
- **Hunting re-run 6 permukaan pasca-R19.5a: IDENTIK** — Fulcrom 15, Amply 18, RAAC 14,
  Hyperbridge 7, Flow 0, Veno 2; 0 kandidat baru.
- **Kredit Kiro sesi ini: 2,76** (311,96 → **314,72/4.000**; sisa 3.685,28, 44 hari → tempo ≈44/hari
  sejak 12 Nov — di bawah garis 82/hari, aman). Model Opus 5.5, tanpa flag MODEL_TIDAK_SESUAI.
- **Backlog detektor tetap KOSONG; residual tersisa:** F10 one-hop, F5/F6 taint, F11 label-per-target,
  `encodeWithSelector` transferFrom 4-arg, F8 swap-output rename + batas baru R19.5a (F5 ternary,
  rantai terbalik >8, assignRe-menelan di kondisi, `x = T(addr)` dgn T di luar korpus/allowlist)
  + catatan Kiro SP1Beefy headers=[] (pertanyaan terbuka sesi BB).
