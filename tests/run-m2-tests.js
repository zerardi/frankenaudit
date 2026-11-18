// FrankenAudit — tests/run-m2-tests.js
// Uji ujung-ke-ujung M2 (tanpa dependensi): node tests/run-m2-tests.js
// Keluar 0 bila semua lolos, 1 bila ada yang gagal.
"use strict";
const fs = require("fs");
const path = require("path");
const { runPipeline, normalizeSlither, buildBaselineMap, runProjectPipeline } = require("../app/pipeline.js");
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

// --- 8. Upstream-diff (Amply 14 Nov 2026): kandidat commented-out-*
// dianotasi konteks baseline; tanpa baseline tidak ada anotasi.
const upstreamSrc = `pragma solidity ^0.8.20;
contract Upstream {
    address public owner;
    uint256 public feeBps;
    uint256 public lastFeeUpdate;
    function setFee(uint256 bps) external {
        require(msg.sender == owner, "not owner");
        feeBps = bps;
    }
    function setFeeMod(uint256 bps) external {
        require(msg.sender == owner, "not owner");
        feeBps = bps;
        emit FeeChanged(bps);
        lastFeeUpdate = block.timestamp;
    }
    function validateBorrow(address asset) external view {
        require(asset != address(0), "zero");
    }
}`;
const upstreamTarget = `pragma solidity ^0.8.20;
contract Target {
    address public owner;
    uint256 public feeBps;
    // TODO disable for MVP: fee is fixed at launch
    // function setFee(uint256 bps) external {
    //     require(msg.sender == owner, "not owner");
    //     feeBps = bps;
    // }
    // function setFeeMod(uint256 bps) external {
    //     require(msg.sender == owner, "not owner");
    //     feeBps = bps;
    // }
    // function setOwner(address n) external {
    //     owner = n;
    // }
    function validateBorrow(address asset) external view {
        // require(asset != address(0), "zero");
    }
    function live(uint256 x) external pure returns (uint256) { return x; }
}`;
const upRes = runPipeline(upstreamTarget, "Target.sol",
  { baseline: { "Target.sol": upstreamSrc } });
const upByFn = {};
for (const c of upRes.candidates) upByFn[c.detector + "@" + c.location.function] = c;
check("upstream-diff: setFee live-identical + penanda niat",
  upByFn["commented-out-function@setFee"]
  && upByFn["commented-out-function@setFee"].upstream.classification === "live-identical"
  && upByFn["commented-out-function@setFee"].upstream.similarity === 1
  && upByFn["commented-out-function@setFee"].upstream.intentMarker === true,
  JSON.stringify(upByFn["commented-out-function@setFee"] && upByFn["commented-out-function@setFee"].upstream));
check("upstream-diff: setFeeMod live-modified (isi berubah vs upstream)",
  upByFn["commented-out-function@setFeeMod"]
  && upByFn["commented-out-function@setFeeMod"].upstream.classification === "live-modified",
  JSON.stringify(upByFn["commented-out-function@setFeeMod"] && upByFn["commented-out-function@setFeeMod"].upstream));
check("upstream-diff: setOwner absent (tidak ada di upstream)",
  upByFn["commented-out-function@setOwner"]
  && upByFn["commented-out-function@setOwner"].upstream.classification === "absent",
  JSON.stringify(upByFn["commented-out-function@setOwner"] && upByFn["commented-out-function@setOwner"].upstream));
check("upstream-diff: validateBorrow check live-identical",
  upByFn["commented-out-check@validateBorrow"]
  && upByFn["commented-out-check@validateBorrow"].upstream.classification === "live-identical",
  JSON.stringify(upByFn["commented-out-check@validateBorrow"] && upByFn["commented-out-check@validateBorrow"].upstream));
const noBaseRes = runPipeline(upstreamTarget, "Target.sol");
check("upstream-diff: tanpa baseline kandidat tidak dianotasi",
  noBaseRes.candidates.every((c) => c.upstream === undefined),
  JSON.stringify(noBaseRes.candidates.map((c) => c.upstream)));
// Deklarasi interface yang dikomentari: baseline hanya punya deklarasi
// (tanpa badan) — tetap terklasifikasi live-identical via fallback.
const ifaceBase = `pragma solidity ^0.8.20;
interface ITarget {
    function setFee(uint256 bps) external;
}`;
const ifaceTarget = `pragma solidity ^0.8.20;
interface ITarget {
    // function setFee(uint256 bps) external;
    function live(uint256 x) external pure returns (uint256);
}`;
const ifaceRes = runPipeline(ifaceTarget, "ITarget.sol",
  { baseline: { "ITarget.sol": ifaceBase } });
check("upstream-diff: deklarasi interface live-identical via fallback",
  ifaceRes.candidates.length === 1
  && ifaceRes.candidates[0].upstream.classification === "live-identical"
  && ifaceRes.candidates[0].upstream.similarity === 1,
  JSON.stringify(ifaceRes.candidates.map((c) => c.upstream)));

// --- 9. Enum-semantic-shift (Amply AMP-03, 14 Nov 2026): enum yang
// dipangkas vs baseline sehingga nilai member yang bertahan bergeser.
const enumBase = `pragma solidity ^0.8.20;
library Types {
    enum InterestRateMode {NONE, STABLE, VARIABLE}
}`;
const enumFork = `pragma solidity ^0.8.20;
library Types {
    enum InterestRateMode {NONE, VARIABLE}
}`;
const enumRes = runPipeline(enumFork, "DataTypes.sol",
  { baseline: { "DataTypes.sol": enumBase } });
check("enum-semantic-shift: 1 kandidat (VARIABLE 2 → 1, Low)",
  enumRes.candidates.length === 1
  && enumRes.candidates[0].detector === "enum-semantic-shift"
  && enumRes.candidates[0].severityGuess === "Low",
  "dapat " + enumRes.candidates.length + ": "
  + JSON.stringify(enumRes.candidates.map((c) => c.detector)));
check("enum-semantic-shift: bukti menyebut VARIABLE: 2 → 1",
  enumRes.candidates.length === 1
  && enumRes.candidates[0].evidence.includes("VARIABLE: 2 → 1"),
  enumRes.candidates.length ? enumRes.candidates[0].evidence : "tidak ada kandidat");
const enumSame = runPipeline(enumBase, "DataTypes.sol",
  { baseline: { "DataTypes.sol": enumBase } });
check("enum-semantic-shift: enum identik baseline → 0 kandidat",
  enumSame.candidates.length === 0, "dapat " + enumSame.candidates.length);
const enumAppend = runPipeline(
  enumBase.replace("VARIABLE}", "VARIABLE, FIXED}"),
  "DataTypes.sol", { baseline: { "DataTypes.sol": enumBase } });
check("enum-semantic-shift: tambah member di akhir → 0 kandidat",
  enumAppend.candidates.length === 0, "dapat " + enumAppend.candidates.length);
const enumReorder = runPipeline(
  `pragma solidity ^0.8.20;
library Types {
    enum InterestRateMode {NONE, VARIABLE, STABLE}
}`,
  "DataTypes.sol", { baseline: { "DataTypes.sol": enumBase } });
check("enum-semantic-shift: urutan dibalik → 1 kandidat",
  enumReorder.candidates.length === 1
  && enumReorder.candidates[0].detector === "enum-semantic-shift",
  "dapat " + enumReorder.candidates.length);
const enumNoBase = runPipeline(enumFork, "DataTypes.sol");
check("enum-semantic-shift: tanpa baseline → 0 kandidat",
  enumNoBase.candidates.length === 0, "dapat " + enumNoBase.candidates.length);

// --- 10. Oracle-passthrough (AMP-06, 14 Nov 2026): baca harga tanpa
// cek staleness memicu (Low); cek updatedAt menekan; cek price > 0 SAJA
// TIDAK menekan (bukan cek staleness); klasifikasi baseline membedakan
// by-design (upstream juga passthrough) vs kandidat (upstream ber-cek).
const oraclePassthrough = `pragma solidity ^0.8.20;
contract OraclePass {
    address public oracle;
    function getPrice() external view returns (uint256) {
        int256 price = IPriceFeed(oracle).latestAnswer();
        require(price > 0, "bad price");
        return uint256(price);
    }
    function usePrice(address asset) external view returns (uint256) {
        return IPriceOracleGetter(oracle).getAssetPrice(asset);
    }
}`;
const orRes = runPipeline(oraclePassthrough, "oracle-pass.sol");
check("oracle-passthrough: 2 kandidat (latestAnswer + getAssetPrice, Low)",
  orRes.candidates.length === 2
  && orRes.candidates.every((c) => c.detector === "oracle-passthrough-no-staleness")
  && orRes.candidates.every((c) => c.severityGuess === "Low"),
  "dapat " + orRes.candidates.length + ": "
  + JSON.stringify(orRes.candidates.map((c) => c.detector + "@" + c.location.function)));
const oracleGuarded = `pragma solidity ^0.8.20;
contract OracleGuarded {
    address public oracle;
    function getPrice() external view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale price");
        require(price > 0, "bad price");
        return uint256(price);
    }
    function getPriceRound() external view returns (uint256) {
        (uint80 roundId, int256 price, , , uint80 answeredInRound) = IPriceFeed(oracle).latestRoundData();
        require(answeredInRound == roundId, "stale round");
        return uint256(price);
    }
}`;
const ogRes = runPipeline(oracleGuarded, "oracle-guarded.sol");
check("oracle-passthrough: cek updatedAt → 0; answeredInRound saja → 1 kandidat (kalibrasi review Kiro 15 Nov: answeredInRound deprecated, hanya menjamin round selesai, bukan umur data)",
  ogRes.candidates.length === 1
  && ogRes.candidates[0].location.function === "getPriceRound", "dapat " + ogRes.candidates.length + ": "
  + JSON.stringify(ogRes.candidates.map((c) => c.detector + "@" + c.location.function)));
// Klasifikasi baseline: upstream yang sama-sama passthrough →
// live-identical (by-design, kasus AMP-06/AaveOracle); upstream yang
// ber-cek staleness → live-divergent (fork menghapus cek); fungsi yang
// di upstream tidak membaca harga → live-modified; fungsi baru → absent.
const oracleUpstreamSame = `pragma solidity ^0.8.20;
contract UpstreamOracle {
    address public oracle;
    function usePrice(address asset) external view returns (uint256) {
        return IPriceOracleGetter(oracle).getAssetPrice(asset);
    }
}`;
const orUpSame = runPipeline(
  oraclePassthrough.replace("OraclePass", "TargetOracle"),
  "TargetOracle.sol", { baseline: { "TargetOracle.sol": oracleUpstreamSame } });
const usePriceSame = orUpSame.candidates.find((c) => c.location.function === "usePrice");
check("oracle-passthrough: upstream sama-sama passthrough → live-identical",
  usePriceSame && usePriceSame.upstream.classification === "live-identical",
  JSON.stringify(usePriceSame && usePriceSame.upstream));
const oracleUpstreamGuarded = `pragma solidity ^0.8.20;
contract UpstreamOracle {
    address public oracle;
    function usePrice(address asset) external view returns (uint256) {
        (, int256 p, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale");
        return uint256(p);
    }
    function otherFn() external view returns (uint256) { return 1; }
}`;
const orUpGuarded = runPipeline(
  oraclePassthrough.replace("OraclePass", "TargetOracle"),
  "TargetOracle.sol", { baseline: { "TargetOracle.sol": oracleUpstreamGuarded } });
const usePriceDiv = orUpGuarded.candidates.find((c) => c.location.function === "usePrice");
check("oracle-passthrough: upstream ber-cek, fork tidak → live-divergent",
  usePriceDiv && usePriceDiv.upstream.classification === "live-divergent",
  JSON.stringify(usePriceDiv && usePriceDiv.upstream));
const getPriceMod = orUpGuarded.candidates.find((c) => c.location.function === "getPrice");
check("oracle-passthrough: fungsi baru di fork (absent di upstream) → absent",
  getPriceMod && getPriceMod.upstream.classification === "absent",
  JSON.stringify(getPriceMod && getPriceMod.upstream));
const oracleUpstreamNoRead = `pragma solidity ^0.8.20;
contract UpstreamOracle {
    address public oracle;
    function usePrice(address asset) external view returns (uint256) {
        return asset == address(0) ? 0 : 1;
    }
}`;
const orUpNoRead = runPipeline(
  oraclePassthrough.replace("OraclePass", "TargetOracle"),
  "TargetOracle.sol", { baseline: { "TargetOracle.sol": oracleUpstreamNoRead } });
const usePriceMod = orUpNoRead.candidates.find((c) => c.location.function === "usePrice");
check("oracle-passthrough: upstream ada tapi tak baca harga → live-modified",
  usePriceMod && usePriceMod.upstream.classification === "live-modified",
  JSON.stringify(usePriceMod && usePriceMod.upstream));
const orNoBase = runPipeline(oraclePassthrough, "oracle-pass.sol");
check("oracle-passthrough: tanpa baseline kandidat tidak dianotasi",
  orNoBase.candidates.every((c) => c.upstream === undefined),
  JSON.stringify(orNoBase.candidates.map((c) => c.upstream)));
// Regresi bentuk bail (RAAC 14 Nov 2026): `age >= ambang → fallback`
// dan `age > maxStaleTime` (identifier camelCase) JUGA dihitung guard.
const oracleBail = `pragma solidity ^0.8.20;
contract OracleBail {
    uint256 public maxStaleTime = 3600;
    address public oracle;
    function getPriceCurve() external view returns (uint256) {
        (, int256 answer, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        if (answer <= 0) return 1e18;
        if (block.timestamp - updatedAt >= maxStaleTime) return 1e18;
        return uint256(answer);
    }
    function getPriceAge() external view returns (uint256) {
        (, int256 answer, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > maxStaleTime) return 1e18;
        return uint256(answer);
    }
}`;
const obRes = runPipeline(oracleBail, "oracle-bail.sol");
check("oracle-passthrough: bentuk bail (>= ambang / age > maxStaleTime) → 0 kandidat",
  obRes.candidates.length === 0, "dapat " + obRes.candidates.length + ": "
  + JSON.stringify(obRes.candidates.map((c) => c.detector + "@" + c.location.function)));

// --- 11. Free-mem-pointer (HYP-01 RedStone, 14 Nov 2026): update
// free-memory pointer dgn add() ukuran data-dependent tanpa pembulatan
// 32 byte memicu (Info saja — terkalibrasi PoC falsified); versi yang
// dibulatkan / penambahan slot tetap TIDAK memicu.
const freeMemRaw = `pragma solidity ^0.8.20;
contract FreeMemRaw {
    uint256 internal constant FREE_MEMORY_PTR = 0x40;
    uint256 internal constant BYTES_ARR_LEN_VAR_BS = 32;
    function prepareMessage(bytes memory encodedFunction, uint256 payloadSize) internal pure returns (bytes memory message) {
        assembly {
            message := mload(FREE_MEMORY_PTR)
            mstore(message, add(encodedFunction.length, payloadSize))
            mstore(
                FREE_MEMORY_PTR,
                add(
                    add(message, add(payloadSize, encodedFunction.length)),
                    BYTES_ARR_LEN_VAR_BS
                )
            )
        }
    }
}`;
const fmRes = runPipeline(freeMemRaw, "free-mem-raw.sol");
check("free-mem-pointer: pola RedStone (add ukuran data, tanpa rounding) → 1 kandidat Info",
  fmRes.candidates.length === 1
  && fmRes.candidates[0].detector === "free-mem-pointer-no-rounding"
  && fmRes.candidates[0].severityGuess === "Info",
  "dapat " + fmRes.candidates.length + ": "
  + JSON.stringify(fmRes.candidates.map((c) => c.detector + "@" + c.location.function + ":" + c.severityGuess)));
const freeMemRounded = `pragma solidity ^0.8.20;
contract FreeMemRounded {
    function alloc(bytes memory data, uint256 size) internal pure returns (bytes memory out) {
        assembly {
            out := mload(0x40)
            mstore(out, size)
            mstore(0x40, and(add(add(out, size), 31), not(31)))
        }
    }
    function allocSlot(uint256 ptr) internal pure returns (uint256) {
        assembly {
            mstore(0x40, add(ptr, 32))
        }
        return ptr;
    }
}`;
const fmrRes = runPipeline(freeMemRounded, "free-mem-rounded.sol");
check("free-mem-pointer: dibulatkan (not(31)) / tambah slot tetap → 0 kandidat",
  fmrRes.candidates.length === 0, "dapat " + fmrRes.candidates.length + ": "
  + JSON.stringify(fmrRes.candidates.map((c) => c.detector + "@" + c.location.function)));

// --- 12. Wiring baseline ke UI (sesi 00:38 WIB 2026-11-15):
// buildBaselineMap (first-wins + tabrakan dicatat), enum-semantic-shift
// + klasifikasi oracle-passthrough lewat jalur yang sama dipakai app.js,
// dan render laporan menampilkan anotasi upstream-diff + status baseline.
const bb = buildBaselineMap([
  { name: "core/DataTypes.sol", text: "A" },
  { name: "periphery/DataTypes.sol", text: "B" },
  { name: "DataTypes.sol", text: "C" },
  { name: "Pool.sol", text: "D" },
]);
check("buildBaselineMap: first-wins per basename (isi pertama menang)",
  bb.map["DataTypes.sol"] === "A" && bb.map["Pool.sol"] === "D",
  JSON.stringify(bb.map));
check("buildBaselineMap: tabrakan basename dicatat sekali",
  JSON.stringify(bb.collisions) === JSON.stringify(["DataTypes.sol"]),
  JSON.stringify(bb.collisions));
check("buildBaselineMap: basename 'constructor' tidak menabrak prototype",
  buildBaselineMap([{ name: "constructor.sol", text: "X" }]).map["constructor.sol"] === "X");

const enumTargetUI = `pragma solidity ^0.8.20;
library DataTypes {
    enum InterestRateMode { NONE, VARIABLE }
}`;
const enumBaseUI = `pragma solidity ^0.8.20;
library DataTypes {
    enum InterestRateMode { NONE, STABLE, VARIABLE }
}`;
const enumResUI = runPipeline(enumTargetUI, "DataTypes.sol",
  { baseline: buildBaselineMap([{ name: "DataTypes.sol", text: enumBaseUI }]).map });
check("baseline UI: enum VARIABLE 2→1 vs baseline → 1 kandidat enum-semantic-shift",
  enumResUI.candidates.length === 1
  && enumResUI.candidates[0].detector === "enum-semantic-shift"
  && enumResUI.baseline && enumResUI.baseline.files === 1,
  "dapat " + JSON.stringify(enumResUI.candidates.map((c) => c.detector + "@" + c.location.function)));
const enumSameUI = runPipeline(enumBaseUI, "DataTypes.sol",
  { baseline: buildBaselineMap([{ name: "DataTypes.sol", text: enumBaseUI }]).map });
check("baseline UI: enum identik baseline → 0 kandidat enum",
  !enumSameUI.candidates.some((c) => c.detector === "enum-semantic-shift"),
  "dapat " + enumSameUI.candidates.length);
check("baseline UI: tanpa baseline → result.baseline null",
  runPipeline(enumTargetUI, "DataTypes.sol").baseline === null);

const oracleTarget = `pragma solidity ^0.8.20;
contract PriceConsumer {
    address public oracle;
    function getVaultPrice() external view returns (uint256) {
        (, int256 price, , , ) = IPriceFeed(oracle).latestRoundData();
        require(price > 0, "bad price");
        return uint256(price);
    }
}`;
const oracleBaseSame = oracleTarget;
const oracleRes = runPipeline(oracleTarget, "PriceConsumer.sol",
  { baseline: buildBaselineMap([{ name: "PriceConsumer.sol", text: oracleBaseSame }]).map });
const oracleCand = oracleRes.candidates.find((c) => c.detector === "oracle-passthrough-no-staleness");
check("baseline UI: oracle passthrough identik upstream → live-identical",
  oracleCand && oracleCand.upstream
  && oracleCand.upstream.classification === "live-identical",
  "dapat " + JSON.stringify(oracleCand && oracleCand.upstream));
const oracleBaseGuarded = `pragma solidity ^0.8.20;
contract PriceConsumer {
    address public oracle;
    function getVaultPrice() external view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale");
        return uint256(price);
    }
}`;
const oracleResDiv = runPipeline(oracleTarget, "PriceConsumer.sol",
  { baseline: buildBaselineMap([{ name: "PriceConsumer.sol", text: oracleBaseGuarded }]).map });
const oracleCandDiv = oracleResDiv.candidates.find((c) => c.detector === "oracle-passthrough-no-staleness");
check("baseline UI: upstream ber-cek staleness, fork tidak → live-divergent",
  oracleCandDiv && oracleCandDiv.upstream
  && oracleCandDiv.upstream.classification === "live-divergent",
  "dapat " + JSON.stringify(oracleCandDiv && oracleCandDiv.upstream));
check("renderReport: kartu kandidat menampilkan baris Upstream-diff + penutup menampilkan baseline",
  renderReport(oracleRes).includes("Upstream-diff:")
  && renderReport(oracleRes).includes("live-identical")
  && renderReport(oracleRes).includes("Baseline upstream:")
  && renderReport(oracleRes).includes("1 file"),
  "render tidak memuat anotasi upstream");

// --- 13. Missing-access-control v2 (Hyperbridge 15 Nov 2026): helper
// internal, modifier restrict/onlyHost, dan deklarasi variabel lokal
// TIDAK boleh memicu; fungsi external tanpa guard TETAP memicu.
const macCalib = `pragma solidity ^0.8.20;
contract MacCalib {
    address public owner;
    uint256 public feeBps;
    modifier restrict(address caller) {
        require(msg.sender == caller, "not allowed");
        _;
    }
    function setOwnerInternal(address n) internal {
        owner = n;
    }
    function setFeeInternal(uint256 bps) private {
        feeBps = bps;
    }
    function setOwnerRestricted(address n) external restrict(owner) {
        owner = n;
    }
    function setOwnerHost(address n) external onlyHost {
        owner = n;
    }
    function setFeeLocal(uint256 bps) external {
        uint256 feeBps = bps;
        require(feeBps < 10000, "too high");
    }
    function setOwnerOpen(address n) external {
        owner = n;
    }
}`;
const macRes = runPipeline(macCalib, "mac-calib.sol");
const macCands = macRes.candidates.filter((c) => c.detector === "missing-access-control");
check("mac-v2: hanya 1 kandidat (setOwnerOpen external tanpa guard)",
  macCands.length === 1 && macCands[0].location.function === "setOwnerOpen",
  "dapat " + JSON.stringify(macCands.map((c) => c.location.function)));
check("mac-v2: helper internal/private tidak memicu",
  !macCands.some((c) => ["setOwnerInternal", "setFeeInternal"].includes(c.location.function)));
check("mac-v2: modifier restrict/onlyHost menekan kandidat",
  !macCands.some((c) => ["setOwnerRestricted", "setOwnerHost"].includes(c.location.function)));
check("mac-v2: deklarasi lokal 'uint256 feeBps =' bukan tulis state",
  !macCands.some((c) => c.location.function === "setFeeLocal"));

// --- 14. Kalibrasi review Kiro atas detektor 13/14 (15 Nov 2026):
// guard staleness bentuk baru + pembacaan harga baru + batas kata
// size/count + pembulatan + mstore(64) + variabel let.
function oracleSnippet(body) {
  return `pragma solidity ^0.8.20;
contract OracleCalib {
    address public oracle;
    ${body}
}`;
}
function oracleHits(body, detector) {
  const r = runPipeline(oracleSnippet(body), "oracle-calib.sol");
  return r.candidates.filter((c) => c.detector === detector);
}
const OP = "oracle-passthrough-no-staleness";
// Guard yang HARUS menekan kandidat (0 hit):
check("kiro-13: guard berkurung '(block.timestamp - updatedAt) <= MAX' menekan",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); require((block.timestamp - updatedAt) <= 3600, "old"); return uint256(price); }`, OP).length === 0);
check("kiro-13: guard lewat variabel 'age = block.timestamp - updatedAt' menekan",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); uint256 age = block.timestamp - updatedAt; require(age <= 3600, "old"); return uint256(price); }`, OP).length === 0);
check("kiro-13: 'updatedAt > block.timestamp - MAX_AGE' menekan",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); require(updatedAt > block.timestamp - 3600, "old"); return uint256(price); }`, OP).length === 0);
check("kiro-13: revert 'updatedAt < block.timestamp - MAX_AGE' menekan",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); if (updatedAt < block.timestamp - 3600) revert PriceTooOld(); return uint256(price); }`, OP).length === 0);
check("kiro-13: revert 'block.timestamp > updatedAt + MAX_AGE' menekan",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); if (block.timestamp > updatedAt + 3600) revert PriceTooOld(); return uint256(price); }`, OP).length === 0);
check("kiro-13: nama variabel 'lastUpdate' dikenali sebagai umur data",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 lastUpdate,) = IPriceFeed(oracle).latestRoundData(); require(block.timestamp - lastUpdate < 3600, "old"); return uint256(price); }`, OP).length === 0);
// Guard palsu yang TIDAK boleh menekan (1 hit):
check("kiro-13: 'updatedAt > block.timestamp' saja BUKAN guard (tetap flag)",
  oracleHits(`function p() external view returns (uint256) { (,int256 price,,uint256 updatedAt,) = IPriceFeed(oracle).latestRoundData(); if (updatedAt > block.timestamp) revert FutureTs(); return uint256(price); }`, OP).length === 1);
check("kiro-13: 'answeredInRound == roundId' saja BUKAN guard (tetap flag)",
  oracleHits(`function p() external view returns (uint256) { (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = IPriceFeed(oracle).latestRoundData(); require(answeredInRound == roundId, "incomplete"); return uint256(price); }`, OP).length === 1);
check("kiro-13: string 'stale price' saja BUKAN guard (tetap flag)",
  oracleHits(`function p() external view returns (uint256) { int256 price = IPriceFeed(oracle).latestAnswer(); require(price > 0, "stale price"); return uint256(price); }`, OP).length === 1);
// Pembacaan harga baru + yang dihapus:
check("kiro-13: getPriceUnsafe (Pyth) ter-flag",
  oracleHits(`function p() external view returns (uint256) { return IOracle(oracle).getPriceUnsafe(); }`, OP).length === 1);
check("kiro-13: getUnderlyingPrice (Compound) ter-flag",
  oracleHits(`function p() external view returns (uint256) { return IOracle(oracle).getUnderlyingPrice(address(0)); }`, OP).length === 1);
check("kiro-13: getRoundData ter-flag",
  oracleHits(`function p() external view returns (uint256) { (uint80 a, int256 price,,,) = IPriceFeed(oracle).getRoundData(1); return uint256(price); }`, OP).length === 1);
check("kiro-13: latestRound (round id, bukan harga) TIDAK ter-flag",
  oracleHits(`function p() external view returns (uint256) { return IPriceFeed(oracle).latestRound(); }`, OP).length === 0);
check("kiro-13: komentar '// TODO stale' TIDAK menekan (komentar di-strip)",
  oracleHits(`function p() external view returns (uint256) { int256 price = IPriceFeed(oracle).latestAnswer(); // TODO: add stale check later\n return uint256(price); }`, OP).length === 1);

function memSnippet(asm) {
  return `pragma solidity ^0.8.20;
contract MemCalib {
    function p(bytes memory data) internal pure returns (bytes memory out) {
        assembly { ${asm} }
    }
}`;
}
function memHits(asm) {
  const r = runPipeline(memSnippet(asm), "mem-calib.sol");
  return r.candidates.filter((c) => c.detector === "free-mem-pointer-no-rounding");
}
check("kiro-14: 'account' (mengandung count) TIDAK ter-flag",
  memHits(`let accountPtr := mload(0x40) mstore(0x40, add(accountPtr, 0x20))`).length === 0);
check("kiro-14: konstanta 'WORD_SIZE' TIDAK ter-flag",
  memHits(`let ptr := mload(0x40) mstore(0x40, add(ptr, WORD_SIZE))`).length === 0);
check("kiro-14: pembulatan inline 'mul(div(add(len,31),32),32)' TIDAK ter-flag",
  memHits(`mstore(0x40, add(mload(0x40), mul(div(add(mload(data), 31), 32), 32)))`).length === 0);
check("kiro-14: pembulatan hex 'and(add(len,0x1F),not(0x1F))' TIDAK ter-flag",
  memHits(`mstore(0x40, add(mload(0x40), and(add(mload(data), 0x1F), not(0x1F))))`).length === 0);
check("kiro-14: mask 'sub(0,32)' TIDAK ter-flag",
  memHits(`mstore(0x40, add(mload(0x40), and(add(mload(data), 31), sub(0, 32))))`).length === 0);
check("kiro-14: 'mstore(64, ...)' (literal desimal) ter-flag",
  memHits(`let p := mload(0x40) mstore(64, add(p, mload(data)))`).length === 1);
check("kiro-14: nilai lewat variabel 'let end := add(ptr, len)' ter-flag",
  memHits(`let end := add(mload(0x40), mload(data)) mstore(0x40, end)`).length === 1);
check("kiro-14: ukuran dari 'mload(data)' (idiom Yul bytes-length) ter-flag",
  memHits(`mstore(0x40, add(add(mload(0x40), 0x20), mload(data)))`).length === 1);
check("kiro-14: variabel 'roundedSize' yang sudah dibulatkan TIDAK ter-flag",
  memHits(`let roundedSize := and(add(mload(data), 31), not(31)) mstore(0x40, add(mload(0x40), roundedSize))`).length === 0);
check("kiro-14: RedStone '_prepareMessage' tetap ter-flag (Info)",
  memHits(`message := mload(0x40) mstore(0x40, add(add(message, add(redstonePayloadByteSize, encodedFunctionBytesCount)), 32))`).length === 1);

