// FrankenAudit — tests/run-m2-tests.js
// Uji ujung-ke-ujung M2 (tanpa dependensi): node tests/run-m2-tests.js
// Keluar 0 bila semua lolos, 1 bila ada yang gagal.
"use strict";
const fs = require("fs");
const path = require("path");
const { runPipeline, normalizeSlither } = require("../app/pipeline.js");
const { renderReport } = require("../app/report.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? " — " + extra : "")); }
}

const SAMPLES = path.join(__dirname, "..", "app", "samples");
const sol = fs.readFileSync(path.join(SAMPLES, "trap-vault.sol"), "utf8");
const truth = JSON.parse(
  fs.readFileSync(path.join(SAMPLES, "trap-vault.analysis.json"), "utf8"));

// --- 1. Trap vault: pasangan (detector, fungsi) harus sama persis dengan ground truth
const result = runPipeline(sol, "trap-vault.sol");
const got = result.candidates.map((c) => c.detector + "@" + c.location.function).sort();
const want = truth.expectedCandidates
  .map((c) => c.detector + "@" + c.function).sort();
check("trap-vault: jumlah kandidat = " + truth.expectedTotal,
  result.candidates.length === truth.expectedTotal,
  "dapat " + result.candidates.length + ": " + got.join(", "));
check("trap-vault: pasangan (detector,fungsi) = ground truth",
  JSON.stringify(got) === JSON.stringify(want),
  "dapat " + JSON.stringify(got) + " vs harap " + JSON.stringify(want));

// --- 2. Negative control: pola aman TIDAK memicu kandidat untuk polanya
for (const nc of truth.negativeControls) {
  const hit = result.candidates.some((c) =>
    c.location.function === nc.function && c.detector === nc.pattern);
  check("negative control " + nc.function + " (" + nc.pattern + ") tidak memicu",
    !hit);
}

// --- 3. Kontrak bersih (guard benar) -> 0 kandidat
const clean = `pragma solidity ^0.8.20;
contract CleanVault {
    mapping(address => uint256) public balances;
    address public owner;
    constructor() { owner = msg.sender; }
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "call failed");
    }
    function setOwner(address n) external {
        require(msg.sender == owner, "not owner");
        owner = n;
    }
}`;
const cleanRes = runPipeline(clean, "clean-vault.sol");
check("clean-vault: 0 kandidat", cleanRes.candidates.length === 0,
  "dapat " + cleanRes.candidates.length);

// --- 4. normalizeSlither: fixture JSON -> kandidat baku
const fixture = { success: true, results: { detectors: [
  { check: "reentrancy-eth", impact: "High", confidence: "Medium",
    description: "Reentrancy in Vault.withdraw\nfoo",
    elements: [{ name: "withdraw",
      source_mapping: { filename_relative: "trap-vault.sol", lines: [41] } }] },
  { check: "tx-origin", impact: "Medium", confidence: "High",
    description: "Dangerous usage of tx.origin",
    elements: [{ name: "emergencyDrain",
      source_mapping: { filename_relative: "trap-vault.sol", lines: [75] } }] },
] } };
const sl = normalizeSlither(fixture, "trap-vault.sol");
check("normalizeSlither: 2 kandidat", sl.length === 2);
check("normalizeSlither: id + severity benar",
  sl[0].id === "SL-001" && sl[0].severityGuess === "High"
  && sl[1].detector === "slither:tx-origin" && sl[1].severityGuess === "Medium",
  JSON.stringify(sl.map((c) => [c.id, c.detector, c.severityGuess])));

// --- 5. Render laporan: semua ID kandidat muncul + disclaimer
const html = renderReport(result);
check("renderReport: semua ID kandidat muncul",
  result.candidates.every((c) => html.includes(c.id)));
check("renderReport: disclaimer kandidat-bukan-verdict muncul",
  html.includes("BUKAN verdict"));
check("renderReport: 3 hipotesis terkuat muncul",
  result.topHypotheses.length === 3
  && result.topHypotheses.every((c) => html.includes(c.id)));

// --- 6. Regresi komentar (RAAC 14 Nov 2026): pola yang hanya ada di
// komentar TIDAK boleh memicu detektor.
const commentTrap = `pragma solidity ^0.8.20;
contract CommentTrap {
    function check(uint256 amount, uint256 cap) external view returns (bool) {
        // totalSupply is the normalized debt (with accrued interest)
        /* bagi dengan totalSupply dihitung di tempat lain */
        return amount <= cap;
    }
}`;
const commentRes = runPipeline(commentTrap, "comment-trap.sol");
check("comment-trap: komentar '// totalSupply' tidak memicu division-no-guard",
  commentRes.candidates.length === 0,
  "dapat " + commentRes.candidates.length + ": "
  + JSON.stringify(commentRes.candidates.map((c) => c.detector + "@" + c.location.function)));

// --- 7. Commented-out-function (Amply 14 Nov 2026): fungsi utuh yang
// dikomentari memicu; prosa yang menyebut signature TIDAK memicu.
const commentedFn = `pragma solidity ^0.8.20;
contract CommentedFn {
    address public owner;
    // function setFee(uint256 bps) external {
    //     require(msg.sender == owner, "not owner");
    //     feeBps = bps;
    // }
    /* function getPrice() external view returns (uint256); */
    function live(uint256 x) external pure returns (uint256) { return x; }
}`;
const cfRes = runPipeline(commentedFn, "commented-fn.sol");
check("commented-out-function: 2 kandidat (setFee multi-baris + getPrice interface)",
  cfRes.candidates.length === 2
  && cfRes.candidates.some((c) => c.detector === "commented-out-function" && c.location.function === "setFee")
  && cfRes.candidates.some((c) => c.detector === "commented-out-function" && c.location.function === "getPrice"),
  "dapat " + cfRes.candidates.length + ": "
  + JSON.stringify(cfRes.candidates.map((c) => c.detector + "@" + c.location.function)));
const proseFn = `pragma solidity ^0.8.20;
contract ProseFn {
    // see function setFee(uint256) for the disabled version
    // (lihat function getPrice() untuk harga lama)
    function live(uint256 x) external pure returns (uint256) { return x; }
}`;
const proseRes = runPipeline(proseFn, "prose-fn.sol");
check("commented-out-function: prosa penyebut signature tidak memicu",
  proseRes.candidates.length === 0,
  "dapat " + proseRes.candidates.length + ": "
  + JSON.stringify(proseRes.candidates.map((c) => c.detector + "@" + c.location.function)));

// --- 7b. Regresi contoh dokumentasi (Amply 14 Nov 2026): contoh kode
// `function foo()` di dalam pagar ``` NatSpec (OZ AccessControl/ERC165)
// BUKAN fungsi yang dimatikan — tidak boleh memicu.
const docExample = `pragma solidity ^0.8.20;
/// @dev Restrict access with hasRole:
/// \`\`\`
/// function foo() public {
///     require(hasRole(MY_ROLE, msg.sender));
/// }
/// \`\`\`
contract DocExample {
    function live(uint256 x) external pure returns (uint256) { return x; }
}`;
const docRes = runPipeline(docExample, "doc-example.sol");
check("commented-out-function: contoh NatSpec dalam pagar ``` tidak memicu",
  docRes.candidates.length === 0,
  "dapat " + docRes.candidates.length + ": "
  + JSON.stringify(docRes.candidates.map((c) => c.detector + "@" + c.location.function)));

// --- Ringkasan
console.log("\n" + pass + " lolos, " + fail + " gagal.");
process.exit(fail ? 1 : 0);
