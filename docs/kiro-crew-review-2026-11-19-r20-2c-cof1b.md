# Review Kiro crew atas R-COF-1 + R20.2 — sesi #33, 19 Nov 2026

- **Sesi Kiro:** BARU "Audit R-COF-1 + R20.2 Veno", ID bdefe1bb-e454-4ba5-8b16-4534451fbc9d
  (https://app.kiro.dev/session/bdefe1bb-e454-4ba5-8b16-4534451fbc9d)
- **Model:** Claude Opus 5.5 dipilih eksplisit, dikonfirmasi jawaban — tanpa flag MODEL_TIDAK_SESUAI.
- **Browser task:** a5eb3f7f-d22e-5850-80d7-e78a33d6aeeb, 00:53–01:02 WIB (±9 mnt, jawab agen 2m 53d).
  Login: Google SSO Arslan tanpa password/2FA/pemilih akun (sesi Google masih aktif).
- **Dashboard:** sebelum 309,15/4.000 → sesudah **311,96/4.000** (delta **2,81**, cocok footer
  "Est. Credits Used: 2.81"). Sisa 3.688,04, 44 hari → tempo ≈44/hari sejak 12 Nov — di bawah garis 82/hari.
- **Harness:** Kiro membangun sendiri di /projects/sandbox/harness/harness.js (Node 22), dari
  tempelan verbatim — repo frankenaudit TIDAK ada di sandbox, tidak ada kode repo diubah.
  Stub Kiro: hasAccessGuard (onlyX / require msg.sender), paramNamesOf (kata terakhir param),
  splitTopLevelArgs, contractSpans, normalizeCandidate (identitas). Wasit mencatat keterbatasan
  stub ini di disposisi tiap temuan (terutama F4/E5).

## Vonis

- **R-COF-1: OK** (2 catatan minor: F7, F8). Semua kasus C0–C12 PASS di harness Kiro.
- **R20.2: NEEDS WORK** — "it now misses a real drain pattern, and it misses one case it
  used to catch." (F1 lubang, F2 regresi.)

## Disposisi wasit per temuan (semua diverifikasi probe ke kode ASLI)

### F1 — TERBUKTI, DIPERBAIKI (R20.2c, must fix)
Entitlement check tidak terikat jumlah: `require(ownerOf(id)==msg.sender)` +
`payable(to).call{value: address(this).balance}("")` → 0 (pemilik satu token bisa kuras
kontrak); varian D6b (amount = parameter mentah) juga 0. Perbaikan: pengecualian
entitlement HANYA bila jumlah BUKAN `address(this).balance` (atau ekspresi yang memuatnya)
dan BUKAN parameter fungsi mentah. Jumlah dari state per-token (`bonds[id]`) atau variabel
lokal hasil hitung tetap dikecualikan (unbond: `tokenAmount` lokal). Probe pasca: D6/D6b → 1,
F1d → 0, unbond → 0. Tes seksi 51 (51-1/51-2/51-3).

### F2 — TERBUKTI, DIPERBAIKI (R20.2c, regresi dari R20.2a)
Pengecualian nama owner/beneficiary/treasury kini berlaku juga di cabang `.call`, dan
hanya mencocokkan nama — parameter bernama `treasury` ikut terkecualikan (E1 → 0;
sebelum R20.2a receiver tetap `payable(treasury)` sehingga ter-flag). E2 menunjukkan
masalah yang sama di cabang `.transfer` (sudah ada sebelum R20.2). Perbaikan:
pengecualian nama hanya bila `!fnParams.has(recv)`. Probe pasca: E1/E2 → 1, treasury
state var → 0. Tes 51-4/51-5.

### F3 — TERBUKTI, DIPERBAIKI (R20.2c, false positive)
Beberapa bentuk cek entitlement umum tidak dikenali: E9 `if (ownerOf(id) != msg.sender)
revert` (gaya custom-error); D8c `_msgSender()` bukan `msg.sender`; D8d OZ v5
`_checkAuthorized` / `_isAuthorized`; D8b `msg.sender == X.ownerOf(` (regex ketiga
mensyaratkan `ownerOf` tepat sesudah `==`). Perbaikan: SENDER mencakup `_msgSender()`,
bentuk `!=` dua arah, qualifier member `[^;{}=]*` sebelum `ownerOf`, plus nama v5.
D5 (urutan argumen `isApprovedOrOwner` terbalik) TETAP ter-flag — Kiro sendiri menilai
itu pilihan konservatif yang wajar (OZ v4: spender dulu). Probe pasca: E9/D8c/D8d → 0.
Tes 51-6/51-7/51-8.

### F4 — SEBAGIAN TERBUKTI (R20.2c: posisi; E5 ARTEFAK; E6 BATAS)
- **E5 DITOLAK sbg artefak:** cek hanya di dalam komentar dihitung — harness Kiro
  membangun objek fn manual tanpa strip komentar. Kode ASLI: `fn.body` berasal dari
  `extractFunctions(cleanSource)` di `runPipeline` — komentar SUDAH di-strip. Probe
  wasit: cek hanya di komentar → tetap 1 (ter-flag). Tes 51-10.
- **E7 TERBUKTI, DIPERBAIKI:** cek SESUDAH payout ikut dihitung (whole-body regex).
  Perbaikan: entitlement hanya diuji pada `body.slice(0, sendIndex)` — teks sebelum
  titik kirim. Probe pasca: → 1. Tes 51-9.
- **E6 BATAS DIKETAHUI (didokumentasikan, tidak diperbaiki):** cek di `if` tanpa revert
  (cabang, bukan guard) tetap dihitung — pola tidak membedakan require/if-revert dari
  if-cabang. Bentuk itu langka; wasit men-triase bila muncul. Probe: tetap 0.

### F5 — TERBUKTI, DIPERBAIKI (R20.2c — dengan pelajaran implementasi)
Receiver paren bersarang tidak terurai: E3 `payable(address(to)).call` dan E4
`payable(address(to)).transfer` → 0 (parse gagal). D2 `payable(ownerOf(id))` → 0
lewat kegagalan yang sama — Kiro: putuskan sengaja, bukan kecelakaan.
**PERCOBAAN GAGAL (dicatat supaya tidak diulangi):** percobaan pertama memperlebar
`recvSrc` umum ke satu level bersarang (`\((?:[^()]*|\([^()]*\))*\)`) menyebabkan
**backtracking katastrofik — `runPipeline` atas snippet unbond menggantung >8 dtk**
(timeout; probe33 background ikut menggantung, dimatikan via SIGTERM). Pola itu
DIKEMBALIKAN ke bentuk datar semula. Perbaikan final: pola SEMPIT terpisah per cabang
(`payable(IDENT(ARGS))`, argumen dalam tanpa paren) + merge semua pengiriman menurut
posisi kode; receiver `ownerOf(...)` kini dikecualikan sengaja (ditentukan kontrak
token). Probe pasca: E3/E4 → 1, D2 → 0 (sengaja), `payable(address(treasury))` → 0.
Tes 51-11/51-12/51-13. Pelajaran: JANGAN pernah generalisasi grammar receiver dengan
grup bersarang berulang di regex — pakai pola sempit per bentuk.

### F6 — PENILAIAN, TIDAK DIUBAH (bukan blocker)
Receiver state var tetap ter-flag walau ada cek entitlement (D4). Perilaku ini sudah ada
sebelum R20.2 dan konservatif-benar: detektor function-scoped tidak bisa memverifikasi
setter state var itu terjaga. Judul detektor ("target pilihan caller") memang tidak
tepat untuk state var — dicatat sebagai batas, bukan bug.

### F7 — TERBUKTI, DIPERBAIKI (R-COF-1b)
(a) Fungsi dikomentari DENGAN badan di file interface-only ikut dibuang (C4) — padahal
interface tidak bisa punya badan, jadi itu kode implementasi yang dimatikan, bukan
trimming. Perbaikan: `listCommentedOutFunctions` kini membawa `hasBody` (`{` sebelum
`;` pertama); kandidat berbadan dipertahankan filter R-COF-1 tanpa baseline
(`commentedHasBody` diteruskan lewat `normalizeCandidate`). (b) C9: file interface +
free function ikut terhitung interface-only. Perbaikan: `ctx.interfaceOnly` kini
mensyaratkan `fns.length === 0`. Probe pasca: C4/C9 → 1, ISavingsDai → 0. Tes 52-1/52-2/52-4.

### F8 — TERVERIFIKASI DARI KODE ASLI, TIDAK BUTUH PERUBAHAN
(a) Himpunan klasifikasi upstream-diff TERTUTUP — hanya `live-identical`,
`live-divergent`, `live-modified`, `absent` yang pernah di-assign (pipeline.js
baris ±4120–4241); `live-renamed` Kiro hipotetis, tidak ada di kode. (b) `ctx.interfaceOnly`
dihitung PER FILE di `runPipeline` (dari `cleanSource` file itu sendiri) — Kiro tidak
bisa memeriksanya karena `runPipeline` tidak ditempel. (c) "Log jumlah kandidat yang
dibuang": tidak diimplementasikan sebagai field baru — efeknya sudah terlihat di
hitungan hunting (Veno 35 → 2); tidak ada perubahan bentuk return.

## Hasil akhir
- **Test: 670/670 PASS** (653 lama + 17 baru: seksi 51 R20.2c 13 tes, seksi 52 R-COF-1b 4 tes).
- Hunting re-run 6 permukaan pasca-R20.2c/R-COF-1b: lihat STATUS.md (sesi #33).
- Kiro TIDAK mengubah kode repo apa pun; semua perbaikan oleh wasit jack + probe lokal.
