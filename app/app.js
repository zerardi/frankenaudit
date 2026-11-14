// FrankenAudit — app.js (M1 scaffold)
// Orkestrasi UI. Daftar sampel dimuat dari samples/index.json (M2).
// M1: tanpa sampel dulu — input manual (tempel source via upload / alamat
// hanya validasi format; lookup on-chain di M2).

const $ = (id) => document.getElementById(id);

function isValidAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

$("run-btn").addEventListener("click", () => {
  const source = $("source-view").textContent || "";
  const fileName = $("sample-select").value || "input.sol";
  if (!source || source.startsWith("// source kontrak")) {
    $("report").innerHTML = "<p>Belum ada source. Pilih sampel, unggah "
      + "file .sol, atau tempel alamat kontrak dulu.</p>";
    return;
  }
  const result = runPipeline(source, fileName);
  $("report").innerHTML = renderReport(result);
});

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $("source-view").textContent = text;
  $("report").innerHTML = "<p>File dimuat. Klik “Jalankan analisis”.</p>";
});

$("address-input").addEventListener("change", async (e) => {
  const addr = e.target.value.trim();
  if (!addr) return;
  if (!isValidAddress(addr)) {
    $("report").innerHTML = "<p>Alamat tidak valid. Format: 0x + 40 karakter hex.</p>";
    return;
  }
  const rpc = ($("chain-select") && $("chain-select").value)
    || "https://bsc-dataseed.binance.org/";
  $("report").innerHTML = "<p>Mengecek bytecode on-chain (read-only, eth_getCode)…</p>";
  try {
    const code = await Promise.race([
      fetchBytecodeReadOnly(rpc, addr),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout RPC")), 15000)),
    ]);
    if (!code || code === "0x") {
      $("report").innerHTML = "<p>Alamat " + addr + " <strong>bukan kontrak</strong> "
        + "(tidak ada bytecode di chain ini) — kemungkinan EOA / belum deploy. "
        + "Analisis butuh source .sol: unggah file atau pilih sampel.</p>";
      return;
    }
    const bytes = (code.length - 2) / 2;
    $("report").innerHTML = "<p>Alamat " + addr + " adalah <strong>kontrak ter-deploy</strong> "
      + "(bytecode " + bytes.toLocaleString("id-ID") + " byte, dicek read-only via eth_getCode). "
      + "Source belum diambil otomatis — tempel/unggah file .sol kontrak ini lalu klik "
      + "“Jalankan analisis” untuk laporan kandidat.</p>";
  } catch (err) {
    $("report").innerHTML = "<p>Lookup on-chain gagal (" + err.message + "). "
      + "Cek koneksi / RPC, atau unggah file .sol langsung.</p>";
  }
});

// Muat daftar sampel (M2 — bila samples/index.json belum ada, biarkan kosong).
fetch("samples/index.json")
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => {
    list.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.file;
      opt.textContent = s.name;
      $("sample-select").appendChild(opt);
    });
  })
  .catch(() => { /* belum ada sampel — wajar di M1 */ });

$("sample-select").addEventListener("change", async (e) => {
  const file = e.target.value;
  if (!file) return;
  const res = await fetch("samples/" + file);
  $("source-view").textContent = await res.text();
  $("report").innerHTML = "<p>Sampel dimuat. Klik “Jalankan analisis”.</p>";
});
