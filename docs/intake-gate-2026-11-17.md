# Intake & Gate (M2.5) — 17 Nov 2026, sesi sprint #22

Modul: `frankenaudit/app/intake.js` (+ seksi 31 di `tests/run-m2-tests.js`).
Metodologi: SUPERAGENT v10 `references/v10/security/autonomy/` — program-discovery.md
(skema record + aturan pasif), program-qualifier.md (drop filter + skoring 0–100),
authorization-gate.md (5 tes gerbang + matriks vonis + mode strict/auto/paused),
memory-dedupe.md (dedupe per id + re-open bila policy berubah). HANYA metodologi
yang diadopsi; modul NATIVE, tidak ada kode Python engine v10 yang ditempel/dipakai.

## Fungsi

- `normalizeProgram(raw)` — normalisasi record; `invites_testing` / `pays_bounty` /
  `automatedTestingAllowed` yang bukan true/false → `"unknown"`.
- `scoreProgram(raw, now)` — bobot qualifier: scope 25, payout 20, freshness 15,
  fit 15, kompetisi 10, respons 10, novelty 5. Sub-skor scope: 0 aset → 0;
  1–2 → 0,4; 3–9 → 0,7; ≥10 → 1,0 (atau `scopeAssetCount`). Payout band
  <100 → 0,2; <1 rb → 0,4; <10 rb → 0,6; <100 rb → 0,8; ≥100 rb → 1,0;
  nilai tak diketahui → 0,3; `pays_bounty: false` → 0. Freshness: ≤7 hari → 1,0;
  ≤30 → 0,8; ≤90 → 0,5; ≤180 → 0,3; >180 → 0,1; tak ada → 0,2.
  Kompetisi: low → 1,0; medium → 0,6; high → 0,2; unknown → 0,5.
- Drop filter (`qualifierDropReasons`, 6): undangan false; scope kosong tanpa
  security.txt; RoE larang otomatis; status exhausted/blacklisted; excluded-tests
  melarang semua teknik agen (frasa blanket "all/any testing" ATAU keempat teknik
  `AGENT_TECHNIQUES` dilarang); deadline lewat.
- `gateProgram(raw, mode)` — 5 tes: publicInvitation, scopeExplicit, notExcluded,
  agenticAllowed, noConflictingSignal. Tiap tes true/false/"unknown". Vonis:
  ada fail → TOLAK; security.txt tanpa undangan eksplisit → KONFIRMASI;
  ada unknown/ambigu → KONFIRMASI; semua lolos + mode strict → KONFIRMASI;
  semua lolos + mode auto → LAYAK; mode paused → KONFIRMASI.
- `routeProgram(raw)` — permukaan → detektor: evm-solidity/contest → all-17;
  defi-lending → oracle/commented-out/enum/MAC/dead-config; defi-perps →
  vacuous/dead-config/share-accounting/MAC/division; bridge → eth-locked/
  tx-origin/MAC/free-mem-pointer. Plus antrean + baseline.
- `dedupePrograms(existing, candidates)` — per id; re-open bila `policyHash`
  berubah; blacklist tidak pernah di-antre ulang.
- `intakeRun(programs, existing, opts)` — dedupe → skor → gate → routing;
  urut skor menurun, seri → scope sub-skor lebih tinggi dulu (lebih aman,
  bukan payout lebih besar). `ranked` = tidak drop + bukan TOLAK;
  `blacklisted` = tidak drop + TOLAK.

## Koreksi desain (ditemukan saat pengujian)

Drop di qualifier ≠ FAIL gerbang. Kandidat yang scope-nya belum terverifikasi
(Kiln, Tokenize.it, VeChain) TIDAK masuk blacklist — mereka tetap kandidat
untuk verifikasi ulang, bukan target terlarang. `intakeRun` memisahkan
`dropped` dari `blacklisted` karena ini.

## Hasil intake atas 7 target dikenal (mode auto, now 17 Nov 04:38 WIB)

| Program | Skor | Vonis | Keterangan |
|---|---|---|---|
| RAAC (Guardian) | 86,3 | LAYAK | 20 kontrak, pool $100 rb musiman, deadline 9 Des 2026 |
| Cronos zkEVM (HackenProof) | 84,0 | LAYAK | 103 aset, maks $50 rb, fee $0, gate reputasi 0 |
| Nado (HackenProof) | 78,0 | KONFIRMASI | izin agentic belum terbukti; gerbang reputasi ≥100 (catatan, bukan tes gate) |
| Aktionariat (self-hosted) | 57,0 | KONFIRMASI | izin agentic belum terbukti; reward 3 ETH (USD tak dihitung) |
| Kiln V2 (Cantina) | 60,8 | DROP | scope belum terverifikasi — bukan blacklist |
| Tokenize.it (HackenProof) | 34,0 | DROP | scope/status/pool belum terverifikasi — bukan blacklist |
| VeChain Stargate (HackenProof) | 34,0 | DROP | scope/status/pool belum terverifikasi — bukan blacklist |

Mode strict (default v10): Cronos + RAAC → KONFIRMASI (butuh konfirmasi
manusia — Cronos sudah dikonfirmasi Toufik di chat 12 Nov, antrean ACTIVE
tetap jalan; RAAC masih antrean QUEUE, belum dikonfirmasi).

## UI

`index.html` seksi "3. Intake & Gate" + pemilih mode + tombol
→ `app.js` memanggil `intakeRun(knownPrograms(), [], {mode})` →
`renderIntakeReport` (kartu per program: skor per kriteria + vonis + alasan
+ routing). Serve statis lokal HTTP 200 (index/intake.js/app.js).

