// FrankenAudit — app.js (M1 scaffold)
// UI orchestration. The sample list is loaded from samples/index.json (M2).

const $ = (id) => document.getElementById(id);

function isValidAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

// Upstream baseline (UI wiring): a basename -> source map built from the
// .sol files the user uploads. Used by runPipeline for the
// enum-semantic-shift detector + upstream-diff classification
// (commented-out-*, oracle-passthrough). Without a baseline those
// candidates still appear, but without the upstream annotation.
let baselineMap = null; // null = not uploaded yet
let baselineCollisions = [];

function renderBaselineStatus() {
  const el = $("baseline-status");
  const clearBtn = $("baseline-clear-btn");
  if (!baselineMap) {
    el.textContent = "Baseline: none uploaded — commented-out / enum / "
      + "oracle candidates are shown without upstream-diff classification.";
    clearBtn.hidden = true;
    return;
  }
  const n = Object.keys(baselineMap).length;
  el.textContent = "Baseline: " + n + " upstream file(s) loaded"
    + (baselineCollisions.length
      ? " (basename collisions ignored: " + baselineCollisions.join(", ") + ")"
      : "")
    + " — commented-out / enum / oracle candidates are classified "
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
  $("report").innerHTML = "<p>Baseline loaded (" + Object.keys(baselineMap).length
    + " file(s)). Click “Run analysis” for a pass with upstream-diff classification.</p>";
});

$("baseline-clear-btn").addEventListener("click", () => {
  baselineMap = null;
  baselineCollisions = [];
  $("baseline-input").value = "";
  renderBaselineStatus();
  $("report").innerHTML = "<p>Baseline cleared. The next pass runs without upstream-diff classification.</p>";
});

$("run-btn").addEventListener("click", () => {
  const source = $("source-view").textContent || "";
  const fileName = $("sample-select").value || "input.sol";
  if (!source || source.startsWith("// contract source")) {
    $("report").innerHTML = "<p>No source yet. Pick a sample, upload "
      + "a .sol file, or paste a contract address first.</p>";
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
  $("report").innerHTML = "<p>File loaded. Click “Run analysis”.</p>";
});

$("address-input").addEventListener("change", async (e) => {
  const addr = e.target.value.trim();
  if (!addr) return;
  if (!isValidAddress(addr)) {
    $("report").innerHTML = "<p>Invalid address. Format: 0x + 40 hex characters.</p>";
    return;
  }
  const rpc = ($("chain-select") && $("chain-select").value)
    || "https://bsc-dataseed.binance.org/";
  $("report").innerHTML = "<p>Checking on-chain bytecode (read-only, eth_getCode)…</p>";
  try {
    const code = await Promise.race([
      fetchBytecodeReadOnly(rpc, addr),
      new Promise((_, rej) => setTimeout(() => rej(new Error("RPC timeout")), 15000)),
    ]);
    if (!code || code === "0x") {
      $("report").innerHTML = "<p>Address " + addr + " is <strong>not a contract</strong> "
        + "(no bytecode on this chain) — likely an EOA / not deployed yet. "
        + "Analysis needs the .sol source: upload the file or pick a sample.</p>";
      return;
    }
    const bytes = (code.length - 2) / 2;
    $("report").innerHTML = "<p>Address " + addr + " is a <strong>deployed contract</strong> "
      + "(bytecode " + bytes.toLocaleString("en-US") + " bytes, checked read-only via eth_getCode). "
      + "Source is not fetched automatically — paste/upload this contract's .sol file and click "
      + "“Run analysis” for the candidate report.</p>";
  } catch (err) {
    $("report").innerHTML = "<p>On-chain lookup failed (" + err.message + "). "
      + "Check the connection / RPC, or upload the .sol file directly.</p>";
  }
});

// M2.5 Intake & Gate: score the known programs (score + gate verdict +
// routing) and render their cards. The gate mode is picked by the user;
// default strict (v10). A KONFIRMASI verdict = stop, do NOT hunt that
// target until a human confirms; TOLAK = blacklist.
$("intake-run-btn").addEventListener("click", () => {
  const mode = ($("intake-mode-select") && $("intake-mode-select").value) || "strict";
  const run = intakeRun(knownPrograms(), [], { mode });
  $("intake-report").innerHTML = renderIntakeReport(run);
});

// Load the sample list (M2 — if samples/index.json does not exist yet, leave empty).
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
  .catch(() => { /* no samples yet — normal at M1 */ });

$("sample-select").addEventListener("change", async (e) => {
  const file = e.target.value;
  if (!file) return;
  const res = await fetch("samples/" + file);
  $("source-view").textContent = await res.text();
  $("report").innerHTML = "<p>Sample loaded. Click “Run analysis”.</p>";
});
