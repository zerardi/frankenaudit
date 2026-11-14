# Product — Steering

## Apa itu FrankenAudit

FrankenAudit adalah asisten audit smart-contract open-source untuk pemburu
bug bounty pemula. Pengguna menempel alamat kontrak (atau mengunggah file
`.sol`), aplikasi menjalankan pipeline analisis, dan hasilnya adalah halaman
laporan berisi **kandidat temuan berformat bug bounty** — bukan vonis.
Setiap kandidat membawa hipotesis yang bisa difalsifikasi, prasyarat state,
tebakan severity, dan daftar verifikasi untuk wasit manusia.

Nama kerja: FrankenAudit (nama final menunggu persetujuan pemilik proyek).

## Jahitan ("Frankenstein")

1. **Slither / analisis statis** — detektor otomatis sebagai pass pertama
   (pola klasik: reentrancy, uninitialized state, shadowing, dll).
2. **Kiro agent crew** — beberapa agen Kiro dengan persona bug bounty
   (lihat `steering/bug-bounty.md`) membaca kode yang sama dari sudut
   berbeda: accounting, access control, oracle, likuidasi. Crew berdebat
   silang (review antar-model) sebelum kandidat ditulis ke laporan.
3. **Lookup on-chain read-only** — baca state deployment live (bukan
   sekadar kode): bobot aset, saldo insurance, konfigurasi — untuk
   memalsifikasi kandidat yang hanya hidup "di kode" tapi mati
   "di deployment". Tidak ada transaksi, tidak ada wallet.

## Prinsip produk

- **Candidate, bukan verdict.** Tidak ada temuan yang disebut "terbukti"
  sebelum PoC fork oleh wasit.
- **Hypothesis-first.** Setiap kandidat mulai dari hipotesis yang bisa
  dibantah, bukan dari pola yang dicocokkan buta.
- **Read-only, selalu.** Tidak ada private key, seed, `.env`, atau
  transaksi mainnet di jalur mana pun.
- **Bisa dipakai juri dalam 2 menit:** buka URL → pilih kontrak sampel →
  lihat laporan kandidat. Tanpa login, tanpa setup.

## Pengguna utama

Pemburu bug bounty pemula (HackenProof / CodeHawks / Sherlock / Cantina)
yang butuh peta permukaan serangan cepat sebelum audit manual mendalam.

## Bukan produk ini

- Bukan auto-submitter laporan (FrankenAudit TIDAK PERNAH submit).
- Bukan audit-as-a-service berbayar.
- Bukan alat exploit / PoC otomatis di mainnet.