// --- 15. Detektor eth-locked-receive (15 Nov 2026, kelas AMP-05):
// receive()/fallback() payable tanpa jalur keluar ETH di file yang sama.
function ethSnippet(body) {
  return `pragma solidity ^0.8.20;
contract EthCalib {
    ${body}
}`;
}
function ethHits(body) {
  const r = runPipeline(ethSnippet(body), "eth-calib.sol");
  return r.candidates.filter((c) => c.detector === "eth-locked-receive");
}
const ELR = "eth-locked-receive";
check("eth-locked: receive() payable tanpa rescue → 1 kandidat Info",
  ethHits(`receive() external payable {}`).length === 1
  && ethHits(`receive() external payable {}`)[0].severityGuess === "Info"
  && ethHits(`receive() external payable {}`)[0].location.function === "receive");
check("eth-locked: receive() + rescue call{value:} → 0",
  ethHits(`receive() external payable {}
    function rescue(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "fail");
    }`).length === 0);
check("eth-locked: receive() + payable(owner).transfer → 0",
  ethHits(`receive() external payable {}
    address payable public owner;
    function rescue() external {
        owner.transfer(address(this).balance);
    }`).length === 0);
check("eth-locked: receive() + payable(owner).transfer (bentuk cast) → 0",
  ethHits(`receive() external payable {}
    address public owner;
    function rescue() external {
        payable(owner).transfer(address(this).balance);
    }`).length === 0);
check("eth-locked: receive() + rescue HANYA ERC20 (transfer token) → 1 (cermin AMP-05)",
  ethHits(`receive() external payable {}
    function rescueTokens(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }`).length === 1);
check("eth-locked: fallback() payable tanpa rescue → 1",
  ethHits(`fallback() external payable {}`).length === 1
  && ethHits(`fallback() external payable {}`)[0].location.function === "fallback");
check("eth-locked: fallback() + selfdestruct → 0",
  ethHits(`fallback() external payable {}
    function kill(address payable to) external { selfdestruct(to); }`).length === 0);
check("eth-locked: receive() TIDAK payable → 0",
  ethHits(`receive() external {}`).length === 0);
check("eth-locked: call{value:} di fungsi lain file yang sama menekan (file-scoped)",
  ethHits(`receive() external payable {}
    function pay(address to) external {
        (bool ok, ) = to.call{value: 1 ether}("");
        require(ok, "fail");
    }`).length === 0);
check("eth-locked: gaya WETH (receive + withdraw call{value:}) → 0",
  ethHits(`receive() external payable {}
    function withdraw(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
    }`).length === 0);
check("eth-locked: helper _sendValue di file yang sama menekan (kalibrasi Hyperbridge)",
  ethHits(`receive() external payable {}
    function pay(address to, uint256 amount) external {
        _sendValue(to, amount);
    }`).length === 0);
check("eth-locked: EntryPoint.withdrawTo di file yang sama menekan (kalibrasi paymaster)",
  ethHits(`receive() external payable {}
    function sweep(address payable treasury, uint256 amount) external {
        entryPoint().withdrawTo(treasury, amount);
    }`).length === 0);

// --- 15b. Kalibrasi v3 detektor eth-locked-receive (review silang Kiro
// Opus 5.5, 15 Nov 2026 12:47 WIB — 26 kasus uji Kiro: 14 FP + 7 FN).
function ethHitsFile(body, name) {
  const r = runPipeline(ethSnippet(body), name);
  return r.candidates.filter((c) => c.detector === "eth-locked-receive");
}
check("eth-locked v3: payable(owner()).transfer (cast bersarang) → 0",
  ethHits(`receive() external payable {}
    function rescue() external { payable(owner()).transfer(address(this).balance); }`).length === 0);
check("eth-locked v3: treasury immutable payable transfer → 0",
  ethHits(`receive() external payable {}
    address payable public immutable treasury;
    function rescue() external { treasury.transfer(address(this).balance); }`).length === 0);
check("eth-locked v3: array address payable rs[i].transfer → 0",
  ethHits(`receive() external payable {}
    address payable[] public rs;
    function rescue(uint256 i) external { rs[i].transfer(address(this).balance); }`).length === 0);
check("eth-locked v3: SafeTransferLib.safeTransferETH → 0",
  ethHits(`receive() external payable {}
    function rescue(address to, uint256 amount) external {
        SafeTransferLib.safeTransferETH(to, amount);
    }`).length === 0);
check("eth-locked v3: IWETH deposit{value:} → 0",
  ethHits(`receive() external payable {}
    function fwd(address w, uint256 amount) external {
        IWETH(w).deposit{value: amount}();
    }`).length === 0);
check("eth-locked v3: Address.functionCallWithValue → 0",
  ethHits(`receive() external payable {}
    function fwd(address t, bytes memory d, uint256 v) external {
        Address.functionCallWithValue(t, d, v);
    }`).length === 0);
check("eth-locked v3: sintaks lama .value() → 0",
  ethHits(`receive() external payable {}
    function rescue(address to, uint256 amount) external {
        to.call.value(amount)("");
    }`).length === 0);
check("eth-locked v3: msg.sender.transfer → 0",
  ethHits(`receive() external payable {}
    function rescue() external { msg.sender.transfer(address(this).balance); }`).length === 0);
check("eth-locked v3: assembly call(gas(),...) → 0",
  ethHits(`receive() external payable {}
    function rescue(address to, uint256 amount) external {
        assembly { if iszero(call(gas(), to, amount, 0, 0, 0, 0)) { revert(0, 0) } }
    }`).length === 0);
check("eth-locked v3: proxy OZ (delegatecall + receive + fallback) → 0",
  ethHits(`receive() external payable { _delegate(_implementation()); }
    fallback() external payable { _delegate(_implementation()); }
    function _delegate(address impl) internal {
        assembly { calldatacopy(0, 0, calldatasize()) let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0) returndatacopy(0, 0, returndatasize()) switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) } }
    }`).length === 0);
check("eth-locked v3: deklarasi abstract receive virtual; → 0",
  ethHits(`receive() external payable virtual;`).length === 0);
check("eth-locked v3: receive() payable external (urutan modifier) → 1",
  ethHits(`receive() payable external {}`).length === 1);
check("eth-locked v3: receive() virtual external payable → 1",
  ethHits(`receive() virtual external payable {}`).length === 1);
check("eth-locked v3: receive() onlyX external payable → 1",
  ethHits(`receive() onlyX external payable {}`).length === 1);
check("eth-locked v3: fallback lama function() external payable → 1",
  ethHits(`function() external payable {}`).length === 1
  && ethHits(`function() external payable {}`)[0].location.function === "fallback");
check("eth-locked v3: deklarasi function withdrawTo ERC20-only TIDAK menekan → 1",
  ethHits(`receive() external payable {}
    function withdrawTo(address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }`).length === 1);
check("eth-locked v3: deklarasi function sendValue TIDAK menekan → 1",
  ethHits(`receive() external payable {}
    function sendValue(address to, uint256 amount) internal {
        IERC20(token).transfer(to, amount);
    }`).length === 1);
check("eth-locked v3: file mock (path mocks/) dilewati → 0",
  ethHitsFile(`receive() external payable {}`, "mocks/MockVault.sol").length === 0);
check("eth-locked v3: file test (*.t.sol) dilewati → 0",
  ethHitsFile(`receive() external payable {}`, "test/Vault.t.sol").length === 0);
check("eth-locked v3: IWETH.withdraw tanpa jalur keluar → 1 Low",
  ethHits(`receive() external payable {}
    function unwrap(uint256 amount) external {
        IWETH(weth).withdraw(amount);
    }`).length === 1
  && ethHits(`receive() external payable {}
    function unwrap(uint256 amount) external {
        IWETH(weth).withdraw(amount);
    }`)[0].severityGuess === "Low");
check("eth-locked v3: refundTo = address(this) → 1 Low",
  ethHits(`receive() external payable {}
    function setRefund() external { refundTo = address(this); }`).length === 1
  && ethHits(`receive() external payable {}
    function setRefund() external { refundTo = address(this); }`)[0].severityGuess === "Low");
check("eth-locked v3.1: .withdraw() non-WETH (gaya HostManager) TIDAK naik Low → 1 Info",
  ethHits(`receive() external payable {}
    function collect(address host, bytes memory params) external {
        IHostManager(host).withdraw(params);
    }`).length === 1
  && ethHits(`receive() external payable {}
    function collect(address host, bytes memory params) external {
        IHostManager(host).withdraw(params);
    }`)[0].severityGuess === "Info");

// --- 16. Kalibrasi v3 hasAccessGuard (hunting Fulcrom, 15 Nov 2026):
// `initializer` (OZ Initializable), `onlyGov` / `onlyAdminOrGov` (GMX),
// dan panggilan guard internal `_onlyGov()` di badan fungsi — keempatnya
// sempat ter-flag High sebagai false positive di PositionManager /
// PositionRouter (initialize + setAdmin).
function macHits(body) {
  const r = runPipeline(`pragma solidity ^0.8.20;
contract MacCalib {
    address public admin;
    ${body}
}`, "mac-calib.sol");
  return r.candidates.filter((c) => c.detector === "missing-access-control");
}
check("mac-calib v3: initialize + modifier initializer → 0",
  macHits(`function initialize(address _admin) public initializer {
        admin = _admin;
    }`).length === 0);
check("mac-calib v3: setAdmin + modifier onlyGov → 0",
  macHits(`function setAdmin(address _admin) external onlyGov {
        admin = _admin;
    }`).length === 0);
check("mac-calib v3: setAdmin + modifier onlyAdminOrGov → 0",
  macHits(`function setAdmin(address _admin) external onlyAdminOrGov {
        admin = _admin;
    }`).length === 0);
check("mac-calib v3: setAdmin + panggilan _onlyGov() di badan → 0",
  macHits(`function setAdmin(address _admin) external {
        _onlyGov();
        admin = _admin;
    }`).length === 0);
check("mac-calib v3: setAdmin + panggilan _onlyAdminOrGov() di badan → 0",
  macHits(`function setAdmin(address _admin) external {
        _onlyAdminOrGov();
        admin = _admin;
    }`).length === 0);
check("mac-calib v3: kontrol positif — setAdmin tanpa guard tetap → 1 High",
  macHits(`function setAdmin(address _admin) external {
        admin = _admin;
    }`).length === 1
  && macHits(`function setAdmin(address _admin) external {
        admin = _admin;
    }`)[0].severityGuess === "High");

// --- 17. Detektor vacuous-identity-check (15 Nov 2026, kelas FUL-REF-01):
// fungsi handler-only yang membandingkan msg.sender dengan identifier lain.
function vicHits(body) {
  const r = runPipeline(`pragma solidity ^0.8.20;
contract VicCalib {
    mapping(bytes32 => address) public codeOwners;
    mapping(address => bytes32) public traderReferralCodes;
    ${body}
}`, "vic-calib.sol");
  return r.candidates.filter((c) => c.detector === "vacuous-identity-check");
}
const VIC = "vacuous-identity-check";
check("vacuous-identity: onlyHandler + `affiliate == msg.sender` → 1 Medium (FUL-REF-01)",
  vicHits(`function setTraderReferralCode(address _trader, bytes32 _code) external onlyHandler {
        address affiliate = codeOwners[_code];
        if (affiliate == address(0) || affiliate == msg.sender) return;
        traderReferralCodes[_trader] = _code;
    }`).length === 1
  && vicHits(`function setTraderReferralCode(address _trader, bytes32 _code) external onlyHandler {
        address affiliate = codeOwners[_code];
        if (affiliate == address(0) || affiliate == msg.sender) return;
        traderReferralCodes[_trader] = _code;
    }`)[0].severityGuess === "Medium");
check("vacuous-identity: onlyRole(HANDLER_ROLE) + require(msg.sender != X) → 1",
  vicHits(`function setTraderReferralCode(address _trader, bytes32 _code) external onlyRole(HANDLER_ROLE) {
        require(msg.sender != _trader, "self");
        traderReferralCodes[_trader] = _code;
    }`).length === 1);
check("vacuous-identity: onlyRouter + `msg.sender == affiliate` (urutan balik) → 1",
  vicHits(`function bind(address _trader, bytes32 _code) external onlyRouter {
        address affiliate = codeOwners[_code];
        if (msg.sender == affiliate) return;
        traderReferralCodes[_trader] = _code;
    }`).length === 1);
check("vacuous-identity: jalur user langsung (tanpa modifier perantara) → 0",
  vicHits(`function setTraderReferralCodeByUser(bytes32 _code) external {
        address affiliate = codeOwners[_code];
        require(affiliate != address(0), "code not registered");
        require(affiliate != msg.sender, "self referral not allowed");
        traderReferralCodes[msg.sender] = _code;
    }`).length === 0);
check("vacuous-identity: onlyOwner + cek msg.sender vs param (bermakna) → 0",
  vicHits(`function setCode(address _user, bytes32 _code) external onlyOwner {
        require(_user != msg.sender, "self");
        traderReferralCodes[_user] = _code;
    }`).length === 0);
check("vacuous-identity: onlyRole(ADMIN_ROLE) + cek msg.sender vs param → 0",
  vicHits(`function setCode(address _user, bytes32 _code) external onlyRole(ADMIN_ROLE) {
        require(_user != msg.sender, "self");
        traderReferralCodes[_user] = _code;
    }`).length === 0);
check("vacuous-identity: handler-only TANPA cek identitas → 0",
  vicHits(`function setTraderReferralCode(address _trader, bytes32 _code) external onlyHandler {
        traderReferralCodes[_trader] = _code;
    }`).length === 0);
check("vacuous-identity: cek `msg.sender == address(0)` di handler-only → 0",
  vicHits(`function setTraderReferralCode(address _trader, bytes32 _code) external onlyHandler {
        require(msg.sender != address(0), "zero");
        traderReferralCodes[_trader] = _code;
    }`).length === 0);

// --- 18. Detektor dead-config-storage (15 Nov 2026, kelas R-02 Fulcrom):
// state var ditulis di initialize/setter tapi tak pernah dibaca.
function dcHits(body) {
  const r = runPipeline(`pragma solidity ^0.8.20;
contract DcCalib {
    ${body}
}`, "dc-calib.sol");
  return r.candidates.filter((c) => c.detector === "dead-config-storage");
}
const DC = "dead-config-storage";
const dcR02 = dcHits(`bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }`);
check("dead-config: bool ditulis di initialize + setter, tak dibaca → 1 Low @initialize (R-02)",
  dcR02.length === 1 && dcR02[0].severityGuess === "Low"
  && dcR02[0].location.function === "initialize",
  JSON.stringify(dcR02.map((c) => c.location.function + ":" + c.severityGuess)));
check("dead-config: uint ditulis di setter DAN dibaca di view → 0",
  dcHits(`uint256 public liveThreshold;
    function setLiveThreshold(uint256 _v) external { liveThreshold = _v; }
    function getLiveThreshold() external view returns (uint256) { return liveThreshold; }`).length === 0);
check("dead-config: statement no-op `secondaryPriceFeed;` BUKAN baca → tetap 1",
  dcHits(`address public secondaryPriceFeed;
    function initialize() external { secondaryPriceFeed; }
    function setSecondaryPriceFeed(address _v) external { secondaryPriceFeed = _v; }`).length === 1);
check("dead-config: mapping ditulis, tak dibaca → 1; mapping dibaca → 0",
  dcHits(`mapping(address => uint256) public deadMap;
    function setDead(address u, uint256 v) external { deadMap[u] = v; }`).length === 1
  && dcHits(`mapping(address => uint256) public liveMap;
    function setLive(address u, uint256 v) external { liveMap[u] = v; }
    function getLive(address u) external view returns (uint256) { return liveMap[u]; }`).length === 0);
check("dead-config: immutable (tulis di constructor saja) dilewati → 0",
  dcHits(`uint256 public immutable maxFee;
    constructor() { maxFee = 100; }`).length === 0);
check("dead-config: hanya inisialisasi di deklarasi, tak ditulis di fungsi → 0",
  dcHits(`uint256 public threshold = 30;
    function getThreshold() external view returns (uint256) { return threshold; }`).length === 0
  && dcHits(`uint256 public threshold = 30;`).length === 0);
check("dead-config: setter ber-param sama nama (shadowing) → tulis lokal, bukan state → 0",
  dcHits(`uint256 public threshold;
    function setThreshold(uint256 threshold) external { threshold = threshold; }`).length === 0);
const dcLocal = dcHits(`uint256 public feeBps;
    function setFeeLocal(uint256 bps) external {
        uint256 feeBps = bps;
        require(feeBps < 10000, "too high");
    }
    function setFeeInternal(uint256 bps) private { feeBps = bps; }`);
check("dead-config: lokal `uint256 feeBps` menutupi state var (macCalib) → 1 @setFeeInternal",
  dcLocal.length === 1 && dcLocal[0].location.function === "setFeeInternal",
  JSON.stringify(dcLocal.map((c) => c.location.function)));
check("dead-config: baca lewat `this.flag()` dihitung baca → 0",
  dcHits(`bool public flag;
    function setFlag(bool _v) external { flag = _v; }
    function readFlag() external view returns (bool) { return this.flag(); }`).length === 0);
check("dead-config: baca lewat getter kontrak LAIN (`other.flag()`) BUKAN baca file ini → 1",
  dcHits(`bool public flag;
    function setFlag(bool _v) external { flag = _v; }
    function poke(address o) external { IOther(o).flag(); }`).length === 1);
check("dead-config: tipe kontrak (IPriceFeed) ditulis, tak dibaca → 1",
  dcHits(`IPriceFeed public feed;
    function setFeed(IPriceFeed _f) external { feed = _f; }`).length === 1);
check("dead-config: `delete` dihitung tulis (bukan baca) → 1 bila tak pernah dibaca",
  dcHits(`uint256 public counter;
    function reset() external { delete counter; }`).length === 1);
// Klasifikasi upstream-diff: baseline membaca var → live-divergent;
// baseline juga dead → live-identical; var baru → absent.
const dcTarget = `pragma solidity ^0.8.20;
contract VaultPriceFeedV2 {
    bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
}`;
const dcBaseGmx = `pragma solidity ^0.8.20;
contract VaultPriceFeed {
    bool public favorPrimaryPrice = false;
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
    function getPrice() external view returns (uint256) {
        if (favorPrimaryPrice) { return 1; }
        return 2;
    }
}`;
const dcBaseDead = dcTarget;
const dcDiv = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": dcBaseGmx } });
const dcDivCand = dcDiv.candidates.find((c) => c.detector === DC);
check("dead-config upstream: GMX membaca favorPrimaryPrice, fork tidak → live-divergent",
  dcDivCand && dcDivCand.upstream
  && dcDivCand.upstream.classification === "live-divergent",
  JSON.stringify(dcDivCand && dcDivCand.upstream));
const dcSame = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": dcBaseDead } });
const dcSameCand = dcSame.candidates.find((c) => c.detector === DC);
check("dead-config upstream: baseline juga dead → live-identical",
  dcSameCand && dcSameCand.upstream
  && dcSameCand.upstream.classification === "live-identical",
  JSON.stringify(dcSameCand && dcSameCand.upstream));
const dcAbsent = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": "pragma solidity ^0.8.20;\ncontract Other {\n    uint256 public x;\n}" } });
const dcAbsentCand = dcAbsent.candidates.find((c) => c.detector === DC);
check("dead-config upstream: var tidak ada di baseline → absent",
  dcAbsentCand && dcAbsentCand.upstream
  && dcAbsentCand.upstream.classification === "absent",
  JSON.stringify(dcAbsentCand && dcAbsentCand.upstream));

// --- 18b. Kalibrasi v2 dead-config-storage (review silang Kiro Opus 5.5,
// 16 Nov 2026 — 36 kasus adversarial: v1 benar 15/36, 6 FP + 13 FN +
// 2 salah-klasifikasi upstream; v2 Kiro 29/33, 4 sisa turun ke Info).
// F = false positive (harap 0 hit), N = false negative (harap 1 hit),
// U = klasifikasi upstream.
function dcHitsSrc(src) {
  const r = runPipeline(src, "dc-src.sol");
  return r.candidates.filter((c) => c.detector === "dead-config-storage");
}
function dcSev(hits) { return hits.length ? hits[0].severityGuess : "-"; }
// F1: getter dibaca kontrak lain dalam file yang sama → 1, turun ke Info.
const dcF1 = dcHitsSrc(`pragma solidity ^0.8.20;
contract Cfg {
    bool public paused;
    function setPaused(bool _v) external { paused = _v; }
}
contract Reader {
    Cfg public cfg;
    function isPaused() external view returns (bool) { return cfg.paused(); }
}`);
check("dead-config v2 F1: getter dibaca kontrak lain (file sama) → 1 Info",
  dcF1.length === 1 && dcF1[0].severityGuess === "Info",
  JSON.stringify(dcF1.map((c) => c.severityGuess)));
// F2: assembly sload(fee.slot) = baca → 0.
check("dead-config v2 F2: sload(fee.slot) → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function readFee() external view returns (uint256) { uint256 x; assembly { x := sload(fee.slot); } return x; }`).length === 0);
// F3: assembly sload(0) slot mentah → 1 Info (bukan Low).
const dcF3 = dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function readSlot() external view returns (uint256) { uint256 x; assembly { x := sload(0); } return x; }`);
check("dead-config v2 F3: sload(0) slot mentah → 1 Info",
  dcF3.length === 1 && dcF3[0].severityGuess === "Info",
  JSON.stringify(dcF3.map((c) => c.severityGuess)));
// F4: this.flag() → 0 (sudah ada di seksi 18; diulang sebagai kasus Kiro).
check("dead-config v2 F4: this.flag() → 0",
  dcHits(`bool public flag;
    function setFlag(bool _v) external { flag = _v; }
    function readFlag() external view returns (bool) { return this.flag(); }`).length === 0);
// F5: dibaca kontrak turunan dalam file yang sama → 0.
check("dead-config v2 F5: dibaca kontrak turunan (file sama) → 0",
  dcHitsSrc(`pragma solidity ^0.8.20;
contract Base {
    uint256 internal fee;
    function setFee(uint256 _v) external { fee = _v; }
}
contract Derived is Base {
    function getFee() external view returns (uint256) { return fee; }
}`).length === 0);
// F6: base abstrak + var internal, pembaca di file lain (tak terlihat) → 1 Info.
const dcF6 = dcHitsSrc(`pragma solidity ^0.8.20;
abstract contract Base {
    uint256 internal fee;
    function setFee(uint256 _v) external { fee = _v; }
}`);
check("dead-config v2 F6: abstract + internal → 1 Info",
  dcF6.length === 1 && dcF6[0].severityGuess === "Info",
  JSON.stringify(dcF6.map((c) => c.severityGuess)));
// F7–F11: emit / argumen external call / delegatecall / abi.encode / keccak256 → 0.
check("dead-config v2 F7: emit E(fee) → 0",
  dcHits(`event E(uint256 fee);
    uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function doEmit() external { emit E(fee); }`).length === 0);
check("dead-config v2 F8: argumen external call → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function useFee(address t) external { IOther(t).take(fee); }`).length === 0);
check("dead-config v2 F9: delegatecall dengan fee → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function fwd(address impl) external { (bool ok, ) = impl.delegatecall(abi.encodeWithSignature("go(uint256)", fee)); ok; }`).length === 0);
check("dead-config v2 F10: abi.encode(fee) → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function enc() external view returns (bytes memory) { return abi.encode(fee); }`).length === 0);
check("dead-config v2 F11: keccak256(abi.encode(fee)) → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function h() external view returns (bytes32) { return keccak256(abi.encode(fee)); }`).length === 0);
// F12–F13: storage ref ke helper / struct field read → 0.
check("dead-config v2 F12: storage ref diteruskan ke helper → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function bump() external { _bump(fee); }
    function _bump(uint256 storage f) internal { f += 1; }`).length === 0);
check("dead-config v2 F13: struct field read cfg.fee → 0",
  dcHits(`struct Cfg { uint256 fee; }
    Cfg public cfg;
    function setFee(uint256 _v) external { cfg.fee = _v; }
    function getFee() external view returns (uint256) { return cfg.fee; }`).length === 0);
// F14: public override (getter interface) → 1 Info.
const dcF14 = dcHits(`uint256 public override fee;
    function setFee(uint256 _v) external { fee = _v; }`);
check("dead-config v2 F14: public override → 1 Info",
  dcF14.length === 1 && dcF14[0].severityGuess === "Info",
  JSON.stringify(dcF14.map((c) => c.severityGuess)));
// F15: baca di badan modifier → 0.
check("dead-config v2 F15: baca di modifier → 0",
  dcHits(`uint256 public fee;
    modifier check() { require(fee > 0, "x"); _; }
    function setFee(uint256 _v) external { fee = _v; }
    function go() external check() {}`).length === 0);
// F16: rantai super.quote() membaca var induk → 0.
check("dead-config v2 F16: super.quote() → 0",
  dcHitsSrc(`pragma solidity ^0.8.20;
contract Base {
    uint256 public quote;
    function setQuote(uint256 _v) external { quote = _v; }
}
contract Child is Base {
    function getQuote() external view returns (uint256) { return super.quote(); }
}`).length === 0);
// F17: lokal senama di blok if, state var dibaca sesudah blok → 0.
check("dead-config v2 F17: lokal di blok if, baca state sesudah blok → 0",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function go(bool b) external {
        if (b) { uint256 fee = 3; require(fee > 0, "x"); }
        require(fee > 0, "y");
    }`).length === 0);
// F18: lokal di receive() bukan state var → hanya fee yang ter-flag (1).
const dcF18 = dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    receive() external payable {
        uint256 amount;
        amount = msg.value;
    }`);
check("dead-config v2 F18: lokal di receive() bukan state var → 1 (fee saja)",
  dcF18.length === 1 && dcF18[0].location.function === "setFee",
  JSON.stringify(dcF18.map((c) => c.location.function)));
// N1: tulis via sstore(fee.slot, v) → 1.
check("dead-config v2 N1: sstore(fee.slot, v) = tulis → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function setFeeAsm(uint256 _v) external { assembly { sstore(fee.slot, _v) } }`).length === 1);
// N2: param modifier senama dibaca → 1 (baca itu param, bukan state).
check("dead-config v2 N2: param modifier check(uint256 fee) → 1",
  dcHits(`uint256 public fee;
    modifier check(uint256 fee) { require(fee > 0, "x"); _; }
    function setFee(uint256 _v) external { fee = _v; }
    function go() external check(1) {}`).length === 1);
// N3: var senama di kontrak lain (file sama) bukan baca → 1.
check("dead-config v2 N3: var senama di kontrak lain → 1",
  dcHitsSrc(`pragma solidity ^0.8.20;
contract A {
    uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
}
contract B {
    uint256 public fee;
    function getFee() external view returns (uint256) { return fee; }
}`).length === 1);
// N4: tulis field infos[u].limit = v → 1.
check("dead-config v2 N4: infos[u].limit = v = tulis → 1",
  dcHits(`struct Info { uint256 limit; }
    mapping(address => Info) public infos;
    function setLimit(address u, uint256 v) external { infos[u].limit = v; }`).length === 1);
// N5: array hanya list.push(a) = tulis → 1.
check("dead-config v2 N5: list.push(a) saja = tulis → 1",
  dcHits(`uint256[] public list;
    function add(uint256 a) external { list.push(a); }`).length === 1);
// N6: tuple (fee, cap) = abi.decode(...) = tulis → 2.
check("dead-config v2 N6: tuple LHS = tulis → 2",
  dcHits(`uint256 public fee;
    uint256 public cap;
    function setBoth(bytes memory d) external { (fee, cap) = abi.decode(d, (uint256, uint256)); }`).length === 2);
