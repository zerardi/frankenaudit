# Requirements — FrankenAudit MVP

## Pengantar

Asisten audit smart-contract open-source untuk pemburu bug bounty pemula.
Input: alamat kontrak atau file `.sol`. Output: halaman laporan kandidat
temuan berformat bug bounty. Target: pipeline jalan ujung-ke-ujung
17–18 Nov 2026; URL live ±19 Nov 2026.

## Requirements

### 1. Input kontrak

- **R1.1** Pengguna dapat memilih salah satu kontrak sampel terkurasi
  dari daftar di aplikasi.
  - *Acceptance:* memilih sampel menampilkan source `.sol`-nya dan
    tombol "Jalankan analisis" aktif.
- **R1.2** Pengguna dapat menempel alamat kontrak (EVM, 0x…) untuk
  lookup read-only.
  - *Acceptance:* alamat tidak valid ditolak dengan pesan jelas; alamat
    valid memicu fetch bytecode/source (bila tersedia publik) tanpa
    transaksi.
- **R1.3** Pengguna dapat mengunggah file `.sol`.
  - *Acceptance:* file terbaca di browser; isi ditampilkan; analisis
    mode sampel tetap jalan bila Slither belum tersedia.

### 2. Pipeline analisis

- **R2.1** Pipeline mode sampel: pattern scan ringan (pola klasik:
  external call sebelum state update, divisi tanpa guard nol, fungsi
  kritikal tanpa modifier, ecrecover tanpa cek address(0)) atas source
  yang dimasukkan.
  - *Acceptance:* tiap pola yang cocok menghasilkan satu kandidat
    mentah dengan lokasi file:fungsi + kutipan kode.
- **R2.2** Pipeline mode Slither (bila backend/CLI tersedia): hasil
  Slither dinormalisasi ke format kandidat yang sama dengan R2.1.
  - *Acceptance:* output Slither tampil sebagai kandidat dengan
    severity Slither terpetakan ke skala Low/Medium/High.
- **R2.3** Review Kiro-agent: tiap kandidat mentah dilengkapi narasi
  hipotesis + prasyarat + "yang harus diverifikasi" mengikuti format
  `.kiro/steering/bug-bounty.md`.
  - *Acceptance:* tidak ada kandidat di laporan yang tampil tanpa
    hipotesis dan daftar verifikasi.

### 3. Laporan audit

- **R3.1** Halaman laporan menampilkan daftar kandidat (ID, judul,
  severity tebakan, lokasi, hipotesis, prasyarat, dampak, bukti kode,
  verifikasi).
  - *Acceptance:* laporan sampel lengkap dan bisa dibaca juri tanpa
    penjelasan tambahan.
- **R3.2** Laporan ditutup dengan: area yang sudah dipetakan, area yang
  belum, dan 3 hipotesis terkuat.
  - *Acceptance:* ketiga bagian selalu ada di akhir laporan.
- **R3.3** Laporan menyatakan eksplisit: "kandidat, bukan verdict —
  butuh PoC fork oleh wasit".
  - *Acceptance:* disclaimer tampil di atas laporan.

### 4. Lookup on-chain read-only

- **R4.1** Untuk alamat kontrak, aplikasi membaca bytecode / state
  publik via RPC publik (eth_getCode, eth_call).
  - *Acceptance:* tidak ada transaksi yang dikirim; tidak ada prompt
    wallet; tidak ada private key yang diminta.

### 5. Deploy & submission

- **R5.1** Aplikasi bisa di-deploy sebagai situs statis (tanpa server
  wajib) dan dibuka juri lewat URL.
- **R5.2** Repo publik berisi semua source + LICENSE MIT terdeteksi +
  direktori `/.kiro` di root (tidak di-gitignore).
