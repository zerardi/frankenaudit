// FrankenAudit — report.js (M2: render kartu kandidat + penutup)
// Render laporan kandidat mengikuti format baku steering bug-bounty.md

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderCandidate(c) {
  const upstream = c.upstream
    ? `<p><strong>Upstream-diff:</strong> ${esc(c.upstream.classification)}`
      + (c.upstream.similarity !== undefined
        ? ` (cakupan token baseline ${esc(c.upstream.similarity)})` : "")
      + (c.upstream.intentMarker ? ` · penanda niat: ya` : "")
      + ` · baseline ${esc(c.upstream.baselineFile || "—")}</p>`
    : "";
  return `<article class="candidate">
    <h3>${esc(c.id)} — ${esc(c.title)}</h3>
    <p><strong>Lokasi:</strong> ${esc(c.location.file)} : ${esc(c.location.function)}</p>
    <p><strong>Hipotesis:</strong> ${esc(c.hypothesis)}</p>
    <p><strong>Prasyarat:</strong> ${esc(c.preconditions)}</p>
    <p><strong>Dampak + severity tebakan:</strong> ${esc(c.severityGuess)} — ${esc(c.impact)}</p>
    <p><strong>Bukti kode:</strong> <code>${esc(c.evidence)}</code></p>${upstream}
    <p><strong>Yang harus diverifikasi wasit:</strong></p>
    <ul>${c.toVerify.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>
    <p class="src">Sumber: ${esc(c.source)}</p>
  </article>`;
}

function renderReport(result) {
  if (!result.candidates.length) {
    return `<p>Tidak ada kandidat dari pass ini. Bukan berarti kontrak aman —
      hanya berarti pola yang dipindai pass ini tidak cocok.</p>`
      + renderClosing(result);
  }
  return result.candidates.map(renderCandidate).join("\n")
    + renderClosing(result);
}

function renderClosing(result) {
  const top = result.topHypotheses.map((c) =>
    `<li>${esc(c.id)} — ${esc(c.title)} (${esc(c.severityGuess)})</li>`).join("");
  const baselineLine = result.baseline
    ? `<p><strong>Baseline upstream:</strong> ${result.baseline.files} file — `
      + `kandidat commented-out / enum / oracle sudah diklasifikasi `
      + `live-identical / live-modified / live-divergent / absent.</p>`
    : `<p><strong>Baseline upstream:</strong> tidak dipakai pass ini — `
      + `unggah file .sol upstream untuk mengaktifkan klasifikasi `
      + `by-design vs deviasi fork.</p>`;
  return `<section class="closing">
    <h3>Penutup pass</h3>
    ${baselineLine}
    <p><strong>Area yang sudah dipetakan:</strong> ${result.mappedAreas.map(esc).join("; ") || "—"}</p>
    <p><strong>Area yang belum:</strong> ${result.unmappedAreas.map(esc).join("; ") || "—"}</p>
    <p><strong>3 hipotesis terkuat:</strong></p>
    <ol>${top || "<li>—</li>"}</ol>
    <p class="disclaimer">Kandidat di atas BUKAN verdict. Verifikasi akhir
      (data live + PoC di fork) dilakukan wasit manusia.</p>
  </section>`;
}

// Export Node (untuk test runner); di browser, fungsi tetap global.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderReport, renderCandidate, esc };
}