// N7: named return returns (uint256 fee) → 1.
check("dead-config v2 N7: named return (uint256 fee) → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function getFee() external view returns (uint256 fee) { fee = 1; }`).length === 1);
// N8: nama hanya di string literal → 1.
check("dead-config v2 N8: nama hanya di string literal → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function err() external pure { revert("fee too high"); }`).length === 1);
// N9: lokal di fungsi satu baris → 1.
check("dead-config v2 N9: lokal fungsi satu baris → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function local() external { uint256 fee = 3; require(fee > 0, "x"); }`).length === 1);
// N10: lokal di header for → 1.
check("dead-config v2 N10: lokal di header for → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function loop() external { for (uint256 fee = 0; fee < 3; fee++) { require(fee > 0, "x"); } }`).length === 1);
// N11: param event senama → 1.
check("dead-config v2 N11: param event senama → 1",
  dcHits(`event FeeUpdated(uint256 fee);
    uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }`).length === 1);
// N12: param error senama → 1.
check("dead-config v2 N12: param error senama → 1",
  dcHits(`error FeeTooHigh(uint256 fee);
    uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }`).length === 1);
// N13: tuple lokal (uint256 fee, ) = ... → 1.
check("dead-config v2 N13: tuple lokal → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function local() external { (uint256 fee, uint256 cap) = (1, 2); require(fee > 0, "x"); }`).length === 1);
// N14: baca hanya di NatSpec/komentar → 1.
check("dead-config v2 N14: baca hanya di komentar → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    /// @notice fee is important
    function note() external pure { }`).length === 1);
// N15: hanya fee += v (tulis, tanpa baca) → 1.
check("dead-config v2 N15: hanya fee += v → 1",
  dcHits(`uint256 public fee;
    function bump(uint256 v) external { fee += v; }`).length === 1);
// P3: tulis HANYA di constructor → 0 (Timelock.mintReceiver).
check("dead-config v2 P3: tulis hanya di constructor → 0",
  dcHits(`address public mintReceiver;
    constructor(address _m) { mintReceiver = _m; }`).length === 0);
// P11: metadata ERC20 (name/symbol/decimals) → 0.
check("dead-config v2 P11: name/symbol/decimals ERC20 → 0",
  dcHitsSrc(`pragma solidity ^0.8.20;
contract Tok is ERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    function setName(string memory _n) external { name = _n; }
    function setSymbol(string memory _s) external { symbol = _s; }
    function setDecimals(uint8 _d) external { decimals = _d; }
}`).length === 0);
// U1: baseline hanya punya param event senama → live-identical.
const u1Base = `pragma solidity ^0.8.20;
contract VaultPriceFeedV2 {
    event PriceModeUpdated(bool favorPrimaryPrice);
    bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
}`;
const u1Run = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": u1Base } });
const u1Cand = u1Run.candidates.find((c) => c.detector === DC);
check("dead-config v2 U1: baseline hanya param event senama → live-identical",
  u1Cand && u1Cand.upstream && u1Cand.upstream.classification === "live-identical",
  JSON.stringify(u1Cand && u1Cand.upstream));
// U2: baseline var senama dibaca di kontrak lain (file baseline) → live-identical.
const u2Base = `pragma solidity ^0.8.20;
contract VaultPriceFeedV2 {
    bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
}
contract Other {
    bool public favorPrimaryPrice;
    function getMode() external view returns (bool) { return favorPrimaryPrice; }
}`;
const u2Run = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": u2Base } });
const u2Cand = u2Run.candidates.find((c) => c.detector === DC);
check("dead-config v2 U2: baseline var dibaca kontrak lain → live-identical",
  u2Cand && u2Cand.upstream && u2Cand.upstream.classification === "live-identical",
  JSON.stringify(u2Cand && u2Cand.upstream));
// U3: baseline membaca lewat modifier → live-divergent (sudah benar di v1).
const u3Base = `pragma solidity ^0.8.20;
contract VaultPriceFeedV2 {
    bool public favorPrimaryPrice;
    modifier check() { require(favorPrimaryPrice, "x"); _; }
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
    function go() external check() {}
}`;
const u3Run = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeedV2.sol": u3Base } });
const u3Cand = u3Run.candidates.find((c) => c.detector === DC);
check("dead-config v2 U3: baseline baca lewat modifier → live-divergent",
  u3Cand && u3Cand.upstream && u3Cand.upstream.classification === "live-divergent",
  JSON.stringify(u3Cand && u3Cand.upstream));

// Fallback nama kontrak (saran review Kiro): file di-rename (target
// VaultPriceFeedV2.sol vs baseline VaultPriceFeed.sol) tetap terklasifikasi.
const fbRun = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeed.sol": dcBaseGmx } });
const fbCand = fbRun.candidates.find((c) => c.detector === DC);
check("dead-config v2 fallback: file+kontrak di-rename (V2) → live-divergent via nama kontrak",
  fbCand && fbCand.upstream && fbCand.upstream.classification === "live-divergent"
  && fbCand.upstream.baselineFile === "VaultPriceFeed.sol",
  JSON.stringify(fbCand && fbCand.upstream));
const fbMiss = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "Other.sol": "pragma solidity ^0.8.20;\ncontract Other {\n    uint256 public x;\n}" } });
const fbMissCand = fbMiss.candidates.find((c) => c.detector === DC);
check("dead-config v2 fallback: kontrak tak cocok → tanpa anotasi upstream",
  fbMissCand && !fbMissCand.upstream);

// --- 19. Kalibrasi v2 detektor vacuous-identity-check (review silang Kiro
// Opus 5.5, 15 Nov 2026 21:10 WIB — 30 kasus uji Kiro: v1 benar 6/30).
// Gerbang diperlebar (suffix/prefix modifier, onlyRoles, Roles.,
// keccak256("..."), case-insensitive) tapi diuji HANYA di ekor signature;
// semua perbandingan diperiksa; polaritas guard menentukan severity.
function vic2Hits(body) {
  const r = runPipeline(`pragma solidity ^0.8.20;
contract Vic2Calib {
    mapping(bytes32 => address) public codeOwners;
    mapping(address => bytes32) public traderReferralCodes;
    ${body}
}`, "vic2-calib.sol");
  return r.candidates.filter((c) => c.detector === "vacuous-identity-check");
}
check("vic v2: onlyHandlerOrOwner + `affiliate == msg.sender` → 1 Medium",
  vic2Hits(`function setCode(address _trader, bytes32 _code) external onlyHandlerOrOwner {
        address affiliate = codeOwners[_code];
        if (affiliate == msg.sender) return;
        traderReferralCodes[_trader] = _code;
    }`).length === 1);
check("vic v2: onlyPositionRouter / onlyRouterPlugin → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyPositionRouter {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyRouterPlugin {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: onlyController (GMX v2, 91 pemakaian) → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyController {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: onlyRole(Roles.ROUTER) / keccak256(\"HANDLER_ROLE\") / handlerRole → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyRole(Roles.ROUTER) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyRole(keccak256("HANDLER_ROLE")) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyRole(handlerRole) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: onlyRoles Solady (_ROLE_HANDLER) → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyRoles(_ROLE_HANDLER) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: onlyRole(GHOST_ROLE) substring HOST → 0",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyRole(GHOST_ROLE) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 0);
check("vic v2: onlyRole(NON_ROUTER_ADMIN) residu yang diakui → 1 (tercatat, belum diperbaiki)",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyRole(NON_ROUTER_ADMIN) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: fungsi bernama restrict (onlyOwner) → 0 (ekor-scoping)",
  vic2Hits(`function restrict(address u) external onlyOwner {
        require(u != msg.sender, "self");
        traderReferralCodes[u] = bytes32(0);
    }`).length === 0);
check("vic v2: modifier restrict di ekor TETAP menggerbang → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external restrict(msg.sender) {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: onlyHandlerAndAbove (admin/EOA) → 0",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandlerAndAbove {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 0);
check("vic v2: operand tx.origin dilewati → 0",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(msg.sender == tx.origin, "eoa only");
        traderReferralCodes[_t] = _c;
    }`).length === 0);
check("vic v2: address(this) pertama tidak menutupi perbandingan kedua → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(msg.sender != address(this), "self");
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: address(affiliate) dibuka → 1; address(owner) juga → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        address affiliate = codeOwners[_c];
        if (address(affiliate) == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (address(codeOwners[_c]) == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: operand berindeks kiri/kanan (codeOwners[c]) → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (msg.sender == codeOwners[_c]) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: _msgSender() + alias lokal `address caller = msg.sender` → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (codeOwners[_c] == _msgSender()) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        address caller = msg.sender;
        if (codeOwners[_c] == caller) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
check("vic v2: operand identitas perantara (msg.sender == router) → 1 Info",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyRouter {
        address router;
        require(msg.sender == router, "not router");
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyRouter {
        address router;
        require(msg.sender == router, "not router");
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Info");
check("vic v2: polaritas — require(x == sender) = DoS Low; require(x != sender) = bypass Medium",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(codeOwners[_c] == msg.sender, "must be affiliate");
        traderReferralCodes[_t] = _c;
    }`).length === 1
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(codeOwners[_c] == msg.sender, "must be affiliate");
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Low"
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(codeOwners[_c] != msg.sender, "self");
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Medium");
check("vic v2: polaritas sender-first — require(msg.sender == X) = DoS Low; if(msg.sender != X) = DoS Low; if(msg.sender == X) = bypass Medium",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(msg.sender == codeOwners[_c], "must be affiliate");
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Low"
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (msg.sender != codeOwners[_c]) return;
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Low"
  && vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        if (msg.sender == codeOwners[_c]) return;
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Medium");
// Regresi: grup operator alternatif sender-first adalah grup 3 (bug:
// m[5] membuat op undefined → polaritas selalu default Medium).
check("vic v2: op sender-first terbaca (bukan undefined) — require(msg.sender != X) tetap Medium",
  vic2Hits(`function bind(address _t, bytes32 _c) external onlyHandler {
        require(msg.sender != codeOwners[_c], "self");
        traderReferralCodes[_t] = _c;
    }`)[0].severityGuess === "Medium");
check("vic v2.1: onlySupportedAdapter(adapter) = validator parameter → 0 (FP RAAC repayOnBehalf)",
  vic2Hits(`function repayOnBehalf(address adapter, bytes calldata data, uint256 amount, address onBehalfOf) external nonReentrant whenNotPaused onlyValidAmount(amount) onlySupportedAdapter(adapter) notBlacklisted(msg.sender) notBlacklisted(onBehalfOf) {
        if (positionScaledDebt != 0 && msg.sender != onBehalfOf) revert();
        _repay(adapter, data, amount);
    }`).length === 0);
check("vic v2.1: onlySupportedAdapter(adapter) = validator parameter → 0 (FP RAAC poolDepositAsset)",
  vic2Hits(`function poolDepositAsset(address adapter, bytes calldata data, address receiver, uint256 minSharesOut) external onlySupportedAdapter(adapter) nonReentrant returns (uint256 sharesMinted) {
        require(msg.sender == stabilityPool, "RWAVault: only stability pool caller");
        return _deposit(adapter, data, receiver, 0, minSharesOut);
    }`).length === 0);
check("vic v2.1: operand stabilityPool di fungsi handler-only → 1 Info (bukan Medium)",
  vic2Hits(`function bind(address _t) external onlyHandler {
        require(msg.sender == stabilityPool, "only pool");
        traderReferralCodes[_t] = 1;
    }`)[0].severityGuess === "Info");
check("vic v2.1: onlyRouter(router) dgn arg parameter TETAP gerbang (ambigu tanpa body modifier)",
  vic2Hits(`function bind(address _t, address router) external onlyRouter(router) {
        if (msg.sender == router) return;
        traderReferralCodes[_t] = 1;
    }`).length === 1);
check("vic v2: guard di body isHandler[msg.sender] menggerbang → 1",
  vic2Hits(`function bind(address _t, bytes32 _c) external {
        require(isHandler[msg.sender], "forbidden");
        if (codeOwners[_c] == msg.sender) return;
        traderReferralCodes[_t] = _c;
    }`).length === 1);
// Regresi korpus nyata (saran Kiro 5.5): file ReferralManager Fulcrom
// yang asli — setTraderReferralCode ter-flag, ByUser tidak.
const fulcromReferralPath = path.join(__dirname, "..", "..", "..", "work", "fulcrom", "source",
  "ReferralManager-impl", "contracts", "referrals", "ReferralManager.sol");
if (fs.existsSync(fulcromReferralPath)) {
  const fulcromReferral = fs.readFileSync(fulcromReferralPath, "utf8");
  const frRes = runPipeline(fulcromReferral, "ReferralManager.sol");
  const frVic = frRes.candidates.filter((c) => c.detector === "vacuous-identity-check");
  check("vic v2: ReferralManager Fulcrom asli — setTraderReferralCode ter-flag Medium, ByUser tidak",
    frVic.length === 1
    && frVic[0].location.function === "setTraderReferralCode"
    && frVic[0].severityGuess === "Medium",
    JSON.stringify(frVic.map((c) => c.location.function + ":" + c.severityGuess)));
} else {
  check("vic v2: ReferralManager Fulcrom asli (file tidak ada — dilewati)",
    true, "file tidak ditemukan: " + fulcromReferralPath);
}

// --- 20. Project-pass lintas-file (residual P1/P2 review Kiro detektor #17,
// sesi 04:38 WIB 2026-11-16): dead-config yang dibaca kontrak lain dihapus.
const ppConfig = `pragma solidity ^0.8.20;
interface IConfig { function feeBps() external view returns (uint256); }
contract Config {
    uint256 public feeBps;
    uint256 public deadFee;
    function setFee(uint256 f) external { feeBps = f; }
    function setDead(uint256 f) external { deadFee = f; }
}`;
const ppReader = `pragma solidity ^0.8.20;
import "./Config.sol";
contract Reader {
    IConfig public cfg;
    function get() external view returns (uint256) { return cfg.feeBps(); }
}`;
const ppBase = `pragma solidity ^0.8.20;
abstract contract VaultBase {
    uint256 internal baseFee;
    function setBaseFee(uint256 f) external { baseFee = f; }
}`;
const ppDerived = `pragma solidity ^0.8.20;
import "./Base.sol";
contract VaultV2 is VaultBase {
    function getFee() external view returns (uint256) { return baseFee; }
}`;
const ppOther = `pragma solidity ^0.8.20;
interface IOther { function feeBps() external view returns (uint256); }
contract Other {
    IOther public cfg2;
    function get() external view returns (uint256) { return cfg2.feeBps(); }
}`;
const ppShadow = `pragma solidity ^0.8.20;
import "./Base.sol";
contract VaultV3 is VaultBase {
    uint256 internal baseFee;
    function getFee() external view returns (uint256) { return baseFee; }
}`;
const ppBare = `pragma solidity ^0.8.20;
import "./Config.sol";
contract BareReader {
    IConfig public cfg;
    function get() external view returns (uint256) { uint256 f = cfg.feeBps; return f; }
}`;
function ppDead(files) {
  const r = runProjectPipeline(files);
  return r.candidates.filter((c) => c.detector === "dead-config-storage");
}
const ppA = runProjectPipeline([
  { name: "Config.sol", text: ppConfig },
  { name: "Reader.sol", text: ppReader },
]);
check("project-pass: feeBps dibaca getter lintas-file → kandidat HILANG",
  ppA.candidates.filter((c) => c.varName === "feeBps").length === 0,
  JSON.stringify(ppA.candidates.map((c) => c.varName)));
check("project-pass: deadFee tetap ada (Low, tak dibaca siapa pun)",
  ppA.candidates.filter((c) => c.varName === "deadFee").length === 1
  && ppA.candidates.find((c) => c.varName === "deadFee").severityGuess === "Low");
check("project-pass: dropped membawa bukti pembaca (file:baris + kind getter)",
  ppA.dropped.length === 1 && ppA.dropped[0].varName === "feeBps"
  && /Reader\.sol/.test(ppA.dropped[0].readBy[0]) && /getter/.test(ppA.dropped[0].readBy[0]),
  JSON.stringify(ppA.dropped));
const ppB = runProjectPipeline([
  { name: "Base.sol", text: ppBase },
  { name: "Derived.sol", text: ppDerived },
]);
check("project-pass: var internal abstract dibaca kontrak turunan file lain → HILANG",
  ppB.candidates.filter((c) => c.varName === "baseFee").length === 0,
  JSON.stringify(ppB.candidates.map((c) => c.varName)));
check("project-pass: turunan via inheritance tercatat kind=inheritance",
  ppB.dropped.length === 1 && /inheritance/.test(ppB.dropped[0].readBy[0]),
  JSON.stringify(ppB.dropped));
const ppD = runProjectPipeline([
  { name: "Config.sol", text: ppConfig },
  { name: "Other.sol", text: ppOther },
]);
check("project-pass: nama var sama di kontrak lain TANPA menyebut pemilik → TETAP (no false removal)",
  ppD.candidates.filter((c) => c.varName === "feeBps").length === 1,
  JSON.stringify(ppD.candidates.map((c) => c.varName)));
const ppF = runProjectPipeline([
  { name: "Base.sol", text: ppBase },
  { name: "Shadow.sol", text: ppShadow },
]);
check("project-pass: turunan mendeklarasi ulang var senama (shadowing) → TETAP",
  ppF.candidates.filter((c) => c.varName === "baseFee").length === 1,
  JSON.stringify(ppF.candidates.map((c) => c.varName)));
const ppE = runProjectPipeline([
  { name: "Config.sol", text: ppConfig },
  { name: "Bare.sol", text: ppBare },
]);
check("project-pass: baca member tanpa parens (cfg.feeBps) → HILANG",
  ppE.candidates.filter((c) => c.varName === "feeBps").length === 0,
  JSON.stringify(ppE.candidates.map((c) => c.varName)));
// Regresi korpus nyata: Vault.sol + VaultUtils.sol Fulcrom asli —
// maxLeverage (public override, dibaca _vault.maxLeverage() di VaultUtils)
// harus HILANG; favorPrimaryPrice VPF2 (tak dibaca) harus TETAP.
const fulcromVaultPath = path.join(__dirname, "..", "..", "..", "work", "fulcrom", "source",
  "Vault-impl", "contracts", "core", "Vault.sol");
const fulcromVaultUtilsPath = path.join(__dirname, "..", "..", "..", "work", "fulcrom", "source",
  "VaultUtils-impl", "contracts", "core", "VaultUtils.sol");
if (fs.existsSync(fulcromVaultPath) && fs.existsSync(fulcromVaultUtilsPath)) {
  const ppReal = runProjectPipeline([
    { name: "Vault.sol", text: fs.readFileSync(fulcromVaultPath, "utf8") },
    { name: "VaultUtils.sol", text: fs.readFileSync(fulcromVaultUtilsPath, "utf8") },
  ]);
  const realDead = ppReal.candidates.filter((c) => c.detector === "dead-config-storage");
  check("project-pass: Vault Fulcrom asli — maxLeverage HILANG (dibaca VaultUtils)",
    !realDead.some((c) => c.varName === "maxLeverage"),
    JSON.stringify(realDead.map((c) => c.varName + ":" + c.severityGuess)));
  check("project-pass: Vault Fulcrom asli — dropped maxLeverage kind=getter",
    ppReal.dropped.some((d) => d.varName === "maxLeverage" && /getter/.test(d.readBy.join(" "))),
    JSON.stringify(ppReal.dropped.map((d) => d.varName)));
} else {
  check("project-pass: Vault Fulcrom asli (file tidak ada — dilewati)", true,
    "file tidak ditemukan");
}

// --- 21. Fallback rename multi-kontrak (residual #2 review Kiro
// detektor #17, sesi 08:38 WIB 2026-11-16): fallback nama kontrak dulu
// hanya memakai kontrak PERTAMA di file — file multi-kontrak bisa salah
// pasang (kontrak target bukan yang pertama) atau gagal total. Kini
// SEMUA nama kontrak dibandingkan + baseline dipilih PER KANDIDAT
// menurut kontrak pemiliknya (nama persis mengalahkan normalisasi
// sufiks versi).
// 21a. Live multi-kontrak, kontrak target KEDUA: dulu tanpa anotasi.
const mcLiveSecond = `pragma solidity ^0.8.20;
contract Helper {
    uint256 public x;
    function setX(uint256 _v) external { x = _v; }
}
contract VaultPriceFeedV2 {
    bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
}`;
const mcA = runPipeline(mcLiveSecond, "Multi.sol",
  { baseline: { "VaultPriceFeed.sol": dcBaseGmx } });
const mcACand = mcA.candidates.find((c) => c.varName === "favorPrimaryPrice");
check("fallback multi-kontrak: live target kedua → live-divergent via VaultPriceFeed.sol",
  mcACand && mcACand.upstream && mcACand.upstream.classification === "live-divergent"
  && mcACand.upstream.baselineFile === "VaultPriceFeed.sol",
  JSON.stringify(mcACand && mcACand.upstream));
// 21b. Baseline multi-kontrak, kontrak target KEDUA di file baseline.
const mcBaseSecond = `pragma solidity ^0.8.20;
contract Other {
    uint256 public x;
}
contract VaultPriceFeed {
    bool public favorPrimaryPrice = false;
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
    function getPrice() external view returns (uint256) {
        if (favorPrimaryPrice) { return 1; }
        return 2;
    }
}`;
const mcB = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "Bundle.sol": mcBaseSecond } });
const mcBCand = mcB.candidates.find((c) => c.detector === DC);
check("fallback multi-kontrak: baseline target kedua → live-divergent via Bundle.sol",
  mcBCand && mcBCand.upstream && mcBCand.upstream.classification === "live-divergent"
  && mcBCand.upstream.baselineFile === "Bundle.sol",
  JSON.stringify(mcBCand && mcBCand.upstream));
// 21c. Per-kandidat: dua kontrak di satu file live, baseline terpisah
// per kontrak. File-level fallback memilih Alpha.sol (pertama); kandidat
// Beta WAJIB diklasifikasi vs Beta.sol (live-identical), bukan vs
// Alpha.sol (yang akan memberi absent — var flag tak ada di sana).
const mcPairLive = `pragma solidity ^0.8.20;
contract Alpha {
    uint256 public mode;
    function setMode(uint256 _v) external { mode = _v; }
}
contract Beta {
    uint256 public flag;
    function setFlag(bool _v) external { flag = _v; }
}`;
const mcAlphaBase = `pragma solidity ^0.8.20;
contract Alpha {
    uint256 public mode;
    function setMode(uint256 _v) external { mode = _v; }
    function getMode() external view returns (uint256) { return mode; }
}`;
const mcBetaBase = `pragma solidity ^0.8.20;
contract Beta {
    uint256 public flag;
    function setFlag(bool _v) external { flag = _v; }
}`;
const mcC = runPipeline(mcPairLive, "Pair.sol",
  { baseline: { "Alpha.sol": mcAlphaBase, "Beta.sol": mcBetaBase } });
const mcMode = mcC.candidates.find((c) => c.varName === "mode");
const mcFlag = mcC.candidates.find((c) => c.varName === "flag");
check("fallback multi-kontrak: kandidat Alpha → live-divergent via Alpha.sol",
  mcMode && mcMode.upstream && mcMode.upstream.classification === "live-divergent"
  && mcMode.upstream.baselineFile === "Alpha.sol",
  JSON.stringify(mcMode && mcMode.upstream));
check("fallback multi-kontrak: kandidat Beta → live-identical via Beta.sol (bukan absent)",
  mcFlag && mcFlag.upstream && mcFlag.upstream.classification === "live-identical"
  && mcFlag.upstream.baselineFile === "Beta.sol",
  JSON.stringify(mcFlag && mcFlag.upstream));
// 21d. Nama persis mengalahkan normalisasi sufiks versi (meski file
// ternormalisasi lebih dulu di peta baseline).
const mcExactBase = `pragma solidity ^0.8.20;
contract VaultPriceFeedV2 {
    bool public favorPrimaryPrice;
    function initialize() external { favorPrimaryPrice = false; }
    function setFavorPrimaryPrice(bool _v) external { favorPrimaryPrice = _v; }
}`;
const mcD = runPipeline(dcTarget, "VaultPriceFeedV2.sol",
  { baseline: { "VaultPriceFeed.sol": dcBaseGmx, "Exact.sol": mcExactBase } });
const mcDCand = mcD.candidates.find((c) => c.detector === DC);
check("fallback multi-kontrak: nama persis (V2) menang atas ternormalisasi → live-identical via Exact.sol",
  mcDCand && mcDCand.upstream && mcDCand.upstream.classification === "live-identical"
  && mcDCand.upstream.baselineFile === "Exact.sol",
  JSON.stringify(mcDCand && mcDCand.upstream));
// 21e. Commented-out-function per-kandidat: setFee yang dikomentari ada
// di kontrak B; baseline A.sol (kontrak pertama yang cocok di level
// file) tidak punya setFee — kandidat WAJIB live-identical via B.sol.
const mcFnLive = `pragma solidity ^0.8.20;
contract A {
    address public owner;
    function liveA(uint256 x) external pure returns (uint256) { return x; }
}
contract B {
    address public owner;
    uint256 public feeBps;
    // function setFee(uint256 bps) external {
    //     require(msg.sender == owner, "not owner");
    //     feeBps = bps;
    // }
    function liveB(uint256 x) external pure returns (uint256) { return x; }
}`;
const mcABase = `pragma solidity ^0.8.20;
contract A {
    address public owner;
    function liveA(uint256 x) external pure returns (uint256) { return x; }
}`;
const mcBBase = `pragma solidity ^0.8.20;
contract B {
    address public owner;
    uint256 public feeBps;
    function setFee(uint256 bps) external {
        require(msg.sender == owner, "not owner");
        feeBps = bps;
    }
    function liveB(uint256 x) external pure returns (uint256) { return x; }
}`;
const mcE = runPipeline(mcFnLive, "MultiFn.sol",
  { baseline: { "A.sol": mcABase, "B.sol": mcBBase } });
const mcSetFee = mcE.candidates.find((c) => c.location.function === "setFee");
check("fallback multi-kontrak: commented-out setFee di kontrak B → live-identical via B.sol",
  mcSetFee && mcSetFee.upstream && mcSetFee.upstream.classification === "live-identical"
  && mcSetFee.upstream.baselineFile === "B.sol",
  JSON.stringify(mcSetFee && mcSetFee.upstream));
// 21f. Oracle per-kandidat (jalur pemilik berbasis nama fungsi):
// getPriceB di FeedB WAJIB live-divergent via FeedB.sol (upstream
// ber-cek), bukan absent vs FeedA.sol.
const mcOracleLive = `pragma solidity ^0.8.20;
contract FeedA {
    address public oracle;
    function getPriceA() external view returns (uint256) {
        int256 price = IPriceFeed(oracle).latestAnswer();
        require(price > 0, "bad price");
        return uint256(price);
    }
}
contract FeedB {
    address public oracle;
    function getPriceB() external view returns (uint256) {
        int256 price = IPriceFeed(oracle).latestAnswer();
        require(price > 0, "bad price");
        return uint256(price);
    }
}`;
const mcFeedABase = `pragma solidity ^0.8.20;
contract FeedA {
    address public oracle;
    function getPriceA() external view returns (uint256) {
        int256 price = IPriceFeed(oracle).latestAnswer();
        require(price > 0, "bad price");
        return uint256(price);
    }
}`;
const mcFeedBBase = `pragma solidity ^0.8.20;
contract FeedB {
    address public oracle;
    function getPriceB() external view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale price");
        require(price > 0, "bad price");
        return uint256(price);
    }
}`;
const mcF = runPipeline(mcOracleLive, "Feeds.sol",
  { baseline: { "FeedA.sol": mcFeedABase, "FeedB.sol": mcFeedBBase } });
const mcPA = mcF.candidates.find((c) => c.location.function === "getPriceA");
const mcPB = mcF.candidates.find((c) => c.location.function === "getPriceB");
check("fallback multi-kontrak: oracle FeedA → live-identical via FeedA.sol",
  mcPA && mcPA.upstream && mcPA.upstream.classification === "live-identical"
  && mcPA.upstream.baselineFile === "FeedA.sol",
  JSON.stringify(mcPA && mcPA.upstream));
check("fallback multi-kontrak: oracle FeedB → live-divergent via FeedB.sol (bukan absent)",
  mcPB && mcPB.upstream && mcPB.upstream.classification === "live-divergent"
  && mcPB.upstream.baselineFile === "FeedB.sol",
  JSON.stringify(mcPB && mcPB.upstream));

// --- 22. Kalibrasi project-pass dari review silang Kiro Opus 5.5
// (sesi 08:38 WIB 2026-11-16 — vonis v1 9/33 atas REPLIKA Kiro, bukan
// kode asli; jack memverifikasi tiap klaim terhadap kode nyata di sini
// dan hanya memperbaiki celah yang TERBUKTI).
// 22a. P3: baca di file test/mock BUKAN bukti (file test tidak di-deploy).
const p3Config = `pragma solidity ^0.8.20;
contract Config {
    uint256 public feeBps;
    function setFee(uint256 f) external { feeBps = f; }
}`;
const p3Reader = `pragma solidity ^0.8.20;
import "../Config.sol";
contract ReaderTest {
    IConfig public cfg;
    function get() external view returns (uint256) { return cfg.feeBps(); }
}`;
const p3Test = runProjectPipeline([
  { name: "Config.sol", text: p3Config },
  { name: "test/Reader.t.sol", text: p3Reader },
]);
check("project-pass P3: baca getter di file test → kandidat TETAP",
  p3Test.candidates.filter((c) => c.varName === "feeBps").length === 1,
  JSON.stringify(p3Test.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p3Test.dropped.map((d) => d.varName)));
const p3Mock = runProjectPipeline([
  { name: "Config.sol", text: p3Config },
  { name: "mocks/MockReader.sol", text: p3Reader },
]);
check("project-pass P3: baca getter di file mock → kandidat TETAP",
  p3Mock.candidates.filter((c) => c.varName === "feeBps").length === 1,
  JSON.stringify(p3Mock.candidates.map((c) => c.varName)));
const p3Real = runProjectPipeline([
  { name: "Config.sol", text: p3Config },
  { name: "Reader.sol", text: p3Reader },
]);
check("project-pass P3 (kontrol): baca getter di file biasa → tetap HILANG",
  p3Real.candidates.filter((c) => c.varName === "feeBps").length === 0,
  JSON.stringify(p3Real.candidates.map((c) => c.varName)));
// 22b. P8: inheritance TRANSITIF — cucu (Grand is Middle is Base)
// membaca var internal Base secara langsung.
const p8Base = `pragma solidity ^0.8.20;
contract Base {
    uint256 internal baseFee;
    function setBaseFee(uint256 f) external { baseFee = f; }
}`;
const p8Mid = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Middle is Base {
}`;
const p8Grand = `pragma solidity ^0.8.20;
import "./Base.sol";
import "./Middle.sol";
contract Grand is Middle {
    function getFee() external view returns (uint256) { return baseFee; }
}`;
const p8 = runProjectPipeline([
  { name: "Base.sol", text: p8Base },
  { name: "Middle.sol", text: p8Mid },
  { name: "Grand.sol", text: p8Grand },
]);
check("project-pass P8: var internal dibaca cucu (transitif) → HILANG",
  p8.candidates.filter((c) => c.varName === "baseFee").length === 0,
  JSON.stringify(p8.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p8.dropped.map((d) => d.varName + ":" + d.readBy)));
check("project-pass P8: dropped cucu tercatat kind=inheritance",
  p8.dropped.length === 1 && /inheritance/.test(p8.dropped[0].readBy[0])
  && /Grand\.sol/.test(p8.dropped[0].readBy[0]),
  JSON.stringify(p8.dropped));
// 22b2. P8-shadowing: perantara mendeklarasi ulang var senama → baca
// di cucu merujuk ke var perantara, BUKAN var pemilik → kandidat TETAP.
const p8MidShadow = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Middle is Base {
    uint256 internal baseFee;
}`;
const p8b = runProjectPipeline([
  { name: "Base.sol", text: p8Base },
  { name: "Middle.sol", text: p8MidShadow },
  { name: "Grand.sol", text: p8Grand },
]);
check("project-pass P8: perantara shadow var → kandidat TETAP",
  p8b.candidates.filter((c) => c.varName === "baseFee").length === 1,
  JSON.stringify(p8b.candidates.map((c) => c.varName)));
// 22c. P1-owner: dua kontrak satu file mendeklarasi var SENAMA; hanya
// var kontrak yang benar-benar dibaca yang boleh dihapus (resolusi
// pemilik via declLine, bukan find pertama berdasarkan nama).
const p1Pair = `pragma solidity ^0.8.20;
contract Alpha {
    uint256 public mode;
    function setModeA(uint256 _v) external { mode = _v; }
}
contract Beta {
    uint256 public mode;
    function setModeB(uint256 _v) external { mode = _v; }
}`;
const p1Reader = `pragma solidity ^0.8.20;
import "./Pair.sol";
contract Reader {
    Alpha public a;
    function get() external view returns (uint256) { return a.mode(); }
}`;
const p1 = runProjectPipeline([
  { name: "Pair.sol", text: p1Pair },
  { name: "Reader.sol", text: p1Reader },
]);
check("project-pass P1-owner: mode Alpha (dibaca) → HILANG",
  p1.candidates.filter((c) => c.varName === "mode"
    && c.location.function === "setModeA").length === 0,
  JSON.stringify(p1.candidates.map((c) => c.location.function + ":" + c.varName)));
check("project-pass P1-owner: mode Beta (tak dibaca) → TETAP",
  p1.candidates.filter((c) => c.varName === "mode"
    && c.location.function === "setModeB").length === 1,
  JSON.stringify(p1.candidates.map((c) => c.location.function + ":" + c.varName)));

// --- Seksi 23. Kalibrasi project-pass P2/P4–P7/P9/P10 (review Kiro 16 Nov).
// Tiap celah DIBUKTIKAN dulu sebagai tes yang GAGAL di v1; yang sudah
// ditangani v1 ditulis sebagai tes kunci (harus lolos sebelum & sesudah).
const pp23Base = `pragma solidity ^0.8.20;
contract Base {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
// 23a. P4: tulis-murni di kontrak turunan BUKAN baca — kandidat TETAP.
const p4aChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function setFee2(uint256 f) external { fee = f; }
}`;
const p4a = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p4aChild },
]);
check("project-pass P4: tulis-murni fee di turunan → kandidat TETAP",
  p4a.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p4a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p4a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 23b. P4: akses member objek lain (`o.fee()`) BUKAN baca var pemilik.
const p4bChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Other {
    uint256 public fee;
}
contract Child is Base {
    Other public o;
    function getOtherFee() external view returns (uint256) { return o.fee(); }
}`;
const p4b = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p4bChild },
]);
check("project-pass P4: o.fee() objek lain di turunan → kandidat TETAP",
  p4b.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p4b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p4b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 23c. P4 (kontrol): `this.fee()` di turunan TETAP baca → HILANG.
const p4cChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function getFee() external view returns (uint256) { return this.fee(); }
}`;
const p4c = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p4cChild },
]);
check("project-pass P4 (kontrol): this.fee() di turunan → HILANG",
  p4c.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p4c.candidates.map((c) => c.varName)));
// 23d. P4: `delete fee` di turunan adalah tulis — kandidat TETAP.
const p4dChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function clearFee() external { delete fee; }
}`;
const p4d = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p4dChild },
]);
check("project-pass P4: delete fee di turunan → kandidat TETAP",
  p4d.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p4d.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p4d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 23e. P5 (kunci, sudah ditangani v1): parameter senama = shadow.
const p5aChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function get(uint256 fee) external pure returns (uint256) { return fee; }
}`;
const p5a = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p5aChild },
]);
check("project-pass P5 (kunci): param fee men-shadow → kandidat TETAP",
  p5a.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p5a.candidates.map((c) => c.varName)));
// 23f. P5 (kunci, sudah ditangani v1): deklarasi lokal senama = shadow.
const p5bChild = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function get() external pure returns (uint256) { uint256 fee = 5; return fee; }
}`;
const p5b = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p5bChild },
]);
check("project-pass P5 (kunci): lokal fee men-shadow → kandidat TETAP",
  p5b.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p5b.candidates.map((c) => c.varName)));
