# Review Kiro crew atas kalibrasi F10 one-hop + R18.3/F10.1 + kalibrasi wasit R10.2

- Sesi Kiro: "Audit F10 One-Hop Dispatcher" — https://app.kiro.dev/session/3936e049-210e-4bea-a8ae-28eaf9f553b2
- Waktu: 18 Nov 2026, 01:08–01:21 WIB (browser task 8c84206f-ce7b-5227-924f-30a9a4d4a736, 13 mnt).
- Model: **Claude Opus 5.5 eksplisit, tanpa penolakan, tanpa flag MODEL_TIDAK_SESUAI** (footer UI tetap Opus 5.5; tidak ada "refused; answered by Opus 4.8").
- Kredit: dashboard 182,29 → **185,28/4.000, delta 2,99** (footer "Est. Credits Used: 2.99, Elapsed Time: 2m 37s" — cocok).
- Login: akun sudah masuk sebagai jjijundaq@gmail.com; tanpa klik Google, tanpa password/2FA.
- Metode Kiro: harness Node atas detektor (26 kasus menurut penugasan + temuan baru F1–F11, masing-masing dibuktikan eksekusi harness).
- Vonis Kiro: **NEEDS WORK** (26/26 kasus PASS, 8 temuan baru diklaim TERBUKTI).
- Catatan browser: pembacaan halaman terakhir memicu pemberitahuan keamanan sistem atas hasil tool; agen browser tidak mengikuti instruksi apa pun dari isi halaman dan tidak menjalankan/mengunduh/menerapkan apa pun darinya. Tidak ada dampak pada tugas ini.

## Tabel 26 kasus (semua PASS menurut Kiro)

1–8, 11, 21, 22, 26 sesuai harapan (1 kandidat); 4–6, 9, 10, 12–15, 18–20, 23, 24, 25 sesuai harapan (0 kandidat); 16–17 findDispatcherSink langsung null. Kasus 23 (Amply verbatim withdrawETH) 0, kasus 24 (Hyperbridge verbatim fillOrder) 0; kasus 9 (two-hop) dan 10 (named args) tetap 0 sesuai batas yang sudah dinyatakan diketahui.

## Disposisi wasit (jack) — tiap klaim diverifikasi probe ke pipeline ASLI

Probe: `/tmp/wasit-f10b/probe.js` + `/tmp/wasit-f10b/probe2.js` (node, atas `app/pipeline.js` pasca-F10/R18.3/F10.1).

| Klaim Kiro | Vonis wasit | Bukti probe |
|---|---|---|
| F1 FN: dispatcher dengan sink jinak lebih dulu | **TERBUKTI (dengan isolasi ulang)** | Probe pertama jack tidak mengisolasi (forwarder juga mengoper data → ter-flag via sink-1). Probe isolasi: forwarder HANYA mengoper target caller, sink-1 `gateway.call(data)`, sink-2 `target.call(data)` → 0 (harap 1). Akar: hanya sink pertama dianalisis. |
| F2 FN: struct diisi per-field | **TERBUKTI** | `c.to = to; c.data = data; _exec(c);` → 0. Akar: `collectControlledAliases` hanya mengenal `name = ...`, bukan `name.field = ...`. |
| F3c FP: overload bernama sama | **TERBUKTI** | Forwarder memanggil overload arity-1 yang jinak; Map menyimpan overload arity-2 (berbahaya, terakhir) → 1 (harap 0). |
| F3d FN: overload | **TERBUKTI (urutan-tergantung)** | Probe jack urutan bahaya-dulu → 1 "karena kebetulan" (record jinak ter-skip guard both-empty sehingga tidak menimpa). Urutan sebaliknya (jinak-dulu, bahaya-terakhir + forwarder 2-arg) juga 1 — tapi F3c membuktikan kelas bugnya nyata: Map runtuh per nama. Perbaikan arity menyelesaikan kedua arah. |
| F4a/F4b FN: nama parameter onlyIfSuccess/auth memicu guard | **TERBUKTI** | D18 langsung atas `run(..., bool onlyIfSuccess)` → 0; `run(..., address auth)` → 0. Akar: `hasAccessGuard` menguji signature UTUH termasuk nama parameter. |
| F5a FP: guard `_checkOwner` | **TERBUKTI** | `_checkOwner();` di badan → 1 (harap 0). OZ Ownable, sangat umum. |
| F5b FP: `require(owner() == msg.sender)` | **TERBUKTI** | Bentuk terbalik → 1 (harap 0). |
| F5c FP: `require(isOperator[msg.sender])` | **TERBUKTI** | Membership murni → 1 (harap 0). Kontrol negatif: `require(balances[msg.sender] > 0)` tetap 1 (cek saldo, bukan guard). |
| F6a/F6b FP: `abi.encodePacked` / `bytes.concat` dengan selector | **TERBUKTI** | Data `abi.encodePacked(IMod.fill.selector, o)` / `bytes.concat(IMod.fill.selector, o)` → 1 (harap 0). Kontrol negatif: selector variabel tetap 1. |
| F11 FP: pemanggilan yang dikomentari | **DITOLAK — artefak harness** | `runPipeline` atas cuplikan dengan `// _dispatch(calls);` → 0 (pipeline men-strip komentar dulu). Harness Kiro membangun objek `fn` manual tanpa strip komentar — kondisinya sendiri ("dengan syarat pemanggil belum menghapus komentar") mengakui ini. |
| F7 dua forwarder (satu guarded, satu tidak) | **BUKAN MASALAH** (Kiro sendiri) | Hanya forwarder tanpa guard ter-flag — perilaku benar. |
| F8a/F8b payable/returns, `super._exec` | **BUKAN MASALAH** (Kiro sendiri) | — |
| F9 alias terbalik | **BUKAN MASALAH** (Kiro sendiri) | — |
| F10 `abi.encode` tanpa selector | **BUKAN MASALAH** (Kiro sendiri) | Ter-flag konservatif — disengaja (encode tanpa selector bukan pemanggilan satu fungsi yang ditentukan). |
| F3a/F3b | PASS "karena kebetulan" (Kiro) — kini deterministik via arity | — |

