# FrankenAudit

Asisten audit smart-contract open-source untuk pemburu bug bounty pemula —
dibangun untuk **Kiroween 2026 (kategori Frankenstein)**.

**Nama kerja** — nama final menunggu persetujuan pemilik proyek.

## Apa ini

Tempel alamat kontrak atau unggah file `.sol`, jalankan pipeline analisis,
dapat halaman laporan berisi **kandidat temuan berformat bug bounty** —
bukan vonis. Setiap kandidat membawa hipotesis yang bisa difalsifikasi,
prasyarat state, tebakan severity, dan daftar verifikasi untuk wasit manusia.

Jahitan ("Frankenstein"):

1. **Slither / analisis statis** — detektor otomatis sebagai pass pertama.
2. **Kiro agent crew** — agen-agen Kiro dengan persona bug bounty
   (`.kiro/steering/bug-bounty.md`) membaca kode yang sama dari sudut
   berbeda dan review silang sebelum kandidat ditulis ke laporan.
3. **Lookup on-chain read-only** — baca state deployment live untuk
   memalsifikasi kandidat yang hanya hidup "di kode" tapi mati
   "di deployment". Tanpa transaksi, tanpa wallet.

## Prinsip

- **Candidate, bukan verdict.** Tidak ada temuan yang disebut "terbukti"
  sebelum PoC fork oleh wasit.
- **Hypothesis-first.** Setiap kandidat mulai dari hipotesis yang bisa
  dibantah.
- **Read-only, selalu.** Tidak ada private key, seed, `.env`, atau
  transaksi mainnet di jalur mana pun.
- **Bisa dipakai dalam 2 menit:** buka URL → pilih kontrak sampel →
  lihat laporan. Tanpa login, tanpa setup.

## Coba lokal (M1)

```bash
cd app
python3 -m http.server 8000
# buka http://localhost:8000
```

Mode sampel terkurasi jalan penuh di browser. Mode Slither butuh
`slither-analyzer` terpasang terpisah (`pip install slither-analyzer`) —
lihat `.kiro/specs/frankenaudit/design.md`.

## Struktur

```
frankenaudit/
  .kiro/
    steering/        # persona & konteks tetap (bug-bounty, product, tech)
    specs/           # spec fitur ala Kiro (requirements/design/tasks)
    hooks/           # automation hooks Kiro
  app/               # aplikasi web statis (MVP)
    samples/         # kontrak .sol sampel terkurasi + analisisnya
  docs/              # catatan desain & keputusan
  LICENSE            # MIT
```

## Status

- M1 scaffold — selesai 13 Nov 2026 (sesi sprint 12:38 WIB)
- M2 MVP pipeline — target siap-hunting 17–18 Nov 2026
- M3 URL live — target ±19 Nov 2026
- Deadline submission Devpost: 5 Des 2026 05:00 WIB

Detail progres: lihat log sesi di repo induk (STATUS.md Frankenstein).
Proyek ini TIDAK PERNAH submit laporan bug bounty — kandidat hasil
pengujian produk diserahkan ke wasit manusia untuk diverifikasi (fork PoC).

## Lisensi

MIT — lihat `LICENSE`.