// 23g. P6 (kontrol): wrapper yang memanggil getter instance bertipe
// pemilik SUDAH tertangkap cabang getter — P6 tak punya celah independen
// (sisa celah = P9, receiver type; lihat 23j/23k).
const p6Wrapper = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Wrapper {
    Base public b;
    function getFee() external view returns (uint256) { return b.fee(); }
}`;
const p6 = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Wrapper.sol", text: p6Wrapper },
]);
check("project-pass P6 (kontrol): wrapper b.fee() → HILANG",
  p6.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p6.candidates.map((c) => c.varName)));
// 23h. P6 (kontrol): wrapper di kontrak turunan SUDAH tertangkap cabang
// inheritance (baca bare `fee` di badan wrapper).
const p6bMid = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Middle is Base {
    function getFee() external view returns (uint256) { return fee; }
}`;
const p6b = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Middle.sol", text: p6bMid },
]);
check("project-pass P6 (kontrol): wrapper turunan return fee → HILANG",
  p6b.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p6b.candidates.map((c) => c.varName)));
// 23i. P7: alias import `Base as Cfg` — tipe Cfg harus dikenali.
const p7aReader = `pragma solidity ^0.8.20;
import {Base as Cfg} from "./Base.sol";
contract Reader {
    Cfg public cfg;
    function get() external view returns (uint256) { return cfg.fee(); }
}`;
const p7a = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Reader.sol", text: p7aReader },
]);
check("project-pass P7: alias import Cfg → baca dikenali → HILANG",
  p7a.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p7a.candidates.map((c) => c.varName)));
// 23j. P7 (kunci): namespace import `NS.Base` sudah dikenali v1.
const p7bReader = `pragma solidity ^0.8.20;
import * as NS from "./Base.sol";
contract Reader {
    NS.Base public cfg;
    function get() external view returns (uint256) { return cfg.fee(); }
}`;
const p7b = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Reader.sol", text: p7bReader },
]);
check("project-pass P7 (kunci): namespace NS.Base → HILANG",
  p7b.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p7b.candidates.map((c) => c.varName)));
// 23k. P9a: receiver bertipe interface bernama lain (IFee) yang
// mendeklarasi getter fee() — baca harus dikenali. Bentuk realistis:
// pemilik MENGIMPLEMENTASI interface itu (`contract Base is IFee`).
const p9aBase = `pragma solidity ^0.8.20;
import "./IFee.sol";
contract Base is IFee {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const p9aIface = `pragma solidity ^0.8.20;
interface IFee {
    function fee() external view returns (uint256);
}`;
const p9aReader = `pragma solidity ^0.8.20;
import "./Base.sol";
import "./IFee.sol";
contract Reader {
    IFee public f;
    function get() external view returns (uint256) { return f.fee(); }
}`;
const p9a = runProjectPipeline([
  { name: "Base.sol", text: p9aBase },
  { name: "IFee.sol", text: p9aIface },
  { name: "Reader.sol", text: p9aReader },
]);
check("project-pass P9a: receiver IFee (deklarasi fee) → HILANG",
  p9a.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9a.candidates.map((c) => c.varName)));
// 23l. P9b: receiver bertipe kontrak turunan pemilik (Vault is Base).
const p9bVault = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Vault is Base {
}`;
const p9bReader = `pragma solidity ^0.8.20;
import "./Base.sol";
import "./Vault.sol";
contract Reader {
    Vault public v;
    function get() external view returns (uint256) { return v.fee(); }
}`;
const p9b = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Vault.sol", text: p9bVault },
  { name: "Reader.sol", text: p9bReader },
]);
check("project-pass P9b: receiver Vault (turunan Base) → HILANG",
  p9b.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9b.candidates.map((c) => c.varName)));
// 23m. P2 (kunci, moot): gerbang basename — import `../Base.sol` sama
// dengan `./Base.sol` bagi project-pass.
const p2Reader = `pragma solidity ^0.8.20;
import "../Base.sol";
contract Reader {
    Base public cfg;
    function get() external view returns (uint256) { return cfg.fee(); }
}`;
const p2 = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "sub/Reader.sol", text: p2Reader },
]);
check("project-pass P2 (kunci): import ../Base.sol → HILANG",
  p2.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p2.candidates.map((c) => c.varName)));
// 23n. P10 (kunci, sudah ditangani v1): deklarasi tuple lokal senama.
const p10Child = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
    function get() external pure returns (uint256) {
        (uint256 fee, uint256 cap) = (1, 2);
        return fee;
    }
}`;
const p10 = runProjectPipeline([
  { name: "Base.sol", text: pp23Base },
  { name: "Child.sol", text: p10Child },
]);
check("project-pass P10 (kunci): tuple lokal (fee, cap) → kandidat TETAP",
  p10.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p10.candidates.map((c) => c.varName)));

// --- Seksi 24. Kalibrasi lanjutan project-pass (review Kiro 16 Nov,
// diverifikasi wasit ke kode ASLI — bukan skor rekonstruksi Kiro).
// Temuan wasit: 2 klaim Kiro SALAH pada kode asli (P4-5 struct field
// SUDAH keep via shadowing; P9a-4 IVault SUDAH drop via aturan I+nama)
// — keduanya dikunci sebagai tes di sini. Sisanya TERBUKTI.
const pp24Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
// 24a. P7-6 (FP BARU kalibrasi): alias hanya divalidasi basename —
// `../legacy/Vault.sol` BUKAN file pemilik → kandidat TETAP.
const p76Reader = `pragma solidity ^0.8.20;
import {Vault as V} from "../legacy/Vault.sol";
contract Reader {
    V public v;
    function get() external view returns (uint256) { return v.fee(); }
}`;
const p76 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "src/Reader.sol", text: p76Reader },
]);
check("project-pass P7-6: alias ke file lain (basename sama) → TETAP",
  p76.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p76.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p76.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24b. P9b-3 (FP BARU kalibrasi): nama turunan bertabrakan — pembaca
// hanya mengimpor file Child yang TIDAK terkait → kandidat TETAP.
const p9b3V2 = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
}`;
const p9b3Other = `pragma solidity ^0.8.20;
contract Child {
    uint256 public fee;
}`;
const p9b3Reader = `pragma solidity ^0.8.20;
import "./Other.sol";
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const p9b3 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "VaultV2.sol", text: p9b3V2 },
  { name: "Other.sol", text: p9b3Other },
  { name: "Reader.sol", text: p9b3Reader },
]);
check("project-pass P9b-3: turunan senama beda file tak diimpor → TETAP",
  p9b3.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p9b3.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p9b3.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24c. P7-3: alias interface (`IVault as IV`) harus dikenali.
const p73Vault = `pragma solidity ^0.8.20;
import "./IVault.sol";
contract Vault is IVault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const p73Iface = `pragma solidity ^0.8.20;
interface IVault {
    function fee() external view returns (uint256);
}`;
const p73Reader = `pragma solidity ^0.8.20;
import {IVault as IV} from "../interfaces/IVault.sol";
contract Reader {
    IV public v;
    function get() external view returns (uint256) { return v.fee(); }
}`;
const p73 = runProjectPipeline([
  { name: "Vault.sol", text: p73Vault },
  { name: "interfaces/IVault.sol", text: p73Iface },
  { name: "src/Reader.sol", text: p73Reader },
]);
check("project-pass P7-3: alias interface IV → HILANG",
  p73.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p73.candidates.map((c) => c.varName)));
// 24d. P7-4: alias turunan (`VaultV2 as V2`) harus dikenali.
const p74V2 = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract VaultV2 is Vault {
}`;
const p74Reader = `pragma solidity ^0.8.20;
import {VaultV2 as V2} from "./VaultV2.sol";
contract Reader {
    V2 public v;
    function get() external view returns (uint256) { return v.fee(); }
}`;
const p74 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "VaultV2.sol", text: p74V2 },
  { name: "Reader.sol", text: p74Reader },
]);
check("project-pass P7-4: alias turunan V2 → HILANG",
  p74.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p74.candidates.map((c) => c.varName)));
// 24e. P7-5: alias di klausa `is` (`contract Child is V`).
const p75Child = `pragma solidity ^0.8.20;
import {Vault as V} from "./Vault.sol";
contract Child is V {
    function getFee() external view returns (uint256) { return fee; }
}`;
const p75 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p75Child },
]);
check("project-pass P7-5: alias di `is V` → HILANG",
  p75.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p75.candidates.map((c) => c.varName)));
// 24e2. P7-5b: namespace di klausa `is` (`contract Child is NS.Vault`).
const p75bChild = `pragma solidity ^0.8.20;
import * as NS from "./Vault.sol";
contract Child is NS.Vault {
    function getFee() external view returns (uint256) { return fee; }
}`;
const p75b = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p75bChild },
]);
check("project-pass P7-5b: namespace di `is NS.Vault` → HILANG",
  p75b.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p75b.candidates.map((c) => c.varName)));
// 24f. P9a-4 umum: interface mewarisi deklarasi getter dari interface
// leluhur (IFeed is IPrice; IPrice yang mendeklarasi fee()).
const p9a4Price = `pragma solidity ^0.8.20;
interface IPrice {
    function fee() external view returns (uint256);
}`;
const p9a4Feed = `pragma solidity ^0.8.20;
import "./IPrice.sol";
interface IFeed is IPrice {
}`;
const p9a4Owner = `pragma solidity ^0.8.20;
import "./IFeed.sol";
contract PriceFeed is IFeed {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const p9a4Reader = `pragma solidity ^0.8.20;
import "./PriceFeed.sol";
import "./IFeed.sol";
contract Reader {
    IFeed public f;
    function get() external view returns (uint256) { return f.fee(); }
}`;
const p9a4 = runProjectPipeline([
  { name: "PriceFeed.sol", text: p9a4Owner },
  { name: "IFeed.sol", text: p9a4Feed },
  { name: "IPrice.sol", text: p9a4Price },
  { name: "Reader.sol", text: p9a4Reader },
]);
check("project-pass P9a-4: IFeed warisi getter dari IPrice → HILANG",
  p9a4.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9a4.candidates.map((c) => c.varName)));
// 24f2. P9a-4 (kunci, klaim Kiro SALAH): IVault SUDAH drop di kode lama
// via aturan I+nama pemilik — bukan celah.
const p9a4bIFee = `pragma solidity ^0.8.20;
interface IFee {
    function fee() external view returns (uint256);
}`;
const p9a4bIVault = `pragma solidity ^0.8.20;
import "./IFee.sol";
interface IVault is IFee {
}`;
const p9a4bVault = `pragma solidity ^0.8.20;
import "./IVault.sol";
contract Vault is IVault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const p9a4bReader = `pragma solidity ^0.8.20;
import "./Vault.sol";
import "./IVault.sol";
contract Reader {
    IVault public v;
    function get() external view returns (uint256) { return v.fee(); }
}`;
const p9a4b = runProjectPipeline([
  { name: "Vault.sol", text: p9a4bVault },
  { name: "IVault.sol", text: p9a4bIVault },
  { name: "IFee.sol", text: p9a4bIFee },
  { name: "Reader.sol", text: p9a4bReader },
]);
check("project-pass P9a-4 (kunci): IVault = I+Vault → HILANG",
  p9a4b.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9a4b.candidates.map((c) => c.varName)));
// 24g. P9a-6: receiver bertipe kontrak leluhur abstrak yang
// mendeklarasi fee() (FeeBase) — membaca var pemilik.
const p9a6FeeBase = `pragma solidity ^0.8.20;
abstract contract FeeBase {
    function fee() external view virtual returns (uint256);
}`;
const p9a6Vault = `pragma solidity ^0.8.20;
import "./FeeBase.sol";
contract Vault is FeeBase {
    uint256 public override fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const p9a6Reader = `pragma solidity ^0.8.20;
import "./Vault.sol";
import "./FeeBase.sol";
contract Reader {
    FeeBase public f;
    function get() external view returns (uint256) { return f.fee(); }
}`;
const p9a6 = runProjectPipeline([
  { name: "Vault.sol", text: p9a6Vault },
  { name: "FeeBase.sol", text: p9a6FeeBase },
  { name: "Reader.sol", text: p9a6Reader },
]);
check("project-pass P9a-6: receiver FeeBase (leluhur) → HILANG",
  p9a6.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9a6.candidates.map((c) => c.varName)));
// 24h. P9b-4: receiver berupa cast (`VaultV2(a).fee()`).
const p9b4V2 = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract VaultV2 is Vault {
}`;
const p9b4Reader = `pragma solidity ^0.8.20;
import "./Vault.sol";
import "./VaultV2.sol";
contract Reader {
    function get(address a) external view returns (uint256) { return VaultV2(a).fee(); }
}`;
const p9b4 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "VaultV2.sol", text: p9b4V2 },
  { name: "Reader.sol", text: p9b4Reader },
]);
check("project-pass P9b-4: cast VaultV2(a).fee() → HILANG",
  p9b4.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p9b4.candidates.map((c) => c.varName)));
// 24i. P4-10: param event di turunan BUKAN baca — kandidat TETAP.
const p410Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    event FeeSet(uint256 fee);
    function setFee2(uint256 f) external { fee = f; }
}`;
const p410 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p410Child },
]);
check("project-pass P4-10: param event di turunan → TETAP",
  p410.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p410.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p410.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24j. P4-13: param modifier di turunan BUKAN baca — kandidat TETAP.
const p413Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    modifier positive(uint256 fee) { _; }
    function setFee2(uint256 f) external { fee = f; }
}`;
const p413 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p413Child },
]);
check("project-pass P4-13: param modifier di turunan → TETAP",
  p413.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p413.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p413.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24k. P4-11: nama var di dalam string literal BUKAN baca.
const p411Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function setFee2(uint256 f) external { fee = f; require(f < 100, "fee too high"); }
}`;
const p411 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p411Child },
]);
check("project-pass P4-11: string literal di turunan → TETAP",
  p411.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p411.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p411.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24l. P4-12: key named-arg (`Params({fee: 5})`) BUKAN baca.
const p412Lib = `pragma solidity ^0.8.20;
struct Params { uint256 fee; uint256 cap; }`;
const p412Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
import "./Lib.sol";
contract Child is Vault {
    function use() external pure { Params memory p = Params({fee: 5, cap: 2}); }
}`;
const p412 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Lib.sol", text: p412Lib },
  { name: "Child.sol", text: p412Child },
]);
check("project-pass P4-12: key named-arg di turunan → TETAP",
  p412.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p412.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p412.dropped.map((d) => d.varName + ":" + d.readBy)));
// 24m. P4-14: deklarasi lokal SETELAH pemakaian tidak men-shadow
// pemakaian sebelumnya — baca asli tetap dihitung → HILANG.
const p414Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function get() external view returns (uint256) {
        uint256 x = fee;
        (uint256 fee, uint256 cap) = (1, 2);
        return fee;
    }
}`;
const p414 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p414Child },
]);
check("project-pass P4-14: baca sebelum deklarasi lokal → HILANG",
  p414.candidates.filter((c) => c.varName === "fee").length === 0,
  JSON.stringify(p414.candidates.map((c) => c.varName)));
// 24n. P4-5 (kunci, klaim Kiro SALAH): field struct di turunan SUDAH
// keep di kode lama — `scanStateVarDecls` menangkapnya sebagai "var"
// kontrak sehingga cek shadowing rantai menelan seluruh kontrak
// (perilaku konservatif; over-shadow ini batas yang didokumentasikan).
const p45Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    struct Params { uint256 fee; }
    function setFee2(uint256 f) external { fee = f; }
}`;
const p45 = runProjectPipeline([
  { name: "Vault.sol", text: pp24Vault },
  { name: "Child.sol", text: p45Child },
]);
check("project-pass P4-5 (kunci): field struct di turunan → TETAP",
  p45.candidates.filter((c) => c.varName === "fee").length === 1,
  JSON.stringify(p45.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(p45.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 25. Residual (5): struct-field over-shadow (sesi 16:38 WIB 16 Nov).
// scanStateVarDecls kini sadar-struct; analyzeStateVar + cabang inheritance
// project-pass melewati isi blok struct. Residual (7) cast bersarang:
// probe 6 bentuk (1–3 level) SEMUA tertangkap castRe — dikunci di sini
// sebagai TIDAK TERBUKTI (bukan celah).
const r25Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal fee;
    function setFee(uint256 f) external { fee = f; }
}`;
// 25a. Detektor: state var ditulis saja + struct field senama di kontrak
// yang sama → var tetap dead (deklarasi field bukan baca).
const r25a = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal fee;
    struct Params { uint256 fee; address who; }
    function setFee(uint256 f) external { fee = f; }
}`;
const r25aRes = runPipeline(r25a, "r25a.sol");
check("R5 detektor: struct field senama tidak menutupi var dead",
  r25aRes.candidates.filter((c) => c.detector === "dead-config-storage" && c.varName === "fee").length === 1
  && r25aRes.candidates.length === 1,
  JSON.stringify(r25aRes.candidates.map((c) => c.detector + ":" + (c.varName || c.location.function))));
// 25b. Project-pass: turunan membaca var warisan + punya struct field
// senama → baca dikenali → HILANG.
const r25bChild = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    struct Params { uint256 fee; }
    function get() external view returns (uint256) { return fee; }
}`;
const r25b = runProjectPipeline([
  { name: "Vault.sol", text: r25Vault },
  { name: "Child.sol", text: r25bChild },
]);
check("R5 project-pass: baca warisan + struct field senama → HILANG",
  r25b.candidates.filter((c) => c.varName === "fee").length === 0
  && r25b.dropped.some((d) => d.varName === "fee" && /inheritance/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r25b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r25b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 25c. Project-pass: turunan HANYA mengakses `params.fee` (field struct)
// → bukan baca state var → TETAP.
const r25cChild = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    struct Params { uint256 fee; }
    Params public params;
    function get() external view returns (uint256) { return params.fee; }
}`;
const r25c = runProjectPipeline([
  { name: "Vault.sol", text: r25Vault },
  { name: "Child.sol", text: r25cChild },
]);
check("R5 project-pass: akses `params.fee` saja → TETAP",
  r25c.candidates.filter((c) => c.varName === "fee").length === 1 && r25c.dropped.length === 0,
  "kept=" + JSON.stringify(r25c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r25c.dropped.map((d) => d.varName)));
// 25d. Detektor: akses `params.fee` saja (tanpa baca bare) → var tetap dead.
const r25d = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal fee;
    struct Params { uint256 fee; }
    Params public params;
    function setFee(uint256 f) external { fee = f; }
    function get() external view returns (uint256) { return params.fee; }
}`;
const r25dRes = runPipeline(r25d, "r25d.sol");
check("R5 detektor: akses `params.fee` saja → var tetap dead",
  r25dRes.candidates.filter((c) => c.detector === "dead-config-storage" && c.varName === "fee").length === 1,
  JSON.stringify(r25dRes.candidates.map((c) => c.detector + ":" + (c.varName || c.location.function))));
// 25e. Project-pass: struct field di file PEMILIK + turunan membaca var
// warisan → HILANG (struct pemilik tidak merusak indeks proyek).
const r25eVault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal fee;
    struct Params { uint256 fee; }
    function setFee(uint256 f) external { fee = f; }
}`;
const r25eChild = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function get() external view returns (uint256) { return fee; }
}`;
const r25e = runProjectPipeline([
  { name: "Vault.sol", text: r25eVault },
  { name: "Child.sol", text: r25eChild },
]);
check("R5 project-pass: struct di pemilik + baca turunan → HILANG",
  r25e.candidates.filter((c) => c.varName === "fee").length === 0
  && r25e.dropped.some((d) => d.varName === "fee"),
  "kept=" + JSON.stringify(r25e.candidates.map((c) => c.varName)));
