# Design — FrankenAudit MVP

## Arsitektur

```
┌─────────────┐   pilih sampel /        ┌──────────────────┐
│  app/       │   tempel alamat /       │  pipeline.js     │
│  index.html │ ──► unggah .sol ──────► │  - pattern scan  │
│  + app.js   │                         │  - normalisasi   │
└─────────────┘                         │    kandidat      │
       ▲                                └──────┬───────────┘
       │ laporan kandidat                      │
       │ (render format BB)                    ▼
       │                              ┌──────────────────┐
       │                              │  report.js       │
       │                              │  render +        │
       │                              │  ringkasan akhir │
       └──────────────────────────────┴──────────────────┘

Mode Slither (opsional, M2 akhir):
  .sol diunggah ──► slither CLI (lokal/Daytona) ──► JSON ──► normalisasi ──► kandidat
Lookup on-chain (read-only):
  alamat ──► RPC publik eth_getCode/eth_call ──► info deployment ──► konteks kandidat
```

## Komponen

### app/index.html
Satu halaman: header + disclaimer kandidat, panel input (dropdown
sampel, field alamat, upload `.sol`), tombol analisis, area laporan.

### app/app.js
Orkestrasi UI: muat sampel, validasi alamat, panggil pipeline, render
laporan. Tanpa framework.

### app/pipeline.js
- `scanPatterns(source)`: regex/AST-ringan untuk pola klasik
  (call-sebelum-update, divisi tanpa guard, fungsi tanpa modifier,
  ecrecover tanpa cek nol). Tiap hit → kandidat mentah.
- `normalizeSlither(json)`: petakan detector Slither → format kandidat.
- `enrichCandidate(raw)`: tempel template narasi hipotesis + prasyarat
  + verifikasi sesuai steering bug-bounty.

### app/report.js
Render kandidat ke kartu laporan + bagian penutup (area terpetakan /
belum / 3 hipotesis terkuat). Sorting default: severity tebakan desc,
lalu kelas prioritas steering.

### app/samples/
Kontrak `.sol` sampel terkurasi + file `.analysis.json` berisi kandidat
yang sudah dikurasi manusia (ground truth untuk demo juri + pengujian
produk). Sampel pertama: kontrak jebakan (trap) kecil yang dipakai tim
untuk latihan audit — mengandung 2–3 bug nyata + 1 pola aman yang sering
salah-flag (negative control).

## Format data kandidat (JSON)

```json
{
  "id": "FA-001",
  "title": "…",
  "location": { "file": "Vault.sol", "function": "withdraw" },
  "hypothesis": "…",
  "preconditions": "…",
  "impact": "…",
  "severityGuess": "Medium",
  "evidence": "kutipan kode …",
  "toVerify": ["…"],
  "source": "pattern-scan | slither | kiro-crew | curated"
}
```

## Keputusan desain

- **Statis dulu, backend belakangan.** Juri harus bisa buka URL tanpa
  server; Slither jadi mode opsional, bukan prasyarat demo.
- **Ground truth terkurasi > detektor mentah.** Laporan sampel memakai
  analisis manusia sebagai referensi; pattern scan hanya pemicu awal.
- **Tidak ada state server / akun.** Semua jalan di browser pengguna.
- **Kiro crew sebagai lapisan review, bukan eksekutor.** Output crew
  adalah teks kandidat; crew tidak menjalankan kode target.

## Risiko

- Pattern scan regex bisa false-positive → mitigasi: label sumber
  jelas + negative control di sampel.
- RPC publik bisa rate-limit → mitigasi: lookup on-chain opsional,
  laporan tetap jalan tanpa itu.
- Slither belum terpasang di VM ini (cek 13 Nov: tidak ada) → mitigasi:
  mode sampel dulu; instalasi Slither dijadwalkan di M2 via venv/Daytona.