## Tes

Seksi 31, 41 tes baru: band sub-skor, 6 drop filter (+ 2 kontrol negatif),
matriks gate (auto/strict/paused/security.txt-only/privat/login-wall/
scope-kosong/RoE-larang), routing, dedupe, intake run atas 7 target dikenal,
render kartu + laporan. **Test 348/348 PASS.**

## Review Kiro crew

Pass review adversarial atas intake.js via browser task 2f2eb33e
(17 Nov 04:53–05:13 WIB terukur runtime, 20 mnt; sesi Kiro baru "Audit Intake
Gate M2.5", ID 9c87a853-c5d6-41e9-ac6d-622d24506bcc; kode ditempel verbatim
3 bagian + 1 pesan data; harness Node dari salinan byte-for-byte di scratch
sandbox, sudah dihapus; tanpa ubahan repo/commit/push).
**MODEL_TIDAK_SESUAI:** pemilih disetel eksplisit Opus 5.5, jawaban pertama
Opus 5.5, lalu bergeser sendiri ke **Opus 4.8** ("refused; answered by
Opus 4.8") — seluruh review dikerjakan Opus 4.8.
**Vonis: 95/99 kasus benar, 0 FP keamanan** (gate fail-safe, tidak ada
program terlarang yang lolos). 4 ketidakcocokan: 1 ekspektasi Kiro sendiri
salah (#70 — securityTxtOnly=true memaksa KONFIRMASI apa pun invites-nya,
kode BENAR); 3 skor klaim meleset (Kiln/Tokenize.it/VeChain — vonis DROP
tetap benar).

### Kalibrasi R1 (wasit jack — tiap klaim diverifikasi ke kode ASLI via Node)

| Item | Vonis wasit | Perbaikan |
|---|---|---|
| P1 HIGH — scopeAssetCount vs scope_assets.length | TERBUKTI (scope sub 1,0 tapi gate TOLAK + dropped) | `scopeCount(p)` kanonik, dipakai skoring + drop filter + gate + alasan |
| P2 HIGH — scope kosong + securityTxt → TOLAK/blacklist | TERBUKTI (qualifier tidak drop, gate TOLAK, intakeRun blacklist) | `scopeExplicit` = "unknown" bila scope 0 + securityTxt → KONFIRMASI; alasan "scope belum terurai" kini tercapai (P9 ikut selesai) |
| P3 MED-HIGH — blanketExcluded substring | TERBUKTI ("casino testing" mengandung "no testing", "install testing" mengandung "all testing", "no testing on prod" mengandung "no testing") | `isBlanketBan`: frasa blanket hanya bila entri memang larangan menyeluruh (persis / diawali frasa tanpa qualifier scope "on/in/against/...") |
| P4 MED — dedupe blacklist tak pernah re-open | TERBUKTI (cek blacklist sebelum policyHash) | bandingkan policyHash dulu; re-open bawa `wasBlacklisted: true` |
| P5 MED — default unknown menaikkan skor | SEBAGIAN (trade-off desain, bukan bug) | didokumentasikan (skor miskin-data = batas atas) + `unknownFields` diekspos di hasil & kartu UI |
| P6 MED — klaim skor Kiln 60,8 / Tokenize 34,0 | **DITOLAK** — angka Kiro 55,0/29,0 dari pemetaan fixture tak lengkap (fit/novelty di-default 0,5, bukan nilai knownPrograms 0,85/0,8/0,6); skor kode terverifikasi ulang 60,8/34,0/34,0 | pelajaran: pass Kiro berikut wajib menyertakan kode fixture lengkap, bukan ringkasan teks |
| P7 LOW-MED — freshness masa depan → 1,0 | TERBUKTI | masa depan → 0,2 (seperti tak terverifikasi) |
| P8 LOW — paused menelan vonis keras | TERBUKTI (doNotTest + paused → KONFIRMASI) | fail keras tetap TOLAK di mode paused; KONFIRMASI hanya untuk yang tak terlarang |
| P9 LOW — alasan "scope belum terurai" kode mati | TERBUKTI (unreachable sebelum P2) | selesai via P2 |
| P10 LOW — Math.round half-up | didokumentasikan (86,25 → 86,3) | komentar di kode |
| P11 LOW — skor dihitung untuk entri dropped | diterima (kosmetik) | `intakeRun`: skor entri dropped = null; kartu render "— (drop — bukan kandidat)" |

**Hasil pasca-R1 (mode auto, now 17 Nov 04:38):** ranked tetap RAAC 86,3 >
Cronos 84,0 > Nado 78,0 > Aktionariat 57,0; dropped Kiln/Tokenize.it/VeChain
(skor intakeRun null; aritmetika mentah 60,8/34,0/34,0 terkunci di tes
scoreProgram); blacklist 0. Mode strict: keempatnya KONFIRMASI.
**Tes: 380/380 PASS** (348 + 32 baru seksi 32). Hunting tidak di-re-run
(kalibrasi hanya menyentuh intake.js, pipeline/detektor tak berubah).

## Hunting re-run 17 Nov 04:38 WIB (pasca-M2.5, 17 detektor)

IDENTIK, 0 kandidat baru — Fulcrom **15** (30 mentah → 15 dropped),
Amply **18**, RAAC **14**, Hyperbridge **2**, Flow **0**; recall vs Kiro AMP
tetap 4/7. File: `fulcrom/amply/raac/hyperbridge/flow-hunt-2026-11-17.json/.md`.