// 25f/g. Residual (7) TIDAK TERBUKTI: cast bersarang 2–3 level tertangkap.
for (const [label, expr] of [
  ["2 level", "return Vault(IVault(x)).fee();"],
  ["3 level", "return Vault(IVault(payable(address(x)))).fee();"],
]) {
  const reader = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Reader {
    function get(address x) external view returns (uint256) { ${expr} }
}`;
  const rr = runProjectPipeline([
    { name: "Vault.sol", text: r25Vault },
    { name: "Reader.sol", text: reader },
  ]);
  check("R7 cast bersarang " + label + " → HILANG (getter)",
    rr.candidates.filter((c) => c.varName === "fee").length === 0
    && rr.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
    "kept=" + JSON.stringify(rr.candidates.map((c) => c.varName)));
}

// --- Seksi 26. Kalibrasi lanjutan review Kiro R5: phantom decl dari
// string literal (R5-7b, sesi 16:38 WIB 16 Nov). scanStateVarDecls kini
// mem-mask string sebelum memindai — teks `"uint256 ghost;"` di dalam
// string tidak lagi tertangkap sebagai var dan membayangi rantai.
const r26Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal ghost;
    function setGhost(uint256 g) external { ghost = g; }
}`;
// 26a. Project-pass: string mirip deklarasi + baca warisan → HILANG
// (sebelum kalibrasi: TETAP — phantom "ghost" men-shadow Child).
const r26aChild = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function get() external view returns (uint256) { return ghost; }
    function e() external pure returns (string memory) { return "uint256 ghost;"; }
}`;
const r26a = runProjectPipeline([
  { name: "Vault.sol", text: r26Vault },
  { name: "Child.sol", text: r26aChild },
]);
check("R5-7b project-pass: string mirip deklarasi bukan shadow → HILANG",
  r26a.candidates.filter((c) => c.varName === "ghost").length === 0
  && r26a.dropped.some((d) => d.varName === "ghost" && /inheritance/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r26a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r26a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 26b. Detektor: string mirip deklarasi tidak melahirkan kandidat phantom.
const r26b = `pragma solidity ^0.8.20;
contract Vault {
    uint256 internal fee;
    function setFee(uint256 f) external { fee = f; }
    function e() external pure returns (string memory) { return "uint256 ghost;"; }
}`;
const r26bRes = runPipeline(r26b, "r26b.sol");
check("R5-7b detektor: tidak ada kandidat phantom `ghost` dari string",
  r26bRes.candidates.filter((c) => c.detector === "dead-config-storage").map((c) => c.varName).join() === "fee",
  JSON.stringify(r26bRes.candidates.map((c) => c.detector + ":" + (c.varName || c.location.function))));

// --- Seksi 27. Residual (6): visibilitas import transitif (sesi 20:38 WIB 16 Nov).
// Solidity: import bersifat transitif — file yang mengimpor Mid.sol juga
// melihat simbol global yang Mid.sol impor. Sebelum kalibrasi ini, 3
// bentuk di bawah GAGAL (kandidat TETAP = dead-config FP); kontrol
// rantai-putus harus tetap TETAP (penyempitan dilarang over-broad).
const r27Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const r27Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {}`;
const r27Mid = `pragma solidity ^0.8.20;
import "./Child.sol";
contract Mid { uint256 public x; }`;
// 27a. Turunan transitif: Reader hanya mengimpor Mid.sol, memakai Child.
const r27aReader = `pragma solidity ^0.8.20;
import "./Mid.sol";
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r27a = runProjectPipeline([
  { name: "Vault.sol", text: r27Vault },
  { name: "Child.sol", text: r27Child },
  { name: "Mid.sol", text: r27Mid },
  { name: "Reader.sol", text: r27aReader },
]);
check("R6 project-pass: turunan transitif (Child via Mid) → HILANG",
  r27a.candidates.filter((c) => c.varName === "fee").length === 0
  && r27a.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r27a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r27a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 27b. Alias transitif: import {Child as C} from "./Mid.sol".
const r27bReader = `pragma solidity ^0.8.20;
import {Child as C} from "./Mid.sol";
contract Reader2 {
    C public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r27b = runProjectPipeline([
  { name: "Vault.sol", text: r27Vault },
  { name: "Child.sol", text: r27Child },
  { name: "Mid.sol", text: r27Mid },
  { name: "Reader2.sol", text: r27bReader },
]);
check("R6 project-pass: alias transitif (Child as C via Mid) → HILANG",
  r27b.candidates.filter((c) => c.varName === "fee").length === 0
  && r27b.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r27b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r27b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 27c. Kontrol negatif: rantai putus (Mid2 tak impor Child) → TETAP.
const r27Mid2 = `pragma solidity ^0.8.20;
contract Mid2 { uint256 public x; }`;
const r27cReader = `pragma solidity ^0.8.20;
import "./Mid2.sol";
contract Reader3 {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r27c = runProjectPipeline([
  { name: "Vault.sol", text: r27Vault },
  { name: "Child.sol", text: r27Child },
  { name: "Mid2.sol", text: r27Mid2 },
  { name: "Reader3.sol", text: r27cReader },
]);
check("R6 project-pass: rantai putus (Child tak terlihat) → TETAP",
  r27c.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r27c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r27c.dropped.map((d) => d.varName + ":" + d.readBy)));
// 27d. Interface transitif: IFee hanya terlihat lewat MidI.sol.
const r27Ifee = `pragma solidity ^0.8.20;
interface IFee { function fee() external view returns (uint256); }`;
const r27VaultJ = `pragma solidity ^0.8.20;
import "./IFee.sol";
contract VaultJ is IFee {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const r27MidI = `pragma solidity ^0.8.20;
import "./IFee.sol";
contract MidI { uint256 public x; }`;
const r27dReader = `pragma solidity ^0.8.20;
import "./MidI.sol";
contract Reader4 {
    IFee public f;
    function get() external view returns (uint256) { return f.fee(); }
}`;
const r27d = runProjectPipeline([
  { name: "IFee.sol", text: r27Ifee },
  { name: "VaultJ.sol", text: r27VaultJ },
  { name: "MidI.sol", text: r27MidI },
  { name: "Reader4.sol", text: r27dReader },
]);
check("R6 project-pass: interface transitif (IFee via MidI) → HILANG",
  r27d.candidates.filter((c) => c.varName === "fee").length === 0
  && r27d.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r27d.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r27d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 27e. Rantai 3 hop: Reader → A → B → Child.sol.
const r27B = `pragma solidity ^0.8.20;
import "./Child.sol";
contract B { uint256 public y; }`;
const r27A = `pragma solidity ^0.8.20;
import "./B.sol";
contract A { uint256 public z; }`;
const r27eReader = `pragma solidity ^0.8.20;
import "./A.sol";
contract Reader5 {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r27e = runProjectPipeline([
  { name: "Vault.sol", text: r27Vault },
  { name: "Child.sol", text: r27Child },
  { name: "B.sol", text: r27B },
  { name: "A.sol", text: r27A },
  { name: "Reader5.sol", text: r27eReader },
]);
check("R6 project-pass: rantai 3 hop (Child via A→B) → HILANG",
  r27e.candidates.filter((c) => c.varName === "fee").length === 0
  && r27e.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r27e.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r27e.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 28. Kalibrasi lanjutan wasit atas review Kiro R6 (sesi 20:38 WIB 16 Nov).
// Vonis Kiro "R6 BELUM BERTAHAN" diverifikasi ke kode ASLI (bukan stub):
// - W3a (BARU dari R6) TERBUKTI: remap "@" lolos lewat fallback basename.
// - W5b (pre-R6) TERBUKTI: definisi lokal senama men-shadow nama impor.
// - W2b/W11c (pre-R6) TERBUKTI: path non-relatif gaya Foundry tak ter-resolve.
// - W11d TERBUKTI: string berisi teks import membuat tepi palsu.
// - W6a/W6b (klaim Kiro) ARTEFAK STUB: typeFiles kode asli hanya berisi
//   definisi terverifikasi — alias ke Child palsu SUDAH ditolak; dikunci
//   sebagai kontrol 28f. W4/W8 (NS.Child, cast) SUDAH benar di kode asli.
// Catatan fixture: pembaca ditaruh di app/ (bukan test/) karena P3
// melewati file test/mock sebagai pembaca.
const r28Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const r28Child = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {}`;
const r28Mid = `pragma solidity ^0.8.20;
import "./Child.sol";
contract Mid { uint256 public x; }`;
// 28a. W3a: remap "@" via closure → TETAP (tidak ada tepi dari "@").
const r28MidR = `pragma solidity ^0.8.20;
import "@app/Child.sol";
contract MidR { uint256 public x; }`;
const r28aReader = `pragma solidity ^0.8.20;
import "./MidR.sol";
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28a = runProjectPipeline([
  { name: "Vault.sol", text: r28Vault },
  { name: "Child.sol", text: r28Child },
  { name: "MidR.sol", text: r28MidR },
  { name: "Reader.sol", text: r28aReader },
]);
check("R6 wasit W3a: remap @ via closure → TETAP",
  r28a.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r28a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r28a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 28b. W5b: definisi lokal Child (bukan turunan) men-shadow → TETAP.
const r28bReader = `pragma solidity ^0.8.20;
import {Mid} from "./Mid.sol";
contract Child {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28b = runProjectPipeline([
  { name: "Vault.sol", text: r28Vault },
  { name: "Child.sol", text: r28Child },
  { name: "Mid.sol", text: r28Mid },
  { name: "Reader.sol", text: r28bReader },
]);
check("R6 wasit W5b: shadow lokal Child bukan turunan → TETAP",
  r28b.candidates.filter((c) => c.varName === "fee" && c.location.file === "Vault.sol").length === 1,
  "kept=" + JSON.stringify(r28b.candidates.map((c) => c.varName + "@" + c.location.file))
  + " dropped=" + JSON.stringify(r28b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 28c. W2b: path non-relatif gaya Foundry (root korpus) → HILANG.
const r28FakeChild = `pragma solidity ^0.8.20;
contract Child { uint256 public fee; }`;
const r28SrcChild = `pragma solidity ^0.8.20;
import "../Vault.sol";
contract Child is Vault {}`;
const r28SrcMid = `pragma solidity ^0.8.20;
import "src/Child.sol";
contract Mid { uint256 public x; }`;
const r28cReader = `pragma solidity ^0.8.20;
import "../src/Mid.sol";
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28c = runProjectPipeline([
  { name: "lib/Child.sol", text: r28FakeChild },
  { name: "src/Vault.sol", text: r28Vault },
  { name: "src/Child.sol", text: r28SrcChild },
  { name: "src/Mid.sol", text: r28SrcMid },
  { name: "app/Reader.sol", text: r28cReader },
]);
check("R6 wasit W2b: import non-relatif root korpus → HILANG",
  r28c.candidates.filter((c) => c.varName === "fee").length === 0
  && r28c.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r28c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r28c.dropped.map((d) => d.varName + ":" + d.readBy)));
// 28d. W11c: alias path non-relatif → HILANG.
const r28dReader = `pragma solidity ^0.8.20;
import {Child as C} from "src/Mid.sol";
contract Reader {
    C public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28d = runProjectPipeline([
  { name: "src/Vault.sol", text: r28Vault },
  { name: "src/Child.sol", text: r28SrcChild },
  { name: "src/Mid.sol", text: r28SrcMid },
  { name: "app/Reader.sol", text: r28dReader },
]);
check("R6 wasit W11c: alias path non-relatif → HILANG",
  r28d.candidates.filter((c) => c.varName === "fee").length === 0
  && r28d.dropped.some((d) => d.varName === "fee" && /getter/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r28d.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r28d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 28e. W11d: string berisi teks import → bukan tepi → TETAP.
const r28Doc = `pragma solidity ^0.8.20;
contract Doc {
    string public d = 'import "./Child.sol";';
}`;
const r28eReader = `pragma solidity ^0.8.20;
import "./Doc.sol";
contract Reader {
    Child public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28e = runProjectPipeline([
  { name: "Vault.sol", text: r28Vault },
  { name: "Child.sol", text: r28Child },
  { name: "Doc.sol", text: r28Doc },
  { name: "Reader.sol", text: r28eReader },
]);
check("R6 wasit W11d: string berisi teks import → TETAP",
  r28e.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r28e.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r28e.dropped.map((d) => d.varName + ":" + d.readBy)));
// 28f. Kontrol W6b (artefak stub): alias via perantara yang impor
// Child palsu → TETAP (typeFiles hanya berisi definisi terverifikasi).
const r28Other = `pragma solidity ^0.8.20;
contract Child { uint256 public fee; }`;
const r28Other2 = `pragma solidity ^0.8.20;
import "./Other.sol";
contract Other2 { uint256 public y; }`;
const r28fReader = `pragma solidity ^0.8.20;
import {Child as C} from "./Other2.sol";
contract Reader {
    C public c;
    function get() external view returns (uint256) { return c.fee(); }
}`;
const r28f = runProjectPipeline([
  { name: "Vault.sol", text: r28Vault },
  { name: "Child.sol", text: r28Child },
  { name: "Other.sol", text: r28Other },
  { name: "Other2.sol", text: r28Other2 },
  { name: "Reader.sol", text: r28fReader },
]);
check("R6 wasit W6b (kontrol): alias via perantara palsu → TETAP",
  r28f.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r28f.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r28f.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 29. Residual (8): wrapper transitif belum terindeks (sesi 00:38 WIB 17 Nov).
// Probe membuktikan 5 bentuk baca lewat wrapper TETAP sebagai dead-config
// (false positive): wrapper internal file-sama, return interface, wrapper
// di base yang diwarisi, wrapper berantai, wrapper via member call.
// Perbaikan: collectWrappers (return type tipe pemilik + bukti badan:
// this / cast tipe pemilik / identifier bertipe pemilik / rantai wrapper)
// + pola (a2) `getVault().fee()` kind=wrapper + gerbang relevansi mengakui
// file pemilik yang terlihat transitif lewat closure import.
const r29Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
// 29a. Wrapper internal di file pembaca → HILANG (kind=wrapper).
const r29aReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    function getVault() internal view returns (Vault) { return vault; }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29a = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Reader.sol", text: r29aReader },
]);
check("R8 wrapper internal file-sama → HILANG (wrapper)",
  r29a.candidates.filter((c) => c.varName === "fee").length === 0
  && r29a.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29b. Wrapper return interface IVault → HILANG.
const r29IVault = `pragma solidity ^0.8.20;
interface IVault { function fee() external view returns (uint256); }`;
const r29bReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {IVault} from "./IVault.sol";
contract Reader {
    Vault private vault;
    function getVault() internal view returns (IVault) { return IVault(address(vault)); }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29b = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "IVault.sol", text: r29IVault },
  { name: "Reader.sol", text: r29bReader },
]);
check("R8 wrapper return interface → HILANG",
  r29b.candidates.filter((c) => c.varName === "fee").length === 0
  && r29b.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29c. Wrapper di base contract, pembaca mewarisi base → HILANG.
const r29Base = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Base {
    Vault internal vault;
    function getVault() internal view returns (Vault) { return vault; }
}`;
const r29cReader = `pragma solidity ^0.8.20;
import {Base} from "./Base.sol";
contract Reader is Base {
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29c = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Base.sol", text: r29Base },
  { name: "Reader.sol", text: r29cReader },
]);
check("R8 wrapper di base (inherited) → HILANG",
  r29c.candidates.filter((c) => c.varName === "fee").length === 0
  && r29c.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29c.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29d. Kontrol: wrapper return tipe TAK TERKAIT → TETAP.
const r29Other = `pragma solidity ^0.8.20;
contract Other { uint256 public fee; }`;
const r29dReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {Other} from "./Other.sol";
contract Reader {
    Other private other;
    function getOther() internal view returns (Other) { return other; }
    function readFee() external view returns (uint256) { return getOther().fee(); }
}`;
const r29d = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Other.sol", text: r29Other },
  { name: "Reader.sol", text: r29dReader },
]);
check("R8 kontrol wrapper unrelated → TETAP",
  r29d.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r29d.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29e. Wrapper berantai (getVault return vaultOf()) → HILANG.
const r29eReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    function vaultOf() internal view returns (Vault) { return vault; }
    function getVault() internal view returns (Vault) { return vaultOf(); }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29e = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Reader.sol", text: r29eReader },
]);
check("R8 wrapper berantai → HILANG",
  r29e.candidates.filter((c) => c.varName === "fee").length === 0
  && r29e.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29e.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29e.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29f. Wrapper via member call (helper.getVault().fee()) → HILANG.
const r29Helper = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Helper {
    Vault private vault;
    function getVault() external view returns (Vault) { return vault; }
}`;
const r29fReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {Helper} from "./Helper.sol";
contract Reader {
    Helper private helper;
    function readFee() external view returns (uint256) { return helper.getVault().fee(); }
}`;
const r29f = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Helper.sol", text: r29Helper },
  { name: "Reader.sol", text: r29fReader },
]);
check("R8 wrapper via member → HILANG",
  r29f.candidates.filter((c) => c.varName === "fee").length === 0
  && r29f.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29f.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29f.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29g. Ambiguitas: nama wrapper senama, satu definisi return tipe lain
// dalam jangkauan → TETAP (konservatif).
const r29GoodLib = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract GoodLib {
    Vault private vault;
    function getVault() internal view returns (Vault) { return vault; }
}`;
const r29BadLib = `pragma solidity ^0.8.20;
import {Other} from "./Other.sol";
contract BadLib {
    Other private other;
    function getVault() internal view returns (Other) { return other; }
}`;
const r29gReader = `pragma solidity ^0.8.20;
import {GoodLib} from "./GoodLib.sol";
import {BadLib} from "./BadLib.sol";
contract Reader is GoodLib, BadLib {
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29g = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Other.sol", text: r29Other },
  { name: "GoodLib.sol", text: r29GoodLib },
  { name: "BadLib.sol", text: r29BadLib },
  { name: "Reader.sol", text: r29gReader },
]);
check("R8 wrapper ambigu (definisi senama tipe lain) → TETAP",
  r29g.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r29g.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29g.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29h. Wrapper `return this;` di file pemilik → HILANG via v.self().fee().
const r29VaultSelf = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
    function self() external view returns (Vault) { return this; }
}`;
const r29hReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault public v;
    function readFee() external view returns (uint256) { return v.self().fee(); }
}`;
const r29h = runProjectPipeline([
  { name: "Vault.sol", text: r29VaultSelf },
  { name: "Reader.sol", text: r29hReader },
]);
check("R8 wrapper return this → HILANG",
  r29h.candidates.filter((c) => c.varName === "fee").length === 0
  && r29h.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r29h.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29h.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29i. Wrapper tanpa bukti badan (ternary) → TETAP.
const r29iReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    bool public cond;
    function getVault() internal view returns (Vault) { return cond ? vault : Vault(address(0)); }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29i = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Reader.sol", text: r29iReader },
]);
check("R8 wrapper tanpa bukti badan (ternary) → TETAP",
  r29i.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r29i.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29i.dropped.map((d) => d.varName + ":" + d.readBy)));
// 29j. Wrapper di file yang TIDAK diimpor pembaca → TETAP.
const r29jReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r29j = runProjectPipeline([
  { name: "Vault.sol", text: r29Vault },
  { name: "Helper.sol", text: r29Helper },
  { name: "Reader.sol", text: r29jReader },
]);
check("R8 wrapper di luar jangkauan import → TETAP",
  r29j.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r29j.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r29j.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 30. Review wasit R8 (pengganti pass Kiro — login Kiro Web
// kedaluwarsa 00:52 WIB 17 Nov, browser task 1f7c63f7 GAGAL sign-in;
// review adversarial dijalankan jack-wasit lokal, 13 kasus W-A..W-N).
// Temuan awal 9/13 → kalibrasi lanjutan R8.1: assembly return (W-A),
// alias pada deklarasi state var (W-H), tuple unwrap (W-L), scoping
// typed-set via ownerTypedStateVars: state var kontrak + leluhur (W-N),
// lokal fungsi lain BUKAN bukti (W-J). Sesudah R8.1: 13/13.
const r30Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
// 30a. W-A: wrapper return via assembly -> HILANG.
const r30aReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    function getVault() internal view returns (Vault) {
        assembly { mstore(0x00, sload(vault.slot)) return(0x00, 0x20) }
    }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30a = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Reader.sol", text: r30aReader },
]);
check("R8.1 W-A assembly return → HILANG",
  r30a.candidates.filter((c) => c.varName === "fee").length === 0
  && r30a.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30b. W-H: state var dideklarasi via alias (V private vault) -> HILANG.
const r30bReader = `pragma solidity ^0.8.20;
import {Vault as V} from "./Vault.sol";
contract Reader {
    V private vault;
    function getVault() internal view returns (V) { return vault; }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30b = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Reader.sol", text: r30bReader },
]);
check("R8.1 W-H alias pada deklarasi state var → HILANG",
  r30b.candidates.filter((c) => c.varName === "fee").length === 0
  && r30b.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30c. W-J2: lokal `vault` di fungsi lain (tanpa baca fee) BUKAN bukti -> TETAP.
const r30cReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private v2;
    function other() internal view returns (uint256) { Vault vault = v2; return 1; }
    function getVault() internal view returns (Vault) { return vault; }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30c = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Reader.sol", text: r30cReader },
]);
check("R8.1 W-J lokal fungsi lain bukan bukti → TETAP",
  r30c.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r30c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30c.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30d. W-L: wrapper return tuple (Vault, uint256) -> HILANG.
const r30dReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Reader {
    Vault private vault;
    function getVault() internal view returns (Vault, uint256) { return (vault, 1); }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30d = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Reader.sol", text: r30dReader },
]);
check("R8.1 W-L return tuple → HILANG",
  r30d.candidates.filter((c) => c.varName === "fee").length === 0
  && r30d.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30d.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30e. W-N: wrapper return state var WARISAN -> HILANG.
const r30Base = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Base {
    Vault internal vault;
}`;
const r30eReader = `pragma solidity ^0.8.20;
import {Base} from "./Base.sol";
contract Reader is Base {
    function getVault() internal view returns (Vault) { return vault; }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30e = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Base.sol", text: r30Base },
  { name: "Reader.sol", text: r30eReader },
]);
check("R8.1 W-N state var warisan → HILANG",
  r30e.candidates.filter((c) => c.varName === "fee").length === 0
  && r30e.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30e.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30e.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30f. W-M: `return helper.vault;` (akses member, tanpa call) — batas -> TETAP.
const r30Helper = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Helper {
    Vault public vault;
}`;
const r30fReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {Helper} from "./Helper.sol";
contract Reader {
    Helper private helper;
    function getVault() internal view returns (Vault) { return helper.vault; }
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30f = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Helper.sol", text: r30Helper },
  { name: "Reader.sol", text: r30fReader },
]);
check("R8.1 W-M return member (batas) → TETAP",
  r30f.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r30f.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30f.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30g. W-K: wrapper return super.getVault() -> HILANG.
const r30gBase = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
contract Base {
    Vault internal vault;
    function getVault() internal view virtual returns (Vault) { return vault; }
}`;
const r30gChild = `pragma solidity ^0.8.20;
import {Base} from "./Base.sol";
import {Vault} from "./Vault.sol";
contract Child is Base {
    function getVault() internal view override returns (Vault) { return super.getVault(); }
}`;
const r30gReader = `pragma solidity ^0.8.20;
import {Child} from "./Child.sol";
contract Reader is Child {
    function readFee() external view returns (uint256) { return getVault().fee(); }
}`;
const r30g = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Base.sol", text: r30gBase },
  { name: "Child.sol", text: r30gChild },
  { name: "Reader.sol", text: r30gReader },
]);
check("R8.1 W-K super.getVault() → HILANG",
  r30g.candidates.filter((c) => c.varName === "fee").length === 0
  && r30g.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30g.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30g.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30h. W-D: wrapper di library -> HILANG.
const r30Lib = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
library Lib {
    function getVault(Vault v) internal pure returns (Vault) { return v; }
}`;
const r30hReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {Lib} from "./Lib.sol";
contract Reader {
    Vault private vault;
    function readFee() external view returns (uint256) { return Lib.getVault(vault).fee(); }
}`;
const r30h = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Lib.sol", text: r30Lib },
  { name: "Reader.sol", text: r30hReader },
]);
check("R8.1 W-D wrapper di library → HILANG",
  r30h.candidates.filter((c) => c.varName === "fee").length === 0
  && r30h.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30h.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30h.dropped.map((d) => d.varName + ":" + d.readBy)));
// 30i. W-I: wrapper free function (di luar kontrak) -> HILANG.
const r30Free = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
function getVault(Vault v) pure returns (Vault) { return v; }`;
const r30iReader = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";
import {getVault} from "./Free.sol";
contract Reader {
    Vault private vault;
    function readFee() external view returns (uint256) { return getVault(vault).fee(); }
}`;
const r30i = runProjectPipeline([
  { name: "Vault.sol", text: r30Vault },
  { name: "Free.sol", text: r30Free },
  { name: "Reader.sol", text: r30iReader },
]);
check("R8.1 W-I free function wrapper → HILANG",
  r30i.candidates.filter((c) => c.varName === "fee").length === 0
  && r30i.dropped.some((d) => d.varName === "fee" && /\(wrapper\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r30i.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r30i.dropped.map((d) => d.varName + ":" + d.readBy)));

const { scoreProgram, gateProgram, routeProgram, dedupePrograms, intakeRun,
  knownPrograms, renderIntakeCard, renderIntakeReport } = require("../app/intake.js");
const NOW31 = "2026-11-17T04:38:00+07:00";
function baseProg(over) {
  return Object.assign({
    id: "test:prog", name: "Test Program", platform: "Test",
    source: "directory", policy_url: "https://example.com/security",
    invites_testing: true, pays_bounty: true,
    scope_assets: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    out_of_scope: [], excluded_tests: [],
    freshness: "2026-11-16", status: "candidate",
    rewardMaxUsd: 50000, responseHealth: 0.6, competition: "medium",
    surfaceFit: 0.9, assetNovelty: 0.5,
    reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
    automatedTestingAllowed: true,
    loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
    securityTxt: false, securityTxtOnly: false,
    surfaces: ["evm-solidity"],
  }, over || {});
}
// 31a. Skoring: bobot × sub-skor = total; Cronos 84,0 di 17 Nov.
const s31a = scoreProgram(baseProg(), NOW31);
check("31a skor = jumlah bobot×sub (Cronos-like 84,0)",
  s31a.score === 84 && s31a.dropped.length === 0,
  "dapat " + s31a.score + " dropped=" + JSON.stringify(s31a.dropped));
check("31a breakdown scope 1,0 / payout 0,8 / freshness 1,0",
  s31a.breakdown.scope === 1 && s31a.breakdown.payout === 0.8
  && s31a.breakdown.freshness === 1,
  JSON.stringify(s31a.breakdown));
// 31b. Sub-skor scope: 0 aset → 0; 1-2 → 0,4; 3-9 → 0,7; ≥10 → 1,0.
check("31b scope 0 aset → 0",
  scoreProgram(baseProg({ scope_assets: [] }), NOW31).breakdown.scope === 0);
check("31b scope 2 aset → 0,4",
  scoreProgram(baseProg({ scope_assets: ["A", "B"] }), NOW31).breakdown.scope === 0.4);
check("31b scope 5 aset → 0,7",
  scoreProgram(baseProg({ scope_assets: ["A", "B", "C", "D", "E"] }), NOW31).breakdown.scope === 0.7);
check("31b scopeAssetCount 103 → 1,0",
  scoreProgram(baseProg({ scope_assets: ["g1"], scopeAssetCount: 103 }), NOW31).breakdown.scope === 1);
// 31c. Sub-skor payout: band + reward tak diketahui → 0,3; pays false → 0.
check("31c payout 500 rb → 1,0",
  scoreProgram(baseProg({ rewardMaxUsd: 500000 }), NOW31).breakdown.payout === 1);
check("31c payout tak diketahui → 0,3",
  scoreProgram(baseProg({ rewardMaxUsd: null }), NOW31).breakdown.payout === 0.3);
check("31c pays_bounty false → 0",
  scoreProgram(baseProg({ pays_bounty: false }), NOW31).breakdown.payout === 0);
// 31d. Sub-skor freshness: ≤7 hari → 1,0; 8-30 → 0,8; 91-180 → 0,3; tak ada → 0,2.
check("31d freshness 1 hari → 1,0",
  scoreProgram(baseProg({ freshness: "2026-11-16" }), NOW31).breakdown.freshness === 1);
check("31d freshness 20 hari → 0,8",
  scoreProgram(baseProg({ freshness: "2026-10-28" }), NOW31).breakdown.freshness === 0.8);
check("31d freshness 100 hari → 0,3",
  scoreProgram(baseProg({ freshness: "2026-08-09" }), NOW31).breakdown.freshness === 0.3);
check("31d freshness tak ada → 0,2",
  scoreProgram(baseProg({ freshness: null }), NOW31).breakdown.freshness === 0.2);
// 31e. Drop filter: tiap alasan berdiri sendiri.
check("31e drop: invites false",
  scoreProgram(baseProg({ invites_testing: false }), NOW31).dropped
    .some((r) => /undangan/.test(r)));
check("31e drop: scope kosong tanpa security.txt",
  scoreProgram(baseProg({ scope_assets: [] }), NOW31).dropped
    .some((r) => /scope kosong/.test(r)));
check("31e TIDAK drop: scope kosong TAPI security.txt ada",
  scoreProgram(baseProg({ scope_assets: [], securityTxt: true }), NOW31).dropped.length === 0);
check("31e drop: RoE larang otomatis",
  scoreProgram(baseProg({ automatedTestingAllowed: false }), NOW31).dropped
    .some((r) => /RoE melarang/.test(r)));
check("31e drop: blacklisted",
  scoreProgram(baseProg({ status: "blacklisted" }), NOW31).dropped
    .some((r) => /blacklisted/.test(r)));
check("31e drop: excluded-tests melarang semua teknik",
  scoreProgram(baseProg({ excluded_tests: ["all automated testing"] }), NOW31).dropped
    .some((r) => /semua teknik/.test(r)));
check("31e TIDAK drop: excluded-tests hanya mainnet",
  scoreProgram(baseProg({ excluded_tests: ["mainnet testing"] }), NOW31).dropped.length === 0);
check("31e drop: deadline lewat",
  scoreProgram(baseProg({ deadline: "2026-11-01" }), NOW31).dropped
    .some((r) => /deadline/.test(r)));
// 31f. Gate: mode auto + semua tes lolos → LAYAK.
check("31f gate auto semua-lolos → LAYAK",
  gateProgram(baseProg(), "auto").verdict === "LAYAK");
// 31g. Gate: mode strict + semua tes lolos → KONFIRMASI (v10: strict = human-confirm).
check("31g gate strict semua-lolos → KONFIRMASI",
  gateProgram(baseProg(), "strict").verdict === "KONFIRMASI");
// 31h. Gate: ambiguitas (izin agentic unknown) → KONFIRMASI, bukan LAYAK.
check("31h gate auto izin-agentic unknown → KONFIRMASI",
  gateProgram(baseProg({ automatedTestingAllowed: "unknown" }), "auto").verdict === "KONFIRMASI");
// 31i. Gate: privat/invite-only → TOLAK.
check("31i gate privat → TOLAK",
  gateProgram(baseProg({ privateOrInviteOnly: true }), "auto").verdict === "TOLAK");
check("31i gate login-wall → TOLAK",
  gateProgram(baseProg({ loginToSeePolicy: true }), "auto").verdict === "TOLAK");
check("31i gate scope kosong → TOLAK",
  gateProgram(baseProg({ scope_assets: [] }), "auto").verdict === "TOLAK");
check("31i gate RoE larang otomatis → TOLAK",
  gateProgram(baseProg({ automatedTestingAllowed: false }), "auto").verdict === "TOLAK");
// 31j. Gate: security.txt tanpa undangan eksplisit → KONFIRMASI (matriks v10).
check("31j gate security.txt-only → KONFIRMASI",
  gateProgram(baseProg({ invites_testing: "unknown", securityTxt: true,
    securityTxtOnly: true }), "auto").verdict === "KONFIRMASI");
// 31k. Gate: mode paused → KONFIRMASI apa pun.
check("31k gate paused → KONFIRMASI",
  gateProgram(baseProg(), "paused").verdict === "KONFIRMASI");
// 31l. Routing: permukaan → detektor + antrean + baseline.
const r31l = routeProgram(baseProg({ surfaces: ["evm-solidity", "defi-lending"],
  queue: "cronos-zkevm", baseline: "GMX v1" }));
check("31l route evm-solidity → all-17 + antrean + baseline",
  r31l.detectors === "all-17" && r31l.queue === "cronos-zkevm" && r31l.baseline === "GMX v1",
  JSON.stringify(r31l));
const r31l2 = routeProgram(baseProg({ surfaces: ["bridge"], queue: "x" }));
check("31l route bridge → detektor bridge (tanpa all-17)",
  Array.isArray(r31l2.detectors) && r31l2.detectors.includes("eth-locked-receive")
  && r31l2.detectors.includes("tx-origin"),
  JSON.stringify(r31l2.detectors));
// 31m. Dedupe: baru / re-open bila policyHash berubah / lewati bila sama / blacklist.
const d31m = dedupePrograms(
  [{ id: "a:x", policyHash: "h1", status: "candidate" },
   { id: "a:y", policyHash: "h1", status: "blacklisted" }],
  [baseProg({ id: "a:x", policyHash: "h2" }),
   baseProg({ id: "a:y", policyHash: "h1" }),
   baseProg({ id: "a:z", policyHash: "h1" }),
   baseProg({ id: "a:x", policyHash: "h1" })]);
check("31m dedupe: re-open / blacklist-skip / baru / sama-skip",
  d31m.reopened.length === 1 && d31m.reopened[0].program.id === "a:x"
  && d31m.added.length === 1 && d31m.added[0].id === "a:z"
  && d31m.skipped.length === 2,
  "added=" + d31m.added.map((p) => p.id) + " reopened=" + d31m.reopened.map((r) => r.program.id)
  + " skipped=" + d31m.skipped.map((s) => s.program.id));
// 31n. Intake run atas daftar yang dikenal (mode auto, now 17 Nov):
// RAAC 86,3 > Cronos 84,0 > Nado 78,0; Kiln/Tokenize/VeChain drop (bukan blacklist).
const run31 = intakeRun(knownPrograms(), [], { mode: "auto", now: NOW31 });
const byId31 = {};
for (const r of run31.results) byId31[r.id] = r;
check("31n intake auto: RAAC 86,3 / Cronos 84,0 / Nado 78,0",
  byId31["guardian:raac"].score === 86.3
  && byId31["hackenproof:cronos-zkevm"].score === 84
  && byId31["hackenproof:nado"].score === 78,
  run31.results.map((r) => r.id + "=" + r.score).join(", "));
check("31n intake auto: Cronos + RAAC LAYAK; Nado + Aktionariat KONFIRMASI",
  byId31["hackenproof:cronos-zkevm"].gate.verdict === "LAYAK"
  && byId31["guardian:raac"].gate.verdict === "LAYAK"
  && byId31["hackenproof:nado"].gate.verdict === "KONFIRMASI"
  && byId31["selfhosted:aktionariat"].gate.verdict === "KONFIRMASI",
  run31.results.map((r) => r.id + "=" + r.gate.verdict).join(", "));
check("31n intake: Kiln/Tokenize/VeChain DROP (scope belum terverifikasi), BUKAN blacklist",
  run31.dropped.length === 3
  && run31.dropped.every((r) => /scope kosong/.test(r.dropped.join(" ")))
  && run31.blacklisted.length === 0,
  "dropped=" + run31.dropped.map((r) => r.id) + " blacklist=" + run31.blacklisted.map((r) => r.id));
check("31n intake: ranked urut skor menurun, RAAC pertama",
  run31.ranked[0].id === "guardian:raac" && run31.ranked.length === 4,
  run31.ranked.map((r) => r.id + "=" + r.score).join(", "));
check("31n intake: Nado bawa catatan gerbang reputasi (bukan tes gate)",
  byId31["hackenproof:nado"].notes.some((n) => /gerbang reputasi ≥100/.test(n)),
  JSON.stringify(byId31["hackenproof:nado"].notes));
// 31o. Intake strict (default): semua-lolos → KONFIRMASI, bukan LAYAK.
const run31o = intakeRun(knownPrograms(), [], { now: NOW31 });
check("31o intake strict: Cronos KONFIRMASI (mode strict)",
  run31o.results.find((r) => r.id === "hackenproof:cronos-zkevm").gate.verdict === "KONFIRMASI");
// 31p. Render kartu: memuat nama + skor + vonis + alasan gate + routing.
const card31 = renderIntakeCard(byId31["hackenproof:cronos-zkevm"]);
check("31p render kartu memuat nama/skor/vonis/routing",
  card31.includes("Cronos zkEVM") && card31.includes("84")
  && card31.includes("LAYAK") && card31.includes("cronos-zkevm")
  && card31.includes("GMX v1"),
  card31.slice(0, 200));
const rep31 = renderIntakeReport(run31);
check("31p render laporan memuat ringkasan intake",
  rep31.includes("4 lolos ke antrean") && rep31.includes("3 drop di qualifier"),
  rep31.slice(0, 200));

// --- Seksi 32. Kalibrasi R1 intake.js (review Kiro Opus 4.8, sesi 04:38 WIB 17 Nov).
// Vonis Kiro 95/99; wasit: P1/P2/P3/P4/P7/P8 TERBUKTI di kode asli → diperbaiki;
// P6 DITOLAK (angka Kiro dari pemetaan fixture tak lengkap — skor kode 60,8/34,0/34,0
// terverifikasi ulang di sini); P5/P10/P11 ditangani via dokumentasi + flag.
const { scopeCount, isBlanketBan, blanketExcluded } = require("../app/intake.js");
// 32a. P1: scope hanya lewat scopeAssetCount → skor 1,0 DAN gate LAYAK, TIDAK drop.
const p32a = baseProg({ scope_assets: [], scopeAssetCount: 40 });
check("32a P1 scopeAssetCount=40 tanpa scope_assets → skor 1,0 + gate LAYAK + tidak drop",
  scoreProgram(p32a, NOW31).breakdown.scope === 1
  && gateProgram(p32a, "auto").verdict === "LAYAK"
  && scoreProgram(p32a, NOW31).dropped.length === 0,
  "scope=" + scoreProgram(p32a, NOW31).breakdown.scope
  + " gate=" + gateProgram(p32a, "auto").verdict
  + " dropped=" + JSON.stringify(scoreProgram(p32a, NOW31).dropped));
check("32a P1 scopeCount kanonik = 40",
  scopeCount(p32a) === 40 && scopeCount(baseProg({ scope_assets: ["A"] })) === 1);
// 32b. P2: scope kosong + securityTxt → gate KONFIRMASI (bukan TOLAK), tidak drop,
// masuk ranked (KONFIRMASI), TIDAK masuk blacklist; alasan "scope belum terurai" hidup (P9).
const p32b = baseProg({ scope_assets: [], securityTxt: true });
const g32b = gateProgram(p32b, "auto");
check("32b P2 scope kosong + securityTxt → gate KONFIRMASI + alasan scope belum terurai",
  g32b.verdict === "KONFIRMASI" && g32b.reasons.some((r) => /scope belum terurai/.test(r)),
  g32b.verdict + " | " + JSON.stringify(g32b.reasons));
check("32b P2 qualifier TIDAK drop (securityTxt ada)",
  scoreProgram(p32b, NOW31).dropped.length === 0);
const run32b = intakeRun([p32b], [], { mode: "auto", now: NOW31 });
check("32b P2 intakeRun: ranked 1, blacklist 0",
  run32b.ranked.length === 1 && run32b.blacklisted.length === 0,
  "ranked=" + run32b.ranked.length + " blacklist=" + run32b.blacklisted.length);
// 32c. P2 negatif: scope kosong TANPA securityTxt → tetap TOLAK + drop, bukan blacklist.
const p32c = baseProg({ scope_assets: [] });
check("32c P2 scope kosong tanpa securityTxt → gate TOLAK + drop",
  gateProgram(p32c, "auto").verdict === "TOLAK"
  && scoreProgram(p32c, NOW31).dropped.length === 1);
const run32c = intakeRun([p32c], [], { mode: "auto", now: NOW31 });
check("32c P2 intakeRun: dropped 1, blacklist 0 (drop ≠ blacklist)",
  run32c.dropped.length === 1 && run32c.blacklisted.length === 0);
// 32d. P3: substring blanket — "casino/install/firewall/arduino testing" +
// "no testing on prod" TIDAK blanket; "no testing"/"all testing"/"all testing is prohibited" YA.
for (const t of ["casino testing", "install testing", "firewall testing",
  "arduino testing", "no testing on prod"]) {
  check("32d P3 '" + t + "' BUKAN blanket",
    blanketExcluded({ excluded_tests: [t] }) === false);
}
for (const t of ["no testing", "all testing", "all testing is prohibited",
  "all automated testing"]) {
  check("32d P3 '" + t + "' = blanket",
    blanketExcluded({ excluded_tests: [t] }) === true);
}
check("32d P3 isBlanketBan langsung",
  isBlanketBan("no testing") === true && isBlanketBan("no testing on prod") === false
  && isBlanketBan("casino testing") === false);
check("32d P3 larang SEMUA teknik tetap blanket",
  blanketExcluded({ excluded_tests: ["automated scanning", "static analysis",
    "fork testing", "fuzzing"] }) === true);
check("32d P3 larang 3 dari 4 teknik BUKAN blanket",
  blanketExcluded({ excluded_tests: ["automated scanning", "static analysis",
    "fork testing"] }) === false);
// 32e. P4: blacklisted + policyHash berubah → re-open (wasBlacklisted);
// blacklisted + hash sama → tetap skip.
const d32e = dedupePrograms(
  [{ id: "b:x", policyHash: "h1", status: "blacklisted" },
   { id: "b:y", policyHash: "h1", status: "blacklisted" }],
  [baseProg({ id: "b:x", policyHash: "h2" }),
   baseProg({ id: "b:y", policyHash: "h1" })]);
check("32e P4 blacklisted + hash berubah → re-open (wasBlacklisted)",
  d32e.reopened.length === 1 && d32e.reopened[0].wasBlacklisted === true
  && d32e.skipped.length === 1,
  "reopened=" + d32e.reopened.length + " skipped=" + d32e.skipped.length);
// 32f. P5: unknownFields — field default tercatat; Cronos (semua terisi) kosong.
const s32f = scoreProgram(baseProg({ surfaceFit: undefined, responseHealth: undefined,
  freshness: null, rewardMaxUsd: null }), NOW31);
check("32f P5 unknownFields memuat fit/respons/freshness/payout",
  s32f.unknownFields.includes("fit") && s32f.unknownFields.includes("respons")
  && s32f.unknownFields.includes("freshness") && s32f.unknownFields.includes("payout"),
  JSON.stringify(s32f.unknownFields));
check("32f P5 Cronos dikenal → unknownFields kosong",
  scoreProgram(knownPrograms().find((p) => p.id === "hackenproof:cronos-zkevm"), NOW31)
    .unknownFields.length === 0);
// 32g. P7: freshness masa depan → 0,2 (bukan 1,0).
check("32g P7 freshness 2027-01-01 → 0,2",
  scoreProgram(baseProg({ freshness: "2027-01-01" }), NOW31).breakdown.freshness === 0.2);
// 32h. P8: paused + sinyal terlarang → TOLAK; paused + bersih → KONFIRMASI.
check("32h P8 paused + doNotTest → TOLAK",
  gateProgram(baseProg({ doNotTest: true }), "paused").verdict === "TOLAK");
check("32h P8 paused + invites false → TOLAK",
  gateProgram(baseProg({ invites_testing: false }), "paused").verdict === "TOLAK");
check("32h P8 paused + bersih → KONFIRMASI (bukan LAYAK)",
  gateProgram(baseProg(), "paused").verdict === "KONFIRMASI");
// 32i. P6 (DITOLAK sebagai bug kode): skor code-level atas knownPrograms tetap
// Kiln 60,8 / Tokenize.it 34,0 / VeChain 34,0 — angka Kiro 55,0/29,0 berasal
// dari pemetaan fixture tak lengkap (fit/novelty di-default 0,5), bukan kode.
const kp32 = knownPrograms();
check("32i P6 skor code-level Kiln 60,8 / Tokenize 34,0 / VeChain 34,0",
  scoreProgram(kp32.find((p) => p.id === "cantina:kiln-v2"), NOW31).score === 60.8
  && scoreProgram(kp32.find((p) => p.id === "hackenproof:tokenize-it"), NOW31).score === 34
  && scoreProgram(kp32.find((p) => p.id === "hackenproof:vechain-stargate"), NOW31).score === 34,
  kp32.map((p) => p.id + "=" + scoreProgram(p, NOW31).score).join(", "));
// 32j. P11: intakeRun — entri dropped skornya null; ranked tetap urut (RAAC pertama).
const run32j = intakeRun(knownPrograms(), [], { mode: "auto", now: NOW31 });
const dropped32 = run32j.results.filter((r) => r.dropped.length > 0);
check("32j P11 skor entri dropped = null (3 entri)",
  dropped32.length === 3 && dropped32.every((r) => r.score === null),
  dropped32.map((r) => r.id + "=" + r.score).join(", "));
check("32j P11 ranked tetap RAAC 86,3 pertama, 4 entri",
  run32j.ranked.length === 4 && run32j.ranked[0].id === "guardian:raac"
  && run32j.ranked[0].score === 86.3,
  run32j.ranked.map((r) => r.id + "=" + r.score).join(", "));
check("32j P11 vonis 7 program tetap: 2 LAYAK / 2 KONFIRMASI / 3 DROP",
  run32j.results.filter((r) => r.gate.verdict === "LAYAK").length === 2
  && run32j.results.filter((r) => r.gate.verdict === "KONFIRMASI").length === 2
  && run32j.dropped.length === 3);
// 32k. Render: kartu dropped menampilkan "— (drop" + field belum terverifikasi;
// kartu Cronos tetap menampilkan skor + LAYAK.
const card32d = renderIntakeCard(run32j.results.find((r) => r.id === "cantina:kiln-v2"));
check("32k render kartu dropped: skor — + field belum terverifikasi",
  card32d.includes("— (drop") && card32d.includes("Field belum terverifikasi"),
  card32d.slice(0, 300));
const card32c = renderIntakeCard(run32j.results.find((r) => r.id === "hackenproof:cronos-zkevm"));
check("32k render kartu Cronos: 84 + LAYAK, tanpa baris field-belum-terverifikasi",
  card32c.includes("84") && card32c.includes("LAYAK")
  && !card32c.includes("Field belum terverifikasi"));

// --- Seksi 33. Residual (10): alias berantai via file perantara (sesi 08:38 WIB 17 Nov).
// Kasus Kiro 11a/11b (review R6): Mid mengekspor K = Vault; Reader mengimpor
// {K as C} dari Mid (11a) atau {K} lalu memakai K langsung (11b) — baca
// `v.fee()` terlewat karena K bukan anggota baseTypeNames.
// Perbaikan: buildExportedTypeMap (nama ekspor per file → tipe kanonik,
// rekursif N hop, aman siklus) + loop alias memakai kanonik itu + import
// tanpa rename ikut dihitung.
const r33Vault = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    function setFee(uint256 f) external { fee = f; }
}`;
const r33Mid = `pragma solidity ^0.8.20;
import {Vault as K} from "./Vault.sol";`;
// 33a. 11a: {K as C} dari Mid → HILANG (getter).
const r33aReader = `pragma solidity ^0.8.20;
import {K as C} from "./Mid.sol";
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r33a = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r33Mid },
  { name: "Reader.sol", text: r33aReader },
]);
check("R10 11a {K as C} berantai → HILANG (getter)",
  r33a.candidates.filter((c) => c.varName === "fee").length === 0
  && r33a.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r33a.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r33a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 33b. 11b: {K} tanpa rename, pakai K langsung → HILANG (getter).
const r33bReader = `pragma solidity ^0.8.20;
import {K} from "./Mid.sol";
contract Reader {
    K private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r33b = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r33Mid },
  { name: "Reader.sol", text: r33bReader },
]);
check("R10 11b {K} langsung berantai → HILANG (getter)",
  r33b.candidates.filter((c) => c.varName === "fee").length === 0
  && r33b.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r33b.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r33b.dropped.map((d) => d.varName + ":" + d.readBy)));
// 33c. Rantai 3 hop (L1 {Vault as K1}, L2 {K1 as K2}, Reader {K2 as C}) → HILANG.
const r33L1 = `pragma solidity ^0.8.20;
import {Vault as K1} from "./Vault.sol";`;
const r33L2 = `pragma solidity ^0.8.20;
import {K1 as K2} from "./L1.sol";`;
const r33cReader = `pragma solidity ^0.8.20;
import {K2 as C} from "./L2.sol";
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r33c = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "L1.sol", text: r33L1 },
  { name: "L2.sol", text: r33L2 },
  { name: "Reader.sol", text: r33cReader },
]);
check("R10 rantai 3 hop → HILANG (getter)",
  r33c.candidates.filter((c) => c.varName === "fee").length === 0
  && r33c.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r33c.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r33c.dropped.map((d) => d.varName + ":" + d.readBy)));
// 33d. Kontrol negatif: alias berantai ke tipe SALAH (Other) → TETAP.
const r33Other = `pragma solidity ^0.8.20;
contract Other { uint256 public fee; }`;
const r33MidWrong = `pragma solidity ^0.8.20;
import {Other as K} from "./Other.sol";`;
const r33d = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Other.sol", text: r33Other },
  { name: "Mid.sol", text: r33MidWrong },
  { name: "Reader.sol", text: r33aReader },
]);
check("R10 alias berantai ke Other (salah) → TETAP",
  r33d.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r33d.candidates.map((c) => c.varName)));
// 33e. Kontrol: alias berantai ke nama TAK DIKENAL (bukan tipe korpus) → TETAP.
const r33MidUnknown = `pragma solidity ^0.8.20;
import {Nope as K} from "./Vault.sol";`;
const r33e = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r33MidUnknown },
  { name: "Reader.sol", text: r33aReader },
]);
check("R10 alias berantai ke nama tak dikenal → TETAP",
  r33e.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r33e.candidates.map((c) => c.varName)));
// 33f. Kontrol: siklus import (Mid <-> Reader) → HILANG, tanpa hang.
const r33MidCycle = `pragma solidity ^0.8.20;
import {Vault as K} from "./Vault.sol";
import {Reader} from "./Reader.sol";`;
const r33f = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r33MidCycle },
  { name: "Reader.sol", text: r33aReader },
]);
check("R10 siklus import → HILANG, tanpa hang",
  r33f.candidates.filter((c) => c.varName === "fee").length === 0
  && r33f.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r33f.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r33f.dropped.map((d) => d.varName + ":" + d.readBy)));
// 33g. Kontrol: alias berantai + shadowing lokal (Reader definisikan C sendiri,
// bukan anggota lineage) → TETAP (W5b berlaku juga untuk alias).
const r33gReader = `pragma solidity ^0.8.20;
import {K as C} from "./Mid.sol";
contract C { uint256 public fee; }
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r33g = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r33Mid },
  { name: "Reader.sol", text: r33gReader },
]);
check("R10 alias berantai + shadowing lokal C → TETAP",
  r33g.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r33g.candidates.map((c) => c.varName)));

