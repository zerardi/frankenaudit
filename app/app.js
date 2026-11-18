// FrankenAudit — app.js (M1 scaffold)
// Orkestrasi UI. Daftar sampel dimuat dari samples/index.json (M2).
// M1: tanpa sampel dulu — input manual (tempel source via upload / alamat
// hanya validasi format; lookup on-chain di M2).

const $ = (id) => document.getElementById(id);

function isValidAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

// Baseline upstream (wiring UI, sesi 00:38 WIB 2026-11-15): peta
// basename -> source, dibangun dari file .sol yang diunggah user.
// Dipakai runPipeline untuk detektor enum-semantic-shift + klasifikasi
// upstream-diff (commented-out-*, oracle-passthrough). Tanpa baseline,
// kandidat-kandidat itu tetap muncul tapi tanpa anotasi upstream.
let baselineMap = null; // null = belum diunggah
let baselineCollisions = [];

function renderBaselineStatus() {
  const el = $("baseline-status");
  const clearBtn = $("baseline-clear-btn");
  if (!baselineMap) {
    el.textContent = "Baseline: belum diunggah — kandidat commented-out / "
      + "enum / oracle tampil tanpa klasifikasi upstream-diff.";
    clearBtn.hidden = true;
    return;
  }
  const n = Object.keys(baselineMap).length;
  el.textContent = "Baseline: " + n + " file upstream dimuat"
    + (baselineCollisions.length
      ? " (tabrakan basename diabaikan: " + baselineCollisions.join(", ") + ")"
      : "")
    + " — kandidat commented-out / enum / oracle diklasifikasi "
    + "live-identical / live-modified / live-divergent / absent.";
  clearBtn.hidden = false;
}

$("baseline-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const read = files.map(async (f) => ({ name: f.name, text: await f.text() }));
  const loaded = await Promise.all(read);
  const built = buildBaselineMap(loaded);
  baselineMap = built.map;
  baselineCollisions = built.collisions;
  renderBaselineStatus();
  $("report").innerHTML = "<p>Baseline dimuat (" + Object.keys(baselineMap).length
    + " file). Klik “Jalankan analisis” untuk pass dengan klasifikasi upstream-diff.</p>";
});

$("baseline-clear-btn").addEventListener("click", () => {
  baselineMap = null;
  baselineCollisions = [];
  $("baseline-input").value = "";
  renderBaselineStatus();
  $("report").innerHTML = "<p>Baseline dihapus. Pass berikutnya jalan tanpa klasifikasi upstream-diff.</p>";
});

$("run-btn").addEventListener("click", () => {
  const source = $("source-view").textContent || "";
  const fileName = $("sample-select").value || "input.sol";
  if (!source || source.startsWith("// source kontrak")) {
    $("report").innerHTML = "<p>Belum ada source. Pilih sampel, unggah "
      + "file .sol, atau tempel alamat kontrak dulu.</p>";
    return;
  }
  const result = runPipeline(source, fileName,
    baselineMap ? { baseline: baselineMap } : undefined);
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

// M2.5 Intake & Gate (sesi 04:38 WIB 2026-11-17): nilai program yang dikenal
// (skor + vonis gerbang + routing) dan render kartunya. Mode gerbang dipilih
// user; default strict (v10). Vonis KONFIRMASI = berhenti, JANGAN hunting
// target itu sampai manusia mengonfirmasi; TOLAK = blacklist.
$("intake-run-btn").addEventListener("click", () => {
  const mode = ($("intake-mode-select") && $("intake-mode-select").value) || "strict";
  const run = intakeRun(knownPrograms(), [], { mode });
  $("intake-report").innerHTML = renderIntakeReport(run);
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