## Yang diterapkan (kalibrasi wasit R10.2)

1. **F1 — `findDispatcherSinks` (jamak):** semua sink non-excluded dikumpulkan; D18 langsung tetap memakai sink pertama (perilaku sama); F10 memakai GABUNGAN parameter target/data dari semua sink di badan dispatcher.
2. **F3 — overload arity:** dispatcher disimpan sebagai DAFTAR record per nama; pemanggilan hanya diperiksa terhadap record yang arity-nya cocok (jumlah argumen == jumlah parameter). Overload arity-sama (tipe beda) tetap ambigu — batas diketahui, yang pertama cocok dipakai.
3. **F2 — alias member:** `collectControlledAliases` kini juga melacak penugasan member/indeks (`c.field = <controlled>`, `c[k].field = ...`) → identifier akar ditandai controlled (fixpoint sama).
4. **F4 — `modifierPart(fn)`:** pola modifier `hasAccessGuard` hanya diuji pada bagian signature sesudah kurung-tutup parameter dan sebelum `returns`/`{` — bukan nama parameter, bukan nama fungsi, bukan parameter returns. Cek berbasis badan fungsi tidak berubah.
5. **F5a — guard `_checkOwner()` / `_checkRole(` / `_checkAdmin(`** dikenali sebagai panggilan guard internal.
6. **F5b — `require(<ident>()? == msg.sender)`** (bentuk terbalik) dikenali sebagai guard.
7. **F5c — `require(X[msg.sender])`** (opsional `== true`, opsional pesan error argumen kedua) dikenali sebagai guard keanggotaan murni. `require(balances[msg.sender] > 0)` tetap BUKAN guard.
8. **F6 — `isSelectorPinnedData` diperluas:** `abi.encodePacked(` dan `bytes.concat(` pinned bila argumen pertama adalah selector konstanta (`.selector` / literal 4 byte / `bytes4(0x...)`); argumen pertama variabel = tidak pinned. `abi.encode(...)` SENGAJA tidak masuk.

## Tes

**530/530 PASS** (513 lama + 17 baru seksi 42: 42a–42q — semua probe wasit dikunci sebagai regresi, termasuk kontrol negatif F5c-neg/F6c-neg dan regresi guard F4 42g/42p/42q).

## Hunting re-run pasca-R10.2

IDENTIK, 0 kandidat baru — Fulcrom **15**, Amply **18**, RAAC **14**, Hyperbridge **6** (D18 tersisa FA-002 `CallDispatcher.dispatch` = konfirmasi H3, utuh), Flow **0**; recall vs Kiro AMP tetap 4/7. Perubahan `hasAccessGuard` (F4/F5) tidak mengubah hasil korpus nyata mana pun.

## Batas diketahui baru (residual)

- (R10.2-a) Overload arity-sama (tipe parameter beda) tetap ambigu — record pertama yang cocok dipakai.
- (R10.2-b) `require(!isBlocked[msg.sender])` (blocklist ternegasi) tidak dikenali sebagai guard.
- (R10.2-c) `abi.encode(...)` tanpa selector tetap ter-flag konservatif (disengaja).
- (R10.2-d) F5/F6 taint decode-flow penuh tetap belum dikerjakan (F10.1 hanya menangani bentuk selector-pinned yang dikenali).
- Tetap berlaku: F10 two-hop, lintas-file, named-args; F11 label-per-target; `ident.balance` polos; `encodeWithSelector` transferFrom 4-arg; F8 swap-output rename.
