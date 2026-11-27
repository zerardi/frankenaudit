// FrankenAudit — report.js (M2: candidate card rendering + closing)
// Renders the candidate report in the standard format of steering bug-bounty.md

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderCandidate(c) {
  const upstream = c.upstream
    ? `<p><strong>Upstream-diff:</strong> ${esc(c.upstream.classification)}`
      + (c.upstream.similarity !== undefined
        ? ` (baseline token coverage ${esc(c.upstream.similarity)})` : "")
      + (c.upstream.intentMarker ? ` · intent marker: yes` : "")
      + ` · baseline ${esc(c.upstream.baselineFile || "—")}</p>`
    : "";
  return `<article class="candidate">
    <h3>${esc(c.id)} — ${esc(c.title)}</h3>
    <p><strong>Location:</strong> ${esc(c.location.file)} : ${esc(c.location.function)}</p>
    <p><strong>Hypothesis:</strong> ${esc(c.hypothesis)}</p>
    <p><strong>Preconditions:</strong> ${esc(c.preconditions)}</p>
    <p><strong>Impact + severity guess:</strong> ${esc(c.severityGuess)} — ${esc(c.impact)}</p>
    <p><strong>Code evidence:</strong> <code>${esc(c.evidence)}</code></p>${upstream}
    <p><strong>What the referee must verify:</strong></p>
    <ul>${c.toVerify.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>
    <p class="src">Source: ${esc(c.source)}</p>
  </article>`;
}

function renderReport(result) {
  if (!result.candidates.length) {
    return `<p>No candidates from this pass. That does not mean the contract is safe —
      only that the patterns this pass scans for did not match.</p>`
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
      + `commented-out / enum / oracle candidates classified as `
      + `live-identical / live-modified / live-divergent / absent.</p>`
    : `<p><strong>Baseline upstream:</strong> not used in this pass — `
      + `upload the upstream .sol files to enable classification of `
      + `by-design vs fork deviation.</p>`;
  return `<section class="closing">
    <h3>Pass closing</h3>
    ${baselineLine}
    <p><strong>Mapped areas:</strong> ${result.mappedAreas.map(esc).join("; ") || "—"}</p>
    <p><strong>Unmapped areas:</strong> ${result.unmappedAreas.map(esc).join("; ") || "—"}</p>
    <p><strong>Top 3 hypotheses:</strong></p>
    <ol>${top || "<li>—</li>"}</ol>
    <p class="disclaimer">The candidates above are NOT a verdict. Final verification
      (live data + a local PoC) is done by a human referee.</p>
  </section>`;
}

// Node export (for the test runner); in the browser the functions stay global.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderReport, renderCandidate, esc };
}