// --- Seksi 34. Kalibrasi lanjutan wasit R10.1 atas review Kiro R10 (sesi 08:38 WIB 17 Nov).
// Vonis Kiro: 9/10 kasus lolos + (j) namespace tak ditangani (diketahui, tak
// dikerjakan). Temuan tambahan diverifikasi wasit KE KODE ASLI via probe:
// x1/x1b FP shortcut base-name — TERBUKTI; x2-owner BUKAN bug (pin P1-owner);
// x2-ivault FP interface senama tak diimplementasi — TERBUKTI; x3 FN rantai
// lewat impor global — TERBUKTI.
// Perbaikan: (F1) kanonik dicek lewat peta ekspor target DULU, shortcut nama
// hanya bila target tak punya entri; (F2) typeFiles["I"+owner] dipangkas ke
// interface yang diimplementasi pemilik + deklarasi getter; (F3) resolveIn
// mengikuti impor global (scanImports kini membawa `kind`); (F1b) nama yang
// di-rebind file pembaca ke tipe lain dikeluarkan dari scopedTypeNames.
const r34Other = `pragma solidity ^0.8.20;
contract Other { uint256 public fee; }`;
const r34MidX1 = `pragma solidity ^0.8.20;
import {Other as Vault} from "./Other.sol";
import {Vault as Helper} from "./Vault.sol";`;
// 34a. x1: Mid {Other as Vault}+{Helper}; Reader {Vault as C} dari Mid → TETAP.
const r34aReader = `pragma solidity ^0.8.20;
import {Vault as C} from "./Mid.sol";
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r34a = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Other.sol", text: r34Other },
  { name: "Mid.sol", text: r34MidX1 },
  { name: "Reader.sol", text: r34aReader },
]);
check("R10.1 x1 alias {Other as Vault} di Mid → TETAP",
  r34a.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r34a.candidates.map((c) => c.varName)));
// 34b. x1b: Mid sama; Reader {Vault} tanpa rename → TETAP (jalur getter juga).
const r34bReader = `pragma solidity ^0.8.20;
import {Vault} from "./Mid.sol";
contract Reader {
    Vault private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r34b = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Other.sol", text: r34Other },
  { name: "Mid.sol", text: r34MidX1 },
  { name: "Reader.sol", text: r34bReader },
]);
check("R10.1 x1b {Vault} dari Mid (Other) → TETAP",
  r34b.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r34b.candidates.map((c) => c.varName)));
// 34c. x2-owner (kontrol, BUKAN bug): Fake Vault sendiri; Reader {Vault as C} → TETAP.
const r34FakeVault = `pragma solidity ^0.8.20;
contract Vault { uint256 public fee; }`;
const r34c = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Fake.sol", text: r34FakeVault },
  { name: "Reader.sol", text: r34aReader.replace("./Mid.sol", "./Fake.sol") },
]);
check("R10.1 x2-owner Fake Vault sendiri → TETAP (pin P1-owner)",
  r34c.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r34c.candidates.map((c) => c.varName)));
// 34d. x2-ivault: Fake IVault (deklarasi fee, tak diimplementasi Vault) → TETAP.
const r34FakeIVault = `pragma solidity ^0.8.20;
interface IVault { function fee() external view returns (uint256); }`;
const r34dReader = `pragma solidity ^0.8.20;
import {IVault as C} from "./Fake.sol";
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r34d = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Fake.sol", text: r34FakeIVault },
  { name: "Reader.sol", text: r34dReader },
]);
check("R10.1 x2-ivault Fake IVault tak diimplementasi → TETAP",
  r34d.candidates.filter((c) => c.varName === "fee").length === 1,
  "kept=" + JSON.stringify(r34d.candidates.map((c) => c.varName)));
// 34e. x3: rantai lewat impor global (Mid import global; Mid2 {Vault as K}) → HILANG.
const r34MidGlobal = `pragma solidity ^0.8.20;
import "./Vault.sol";`;
const r34Mid2 = `pragma solidity ^0.8.20;
import {Vault as K} from "./Mid.sol";`;
const r34eReader = `pragma solidity ^0.8.20;
import {K as C} from "./Mid2.sol";
contract Reader {
    C private v;
    function readFee() external view returns (uint256) { return v.fee(); }
}`;
const r34e = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r34MidGlobal },
  { name: "Mid2.sol", text: r34Mid2 },
  { name: "Reader.sol", text: r34eReader },
]);
check("R10.1 x3 rantai lewat impor global → HILANG (getter)",
  r34e.candidates.filter((c) => c.varName === "fee").length === 0
  && r34e.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r34e.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r34e.dropped.map((d) => d.varName + ":" + d.readBy)));
// 34f. x4 (kontrol, jangan regresi): satu hop lewat impor global → HILANG.
const r34f = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r34MidGlobal },
  { name: "Reader.sol", text: r34aReader },
]);
check("R10.1 x4 satu hop impor global → HILANG (getter)",
  r34f.candidates.filter((c) => c.varName === "fee").length === 0
  && r34f.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r34f.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r34f.dropped.map((d) => d.varName + ":" + d.readBy)));
// 34g. Kontrol: re-export tengah SETIA (Mid {Vault} tanpa rename) → HILANG.
const r34MidFaithful = `pragma solidity ^0.8.20;
import {Vault} from "./Vault.sol";`;
const r34g = runProjectPipeline([
  { name: "Vault.sol", text: r33Vault },
  { name: "Mid.sol", text: r34MidFaithful },
  { name: "Reader.sol", text: r34aReader },
]);
check("R10.1 re-export setia {Vault} → HILANG (getter)",
  r34g.candidates.filter((c) => c.varName === "fee").length === 0
  && r34g.dropped.some((d) => d.varName === "fee" && /\(getter\)/.test(d.readBy.join())),
  "kept=" + JSON.stringify(r34g.candidates.map((c) => c.varName))
  + " dropped=" + JSON.stringify(r34g.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 35. Residual (9): shadow lokal prefix-based di project-pass
// (sesi 12:38 WIB 17 Nov).
// Probe membuktikan 2 cacat pada kode lama: (9a) deklarasi lokal di blok
// bersarang yang SUDAH menutup ikut menutupi baca state var sesudahnya
// (cek prefix fungsi) — baca inheritance terlewat; (9b) deklarasi lokal
// di dalam fungsi tercatat sebagai state var kontrak di buildProjectIndex
// (phantom) sehingga cek shadow rantai inheritance menutup baca.
// Perbaikan: (9a) isShadowedByLocalDecl — bayangan hanya sampai `}`
// penutup blok deklarasi (pola P5 analyzeStateVar); (9b) filter deklarasi
// di dalam badan fungsi dari ct.vars (pola ownerTypedStateVars).
// Batas: deklarasi tanpa kurung kurawal (if tanpa blok, init for)
// menutupi sampai akhir fungsi (konservatif, didokumentasikan).
const r35Vault = r33Vault;
const r35mkChild = (body) => `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function readFee() external view returns (uint256) {
${body}
    }
}`;
const r35run = (body) => runProjectPipeline([
  { name: "Vault.sol", text: r35Vault },
  { name: "Child.sol", text: r35mkChild(body) },
]);
const r35kept = (r) => r.candidates.filter((c) => c.varName === "fee").length;
const r35droppedInh = (r) => r.dropped.some((d) => d.varName === "fee" && /\(inheritance\)/.test(d.readBy.join()));
// 35a. (9a) Blok bersarang tertutup, baca state var sesudahnya → HILANG.
const r35a = r35run(`        if (true) { uint256 fee = 1; }
        return fee;`);
check("R9 35a blok tertutup, baca sesudah → HILANG (inheritance)",
  r35kept(r35a) === 0 && r35droppedInh(r35a),
  "kept=" + r35kept(r35a) + " dropped=" + JSON.stringify(r35a.dropped.map((d) => d.varName + ":" + d.readBy)));
// 35b. Kontrol: deklarasi lokal di blok yang sama sebelum baca → TETAP.
const r35b = r35run(`        uint256 fee = 1;
        return fee;`);
check("R9 35b blok sama, lokal dulu → TETAP",
  r35kept(r35b) === 1,
  "kept=" + r35kept(r35b));
// 35c. Kontrol: baca DI DALAM blok bersarang yang mendeklarasi lokal → TETAP.
const r35c = r35run(`        if (true) { uint256 fee = 1; return fee; }
        return 0;`);
check("R9 35c baca di dalam blok lokal → TETAP",
  r35kept(r35c) === 1,
  "kept=" + r35kept(r35c));
// 35d. (9b) Deklarasi lokal SESUDAH baca (P4-14) → HILANG (phantom var).
const r35d = r35run(`        uint256 x = fee;
        uint256 fee = 1;
        return x;`);
check("R9 35d lokal sesudah baca → HILANG (inheritance)",
  r35kept(r35d) === 0 && r35droppedInh(r35d),
  "kept=" + r35kept(r35d) + " dropped=" + JSON.stringify(r35d.dropped.map((d) => d.varName + ":" + d.readBy)));
// 35e. (9a) Baca di blok kedua sesudah blok pertama menutup → HILANG.
const r35e = r35run(`        if (true) { uint256 fee = 1; }
        if (true) { return fee; }
        return 0;`);
check("R9 35e blok kedua baca sesudah blok pertama tutup → HILANG (inheritance)",
  r35kept(r35e) === 0 && r35droppedInh(r35e),
  "kept=" + r35kept(r35e) + " dropped=" + JSON.stringify(r35e.dropped.map((d) => d.varName + ":" + d.readBy)));
// 35f. (9a) Blok ganda bersarang: deklarasi di blok dalam, baca sesudah
// blok dalam menutup (masih di blok luar) → HILANG.
const r35f = r35run(`        if (true) {
            if (true) { uint256 fee = 1; }
            return fee;
        }
        return 0;`);
check("R9 35f blok dalam tertutup, baca di blok luar → HILANG (inheritance)",
  r35kept(r35f) === 0 && r35droppedInh(r35f),
  "kept=" + r35kept(r35f) + " dropped=" + JSON.stringify(r35f.dropped.map((d) => d.varName + ":" + d.readBy)));

// --- Seksi 36. Kalibrasi lanjutan wasit R9.1 atas review Kiro R9
// (sesi 12:38 WIB 17 Nov).
// Vonis Kiro: 22/41 kasus benar; temuan F1–F12 diverifikasi wasit ke
// pipeline ASLI via probe — TERBUKTI: F1 (uint24/bytes20), F2 (address
// payable), F3 (mapping storage), F4 (struct huruf-kecil), F5b ($fee),
// F6 (for-init), F8 (self-init), F9 (dua fungsi sebaris), F10 (param
// Yul), F11 (param modifier), F12 (var sebaris fungsi). TIDAK TERBUKTI
// pada harness Kiro tapi TERBUKTI lewat probe wasit dgn mekanisme
// berbeda: F5a (benar via jalan lain), F7 (nama-deklarasi dihitung
// baca). DITEMUKAN WASIT (di luar daftar Kiro): nama-deklarasi lokal
// (`uint256 fee;`, named return) dihitung sebagai baca; detektor buta
// state var uint24; lokal di badan modifier + param Yul menutupi baca
// di detektor; F12 juga merusak detektor (findDeadConfigVars).
// Perbaikan: (1) LOCAL_DECL_HEAD_SRC — tipe diperlebar + batas $;
// (2) localDeclShadowRange v2 — awal `;` pernyataan (F8) + akhir
// paren-case for/try/catch/returns (F6/F7), paren tuple dikecualikan;
// (3) isLocalDeclName — nama deklarasi bukan baca; (4) indeks CHAR
// ganti baris di extractFunctions/scanModifiers/findSpecialFnSpans +
// findDeadConfigVars + buildProjectIndex + floor findCrossFileReads
// (F9/F12); (5) modifier sebagai cakupan bayangan (F11); (6) blok
// assembly dilewati kecuali `.slot`/`.offset` (F10); (7) STATE_TYPE_SRC
// diperlebar (uint24 state var kini terdeteksi).
// Batas tersisa: mapping bersarang >1 level tak dikenali; `if (x)
// uint256 fee = 1;` tak dapat dikompilasi (Kiro) — dari limit lama
// hanya for-init yang dapat terjadi, kini tertangani.
const r36mkChild = (body, extra) => `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
${extra || ""}
    function readFee() external view returns (uint256) {
${body}
    }
}`;
const r36run = (vault, child) => runProjectPipeline([
  { name: "Vault.sol", text: vault },
  { name: "Child.sol", text: child },
]);
const r36kept = (r) => r.candidates.filter((c) => c.varName === "fee").length;
const r36inh = (r) => r.dropped.some((d) => d.varName === "fee" && /\(inheritance\)/.test(d.readBy.join()));
// 36a. F1: uint24 lokal → TETAP.
check("R9.1 36a uint24 lokal → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        uint24 fee = 3000;\n        return fee;"))) === 1);
// 36b. F1: bytes20 lokal → TETAP.
check("R9.1 36b bytes20 lokal → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        bytes20 fee = bytes20(uint160(1));\n        return uint160(fee);"))) === 1);
// 36c. F2: address payable lokal → TETAP.
check("R9.1 36c address payable lokal → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        address payable fee = payable(msg.sender);\n        return uint160(address(fee));"))) === 1);
// 36d. F3: mapping storage lokal → TETAP.
const r36VaultMap = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    mapping(address => uint256) public other;
    function setFee(uint256 f) external { fee = f; }
}`;
check("R9.1 36d mapping storage lokal → TETAP",
  r36kept(r36run(r36VaultMap, r36mkChild("        mapping(address => uint256) storage fee = other;\n        return fee[msg.sender];"))) === 1);
// 36e. F4: struct huruf-kecil memory → TETAP.
const r36VaultInfo = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee;
    struct info { uint256 v; }
    function setFee(uint256 f) external { fee = f; }
}`;
check("R9.1 36e struct huruf-kecil memory → TETAP",
  r36kept(r36run(r36VaultInfo, r36mkChild("        info memory fee = info(1);\n        return fee.v;"))) === 1);
