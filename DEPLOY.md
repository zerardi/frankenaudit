# Deploy FrankenAudit (M3)

Aplikasi ini **statis murni** (`app/` — HTML + CSS + JS, tanpa build step,
tanpa backend). Pipeline analisis jalan di browser; lookup on-chain hanya
`eth_getCode` read-only ke RPC publik (default BSC dataseed, bisa diganti
di UI ke Ethereum / Cronos zkEVM).

## Jalur utama: GitHub Pages (gratis, URL publik untuk juri)

> ⛔ **BUTUH PERSETUJUAN TOUFIK DULU** — langkah 1–2 membuat repo **publik**
> di akun GitHub `zerardi` dan mem-push seluruh source. Sesi ini menyiapkan
> semuanya lokal; JANGAN push sebelum the owner bilang "gass" di chat.

1. Buat repo publik `zerardi/frankenaudit` di GitHub (tanpa README/.gitignore
   awal — repo lokal sudah berisi semuanya, termasuk `LICENSE` MIT dan
   `.kiro/` di root).
2. Dari `frankenaudit/`:
   ```sh
   git remote add origin https://github.com/zerardi/frankenaudit.git
   git push -u origin main
   ```
3. Di repo GitHub: Settings → Pages → Build and deployment → Source:
   **GitHub Actions**. Workflow `.github/workflows/pages.yml` (sudah ada
   di repo ini) otomatis deploy isi `app/` ke Pages setiap push ke `main`.
4. URL hasil: `https://zerardi.github.io/frankenaudit/` — verifikasi:
   buka URL, jalankan analisis atas sampel TrapVault, pastikan laporan
   muncul dan lookup on-chain jalan.

## Jalur alternatif (bila Pages bermasalah)

- **Netlify Drop / Vercel**: drag-and-drop folder `app/` — tanpa akun baru
  bila sudah login; URL sementara tetap bisa dipakai juri, tapi URL final
  yang dicantumkan di Devpost sebaiknya yang GitHub Pages (stabil).
- **Lokal saja**: `cd app && python3 -m http.server` — hanya untuk demo
  internal, BUKAN URL juri.

## Checklist sebelum URL dicantumkan di Devpost

- [ ] Repo publik `zerardi/frankenaudit` berisi source + LICENSE MIT + `.kiro/`
- [ ] URL Pages hidup dan halaman utama termuat (judul "FrankenAudit")
- [ ] Analisis sampel TrapVault → 30 kandidat tampil di laporan
- [ ] Lookup on-chain: alamat kontrak Amply Pool proxy → bytecode terbaca
- [ ] Tidak ada kunci/API secret di repo (cek `git log --all --oneline`)

## Yang sudah diverifikasi sesi 00:38 WIB 14 Nov 2026

- Serve statis lokal: `python3 -m http.server` → `index.html`,
  `pipeline.js`, `report.js`, `app.js`, `style.css` semua HTTP 200.
- Workflow Pages + dokumen ini disiapkan; push MASIH MENUNGGU persetujuan.