// 36f. F5a: fee$ lokal, baca state → HILANG (alasan benar kini).
const r36f = r36run(r33Vault, r36mkChild("        uint256 fee$ = 1;\n        return fee + fee$;"));
check("R9.1 36f fee$ lokal, baca state → HILANG (inheritance)",
  r36kept(r36f) === 0 && r36inh(r36f));
// 36g. F5b: $fee lokal → TETAP.
check("R9.1 36g $fee lokal → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        uint256 $fee = 1;\n        return $fee;"))) === 1);
// 36h. F6: for-init, baca sesudah loop → HILANG.
const r36h = r36run(r33Vault, r36mkChild("        for (uint256 fee = 0; fee < 3; fee++) {}\n        return fee;"));
check("R9.1 36h for-init, baca sesudah loop → HILANG (inheritance)",
  r36kept(r36h) === 0 && r36inh(r36h));
// 36i. F7a: try-returns, baca sesudah → HILANG.
const r36Try = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function x() external returns (uint256) { return 1; }
    function readFee() external view returns (uint256) {
        try this.x() returns (uint256 fee) { fee; } catch {}
        return fee;
    }
}`;
const r36i = r36run(r33Vault, r36Try);
check("R9.1 36i try-returns, baca sesudah → HILANG (inheritance)",
  r36kept(r36i) === 0 && r36inh(r36i));
// 36j. F7a': try saja tanpa baca state → TETAP.
const r36Try2 = r36Try.replace("        return fee;", "        return 0;");
check("R9.1 36j try saja tanpa baca state → TETAP",
  r36kept(r36run(r33Vault, r36Try2)) === 1);
// 36k. F7b: catch-param, baca sesudah → HILANG.
const r36Catch = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function x() external returns (uint256) { return 1; }
    function readFee() external view returns (uint256) {
        try this.x() returns (uint256 v) { v; } catch (bytes memory fee) { fee; }
        return fee;
    }
}`;
const r36k = r36run(r33Vault, r36Catch);
check("R9.1 36k catch-param, baca sesudah → HILANG (inheritance)",
  r36kept(r36k) === 0 && r36inh(r36k));
// 36l. F8: self-init, RHS = state → HILANG.
const r36l = r36run(r33Vault, r36mkChild("        uint256 fee = fee * 2;\n        return fee;"));
check("R9.1 36l self-init, RHS = state → HILANG (inheritance)",
  r36kept(r36l) === 0 && r36inh(r36l));
// 36m. F9: dua fungsi sebaris → HILANG.
const r36SameLine = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault { function a(uint256 fee) external pure returns (uint256) { return fee; } function readFee() external view returns (uint256) { return fee; } }`;
const r36m = r36run(r33Vault, r36SameLine);
check("R9.1 36m dua fungsi sebaris → HILANG (inheritance)",
  r36kept(r36m) === 0 && r36inh(r36m));
// 36n. F10: param fungsi Yul → TETAP.
check("R9.1 36n param fungsi Yul → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        uint256 r;\n        assembly { function g(fee) -> o { o := fee } r := g(1); }\n        return r;"))) === 1);
// 36o. F10: sload(fee.slot) = baca nyata → HILANG.
const r36o = r36run(r33Vault, r36mkChild("        uint256 r;\n        assembly { r := sload(fee.slot) }\n        return r;"));
check("R9.1 36o sload(fee.slot) → HILANG (inheritance)",
  r36kept(r36o) === 0 && r36inh(r36o));
// 36p. F11: modifier-param saja → TETAP.
const r36ModOnly = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    modifier m(uint256 fee) { require(fee > 0); _; }
    function readFee() external view m(1) returns (uint256) { return 0; }
}`;
check("R9.1 36p modifier-param saja → TETAP",
  r36kept(r36run(r33Vault, r36ModOnly)) === 1);
// 36q. F11: modifier + baca state nyata → HILANG.
const r36ModRead = r36ModOnly.replace("return 0;", "return fee;");
const r36q = r36run(r33Vault, r36ModRead);
check("R9.1 36q modifier + baca state → HILANG (inheritance)",
  r36kept(r36q) === 0 && r36inh(r36q));
// 36r. F12: var sebaris dengan fungsi → HILANG (detektor + pass).
const r36VaultShared = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public fee; function setFee(uint256 f) external { fee = f; }
}`;
const r36r = r36run(r36VaultShared, r36mkChild("        return fee;"));
check("R9.1 36r var sebaris fungsi → HILANG (inheritance)",
  r36kept(r36r) === 0 && r36inh(r36r));
// 36s. Tuple-deklarasi di blok tertutup, baca sesudah → HILANG
// (paren tuple bukan paren cakupan — regresi N13/P10).
const r36s = r36run(r33Vault, r36mkChild("        if (true) { (uint256 fee, uint256 cap) = (1, 2); }\n        return fee;"));
check("R9.1 36s tuple di blok tertutup, baca sesudah → HILANG (inheritance)",
  r36kept(r36s) === 0 && r36inh(r36s));
// 36t. Named return saja → TETAP.
const r36NamedRet = `pragma solidity ^0.8.20;
import "./Vault.sol";
contract Child is Vault {
    function readFee() external view returns (uint256 fee) { return fee; }
}`;
check("R9.1 36t named return saja → TETAP",
  r36kept(r36run(r33Vault, r36NamedRet)) === 1);
// 36u. Lokal tanpa inisialisasi → TETAP.
check("R9.1 36u lokal tanpa init → TETAP",
  r36kept(r36run(r33Vault, r36mkChild("        uint256 fee;\n        fee = 1;\n        return fee;"))) === 1);
// 36v. Detektor F8: self-init satu-satunya baca → var TERBACA (0 kandidat).
check("R9.1 36v detektor self-init → bukan dead-config",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function bump() external { uint256 fee = fee * 2; fee; }`).length === 0);
// 36w. Detektor F10: param Yul → kandidat tetap ada.
check("R9.1 36w detektor param Yul → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    function g() external view returns (uint256 r) { assembly { function h(fee) -> o { o := fee } r := h(1); } }`).length === 1);
// 36x. Detektor modifier-lokal → kandidat tetap ada.
check("R9.1 36x detektor modifier-lokal → 1",
  dcHits(`uint256 public fee;
    function setFee(uint256 _v) external { fee = _v; }
    modifier m() { uint256 fee = 1; require(fee > 0); _; }
    function g() external m() {}`).length === 1);
// 36y. Detektor: state var uint24 kini terdeteksi → 1.
check("R9.1 36y detektor uint24 state var → 1",
  dcHits(`uint24 public fee;
    function setFee(uint24 _v) external { fee = _v; }`).length === 1);

// --- Seksi 37. Residual (3): heuristik abstract+internal over-downgrade
// (sesi 16:38 WIB 17 Nov).
// F6 menebak pembaca di kontrak turunan file lain → Info. Project-pass
// kini menguji hipotesis itu di korpus penuh: bila tidak ada pembaca dan
// F6 satu-satunya alasan Info, kandidat kembali Low (bukti di evidence).
// Single-file tetap konservatif (Info) — korpus tak diketahui. Alasan
// Info lain (raw-slot, override, member-call) TIDAK dicabut.
const r37Base = `pragma solidity ^0.8.20;
abstract contract FeeBase {
    uint256 internal feeBps;
    function setFee(uint256 v) external { feeBps = v; }
}`;
const r37Child = (body) => `pragma solidity ^0.8.20;
import "./FeeBase.sol";
contract Child is FeeBase {
    function getX() external view returns (uint256) {
${body}
    }
}`;
const r37run = (childBody) => runProjectPipeline([
  { name: "FeeBase.sol", text: r37Base },
  { name: "Child.sol", text: r37Child(childBody) },
]);
const r37dc = (r) => r.candidates.filter((c) => c.detector === "dead-config-storage" && c.varName === "feeBps");
// 37a. Turunan tidak membaca → TETAP, naik ke Low + bukti project-pass.
const r37a = r37run(`        return 1;`);
check("R3 37a turunan tak baca → TETAP Low + bukti project-pass",
  r37dc(r37a).length === 1 && r37dc(r37a)[0].severityGuess === "Low"
    && /project-pass: hipotesis abstract-internal/.test(r37dc(r37a)[0].evidence)
    && !/abstract-internal: mungkin dibaca/.test(r37dc(r37a)[0].evidence)
    && (r37dc(r37a)[0].infoReasons || []).length === 0,
  "dapat " + JSON.stringify(r37dc(r37a).map((c) => c.severityGuess + "|" + c.evidence)));
// 37b. Kontrol: turunan membaca → DROP (inheritance).
const r37b = r37run(`        return feeBps;`);
check("R3 37b turunan baca → DROP (inheritance)",
  r37dc(r37b).length === 0 && r37b.dropped.some((d) => d.varName === "feeBps"),
  "kept=" + r37dc(r37b).length);
// 37c. Single-file (tanpa project-pass) → tetap Info.
const r37c = runPipeline(r37Base, "FeeBase.sol").candidates
  .filter((c) => c.detector === "dead-config-storage");
check("R3 37c single-file → tetap Info",
  r37c.length === 1 && r37c[0].severityGuess === "Info",
  "dapat " + r37c.map((c) => c.severityGuess).join(","));
// 37d. F6 + alasan lain (raw-slot) → tetap Info, hanya F6 yang dicabut.
const r37BaseSlot = `pragma solidity ^0.8.20;
abstract contract FeeBase {
    uint256 internal feeBps;
    function setFee(uint256 v) external { feeBps = v; }
    function peek() external view returns (uint256 x) { assembly { x := sload(0); } }
}`;
const r37d = runProjectPipeline([
  { name: "FeeBase.sol", text: r37BaseSlot },
  { name: "Child.sol", text: r37Child(`        return 1;`) },
]);
check("R3 37d F6 + raw-slot → tetap Info, raw-slot dipertahankan",
  r37dc(r37d).length === 1 && r37dc(r37d)[0].severityGuess === "Info"
    && /\[Info: raw-slot:/.test(r37dc(r37d)[0].evidence)
    && !/abstract-internal/.test(r37dc(r37d)[0].evidence)
    && (r37dc(r37d)[0].infoReasons || []).length === 1,
  "dapat " + JSON.stringify(r37dc(r37d).map((c) => c.severityGuess + "|" + c.evidence)));
// 37e. Tanpa file turunan sama sekali (korpus = base saja) → Low.
const r37e = runProjectPipeline([{ name: "FeeBase.sol", text: r37Base }]);
check("R3 37e tanpa turunan di korpus → Low",
  r37dc(r37e).length === 1 && r37dc(r37e)[0].severityGuess === "Low",
  "dapat " + r37dc(r37e).map((c) => c.severityGuess).join(","));
// 37f. Regresi: kontrak NON-abstract, var internal mati → Low (tak berubah).
const r37Plain = `pragma solidity ^0.8.20;
contract Plain {
    uint256 internal feeBps;
    function setFee(uint256 v) external { feeBps = v; }
}`;
const r37f = runProjectPipeline([{ name: "Plain.sol", text: r37Plain }]);
check("R3 37f non-abstract → Low (regresi)",
  r37dc(r37f).length === 1 && r37dc(r37f)[0].severityGuess === "Low",
  "dapat " + r37dc(r37f).map((c) => c.severityGuess).join(","));
// 37g. Regresi: abstract + var PUBLIC → Low (F6 hanya non-public).
const r37BasePub = `pragma solidity ^0.8.20;
abstract contract FeeBase {
    uint256 public feeBps;
    function setFee(uint256 v) external { feeBps = v; }
}`;
const r37g = runProjectPipeline([
  { name: "FeeBase.sol", text: r37BasePub },
  { name: "Child.sol", text: r37Child(`        return 1;`) },
]);
check("R3 37g abstract + public → Low (regresi)",
  r37dc(r37g).length === 1 && r37dc(r37g)[0].severityGuess === "Low",
  "dapat " + r37dc(r37g).map((c) => c.severityGuess).join(","));
// 37h. Dengan baseline: tag [Info:] di TENGAH evidence (disusul
// [upstream-diff:]) tetap terganti bersih → Low + kedua tag utuh.
const r37BaseUp = `pragma solidity ^0.8.20;
abstract contract FeeBase {
    uint256 internal other;
    function setOther(uint256 v) external { other = v; }
}`;
const r37h = runProjectPipeline([
  { name: "FeeBase.sol", text: r37Base },
  { name: "Child.sol", text: r37Child(`        return 1;`) },
], { baseline: buildBaselineMap([{ name: "FeeBase.sol", text: r37BaseUp }]).map });
check("R3 37h baseline: F6 dicabut di tengah evidence → Low + upstream-diff utuh",
  r37dc(r37h).length === 1 && r37dc(r37h)[0].severityGuess === "Low"
    && /project-pass: hipotesis abstract-internal/.test(r37dc(r37h)[0].evidence)
    && /\[upstream-diff: absent/.test(r37dc(r37h)[0].evidence)
    && !/abstract-internal: mungkin dibaca/.test(r37dc(r37h)[0].evidence),
  "dapat " + JSON.stringify(r37dc(r37h).map((c) => c.severityGuess + "|" + c.evidence)));

// --- Seksi 38. Detektor ke-18/ke-19: permissionless-dispatcher +
// full-balance-sweep (kelas H3/H3b Hyperbridge, sesi 20:38 WIB 17 Nov).
const d18 = (src) => runPipeline(src, "T.sol").candidates
  .filter((c) => c.detector === "permissionless-dispatcher");
const d19 = (src) => runPipeline(src, "T.sol").candidates
  .filter((c) => c.detector === "full-balance-sweep");
const wrap38 = (body) => "pragma solidity ^0.8.20;\ncontract T {\n"
  + "    address public gateway;\n    address public pool;\n    address public owner;\n"
  + body + "\n}";
// 38a. Bentuk persis CallDispatcher.dispatch → 1 Medium.
const t38a = wrap38(`    function dispatch(bytes calldata encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory c = calls[i];
            (bool ok, ) = c.to.call{value: c.value}(c.data);
            require(ok, "fail");
        }
    }`);
check("D18 38a dispatch arbitrer → 1 Medium",
  d18(t38a).length === 1 && d18(t38a)[0].severityGuess === "Medium",
  "dapat " + d18(t38a).length);
// 38b. Guard require(msg.sender == gateway) → 0.
const t38b = wrap38(`    function dispatch(bytes calldata encoded) external {
        require(msg.sender == gateway, "no");
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory c = calls[i];
            (bool ok, ) = c.to.call{value: c.value}(c.data);
            require(ok, "fail");
        }
    }`);
check("D18 38b guard require sender → 0", d18(t38b).length === 0,
  "dapat " + d18(t38b).length);
// 38c. Varian delegatecall → 1.
const t38c = wrap38(`    function exec(address target, bytes calldata data) external {
        (bool ok, ) = target.delegatecall(data);
        require(ok, "fail");
    }`);
check("D18 38c delegatecall arbitrer → 1", d18(t38c).length === 1,
  "dapat " + d18(t38c).length);
// 38d. Receiver msg.sender (forward ke pemanggil) → 0.
const t38d = wrap38(`    function fwd(bytes calldata data) external {
        (bool ok, ) = msg.sender.call{value: 0}(data);
        require(ok, "fail");
    }`);
check("D18 38d receiver msg.sender → 0", d18(t38d).length === 0,
  "dapat " + d18(t38d).length);
// 38e. Data kosong (hanya kirim ETH, cakupan v1) → 0.
const t38e = wrap38(`    function sendEth(address to, uint256 amount) external {
        to.call{value: amount}("");
    }`);
check("D18 38e data kosong → 0", d18(t38e).length === 0,
  "dapat " + d18(t38e).length);
// 38f. Varian OZ functionCall → 1.
const t38f = wrap38(`    function run(address target, bytes calldata data) external {
        target.functionCall(data);
    }`);
check("D18 38f functionCall arbitrer → 1", d18(t38f).length === 1,
  "dapat " + d18(t38f).length);
// 38g. Fungsi internal (gating di entry point) → 0.
const t38g = wrap38(`    function dispatch(bytes calldata encoded) internal {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory c = calls[i];
            (bool ok, ) = c.to.call{value: c.value}(c.data);
            require(ok, "fail");
        }
    }`);
check("D18 38g internal → 0", d18(t38g).length === 0,
  "dapat " + d18(t38g).length);
// 38h. Sweep var-form ERC20 → 1 Low.
const t38h = wrap38(`    function sweep(address token, uint256 required) external {
        uint256 balance = IERC20(token).balanceOf(pool);
        require(balance >= required, "low");
        IERC20(token).transfer(address(this), balance);
    }`);
check("D19 38h sweep var-form → 1 Low",
  d19(t38h).length === 1 && d19(t38h)[0].severityGuess === "Low",
  "dapat " + d19(t38h).length);
// 38i. Sweep bentuk langsung (tanpa variabel) → 1.
const t38i = wrap38(`    function sweep(address token) external {
        IERC20(token).transfer(address(this), IERC20(token).balanceOf(pool));
    }`);
check("D19 38i sweep langsung → 1", d19(t38i).length === 1,
  "dapat " + d19(t38i).length);
// 38j. Sweep native via field value: (Call struct) → 1.
const t38j = wrap38(`    function sweepNative(uint256 required) external {
        uint256 balance = address(pool).balance;
        require(balance >= required, "low");
        (bool ok, ) = address(this).call{value: balance}("");
        require(ok, "fail");
    }`);
check("D19 38j sweep native value: → 1", d19(t38j).length === 1,
  "dapat " + d19(t38j).length);
// 38k. Jumlah deklarasi (parameter) → 0.
const t38k = wrap38(`    function sweep(address token, uint256 amount) external {
        IERC20(token).transfer(address(this), amount);
    }`);
check("D19 38k jumlah deklarasi → 0", d19(t38k).length === 0,
  "dapat " + d19(t38k).length);
// 38l. Rescue saldo sendiri → 0.
const t38l = wrap38(`    function rescue(address token) external {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }`);
check("D19 38l rescue saldo sendiri → 0", d19(t38l).length === 0,
  "dapat " + d19(t38l).length);
// 38m. Withdraw-all saldo pemanggil → 0.
const t38m = wrap38(`    function withdrawAll(address token) external {
        IERC20(token).transfer(msg.sender, IERC20(token).balanceOf(msg.sender));
    }`);
check("D19 38m withdraw-all msg.sender → 0", d19(t38m).length === 0,
  "dapat " + d19(t38m).length);
// 38n. Cuplikan VERBATIM kode nyata Hyperbridge: CallDispatcher.dispatch
//      → 1 Medium; blok sweep placeOrder → 1 Low; _sweepDust → 0.
const t38nDispatch = `pragma solidity ^0.8.17;
contract CallDispatcher {
    error NotContract(address target);
    error CallFailed(address target, bytes result);
    receive() external payable {}
    function dispatch(bytes memory encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        uint256 callsLen = calls.length;
        for (uint256 i = 0; i < callsLen; ++i) {
            Call memory call = calls[i];
            uint32 size;
            address to = call.to;
            assembly {
                size := extcodesize(to)
            }
            if (size == 0) {
                revert NotContract(to);
            }
            (bool success, bytes memory result) = to.call{value: call.value}(call.data);
            if (!success) revert CallFailed(to, result);
        }
    }
}`;
check("D18 38n CallDispatcher nyata → 1 Medium",
  d18(t38nDispatch).length === 1 && d18(t38nDispatch)[0].severityGuess === "Medium",
  "dapat " + d18(t38nDispatch).length);
const t38nSweep = wrap38(`    function placeOrder(address token, address dispatcher, uint256 requiredAmount) external {
        uint256 balance = IERC20(token).balanceOf(dispatcher);
        if (balance < requiredAmount) revert InsufficientBalance();
        Call memory transferCall = Call({
            to: token,
            value: 0,
            data: abi.encodeWithSelector(IERC20.transfer.selector, address(this), balance)
        });
        ICallDispatcher(dispatcher).dispatch(abi.encode(transferCall));
    }`);
check("D19 38n sweep placeOrder nyata → 1 Low",
  d19(t38nSweep).length === 1 && d19(t38nSweep)[0].severityGuess === "Low",
  "dapat " + d19(t38nSweep).length);
const t38nDust = wrap38(`    function sweepDust(address token, address beneficiary, uint256 amount) internal {
        if (token == address(0)) {
            _sendValue(beneficiary, amount);
        } else {
            IERC20(token).safeTransfer(beneficiary, amount);
        }
    }`);
check("D19 38n _sweepDust jumlah deklarasi → 0", d19(t38nDust).length === 0,
  "dapat " + d19(t38nDust).length);

// --- Seksi 39. Kalibrasi R18.1/R19.1 + detektor ke-20 (review Kiro
// detektor 18/19, sesi 20:38 WIB 17 Nov 2026 — wasit: tiap klaim Kiro
// diverifikasi probe ke kode asli; yang TERBUKTI diperbaiki, yang
// artefak ditolak — lihat docs/kiro-crew-review-2026-11-17-detectors-18-19.md).
const d20 = (src) => runPipeline(src, "T.sol").candidates
  .filter((c) => c.detector === "permissionless-value-send");
const wrap39 = (body) => "pragma solidity ^0.8.20;\ncontract T {\n"
  + "    address public gateway;\n    address public pool;\n    address public owner;\n    address public dispatcher;\n"
  + body + "\n}";
// 39a. F1 TERBUKTI: onlyGateway kini dikenali hasAccessGuard → 0.
const t39a = wrap39(`    function dispatch(bytes calldata encoded) external onlyGateway {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) { Call memory c = calls[i]; (bool ok, ) = c.to.call{value: c.value}(c.data); require(ok, "fail"); }
    }`);
check("R18 39a onlyGateway → 0", d18(t39a).length === 0,
  "dapat " + d18(t39a).length);
// 39b. F2-lanjutan TERBUKTI: guard if-revert kini dikenali → 0.
check("R18 39b if-revert guard → 0",
  d18(wrap39(`    function dispatch(bytes calldata encoded) external {
        if (msg.sender != gateway) revert NotGateway();
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) { Call memory c = calls[i]; (bool ok, ) = c.to.call{value: c.value}(c.data); require(ok, "fail"); }
    }`)).length === 0);
// 39c. F2-narrow TERBUKTI: require(msg.sender == address(0)) BUKAN guard → 1.
check("R18 39c require sender==address(0) → 1",
  d18(wrap39(`    function dispatch(bytes calldata encoded) external {
        require(msg.sender == address(0), "no");
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) { Call memory c = calls[i]; (bool ok, ) = c.to.call{value: c.value}(c.data); require(ok, "fail"); }
    }`)).length === 1);
// 39d. F4 TERBUKTI: receiver terindeks calls[i].target.call → 1.
check("R18 39d indexed calls[i].target.call → 1",
  d18(wrap39(`    function execute(bytes calldata encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 1);
check("R18 39d2 indexed calls[i].to.call{value:} → 1",
  d18(wrap39(`    function execute(bytes calldata encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 1);
// 39e. F3 TERBUKTI: assembly call(target) → 1; staticcall → 0;
//     assembly call target hardcoded → 0.
check("R18 39e assembly call(target) → 1",
  d18(wrap39(`    function exec(address target, bytes calldata data) external {
        assembly {
            let ok := call(gas(), target, 0, add(data.offset, 0x20), mload(data.offset), 0, 0)
            if iszero(ok) { revert(0, 0) }
        }
    }`)).length === 1);
check("R18 39e2 assembly staticcall → 0",
  d18(wrap39(`    function get(address target, bytes calldata data) external view returns (bytes memory) {
        assembly {
            let ok := staticcall(gas(), target, add(data.offset, 0x20), mload(data.offset), 0, 0)
            if iszero(ok) { revert(0, 0) }
        }
    }`)).length === 0);
check("R18 39e3 assembly call target literal → 0",
  d18(wrap39(`    function exec(bytes calldata data) external {
        assembly {
            let ok := call(gas(), 0x1234567890123456789012345678901234567890, 0, add(data.offset, 0x20), mload(data.offset), 0, 0)
            if iszero(ok) { revert(0, 0) }
        }
    }`)).length === 0);
// 39f. F7: functionDelegateCall → 1.
check("R18 39f functionDelegateCall → 1",
  d18(wrap39(`    function run(address target, bytes calldata data) external {
        target.functionDelegateCall(data);
    }`)).length === 1);
// 39g. F12 TERBUKTI: cross-paren `emit Log(transfer(a, 1), balance)` → 0.
check("R19 39g cross-paren bukan jumlah transfer → 0",
  d19(wrap39(`    function f(address token, address beneficiary, uint256 amount) external {
        uint256 balance = IERC20(token).balanceOf(pool);
        emit Log(IERC20(token).transfer(beneficiary, amount), balance);
    }`)).length === 0);
// 39h. F13 TERBUKTI: encodeWithSelector balance sbg recipient → 0.
check("R19 39h encodeWithSelector balance sbg recipient → 0",
  d19(wrap39(`    function f(address token, uint256 amount) external {
        uint256 balance = IERC20(token).balanceOf(pool);
        bytes memory d = abi.encodeWithSelector(IERC20.transfer.selector, balance, amount);
        (bool ok, ) = token.call(d);
        require(ok, "f");
    }`)).length === 0);
// 39i. F18 TERBUKTI: reassign penuh (balance = required) → 0.
check("R19 39i balance = required (reassign penuh) → 0",
  d19(wrap39(`    function sweep(address token, uint256 required) external {
        uint256 balance = IERC20(token).balanceOf(pool);
        balance = required;
        IERC20(token).transfer(address(this), balance);
    }`)).length === 0);
// 39j. F18: turunan dari diri sendiri (balance = balance - fee) → 1.
check("R19 39j balance = balance - fee → 1",
  d19(wrap39(`    function sweep(address token, uint256 required) external {
        uint256 balance = IERC20(token).balanceOf(pool);
        balance = balance - 10;
        IERC20(token).transfer(address(this), balance);
    }`)).length === 1);
// 39k. F17 TERBUKTI: `==` bukan assignment → 0.
check("R19 39k == bukan assignment → 0",
  d19(wrap39(`    function f(address token, address to, uint256 amount) external {
        uint256 x = 1;
        if (x == IERC20(token).balanceOf(pool)) { }
        IERC20(token).transfer(to, x);
    }`)).length === 0);
// 39l. F16-lite: payable(pool).balance → 1.
check("R19 39l payable(pool).balance → 1",
  d19(wrap39(`    function sweep(address token, uint256 required) external {
        uint256 balance = payable(pool).balance;
        require(balance >= required, "low");
        (bool ok, ) = address(this).call{value: balance}("");
        require(ok, "f");
    }`)).length === 1);
// 39m. F8 (detektor ke-20): bare drain → 1 Medium; payFee → 1;
//     withdrawSelf / withdrawToOwner / payToken → 0.
check("D20 39m bare drain → 1 Medium",
  d20(wrap39(`    function drain(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "f");
    }`)).length === 1
  && d20(wrap39(`    function drain(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "f");
    }`))[0].severityGuess === "Medium");
check("D20 39m2 payFee shape → 1",
  d20(wrap39(`    function payFee(address to, uint256 amount) external {
        to.call{value: amount}("");
    }`)).length === 1);
check("D20 39m3 withdrawSelf → 0",
  d20(wrap39(`    function withdrawSelf(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "f");
    }`)).length === 0);
check("D20 39m4 withdrawToOwner → 0",
  d20(wrap39(`    function withdrawToOwner(uint256 amount) external {
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "f");
    }`)).length === 0);
check("D20 39m5 ERC20 transfer 2-arg → 0",
  d20(wrap39(`    function payToken(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }`)).length === 0);
check("D20 39m6 payable(to).transfer → 1",
  d20(wrap39(`    function sendEth(address to, uint256 amount) external {
        payable(to).transfer(amount);
    }`)).length === 1);
check("D20 39m7 value 0 → 0",
  d20(wrap39(`    function noop(address to) external {
        (bool ok, ) = to.call{value: 0}("");
        require(ok, "f");
    }`)).length === 0);
// 39n. (c3)/(c4)/(c6) DITOLAK wasit — probe membuktikan detektor v1
//     SUDAH benar: Call-struct value: → 1; var-form rescue own → 0;
//     assignment multi-baris → 1.
check("R19 39n Call-struct value: murni → 1 (c3 ditolak)",
  d19(wrap39(`    function placeOrder(address token, address disp, uint256 required) external {
        uint256 balance = IERC20(token).balanceOf(disp);
        require(balance >= required, "low");
        Call memory tc = Call({to: address(this), value: balance, data: ""});
        ICallDispatcher(disp).dispatch(abi.encode(tc));
    }`)).length === 1);
check("R19 39n2 var-form rescue own → 0 (c4 ditolak)",
  d19(wrap39(`    function rescue(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, bal);
    }`)).length === 0);
check("R19 39n3 assignment multi-baris → 1 (c6 ditolak)",
  d19(wrap39(`    function sweep(address token, uint256 required) external {
        uint256 balance =
            IERC20(token).balanceOf(pool);
        require(balance >= required, "low");
        IERC20(token).transfer(address(this), balance);
    }`)).length === 1);

// --- Seksi 40. Kalibrasi R18.2/R20.1 dari hunting re-run (sesi 20:38 WIB
// 17 Nov 2026 — wasit: 4 FP RAAC + 4 FP wrapper Hyperbridge dibedah ke
// kode nyata sebelum diperbaiki).
// 40a. R18.2: modifier only* majemuk kini dikenali hasAccessGuard.
check("R18.2 40a onlyManagerOrOwner → 0",
  d18(wrap39(`    function liquidateBorrower(address a, address b) external onlyManagerOrOwner {
        (bool ok, ) = liquidationStrategyProxy.delegatecall(abi.encodeWithSignature("liquidateBorrower(address,address)", a, b));
        require(ok, "f");
    }`)).length === 0);
check("R18.2 40b onlyStabilityPool → 0",
  d18(wrap39(`    function finalizeLiquidation(address a) external onlyStabilityPool {
        (bool ok, ) = liquidationProxy.delegatecall(abi.encodeWithSignature("finalizeLiquidation(address)", a));
        require(ok, "f");
    }`)).length === 0);
check("R18.2 40c onlySupportedAdapter → 0",
  d18(wrap39(`    function initiateLiquidation(address a) external onlySupportedAdapter(a) {
        (bool ok, ) = liquidationProxy.delegatecall(abi.encodeWithSignature("initiateLiquidation(address)", a));
        require(ok, "f");
    }`)).length === 0);
// 40d. R20.1: wrap msg.value ke WETH() → 0.
check("R20.1 40d wrap msg.value → WETH() → 0",
  d20(wrap39(`    function swapETHForExactTokens(uint256 amountOut) external payable returns (uint256) {
        if (amountOut > msg.value) revert TooLittle();
        (bool sent,) = WETH().call{value: msg.value}("");
        if (!sent) revert DepositFailed();
        return msg.value;
    }`)).length === 0);
// 40e. R20.1: unwrap-forward (tarik amountIn dari msg.sender, kirim ke to) → 0.
check("R20.1 40e unwrap-forward amountIn → 0",
  d20(wrap39(`    function swapExactTokensForETH(uint256 amountIn, address to) external returns (uint256) {
        IERC20(WETH()).safeTransferFrom(msg.sender, address(this), amountIn);
        IWETH(WETH()).withdraw(amountIn);
        (bool sent,) = to.call{value: amountIn}("");
        if (!sent) revert WithdrawFailed();
        return amountIn;
    }`)).length === 0);
// 40f. R20.1: drain murni (tanpa pull) TETAP → 1.
check("R20.1 40f drain tanpa pull → 1",
  d20(wrap39(`    function drain(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "f");
    }`)).length === 1);

// --- Seksi 41. Kalibrasi F10: one-hop forwarder -> dispatcher internal
// (residual review Kiro 17 Nov 2026, kasus (e); sesi 00:38 WIB 18 Nov).
// 41a. Bentuk persis F10: external execute(calls) -> _dispatch internal
// yang me-loop calls[i].target.call(calls[i].data) → 1 Medium one-hop.
check("F10 41a forwarder -> internal dispatcher → 1 Medium",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 1
  && d18(wrap39(`    function execute(bytes[] calldata calls) external {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`))[0].severityGuess === "Medium"
  && /one-hop/i.test(d18(wrap39(`    function execute(bytes[] calldata calls) external {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`))[0].evidence));
// 41b. Target tetap + data caller → 1 (posisi data kendali caller).
check("F10 41b target tetap + data caller → 1",
  d18(wrap39(`    function run(bytes calldata data) external {
        _exec(0x1111111111111111111111111111111111111111, data);
    }
    function _exec(address target, bytes memory payload) internal {
        (bool ok, ) = target.call(payload);
        require(ok, "f");
    }`)).length === 1);
// 41c. Data tetap + target caller → 1 (posisi target kendali caller).
check("F10 41c data tetap + target caller → 1",
  d18(wrap39(`    function run(address t) external {
        _exec(t, hex"00112233");
    }
    function _exec(address target, bytes memory payload) internal {
        (bool ok, ) = target.call(payload);
        require(ok, "f");
    }`)).length === 1);
// 41d. Argumen tetap semua (literal) → 0.
check("F10 41d argumen tetap → 0",
  d18(wrap39(`    function runFixed() external {
        _exec(0x1111111111111111111111111111111111111111, hex"00112233");
    }
    function _exec(address target, bytes memory payload) internal {
        (bool ok, ) = target.call(payload);
        require(ok, "f");
    }`)).length === 0);
// 41e. Forwarder ber-guard → 0.
check("F10 41e forwarder guarded → 0",
  d18(wrap39(`    function execute(bytes[] calldata calls) external onlyOwner {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 0);
// 41f. Dispatcher internal ber-guard → 0.
check("F10 41f dispatcher internal guarded → 0",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal onlyOwner {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 0);
// 41g. Alias lokal dari parameter (`cs = calls`) → 1.
check("F10 41g alias lokal parameter → 1",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        bytes[] memory cs = calls;
        _dispatch(cs);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 1);
// 41h. Kendali caller HANYA di posisi fee (bukan target/data) → 0.
check("F10 41h caller hanya di posisi fee → 0",
  d18(wrap39(`    function run(uint256 fee) external {
        _exec(0x1111111111111111111111111111111111111111, hex"00112233", fee);
    }
    function _exec(address target, bytes memory payload, uint256 fee) internal {
        (bool ok, ) = target.call(payload);
        require(ok, "f");
    }`)).length === 0);
// 41i. Rantai dua hop (external -> helper -> dispatcher) → 0 (batas).
check("F10 41i two-hop → 0 (batas diketahui)",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        _helper(calls);
    }
    function _helper(bytes[] memory calls) internal {
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 0);
// 41j. Named args → 0 (batas diketahui).
check("F10 41j named args → 0 (batas diketahui)",
  d18(wrap39(`    function run(address t, bytes calldata d) external {
        _exec({target: t, payload: d});
    }
    function _exec(address target, bytes memory payload) internal {
        (bool ok, ) = target.call(payload);
        require(ok, "f");
    }`)).length === 0);
// 41k. Sink assembly di dispatcher internal → 1.
check("F10 41k sink assembly internal → 1",
  d18(wrap39(`    function execute(address target, bytes calldata data) external {
        _execAsm(target, data);
    }
    function _execAsm(address target, bytes memory data) internal {
        assembly {
            let ok := call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0)
            if iszero(ok) { revert(0, 0) }
        }
    }`)).length === 1);
// 41l. Perangkap substring: `calls2` BUKAN `calls` → 0.
check("F10 41l substring calls2 → 0",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        bytes[] memory calls2 = new bytes[](0);
        _dispatch(calls2);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 0);
// 41m. Forwarder tanpa parameter + argumen state var → 0.
check("F10 41m forwarder tanpa param → 0",
  d18(wrap39(`    function execute(uint256 x) external {
        _run();
    }
    function _run() internal {
        (bool ok, ) = gateway.call(payload);
        require(ok, "f");
    }
    bytes public payload;`)).length === 0);
// 41n. D18 langsung + F10 TIDAK ganda: forwarder yang juga berisi sink
// langsung → tetap 1 kandidat (bukan 2).
check("F10 41n D18 langsung tidak ganda → 1",
  d18(wrap39(`    function execute(bytes[] calldata calls) external {
        (bool ok, ) = calls[0].target.call(calls[0].data);
        require(ok, "f");
        _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok2, ) = calls[i].target.call(calls[i].data);
            require(ok2, "fail");
        }
    }`)).length === 1);
// 41o. Parameter dispatcher tak bernama di posisi target: hanya posisi
// data yang dihitung — target caller saja → 0.
check("F10 41o target param tak bernama → 0",
  d18(wrap39(`    function run(address t) external {
        _exec(t, hex"00112233");
    }
    function _exec(address, bytes memory payload) internal {
        (bool ok, ) = address(0x1111111111111111111111111111111111111111).call(payload);
        require(ok, "f");
    }`)).length === 0);
// 41p. Parameter dispatcher tak bernama di posisi target, data caller → 1.
check("F10 41p data caller + target tak bernama → 1",
  d18(wrap39(`    function run(bytes calldata d) external {
        _exec(0x1111111111111111111111111111111111111111, d);
    }
    function _exec(address, bytes memory payload) internal {
        (bool ok, ) = address(0x1111111111111111111111111111111111111111).call(payload);
        require(ok, "f");
    }`)).length === 1);

// 41q. R18.3: data `new bytes(0)` = bytes kosong → 0 (bukan sink).
check("R18.3 41q new bytes(0) → 0",
  d18(wrap39(`    function pay(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}(new bytes(0));
        require(ok, "f");
    }`)).length === 0);
// 41r. R18.3: data `abi.encode()` = bytes kosong → 0.
check("R18.3 41r abi.encode() → 0",
  d18(wrap39(`    function pay(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}(abi.encode());
        require(ok, "f");
    }`)).length === 0);
// 41s. F10.1: data `abi.encodeCall(...)` = selector pinned → 0.
check("F10.1 41s encodeCall pinned → 0",
  d18(wrap39(`    address public mod;
    function fill(Order calldata o) external {
        _delegate(mod, abi.encodeCall(IMod.fill, (o)));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 0);
// 41t. F10.1: data `abi.encodeWithSignature("lit", ...)` → 0.
check("F10.1 41t encodeWithSignature literal → 0",
  d18(wrap39(`    address public mod;
    function fill(bytes calldata o) external {
        _delegate(mod, abi.encodeWithSignature("fillOrder(bytes)", o));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 0);
// 41u. F10.1: data `abi.encodeWithSelector(X.fn.selector, ...)` → 0.
check("F10.1 41u encodeWithSelector .selector → 0",
  d18(wrap39(`    address public mod;
    function fill(bytes calldata o) external {
        _delegate(mod, abi.encodeWithSelector(IMod.fill.selector, o));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 0);
// 41v. F10.1: selector dari VARIABEL (bukan pinned) → 1.
check("F10.1 41v encodeWithSelector variabel → 1",
  d18(wrap39(`    address public mod;
    function run(bytes4 sel, bytes calldata d) external {
        _exec(mod, abi.encodeWithSelector(sel, d));
    }
    function _exec(address target, bytes memory data) internal {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1);
// 41w. F10.1: data pinned TAPI target kendali caller → 1.
check("F10.1 41w pinned data + target caller → 1",
  d18(wrap39(`    function run(address to, Order calldata o) external {
        _delegate(to, abi.encodeCall(IMod.fill, (o)));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 1);
// 41x. VERBATIM Amply WrappedTokenGatewayV3.withdrawETH -> _safeTransferETH
// (kode nyata, sesi 18 Nov): dana milik caller sendiri → 0.
check("F10 41x verbatim Amply withdrawETH → 0",
  d18(wrap39(`    function withdrawETH(address, uint256 amount, address to) external {
        uint256 amountToWithdraw = amount;
        aWETH.transferFrom(msg.sender, address(this), amountToWithdraw);
        POOL.withdraw(address(WETH), amountToWithdraw, address(this));
        WETH.withdraw(amountToWithdraw);
        _safeTransferETH(to, amountToWithdraw);
    }
    function _safeTransferETH(address to, uint256 value) internal {
        (bool success, ) = to.call{value: value}(new bytes(0));
        require(success, "ETH_TRANSFER_FAILED");
    }`)).length === 0);
// 41y. VERBATIM Hyperbridge IntentGatewayV2.fillOrder -> _delegate
// (kode nyata, sesi 18 Nov): target modul tetap + selector fillOrder
// tetap → 0.
check("F10 41y verbatim Hyperbridge fillOrder → 0",
  d18(wrap39(`    address public intrinsicModule;
    function fillOrder(Order calldata order, FillOptions calldata options) public payable {
        bytes32 commitment = keccak256(abi.encode(order));
        bytes memory returned = _delegate(intrinsicModule, abi.encodeCall(IntrinsicModule.fillOrder, (order, options, commitment)));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory returned) {
        assembly ("memory-safe") {
            let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0)
            let size := returndatasize()
            returned := mload(0x40)
            returndatacopy(add(returned, 0x20), 0, size)
            if iszero(ok) { revert(add(returned, 0x20), size) }
            mstore(returned, size)
            mstore(0x40, add(add(returned, 0x20), and(add(size, 0x1f), not(0x1f))))
        }
    }`)).length === 0);

// --- Seksi 42. Kalibrasi wasit R10.2 atas review Kiro F10 (sesi 00:38 WIB
// 18 Nov 2026 — vonis Kiro NEEDS WORK, 26/26 kasus harness PASS; tiap
// temuan baru F1–F11 diverifikasi probe ke pipeline ASLI sebelum diadopsi).
// 42a. F1 TERBUKTI: multi-sink — forwarder hanya mengoper target caller,
// sink-1 tidak memakai param target, sink-2 memakai → 1.
check("R10.2 42a F1 multi-sink target-only → 1",
  d18(wrap39(`    function run(address t) external {
        _exec(t, hex"00112233");
    }
    function _exec(address target, bytes memory data) internal {
        (bool a, ) = gateway.call(data);
        require(a, "f");
        (bool b, ) = target.call(data);
        require(b, "f");
    }`)).length === 1);
// 42b. F2 TERBUKTI: struct diisi per-field lalu diteruskan → 1.
check("R10.2 42b F2 struct per-field → 1",
  d18(wrap39(`    function run(address to, bytes calldata data) external {
        Call memory c;
        c.to = to;
        c.data = data;
        _exec(c);
    }
    function _exec(Call memory c) internal {
        (bool ok, ) = c.to.call(c.data);
        require(ok, "f");
    }`)).length === 1);
// 42c. F3c TERBUKTI: overload — forwarder memanggil overload arity-1
// yang jinak; overload arity-2 (berbahaya) tidak boleh menular → 0.
check("R10.2 42c F3c overload FP → 0",
  d18(wrap39(`    function run(address t) external {
        _exec(t);
    }
    function _exec(address target) internal {
        (bool ok, ) = gateway.call(hex"0011");
        require(ok, "f");
    }
    function _exec(address target, bytes memory data) internal {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 0);
// 42d. F3d: overload — forwarder memanggil overload arity-2 yang
// berbahaya, dalam kedua urutan deklarasi → 1.
check("R10.2 42d F3d overload bahaya → 1",
  d18(wrap39(`    function run(address t, bytes calldata d) external {
        _exec(t, d);
    }
    function _exec(address target) internal {
        (bool ok, ) = gateway.call(hex"0011");
        require(ok, "f");
    }
    function _exec(address target, bytes memory data) internal {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1
  && d18(wrap39(`    function run(address t, bytes calldata d) external {
        _exec(t, d);
    }
    function _exec(address target, bytes memory data) internal {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }
    function _exec(address target) internal {
        (bool ok, ) = gateway.call(hex"0011");
        require(ok, "f");
    }`)).length === 1);
// 42e. F4a TERBUKTI: parameter bernama onlyIfSuccess tidak memicu guard.
check("R10.2 42e F4a param onlyIfSuccess → 1",
  d18(wrap39(`    function run(address target, bytes calldata data, bool onlyIfSuccess) external {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1);
// 42f. F4b TERBUKTI: parameter bernama auth tidak memicu guard.
check("R10.2 42f F4b param auth → 1",
  d18(wrap39(`    function run(address target, bytes calldata data, address auth) external {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1);
// 42g. Regresi F4: modifier onlyOwner ASLI tetap dikenali sebagai guard.
check("R10.2 42g modifier onlyOwner tetap guard → 0",
  d18(wrap39(`    function run(address target, bytes calldata data) external onlyOwner {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 0);
// 42h. F5a TERBUKTI: guard `_checkOwner()` OZ Ownable dikenali.
check("R10.2 42h F5a _checkOwner() → 0",
  d18(wrap39(`    function run(address target, bytes calldata data) external {
        _checkOwner();
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 0);
// 42i. F5b TERBUKTI: `require(owner() == msg.sender)` dikenali.
check("R10.2 42i F5b owner()==msg.sender → 0",
  d18(wrap39(`    function run(address target, bytes calldata data) external {
        require(owner() == msg.sender, "no");
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 0);
// 42j. F5c TERBUKTI: `require(isOperator[msg.sender])` dikenali.
check("R10.2 42j F5c isOperator[msg.sender] → 0",
  d18(wrap39(`    function run(address target, bytes calldata data) external {
        require(isOperator[msg.sender], "no");
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 0);
// 42k. F5c-negatif: `require(balances[msg.sender] > 0)` BUKAN guard.
check("R10.2 42k F5c-neg balances>0 → 1",
  d18(wrap39(`    function run(address target, bytes calldata data) external {
        require(balances[msg.sender] > 0, "no");
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1);
// 42l. F6a TERBUKTI: `abi.encodePacked(selector, ...)` pinned → 0.
check("R10.2 42l F6a encodePacked pinned → 0",
  d18(wrap39(`    address public mod;
    function fill(bytes calldata o) external {
        _delegate(mod, abi.encodePacked(IMod.fill.selector, o));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 0);
// 42m. F6b TERBUKTI: `bytes.concat(selector, ...)` pinned → 0.
check("R10.2 42m F6b bytes.concat pinned → 0",
  d18(wrap39(`    address public mod;
    function fill(bytes calldata o) external {
        _delegate(mod, bytes.concat(IMod.fill.selector, o));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 0);
// 42n. F6c-negatif: encodePacked selector variabel → 1.
check("R10.2 42n F6c-neg selector variabel → 1",
  d18(wrap39(`    address public mod;
    function fill(bytes4 sel, bytes calldata o) external {
        _delegate(mod, abi.encodePacked(sel, o));
    }
    function _delegate(address module, bytes memory data) internal returns (bytes memory) {
        assembly { let ok := delegatecall(gas(), module, add(data, 0x20), mload(data), 0, 0) if iszero(ok) { revert(0, 0) } }
    }`)).length === 1);
// 42o. F11 DITOLAK (artefak harness Kiro — pipeline men-strip komentar
// dulu): pemanggilan dispatcher yang dikomentari → 0.
check("R10.2 42o F11 panggil dikomentari → 0",
  d18(wrap39(`    function run(bytes[] calldata calls) external {
        // _dispatch(calls);
    }
    function _dispatch(bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, ) = calls[i].target.call(calls[i].data);
            require(ok, "fail");
        }
    }`)).length === 0);
// 42p. Regresi F4: parameter returns bernama auth tidak memicu guard.
check("R10.2 42p returns bernama auth → 1",
  d18(wrap39(`    function run(address target, bytes calldata data) external returns (bool auth) {
        (bool ok, ) = target.call(data);
        require(ok, "f");
        auth = ok;
    }`)).length === 1);
// 42q. Regresi F4: FUNGSI bernama `auth` tidak memicu guard.
check("R10.2 42q fungsi bernama auth → 1",
  d18(wrap39(`    function auth(address target, bytes calldata data) external {
        (bool ok, ) = target.call(data);
        require(ok, "f");
    }`)).length === 1);

// --- Seksi 43. Kalibrasi R19.2: `ident.balance` polos di D19
// full-balance-sweep (sesi 04:38 WIB 18 Nov 2026) — ident dikenali
// hanya bila TERBUKTI address-typed (param/lokal/state var bertipe
// address atau kontrak/interface di file ini); field struct tetap 0.
const wrap43 = (body, extra) => "pragma solidity ^0.8.20;\n" + (extra || "")
  + "contract T {\n    address public gateway;\n    address public pool;\n    address public owner;\n" + body + "\n}";
const IFACE43 = "interface IEscrow { function x() external; }\n";
const STRUCT43 = "struct Info { uint256 balance; }\n";
// 43a. State var address `pool.balance` via var perantara → 1.
check("R19.2 43a pool.balance via var → 1",
  d19(wrap38(`    function sweep(address token, address to) external {
        uint256 bal = pool.balance;
        IERC20(token).transfer(to, bal);
    }`)).length === 1);
// 43b. Param address `escrow.balance` langsung → 1.
check("R19.2 43b escrow.balance param → 1",
  d19(wrap38(`    function sweep(address escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }`)).length === 1);
// 43c. Param tipe interface `IEscrow escrow` + .balance → 1.
check("R19.2 43c IEscrow param .balance → 1",
  d19(wrap43(`    function sweep(IEscrow escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }`, IFACE43)).length === 1);
// 43d. NEGATIF: field struct `info.balance` (state var struct) → 0.
check("R19.2 43d info.balance struct → 0",
  d19(wrap43(`    Info public info;
    function f(address token, address to) external {
        IERC20(token).transfer(to, info.balance);
    }`, STRUCT43)).length === 0);
// 43e. NEGATIF: `msg.sender.balance` (saldo sendiri) → 0.
check("R19.2 43e msg.sender.balance → 0",
  d19(wrap38(`    function f(address token, address to) external {
        IERC20(token).transfer(to, msg.sender.balance);
    }`)).length === 0);
// 43f. NEGATIF: `address(this).balance` (saldo sendiri) → 0.
check("R19.2 43f address(this).balance → 0",
  d19(wrap38(`    function f(address token, address to) external {
        IERC20(token).transfer(to, address(this).balance);
    }`)).length === 0);
// 43g. Lokal `address esc` + `esc.balance` → 1.
check("R19.2 43g lokal address .balance → 1",
  d19(wrap38(`    function sweep(address token, address to) external {
        address esc = pool;
        IERC20(token).transfer(to, esc.balance);
    }`)).length === 1);
// 43h. NEGATIF: param struct `Info info` + `info.balance` → 0.
check("R19.2 43h param struct .balance → 0",
  d19(wrap43(`    function f(Info memory info, address token, address to) external {
        IERC20(token).transfer(to, info.balance);
    }`, STRUCT43)).length === 0);
// 43i. State var tipe interface `IEscrow escrow` + .balance → 1.
check("R19.2 43i IEscrow state var .balance → 1",
  d19(wrap43(`    IEscrow public escrow;
    function f(address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }`, IFACE43)).length === 1);
// 43j. Kontrol: `balanceOf` lama tetap → 1.
check("R19.2 43j balanceOf tetap → 1",
  d19(wrap38(`    function sweep(address token, address to) external {
        uint256 bal = IERC20(token).balanceOf(pool);
        IERC20(token).transfer(to, bal);
    }`)).length === 1);
// 43k. Bentuk `value:` Call struct memakai `pool.balance` → 1.
check("R19.2 43k value: pool.balance → 1",
  d19(wrap38(`    function f(address t) external {
        Call memory c = Call({target: t, value: pool.balance, data: ""});
        (bool ok, ) = c.target.call{value: c.value}(c.data);
        require(ok, "f");
    }`)).length === 1);
// 43l. NEGATIF: lokal struct `Info info` + `info.balance` → 0.
check("R19.2 43l lokal struct .balance → 0",
  d19(wrap43(`    function f(address token, address to) external {
        Info memory info = Info(1);
        IERC20(token).transfer(to, info.balance);
    }`, STRUCT43)).length === 0);
// 43m. NEGATIF: param array `address[] addrs` + `addrs.balance` → 0.
check("R19.2 43m address[] .balance → 0",
  d19(wrap38(`    function f(address[] calldata addrs, address token, address to) external {
        IERC20(token).transfer(to, addrs.balance);
    }`)).length === 0);
// 43n. R19.2a TERBUKTI (wasit A18): lokal struct `Info pool` menutupi
// state var `address pool` → `pool.balance` merujuk struct → 0.
check("R19.2a 43n lokal struct menutupi state var → 0",
  d19(wrap43(`    function f(address token, address to) external {
        Info memory pool = Info(1);
        IERC20(token).transfer(to, pool.balance);
    }`, STRUCT43)).length === 0);
// 43o. R19.2a: param struct `Info pool` menutupi state var address → 0.
check("R19.2a 43o param struct menutupi state var → 0",
  d19(wrap43(`    function f(Info memory pool, address token, address to) external {
        IERC20(token).transfer(to, pool.balance);
    }`, STRUCT43)).length === 0);
// 43p. Kontrol A20d: lokal `address pool` menutupi state var uint256 → 1.
check("R19.2a 43p lokal address menutupi uint256 → 1",
  d19("pragma solidity ^0.8.20;\ncontract T {\n    uint256 public pool;\n    function f(address token, address to) external {\n        address pool = msg.sender;\n        IERC20(token).transfer(to, pool.balance);\n    }\n}").length === 1);
// 43q. Cakupan per-fungsi (wasit A20b): `g` (param address) → 1,
// `f` (param struct senama) → 0; total tepat 1 dari `g`.
check("R19.2a 43q nama sama beda fungsi → 1 dari g",
  d19(wrap43(`    function g(address escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }
    function f(Info memory escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }`, STRUCT43)).length === 1
  && d19(wrap43(`    function g(address escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }
    function f(Info memory escrow, address token, address to) external {
        IERC20(token).transfer(to, escrow.balance);
    }`, STRUCT43))[0].location.function === "g");
// 43r. Guard wasit: `return pool;` BUKAN deklarasi — `pool.balance`
// state var tetap → 1.
check("R19.2a 43r return pool bukan bayangan → 1",
  d19(wrap38(`    function f(address token, address to) external returns (address) {
        uint256 bal = pool.balance;
        IERC20(token).transfer(to, bal);
        return pool;
    }`)).length === 1);

// --- Seksi 44. Kalibrasi R19.3: akses terindeks `BASE[i].balance` di D19
// full-balance-sweep (sesi 08:38 WIB 18 Nov 2026 — residual A16
// TERBUKTI: 5 bentuk genuine FN sebelum perbaikan). Elemen BASE harus
// TERBUKTI address-typed (address[] / mapping(K => address) /
// IContract[] — state var, param, atau lokal); elemen struct/uint
// tetap 0; deklarasi senama non-address menutupi base.
const wrap44 = (body, extra) => "pragma solidity ^0.8.20;\n" + (extra || "")
  + "contract T {\n    address public gateway;\n    address public pool;\n    address public owner;\n" + body + "\n}";
// 44a. State var `address[] pools` + `pools[0].balance` langsung → 1.
check("R19.3 44a state address[] pools[0].balance → 1",
  d19(wrap44(`    address[] public pools;
    function f(address token, address to) external {
        IERC20(token).transfer(to, pools[0].balance);
    }`)).length === 1);
// 44b. State var `mapping(uint256 => address)` + `pools[0].balance` → 1.
check("R19.3 44b mapping(uint=>address) pools[0].balance → 1",
  d19(wrap44(`    mapping(uint256 => address) public pools;
    function f(address token, address to) external {
        IERC20(token).transfer(to, pools[0].balance);
    }`)).length === 1);
// 44c. Param `address[] calldata addrs` + `addrs[0].balance` → 1.
check("R19.3 44c param address[] addrs[0].balance → 1",
  d19(wrap44(`    function f(address[] calldata addrs, address token, address to) external {
        IERC20(token).transfer(to, addrs[0].balance);
    }`)).length === 1);
// 44d. NEGATIF: `mapping(address => Info) infos[u].balance` = field struct → 0.
check("R19.3 44d mapping(address=>Info) infos[u].balance → 0",
  d19(wrap44(`    mapping(address => Info) public infos;
    function f(address user, address token, address to) external {
        IERC20(token).transfer(to, infos[user].balance);
    }`, STRUCT43)).length === 0);
// 44e. NEGATIF: `uint256[] amounts[0].balance` (elemen bukan address) → 0.
check("R19.3 44e uint256[] amounts[0].balance → 0",
  d19(wrap44(`    uint256[] public amounts;
    function f(address token, address to) external {
        IERC20(token).transfer(to, amounts[0].balance);
    }`)).length === 0);
// 44f. State var `IEscrow[] escrows` + `escrows[0].balance` → 1.
check("R19.3 44f state IEscrow[] escrows[0].balance → 1",
  d19(wrap44(`    IEscrow[] public escrows;
    function f(address token, address to) external {
        IERC20(token).transfer(to, escrows[0].balance);
    }`, IFACE43)).length === 1);
// 44g. Via var perantara: `bal = pools[i].balance` lalu transfer → 1.
check("R19.3 44g bal = pools[i].balance lalu transfer → 1",
  d19(wrap44(`    address[] public pools;
    function f(uint256 i, address token, address to) external {
        uint256 bal = pools[i].balance;
        IERC20(token).transfer(to, bal);
    }`)).length === 1);
// 44h. NEGATIF: `mapping(address => uint256) balances[u].balance` → 0.
check("R19.3 44h mapping(address=>uint256) balances[u].balance → 0",
  d19(wrap44(`    mapping(address => uint256) public balances;
    function f(address user, address token, address to) external {
        IERC20(token).transfer(to, balances[user].balance);
    }`)).length === 0);
// 44i. NEGATIF: lokal `uint256[] memory pools` menutupi state
// `address[] pools` → 0.
check("R19.3 44i lokal uint256[] menutupi state address[] → 0",
  d19(wrap44(`    address[] public pools;
    function f(address token, address to) external {
        uint256[] memory pools = new uint256[](1);
        IERC20(token).transfer(to, pools[0].balance);
    }`)).length === 0);
// 44j. NEGATIF: `mapping(uint256 => Info) infos[0].balance` = field struct → 0.
check("R19.3 44j mapping(uint=>Info) infos[0].balance → 0",
  d19(wrap44(`    mapping(uint256 => Info) public infos;
    function f(address token, address to) external {
        IERC20(token).transfer(to, infos[0].balance);
    }`, STRUCT43)).length === 0);
// 44k. Regresi R19.3: param array address TIDAK membayangi dirinya
// sendiri — `fn.body` memuat signature, jadi `calldata addrs` sempat
// terbaca sebagai deklarasi bertipe `calldata` (probe A16-3 gagal
// sebelum perbaikan ini; tanpa perbaikan, 44c = 0).
check("R19.3 44k regresi bayangan-calldata (44c ulang, eksplisit) → 1",
  d19(wrap44(`    function f(address[] calldata addrs, address token, address to) external {
        IERC20(token).transfer(to, addrs[0].balance);
    }`)).length === 1);

// --- Ringkasan
console.log("\n" + pass + " lolos, " + fail + " gagal.");
process.exit(fail ? 1 : 0);
