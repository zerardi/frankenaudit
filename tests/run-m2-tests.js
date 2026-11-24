// FrankenAudit — tests/run-m2-tests.js
// Uji ujung-ke-ujung M2 (tanpa dependensi): node tests/run-m2-tests.js
// Keluar 0 bila semua lolos, 1 bila ada yang gagal.
"use strict";
const fs = require("fs");
const path = require("path");
const { runPipeline, normalizeSlither, buildBaselineMap, runProjectPipeline, findDustSignalsInText, applyDustByDesign } = require("../app/pipeline.js");
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
  run31.ranked[0].id === "guardian:raac" && run31.ranked.length === 5,
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
  rep31.includes("5 lolos ke antrean") && rep31.includes("3 drop di qualifier"),
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
check("32j P11 ranked tetap RAAC 86,3 pertama, 5 entri",
  run32j.ranked.length === 5 && run32j.ranked[0].id === "guardian:raac"
  && run32j.ranked[0].score === 86.3,
  run32j.ranked.map((r) => r.id + "=" + r.score).join(", "));
check("32j P11 vonis 8 program tetap: 2 LAYAK / 3 KONFIRMASI / 3 DROP",
  run32j.results.filter((r) => r.gate.verdict === "LAYAK").length === 2
  && run32j.results.filter((r) => r.gate.verdict === "KONFIRMASI").length === 3
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
// 32l. Somm (sesi #50): program ke-8, terverifikasi 21 Nov 2026 —
// skor 75,8; vonis KONFIRMASI di auto DAN strict (izin pengujian agentic
// belum terbukti — halaman hanya menyebut testnet/simulasi + PoC minimal);
// unknownFields = kompetisi saja; TIDAK drop, TIDAK blacklist.
const somm32 = knownPrograms().find((p) => p.id === "selfhosted:somm");
const NOW50 = "2026-11-21T20:38:00+07:00"; // tanggal verifikasi Somm (bukan NOW31 — freshness 21 Nov di masa depan relatif 17 Nov → 0,2, kalibrasi R1 P7)
check("32l Somm: skor 75,8 + KONFIRMASI (auto + strict)",
  scoreProgram(somm32, NOW50).score === 75.8
  && gateProgram(somm32, "auto").verdict === "KONFIRMASI"
  && gateProgram(somm32, "strict").verdict === "KONFIRMASI",
  "skor=" + scoreProgram(somm32, NOW50).score
  + " auto=" + gateProgram(somm32, "auto").verdict
  + " strict=" + gateProgram(somm32, "strict").verdict);
check("32l Somm: alasan gate = izin agentic belum terbukti; unknownFields kompetisi",
  gateProgram(somm32, "auto").reasons.some((r) => /agentic/.test(r))
  && scoreProgram(somm32, NOW50).unknownFields.join(",") === "kompetisi"
  && scoreProgram(somm32, NOW50).dropped.length === 0,
  JSON.stringify(gateProgram(somm32, "auto").reasons)
  + " unknown=" + JSON.stringify(scoreProgram(somm32, NOW50).unknownFields));

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

// --- Seksi 45. Kalibrasi R18.4: dust-by-design (backlog detektor, sesi
// 12:38 WIB 18 Nov 2026 — H3 gugur: residu dispatcher terdokumentasi
// sebagai dust protokol → D18 Medium diturunkan ke Low, kandidat TETAP).
const DOCS_QUOTE_45 = "After execution, any tokens remaining in the `CallDispatcher` are swept back to the gateway and collected as dust (emitting `DustCollected` for each token).";
const DISPATCH45 = `    function dispatch(bytes memory encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory c = calls[i];
            (bool ok, ) = c.to.call{value: c.value}(c.data);
            require(ok, "fail");
        }
    }`;
// 45a. Regresi: dispatcher polos (tanpa sinyal dust) tetap 1 Medium.
check("R18.4 45a dispatcher polos → 1 Medium",
  d18(t38a).length === 1 && d18(t38a)[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(d18(t38a).map((c) => c.severityGuess)));
// 45b. Komentar dust-by-design di file yang sama + event DustCollected
// (aturan dua-sumber R18.4b: 1 sinyal saja tidak cukup) → Low.
const t45b = wrap38(`    // Residue is swept back and collected as dust.
    event DustCollected(address token, uint256 amount);
${DISPATCH45}`);
check("R18.4 45b komentar dust file-sama → Low + bukti",
  d18(t45b).length === 1 && d18(t45b)[0].severityGuess === "Low"
    && /dust-by-design/.test(d18(t45b)[0].evidence),
  "dapat " + JSON.stringify(d18(t45b).map((c) => c.severityGuess)));
// 45c. Event DustCollected di file yang sama + NatSpec dust (dua-sumber) → Low.
const t45c = wrap38(`    event DustCollected(address token, uint256 amount);
    /// @dev Sweep accumulated protocol dust to a beneficiary.
${DISPATCH45}`);
check("R18.4 45c event DustCollected file-sama → Low",
  d18(t45c).length === 1 && d18(t45c)[0].severityGuess === "Low",
  "dapat " + JSON.stringify(d18(t45c).map((c) => c.severityGuess)));
// 45d. NEGATIF: kata "dust" tanpa kata konteks → tetap Medium.
const t45d = wrap38(`    // dust is everywhere in this file.
${DISPATCH45}`);
check("R18.4 45d dust tanpa kata konteks → tetap Medium",
  d18(t45d).length === 1 && d18(t45d)[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(d18(t45d).map((c) => c.severityGuess)));
// 45e. Proyek: file kedua berisi sinyal dust + menyebut dispatcher → Low.
const proj45e = runProjectPipeline([
  { name: "CallDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "Gateway.sol",
    text: "pragma solidity ^0.8.20;\ncontract Gateway {\n"
      + "    address public dispatcher;\n"
      + "    event DustCollected(address token, uint256 amount);\n"
      + "    function _sweepDust(address token, address to) internal {\n"
      + "        emit DustCollected(token, 1);\n    }\n"
      + "    function execute(address d) external {\n"
      + "        ICallDispatcher(d).dispatch(\"\");\n    }\n}" },
]);
const c45e = proj45e.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45e sinyal dust lintas-file terikat → dispatch Low",
  c45e.length === 1 && c45e[0].severityGuess === "Low"
    && /dust-by-design/.test(c45e[0].evidence) && /Gateway\.sol/.test(c45e[0].evidence),
  "dapat " + JSON.stringify(c45e.map((c) => c.location.file + ":" + c.severityGuess)));
// 45f. NEGATIF proyek: file dust TIDAK menyebut dispatcher → Medium.
const proj45f = runProjectPipeline([
  { name: "CallDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "DustSweeper.sol",
    text: "pragma solidity ^0.8.20;\ncontract DustSweeper {\n"
      + "    event DustCollected(address token, uint256 amount);\n"
      + "    function sweepDust(address token, address to) external {\n"
      + "        emit DustCollected(token, 1);\n    }\n}" },
]);
const c45f = proj45f.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45f sinyal dust tak-terikat → tetap Medium",
  c45f.length === 1 && c45f[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c45f.map((c) => c.location.file + ":" + c.severityGuess)));
// 45g. docsText berisi kutipan overview.mdx:162 → Low. Kontrak kandidat
// HARUS bernama CallDispatcher — docs menyebut nama itu secara eksak;
// kontrak bernama lain (T) tidak terikat ke docs ini (R18.4b, ikatan (b)).
const DISPATCH45_CD = DISPATCH45;
const t45gSrc = "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n"
  + "    address public gateway;\n" + DISPATCH45_CD + "\n}";
const r45g = runPipeline(t45gSrc, "CallDispatcher.sol",
  { docsText: DOCS_QUOTE_45, docsLabel: "docs:overview.mdx" });
const c45g = r45g.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45g docsText kutipan dust → Low",
  c45g.length === 1 && c45g[0].severityGuess === "Low"
    && /docs:overview\.mdx/.test(c45g[0].evidence),
  "dapat " + JSON.stringify(c45g.map((c) => c.severityGuess)));
// 45h. NEGATIF: docsText tanpa dust → tetap Medium.
const r45h = runPipeline(t38a, "T.sol",
  { docsText: "The gateway executes orders via the dispatcher.", docsLabel: "docs:overview.mdx" });
const c45h = r45h.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45h docsText tanpa dust → tetap Medium",
  c45h.length === 1 && c45h[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c45h.map((c) => c.severityGuess)));
// 45i. F10 one-hop forwarder + komentar dust + event (dua-sumber) → Low.
const t45i = `pragma solidity ^0.8.20;
contract T {
    // Residue is swept back and collected as dust.
    event DustCollected(address token, uint256 amount);
    function _exec(address target, bytes memory data) internal {
        (bool ok, ) = target.call(data);
        require(ok, "fail");
    }
    function forward(address target, bytes memory data) external {
        _exec(target, data);
    }
}`;
const c45i = runPipeline(t45i, "T.sol").candidates
  .filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45i one-hop forwarder + dust → Low",
  c45i.length === 1 && c45i[0].severityGuess === "Low"
    && /dust-by-design/.test(c45i[0].evidence),
  "dapat " + JSON.stringify(c45i.map((c) => c.location.function + ":" + c.severityGuess)));
// 45j. NEGATIF: docsText dust tapi tanpa kata "dispatcher" → Medium.
const r45j = runPipeline(t38a, "T.sol",
  { docsText: "Any tokens remaining are swept back and collected as dust.", docsLabel: "docs:overview.mdx" });
const c45j = r45j.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45j docsText dust tanpa dispatcher → tetap Medium",
  c45j.length === 1 && c45j[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c45j.map((c) => c.severityGuess)));
// 45k. VERBATIM Hyperbridge: dispatch asli + kutipan IntentsBase asli
// (NatSpec SweepDust + event DustCollected + _sweepDust + penyebutan
// CallDispatcher) → dispatch Low dengan bukti dust-by-design.
const proj45k = runProjectPipeline([
  { name: "utils/CallDispatcher.sol",
    text: "pragma solidity ^0.8.17;\ncontract CallDispatcher {\n"
      + "    receive() external payable {}\n"
      + "    function dispatch(bytes memory encoded) external {\n"
      + "        Call[] memory calls = abi.decode(encoded, (Call[]));\n"
      + "        uint256 callsLen = calls.length;\n"
      + "        for (uint256 i = 0; i < callsLen; ++i) {\n"
      + "            Call memory call = calls[i];\n"
      + "            uint32 size;\n"
      + "            address to = call.to;\n"
      + "            assembly {\n"
      + "                size := extcodesize(to)\n"
      + "            }\n"
      + "            if (size == 0) {\n"
      + "                revert NotContract(to);\n"
      + "            }\n"
      + "            (bool success, bytes memory result) = to.call{value: call.value}(call.data);\n"
      + "            if (!success) revert CallFailed(to, result);\n"
      + "        }\n"
      + "    }\n}" },
  { name: "apps/intentsv2/IntentsBase.sol",
    text: "pragma solidity ^0.8.20;\ncontract IntentsBase {\n"
      + "    /**\n"
      + "     * @dev Sweep accumulated protocol dust to a beneficiary.\n"
      + "     */\n"
      + "    event DustCollected(address token, uint256 amount);\n"
      + "    event DustSwept(address token, uint256 amount, address beneficiary);\n"
      + "    /// @param predispatch The tokens sent to the CallDispatcher for pre-order execution.\n"
      + "    function _sweepDust(uint256 amount) internal {\n"
      + "        emit DustSwept(address(0), amount, msg.sender);\n"
      + "    }\n}" },
]);
const c45k = proj45k.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4 45k verbatim Hyperbridge dispatch → Low",
  c45k.length === 1 && c45k[0].severityGuess === "Low"
    && /dust-by-design/.test(c45k[0].evidence)
    && /IntentsBase\.sol/.test(c45k[0].evidence),
  "dapat " + JSON.stringify(c45k.map((c) => c.location.file + "#" + c.location.function + ":" + c.severityGuess)));

// --- Seksi 46. Kalibrasi R18.4b: regresi temuan Kiro F2–F15 atas R18.4
// (review crew sesi 12:38 WIB 18 Nov 2026 — harness H1–H9 9/9, vonis
// NEEDS WORK; F1 BENAR konservatif, didokumentasikan di 46o, tanpa fix).
const t46a = wrap38(`    function dispatch(bytes calldata encoded) external {
        require(1 > 0, "amount is dust, nothing left to dispatch");
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory c = calls[i];
            (bool ok, ) = c.to.call{value: c.value}(c.data);
            require(ok, "fail");
        }
    }`);
// 46a. F2: string literal kode berisi dust+left BUKAN dokumentasi → 0 sinyal, Medium.
check("R18.4b 46a F2 string literal dust -> 0 sinyal + Medium",
  findDustSignalsInText(t46a, "T.sol").length === 0
    && d18(t46a).length === 1 && d18(t46a)[0].severityGuess === "Medium",
  "dapat " + findDustSignalsInText(t46a, "T.sol").length + " sinyal");
// 46b. F3: kalimat docs ter-wrap 2 baris tetap tertangkap (per kalimat).
const DOCS46B = "After execution, tokens in the CallDispatcher are returned to the gateway and swept back as\n dust. Excess dust is collected by the protocol.";
check("R18.4b 46b F3 docs 2-baris -> sinyal >=2",
  findDustSignalsInText(DOCS46B, "docs", true).length >= 2,
  "dapat " + findDustSignalsInText(DOCS46B, "docs", true).length);
const r46b = runPipeline(t45gSrc, "CallDispatcher.sol",
  { docsText: DOCS46B, docsLabel: "docs:overview.mdx" });
const c46b = r46b.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46b F3 docs 2-baris + CallDispatcher -> Low",
  c46b.length === 1 && c46b[0].severityGuess === "Low",
  "dapat " + JSON.stringify(c46b.map((c) => c.severityGuess)));
// 46c. F4: "swept" kini cocok (dulu "sweep\\w*" melewatkan "swept").
check("R18.4b 46c F4 'are swept ... as dust' -> sinyal >=1",
  findDustSignalsInText("Tokens in the CallDispatcher are swept to the gateway as dust.", "docs", true).length >= 1);
// 46d. F5: "leftover" + "remainder" kini kata konteks.
check("R18.4b 46d F5 leftover + remainder -> sinyal",
  findDustSignalsInText("Any dust leftover in the CallDispatcher goes to the treasury.", "docs", true).length >= 1
    && findDustSignalsInText("Any remainder dust in the CallDispatcher is collected by the protocol.", "docs", true).length >= 1);
// 46e. F6: file dust yang hanya impor IDispatcher generik TIDAK terikat
// ke kandidat CallDispatcher (2 sinyal supaya yang diuji ikatannya, bukan jumlah).
const proj46e = runProjectPipeline([
  { name: "CallDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "SwapRouter.sol",
    text: "pragma solidity ^0.8.20;\nimport {IDispatcher} from \"./IDispatcher.sol\";\ncontract SwapRouter {\n"
      + "    // AMM rounding dust remaining in the pool is collected by LPs.\n"
      + "    // Excess dust is swept to the fee collector.\n"
      + "    function swap(address token, uint256 amount) external {}\n}" },
]);
const c46e = proj46e.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46e F6 sinyal file lain tanpa nama eksak -> tetap Medium",
  c46e.length === 1 && c46e[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c46e.map((c) => c.severityGuess)));
// 46f. F7: sebutan "Dispatcher" di kalimat lain tidak mengikat sinyal dust.
const proj46f = runProjectPipeline([
  { name: "CallDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "FeeModule.sol",
    text: "pragma solidity ^0.8.20;\ncontract FeeModule {\n"
      + "    /// @notice Fee dust remaining after bps rounding is kept by the treasury.\n"
      + "    /// @dev Called by the Dispatcher to settle fees.\n"
      + "    /// Surplus dust is collected by the treasury.\n"
      + "    function settle() external {}\n}" },
]);
const c46f = proj46f.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46f F7 dispatcher di kalimat lain -> tetap Medium",
  c46f.length === 1 && c46f[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c46f.map((c) => c.severityGuess)));
// 46g. F8: `import {DustCollector}` bukan bukti residu di-sweep → Medium.
const t46g = "pragma solidity ^0.8.20;\nimport {DustCollector} from './DustCollector.sol';\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}";
check("R18.4b 46g F8 import DustCollector -> 0 sinyal + Medium",
  findDustSignalsInText(t46g, "CallDispatcher.sol").length === 0
    && d18(t46g).length === 1 && d18(t46g)[0].severityGuess === "Medium",
  "dapat " + findDustSignalsInText(t46g, "CallDispatcher.sol").length + " sinyal");
// 46h. F9: negasi ("does NOT sweep dust" + DustSweepNotSupported) → 0 sinyal.
const t46h = "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n"
  + "    /// This dispatcher does NOT sweep dust; remaining tokens stay stuck.\n"
  + "    error DustSweepNotSupported();\n" + DISPATCH45 + "\n}";
check("R18.4b 46h F9 negasi -> 0 sinyal + Medium",
  findDustSignalsInText(t46h, "CallDispatcher.sol").length === 0
    && d18(t46h).length === 1 && d18(t46h)[0].severityGuess === "Medium",
  "dapat " + findDustSignalsInText(t46h, "CallDispatcher.sol").length + " sinyal");
// 46i. F10: file test/mock dikecualikan dari sinyal dust.
const proj46i = runProjectPipeline([
  { name: "CallDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract CallDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "test/mocks/MockDispatcher.t.sol",
    text: "pragma solidity ^0.8.20;\ncontract MockDispatcher {\n"
      + "    event DustCollected(address token, uint256 amount);\n"
      + "    function test_sweepDust() public {}\n}" },
]);
const c46i = proj46i.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46i F10 sinyal dari mock test -> tetap Medium",
  c46i.length === 1 && c46i[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c46i.map((c) => c.severityGuess)));
// 46j. F11: komentar identik 4x di-dedup — dulu 6 sinyal, kini 3
// (sweepDust + DustCollected + 1 prosa); severity tetap Low (2 sumber).
const t46j = wrap38(`    // sweepDust collects remaining dust
    // sweepDust collects remaining dust
    // sweepDust collects remaining dust
    // sweepDust collects remaining dust
    event DustCollected(address token, uint256 amount);
${DISPATCH45}`);
check("R18.4b 46j F11 dedup komentar identik -> 3 sinyal (bukan 6)",
  findDustSignalsInText(t46j, "T.sol").length === 3,
  "dapat " + findDustSignalsInText(t46j, "T.sol").length);
check("R18.4b 46j F11 pipeline tetap Low (2 sumber berbeda)",
  d18(t46j).length === 1 && d18(t46j)[0].severityGuess === "Low",
  "dapat " + JSON.stringify(d18(t46j).map((c) => c.severityGuess)));
// 46k. F12: "shift left by 8" — "left" telanjang bukan kata konteks → 0.
check("R18.4b 46k F12 'shift left' -> 0 sinyal",
  findDustSignalsInText("// shift left by 8 to avoid dust in fixed-point math", "X.sol").length === 0);
const t46k = wrap38(`    // shift left by 8 to avoid dust in fixed-point math
${DISPATCH45}`);
check("R18.4b 46k F12 pipeline tetap Medium",
  d18(t46k).length === 1 && d18(t46k)[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(d18(t46k).map((c) => c.severityGuess)));
// 46l. F13: sinyal menyebut CallDispatcher TIDAK mengikat kandidat
// BridgeDispatcher (nama eksak berbeda).
const proj46l = runProjectPipeline([
  { name: "BridgeDispatcher.sol",
    text: "pragma solidity ^0.8.20;\ncontract BridgeDispatcher {\n" + DISPATCH45 + "\n}" },
  { name: "apps/intentsv2/IntentsBase.sol",
    text: "pragma solidity ^0.8.20;\ncontract IntentsBase {\n"
      + "    /**\n"
      + "     * @dev Sweep accumulated protocol dust to a beneficiary.\n"
      + "     */\n"
      + "    event DustCollected(address token, uint256 amount);\n"
      + "    event DustSwept(address token, uint256 amount, address beneficiary);\n"
      + "    /// @param predispatch The tokens sent to the CallDispatcher for pre-order execution.\n"
      + "    function _sweepDust(uint256 amount) internal {\n"
      + "        emit DustSwept(address(0), amount, msg.sender);\n"
      + "    }\n}" },
]);
const c46l = proj46l.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46l F13 nama dispatcher beda -> tetap Medium",
  c46l.length === 1 && c46l[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c46l.map((c) => c.severityGuess)));
// 46m. F14/F15: kandidat tanpa toVerify/evidence/impact tidak crash;
// severity diubah terakhir; evidence bukan "undefined ...".
const sig46m = (function () {
  const { collectDustSignals } = require("../app/pipeline.js");
  return collectDustSignals([
    { name: "Gateway.sol",
      text: "pragma solidity ^0.8.20;\ncontract Gateway {\n"
        + "    address public dispatcher;\n"
        + "    event DustCollected(address token, uint256 amount);\n"
        + "    function _sweepDust(address token, address to) internal {\n"
        + "        emit DustCollected(token, 1);\n"
        + "    }\n"
        + "    function execute(address d) external {\n"
        + "        ICallDispatcher(d).dispatch(\"\");\n"
        + "    }\n}" },
  ]);
})();
const c46m = [{ detector: "permissionless-dispatcher", severityGuess: "Medium" }];
let threw46m = false;
try { applyDustByDesign(c46m, sig46m, "CallDispatcher.sol", new Set(["CallDispatcher"])); }
catch (e) { threw46m = true; }
check("R18.4b 46m F14/F15 kandidat tanpa field tidak crash + Low",
  !threw46m && c46m[0].severityGuess === "Low"
    && typeof c46m[0].evidence === "string" && !/undefined/.test(c46m[0].evidence)
    && Array.isArray(c46m[0].toVerify),
  threw46m ? "throw" : JSON.stringify(c46m[0].severityGuess));
// 46n. F3+F4 (saran Kiro 11): kutipan H3 di-wrap 2 baris tetap turun ke Low.
const DOCS46N = "After execution, any tokens remaining in the `CallDispatcher` are swept back to the gateway and collected as\n dust (emitting `DustCollected` for each token).";
const r46n = runPipeline(t45gSrc, "CallDispatcher.sol",
  { docsText: DOCS46N, docsLabel: "docs:overview.mdx" });
const c46n = r46n.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R18.4b 46n kutipan H3 wrap 2-baris -> Low",
  c46n.length === 1 && c46n[0].severityGuess === "Low",
  "dapat " + JSON.stringify(c46n.map((c) => c.severityGuess)));
// 46o. F1 (BENAR, konservatif, tanpa fix): identifier "withdrawDust"
// tanpa sweep/collect bukan sinyal — didokumentasikan sebagai batas.
check("R18.4b 46o F1 withdrawDust saja -> 0 sinyal (batas diketahui)",
  findDustSignalsInText("uint256 public dustBalance; function withdrawDust(address to) external {}", "X.sol").length === 0);

// --- Seksi 47. Kalibrasi R19.4: tipe kontrak/interface dari import di D19
// (residual A17/A19, sesi 16:38 WIB 18 Nov 2026 — probe wasit 8/8).
// Tipe import dikenali bila didefinisikan di korpus proyek (gabungan
// nama tipe runProjectPipeline) atau bernama interface standar ERC
// (allowlist di isAddressTypeName); struct senama tetap menang.
const d19p = (files) => runProjectPipeline(files).candidates
  .filter((c) => c.detector === "full-balance-sweep");
const IFACE47 = "interface IERC20 { function balanceOf(address a) external view returns (uint256); }";
const IVAULT47 = "interface IVault { function getPrice() external view returns (uint256); }";
// 47a. A19 literal, mode proyek: IERC20 di file lain + `token.balance` → 1.
check("R19.4 47a proyek IERC20 token.balance -> 1",
  d19p([
    { name: "IERC20.sol", text: IFACE47 },
    { name: "Sweeper.sol", text: "import \"./IERC20.sol\";\ncontract Sweeper {\n"
      + "    function sweep(IERC20 token, address to) external {\n"
      + "        IERC20(token).transfer(to, token.balance);\n    }\n}" },
  ]).length === 1);
// 47b. Kontrol: param `address token` → 1.
check("R19.4 47b kontrol address token.balance -> 1",
  d19p([
    { name: "Sweeper.sol", text: "contract Sweeper {\n"
      + "    function sweep(address token, address to) external {\n"
      + "        IERC20(token).transfer(to, token.balance);\n    }\n}" },
  ]).length === 1);
// 47c. A17: IVault di file lain + `vault.balance` polos → 1.
check("R19.4 47c proyek IVault vault.balance -> 1",
  d19p([
    { name: "IVault.sol", text: IVAULT47 },
    { name: "Drain.sol", text: "import \"./IVault.sol\";\ncontract Drain {\n"
      + "    function drain(IVault vault, address to) external {\n"
      + "        IERC20(address(vault)).transfer(to, vault.balance);\n    }\n}" },
  ]).length === 1);
// 47d. Bentuk terindeks: param `IERC20[] tokens` + `tokens[0].balance` → 1.
check("R19.4 47d proyek IERC20[] tokens[0].balance -> 1",
  d19p([
    { name: "IERC20.sol", text: IFACE47 },
    { name: "Sweeper.sol", text: "import \"./IERC20.sol\";\ncontract Sweeper {\n"
      + "    function sweepMany(IERC20[] calldata tokens, address to) external {\n"
      + "        IERC20(tokens[0]).transfer(to, tokens[0].balance);\n    }\n}" },
  ]).length === 1);
// 47e. Penjaga struct: struct lokal bernama IERC20 menutupi interface
// file lain — `info.balance` adalah field struct → 0.
check("R19.4 47e struct lokal IERC20 menutupi -> 0",
  d19p([
    { name: "IERC20.sol", text: IFACE47 },
    { name: "Holder.sol", text: "import \"./IERC20.sol\";\ncontract Holder {\n"
      + "    struct IERC20 { uint256 balance; }\n"
      + "    function sweep(IERC20 memory info, address to) external {\n"
      + "        IERC20(address(0)).transfer(to, info.balance);\n    }\n}" },
  ]).length === 0);
// 47f. Mode single-file: IVault (bukan allowlist) tetap konservatif 0.
check("R19.4 47f single-file IVault vault.balance -> 0",
  d19("import \"./IVault.sol\";\ncontract Drain {\n"
    + "    function drain(IVault vault, address to) external {\n"
    + "        IERC20(address(vault)).transfer(to, vault.balance);\n    }\n}").length === 0);
// 47g. Allowlist: IERC20 dikenali walau tidak ada di korpus sama sekali
// (kasus nyata: IERC20 dari OZ, dependencies dikecualikan dari korpus).
check("R19.4 47g single-file IERC20 token.balance -> 1 (allowlist)",
  d19("contract Sweeper {\n"
    + "    function sweep(IERC20 token, address to) external {\n"
    + "        IERC20(token).transfer(to, token.balance);\n    }\n}").length === 1);
// 47h. Allowlist tidak menembus struct lokal: struct IERC20 di file ini.
check("R19.4 47h single-file struct IERC20 menutupi -> 0",
  d19("contract Holder {\n"
    + "    struct IERC20 { uint256 balance; }\n"
    + "    function sweep(IERC20 memory info, address to) external {\n"
    + "        IERC20(address(0)).transfer(to, info.balance);\n    }\n}").length === 0);
// 47i. Penjaga R18.4b: `dispatcherNames` tetap dari set LOKAL — dua sinyal
// dust di file B yang menyebut kontrak file B (DustVault) TIDAK mengikat
// kandidat D18 di file A (kontrak Vault) → tetap Medium. (Bila set
// gabungan proyek dipakai di sana, kedua sinyal terikat → Low palsu.)
const proj47i = runProjectPipeline([
  { name: "A.sol", text: "pragma solidity ^0.8.20;\ncontract Vault {\n"
    + "    function dispatch(bytes calldata encoded) external {\n"
    + "        Call[] memory calls = abi.decode(encoded, (Call[]));\n"
    + "        for (uint256 i = 0; i < calls.length; ++i) {\n"
    + "            Call memory c = calls[i];\n"
    + "            (bool ok, ) = c.to.call{value: c.value}(c.data);\n"
    + "            require(ok, \"fail\");\n        }\n    }\n}" },
  { name: "B.sol", text: "pragma solidity ^0.8.20;\ncontract DustVault {\n"
    + "    // Sweep dust from DustVault to treasury.\n"
    + "    // DustVault keeps leftover dust for the protocol.\n"
    + "    function x() external {}\n}" },
]);
const c47i = proj47i.candidates.filter((c) => c.detector === "permissionless-dispatcher");
check("R19.4 47i sinyal dust file lain tidak ikat D18 -> Medium",
  c47i.length === 1 && c47i[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(c47i.map((c) => c.severityGuess)));

// --- Seksi 48. Detektor ke-21: empty-sublist-proof-advances-height (K-1)
const d21 = (src) => runPipeline(src, "d21.sol").candidates
  .filter((c) => c.detector === "empty-sublist-proof-advances-height");
// 48a. Bentuk ringkas EcdsaBeefy: gerbang len>0 + verify + height maju +
// stale no-op → 1 Low di verifyParachainHeaders.
const BEEFY48 = "pragma solidity ^0.8.20;\ncontract BeefyTrap {\n"
  + "    struct State { uint256 latestHeight; }\n"
  + "    struct Proof { uint256 blockNumber; bytes32[] parachains; bytes proof; }\n"
  + "    State public st;\n"
  + "    function verifyProof(bytes32 r, bytes memory p, bytes32[] memory l) internal pure returns (bool) { return true; }\n"
  + "    function verifyParachainHeaders(bytes32 headsRoot, Proof memory proof) internal returns (uint256) {\n"
  + "        uint256 len = proof.parachains.length;\n"
  + "        bytes32[] memory leaves = new bytes32[](len);\n"
  + "        for (uint256 i = 0; i < len; i++) { leaves[i] = proof.parachains[i]; }\n"
  + "        if (len > 0) {\n"
  + "            require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n"
  + "        }\n"
  + "        return len;\n"
  + "    }\n"
  + "    function verify(bytes memory prev, Proof memory proof) external returns (bytes memory) {\n"
  + "        State memory s = abi.decode(prev, (State));\n"
  + "        if (s.latestHeight >= proof.blockNumber) { return prev; }\n"
  + "        verifyParachainHeaders(bytes32(0), proof);\n"
  + "        s.latestHeight = proof.blockNumber;\n"
  + "        return abi.encode(s);\n"
  + "    }\n}";
const c48a = d21(BEEFY48);
check("D21 48a bentuk K-1 -> 1 Low di verifyParachainHeaders",
  c48a.length === 1 && c48a[0].severityGuess === "Low"
    && c48a[0].location.function === "verifyParachainHeaders",
  "dapat " + JSON.stringify(c48a.map((c) => c.location.function + ":" + c.severityGuess)));
// 48b. Penjaga require(len > 0) sebelum gerbang → daftar kosong revert → 0.
check("D21 48b require(len > 0) -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        require(len > 0, \"empty\");\n        if (len > 0) {")).length === 0);
// 48c. Penjaga `if (len == 0) revert` sebelum gerbang → 0.
check("D21 48c if (len == 0) revert -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        if (len == 0) revert EmptyProof();\n        if (len > 0) {")).length === 0);
// 48d. Verifikasi bergaris panjang tapi TIDAK ada kemajuan height → 0.
check("D21 48d tanpa kemajuan height -> 0",
  d21(BEEFY48.replace("        s.latestHeight = proof.blockNumber;\n", "")).length === 0);
// 48e. Verifikasi TIDAK bergaris panjang (dipanggil tanpa syarat) → 0.
check("D21 48e verifikasi tanpa gerbang len -> 0",
  d21(BEEFY48.replace("        if (len > 0) {\n            require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n        }\n",
    "        require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n")).length === 0);
// 48f. Gerbang `len > 0` di sekitar BUKAN verifikasi → 0.
check("D21 48f gerbang tanpa panggilan verify -> 0",
  d21(BEEFY48.replace("require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");",
    "leaves[0] = bytes32(uint256(1));")).length === 0);
// 48g. Cabang `else revert` sesudah gerbang → daftar kosong revert → 0.
check("D21 48g else revert -> 0",
  d21(BEEFY48.replace("        }\n        return len;",
    "        } else { revert EmptyProof(); }\n        return len;")).length === 0);
// 48h. Bentuk langsung `<list>.length > 0` tanpa variabel len → 1.
check("D21 48h bentuk langsung .length > 0 -> 1",
  d21(BEEFY48
    .replace("        uint256 len = proof.parachains.length;\n", "")
    .replace("        bytes32[] memory leaves = new bytes32[](len);",
      "        bytes32[] memory leaves = new bytes32[](proof.parachains.length);")
    .replace("        for (uint256 i = 0; i < len; i++) { leaves[i] = proof.parachains[i]; }",
      "        for (uint256 i = 0; i < proof.parachains.length; i++) { leaves[i] = proof.parachains[i]; }")
    .replace("        if (len > 0) {", "        if (proof.parachains.length > 0) {")
    .replace("        return len;", "        return proof.parachains.length;")).length === 1);
// 48i. Stale-check yang revert (bukan return) tetap sensor → 1.
check("D21 48i stale-check revert -> 1",
  d21(BEEFY48.replace("if (s.latestHeight >= proof.blockNumber) { return prev; }",
    "if (s.latestHeight >= proof.blockNumber) { revert Stale(); }")).length === 1);
// 48j. File nyata EcdsaBeefy.sol (verbatim, Hyperbridge @ 3cd7d227) → 1 Low.
const ecdsaPath = path.join(__dirname, "..", "..", "..", "work",
  "hyperbridge-flow", "hyperbridge", "evm", "src", "consensus", "EcdsaBeefy.sol");
const ecdsaSrc = fs.readFileSync(ecdsaPath, "utf8");
const c48j = runPipeline(ecdsaSrc, "EcdsaBeefy.sol").candidates
  .filter((c) => c.detector === "empty-sublist-proof-advances-height");
check("D21 48j EcdsaBeefy verbatim -> 1 Low",
  c48j.length === 1 && c48j[0].severityGuess === "Low",
  "dapat " + JSON.stringify(c48j.map((c) => c.location.function + ":" + c.severityGuess)));

// --- Seksi 48b. Kalibrasi R21.1: review Kiro Opus 5.5 atas D21 (sesi
// 8da7a082, vonis NEEDS WORK — 42 kasus: 8 benar, 15 FP, 19 FN; probe
// wasit /tmp/probe-d21.js membuktikan 22/24 klaim, N15 sudah lolos).
// 48b-1..14: FP Kiro (harap 0). 48b-15..31: FN Kiro (harap 1).
check("D21 48b-1 G03 require(list.length>0) -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        require(proof.parachains.length > 0);\n        if (len > 0) {")).length === 0);
check("D21 48b-2 G04 gerbang .length>0 + require(.length>0) -> 0",
  d21(BEEFY48
    .replace("        uint256 len = proof.parachains.length;",
      "        uint256 len = proof.parachains.length;\n        require(proof.parachains.length > 0);")
    .replace("        if (len > 0) {", "        if (proof.parachains.length > 0) {")).length === 0);
check("D21 48b-3 G05 assert(len>0) -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        assert(len > 0);\n        if (len > 0) {")).length === 0);
check("D21 48b-4 G06 if(len==0){revert} -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        if (len == 0) { revert Empty(); }\n        if (len > 0) {")).length === 0);
check("D21 48b-5 G07 require(len!=0) -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        require(len != 0);\n        if (len > 0) {")).length === 0);
check("D21 48b-6 G08 if(len<1) revert -> 0",
  d21(BEEFY48.replace("        if (len > 0) {",
    "        if (len < 1) revert Empty();\n        if (len > 0) {")).length === 0);
check("D21 48b-7 G09 guard di caller verify() -> 0",
  d21(BEEFY48.replace("        verifyParachainHeaders(bytes32(0), proof);",
    "        require(proof.parachains.length > 0);\n        verifyParachainHeaders(bytes32(0), proof);")).length === 0);
check("D21 48b-8 G10 else revert tanpa kurawal -> 0",
  d21(BEEFY48.replace("        }\n        return len;",
    "        } else revert Empty();\n        return len;")).length === 0);
check("D21 48b-9 G11 else + komentar di antaranya -> 0",
  d21(BEEFY48.replace("        }\n        return len;",
    "        } /* empty list is an error */ else { revert Empty(); }\n        return len;")).length === 0);
check("D21 48b-10 G12 var len$ (escape RegExp) -> 0",
  d21("pragma solidity ^0.8.20;\ncontract G12 {\n"
    + "    struct State { uint256 latestHeight; }\n"
    + "    struct Proof { uint256 blockNumber; bytes32[] parachains; bytes proof; }\n"
    + "    function verifyProof(bytes32 r, bytes memory p, bytes32[] memory l) internal pure returns (bool) { return true; }\n"
    + "    function go(bytes32 h, Proof memory proof) internal returns (uint256) {\n"
    + "        uint256 len$ = proof.parachains.length;\n"
    + "        require(len$ > 0);\n"
    + "        if (len$ > 0) { require(verifyProof(h, proof.proof, new bytes32[](len$)), \"bad\"); }\n"
    + "        return len$;\n"
    + "    }\n"
    + "    function verify(bytes memory prev, Proof memory proof) external returns (bytes memory) {\n"
    + "        State memory s = abi.decode(prev, (State));\n"
    + "        if (s.latestHeight >= proof.blockNumber) { return prev; }\n"
    + "        go(bytes32(0), proof);\n"
    + "        s.latestHeight = proof.blockNumber;\n"
    + "        return abi.encode(s);\n"
    + "    }\n}").length === 0);
check("D21 48b-11 G13 height maju DI DALAM gerbang -> 0",
  d21(BEEFY48
    .replace("        s.latestHeight = proof.blockNumber;\n", "")
    .replace("        if (len > 0) {\n            require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n        }",
      "        if (len > 0) {\n            require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n            s.latestHeight = proof.blockNumber;\n        }")).length === 0);
check("D21 48b-12 G16 tiga fungsi tak berhubungan -> 0",
  d21("pragma solidity ^0.8.20;\ncontract Sep {\n"
    + "    struct Cfg { uint256 latestHeight; }\n"
    + "    Cfg public cfg;\n"
    + "    function claim(bytes32[] memory proofs, bytes memory p) external {\n"
    + "        if (proofs.length > 0) { require(MerkleProof.verify(p, proofs)); }\n"
    + "    }\n"
    + "    function setHeight(uint256 h) external { cfg.latestHeight = h; }\n"
    + "    function poke(uint256 blockNumber) external returns (bool) {\n"
    + "        if (cfg.latestHeight >= blockNumber) { return false; }\n"
    + "        return true;\n"
    + "    }\n}").length === 0);
check("D21 48b-13 G17 emit VerifyRequested -> 0",
  d21(BEEFY48.replace("require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");",
    "emit VerifyRequested(len);")).length === 0);
check("D21 48b-14 G18 deklarasi multi-baris bukan advance -> 0",
  d21("pragma solidity ^0.8.20;\ncontract DeclTrap {\n"
    + "    struct State { uint256 latestHeight; }\n"
    + "    struct Proof { uint256 blockNumber; bytes32[] parachains; bytes proof; }\n"
    + "    function verifyProof(bytes32 r, bytes memory p, bytes32[] memory l) internal pure returns (bool) { return true; }\n"
    + "    function verifyParachainHeaders(bytes32 headsRoot, Proof memory proof) internal returns (uint256) {\n"
    + "        uint256 len = proof.parachains.length;\n"
    + "        if (len > 0) { require(verifyProof(headsRoot, proof.proof, new bytes32[](len)), \"bad\"); }\n"
    + "        return len;\n"
    + "    }\n"
    + "    uint256 public\n"
    + "        latestHeight = 1;\n"
    + "    function verify(bytes memory prev, Proof memory proof) external returns (bytes memory) {\n"
    + "        State memory s = abi.decode(prev, (State));\n"
    + "        if (s.latestHeight >= proof.blockNumber) { return prev; }\n"
    + "        verifyParachainHeaders(bytes32(0), proof);\n"
    + "        return abi.encode(s);\n"
    + "    }\n}").length === 0);
check("D21 48b-15 N01 if(len!=0) -> 1",
  d21(BEEFY48.replace("if (len > 0) {", "if (len != 0) {")).length === 1);
check("D21 48b-16 N02 if(len>=1) -> 1",
  d21(BEEFY48.replace("if (len > 0) {", "if (len >= 1) {")).length === 1);
check("D21 48b-17 N03 if tanpa kurawal -> 1",
  d21(BEEFY48.replace("        if (len > 0) {\n            require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");\n        }",
    "        if (len > 0) require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");")).length === 1);
check("D21 48b-18 N04 0<.length -> 1",
  d21(BEEFY48.replace("if (len > 0) {", "if (0 < proof.parachains.length) {")).length === 1);
check("D21 48b-19 N05 calculateRoot sbg verifikasi -> 1",
  d21(BEEFY48.replace("require(verifyProof(headsRoot, proof.proof, leaves), \"bad\");",
    "require(calculateRoot(proof.proof, leaves) == headsRoot, \"bad\");")).length === 1);
check("D21 48b-20 N06 paras(proof).length -> 1",
  d21(BEEFY48.replace("uint256 len = proof.parachains.length;",
    "uint256 len = paras(proof).length;")).length === 1);
check("D21 48b-21 N10 var newHeight dari blockNumber -> 1",
  d21(BEEFY48.replace("        if (s.latestHeight >= proof.blockNumber) { return prev; }",
    "        uint256 newHeight = proof.blockNumber;\n        if (s.latestHeight >= newHeight) { return prev; }")).length === 1);
check("D21 48b-22 N11 stale if-revert tanpa kurawal -> 1",
  d21(BEEFY48.replace("if (s.latestHeight >= proof.blockNumber) { return prev; }",
    "if (s.latestHeight >= proof.blockNumber) revert Stale();")).length === 1);
check("D21 48b-23 N12 require(blockNumber>latestHeight) -> 1",
  d21(BEEFY48.replace("        if (s.latestHeight >= proof.blockNumber) { return prev; }\n",
    "        require(proof.blockNumber > s.latestHeight, \"stale\");\n")).length === 1);
check("D21 48b-24 N13 stale terbalik <= -> 1",
  d21(BEEFY48.replace("if (s.latestHeight >= proof.blockNumber) { return prev; }",
    "if (proof.blockNumber <= s.latestHeight) { return prev; }")).length === 1);
check("D21 48b-25 N14 latestHeight += 1 -> 1",
  d21(BEEFY48.replace("        s.latestHeight = proof.blockNumber;",
    "        s.latestHeight += 1;")).length === 1);
check("D21 48b-26 N15 if(ok) latestHeight=... -> 1",
  d21(BEEFY48.replace("        s.latestHeight = proof.blockNumber;",
    "        if (true) s.latestHeight = proof.blockNumber;")).length === 1);
check("D21 48b-27 N16 struct literal latestHeight: blockNumber -> 1",
  d21(BEEFY48.replace("        s.latestHeight = proof.blockNumber;\n        return abi.encode(s);",
    "        return abi.encode(State({latestHeight: proof.blockNumber}));")).length === 1);
check("D21 48b-28 N17 if(ok){ s.latestHeight=...; } -> 1",
  d21(BEEFY48.replace("        s.latestHeight = proof.blockNumber;",
    "        if (true) { s.latestHeight = proof.blockNumber; }")).length === 1);
check("D21 48b-29 N20 gerbang && gabungan -> 1",
  d21(BEEFY48.replace("if (len > 0) {", "if (len > 0 && proof.proof.length > 0) {")).length === 1);
check("D21 48b-30 N21 p.length 1-huruf -> 1",
  d21(BEEFY48
    .replace("uint256 len = proof.parachains.length;",
      "bytes32[] memory p = proof.parachains;\n        uint256 len = p.length;")
    .replace("for (uint256 i = 0; i < len; i++) { leaves[i] = proof.parachains[i]; }",
      "for (uint256 i = 0; i < len; i++) { leaves[i] = p[i]; }")).length === 1);
check("D21 48b-31 N07 latestBlock sbg nama height -> 1",
  d21(BEEFY48.replace(/latestHeight/g, "latestBlock")).length === 1);
check("D21 48b-32 G14 stale-check `>` saja -> 0 (blok sama lolos)",
  d21(BEEFY48.replace("if (s.latestHeight >= proof.blockNumber)",
    "if (s.latestHeight > proof.blockNumber)")).length === 0);
check("D21 48b-33 F6 toVerify menyebut ikatan komitmen daftar kosong",
  c48a.length === 1 && c48a[0].toVerify.some((t) => /terikat ke komitmen/.test(t)));
check("D21 48b-34 N18 gerbang di modifier -> 1 (fungsi = nama kontrak)",
  d21("pragma solidity ^0.8.20;\ncontract ModTrap {\n"
    + "    struct State { uint256 latestHeight; }\n"
    + "    struct Proof { uint256 blockNumber; bytes32[] parachains; bytes proof; }\n"
    + "    State public st;\n"
    + "    function verifyProof(bytes32 r, bytes memory p, bytes32[] memory l) internal pure returns (bool) { return true; }\n"
    + "    modifier paraChecked(bytes32 headsRoot, Proof memory proof) {\n"
    + "        uint256 len = proof.parachains.length;\n"
    + "        if (len > 0) { require(verifyProof(headsRoot, proof.proof, new bytes32[](len)), \"bad\"); }\n"
    + "        _;\n"
    + "    }\n"
    + "    function verify(bytes memory prev, Proof memory proof) external paraChecked(bytes32(0), proof) returns (bytes memory) {\n"
    + "        State memory s = abi.decode(prev, (State));\n"
    + "        if (s.latestHeight >= proof.blockNumber) { return prev; }\n"
    + "        s.latestHeight = proof.blockNumber;\n"
    + "        return abi.encode(s);\n"
    + "    }\n}").length === 1);

// --- Seksi 49. Kalibrasi R-COF-1: interface-trimming di commented-out-function
// (sesi #33, 19 Nov 2026 — residual hunting Veno: ISavingsDai.sol 32 FP).
// Aturan: kandidat commented-out-function dari file interface-only dibuang
// BILA baseline tidak membuktikan fungsi itu ada di upstream; dipertahankan
// bila klasifikasi live-identical / live-divergent / live-modified.
const cofCount = (src, name, opts) => runPipeline(src, name, opts).candidates
  .filter((c) => c.detector === "commented-out-function").length;
const trimIface = `pragma solidity ^0.8.20;
interface ITrimmed {
    function liveA(uint256) external view returns (uint256);
    // function deadA(address) external view returns (uint256);
    // function deadB(address, uint256) external returns (bool);
    function liveB(uint256) external returns (uint256);
    // function deadC() external;
}`;
check("COF 49-1 interface-only tanpa baseline -> 0 (trimming sDAI)",
  cofCount(trimIface, "ITrimmed.sol") === 0);
check("COF 49-2 interface-only + baseline absent -> 0",
  cofCount(trimIface, "ITrimmed.sol",
    { baseline: { "ITrimmed.sol": "pragma solidity ^0.8.20;\ninterface ITrimmed {\n    function liveA(uint256) external view returns (uint256);\n    function liveB(uint256) external returns (uint256);\n}" } }) === 0);
check("COF 49-3 interface-only + baseline live-identical -> 3 dipertahankan",
  cofCount(trimIface, "ITrimmed.sol",
    { baseline: { "ITrimmed.sol": "pragma solidity ^0.8.20;\ninterface ITrimmed {\n    function liveA(uint256) external view returns (uint256);\n    function deadA(address) external view returns (uint256);\n    function deadB(address, uint256) external returns (bool);\n    function liveB(uint256) external returns (uint256);\n    function deadC() external;\n}" } }) === 3);
const cofContract = `pragma solidity ^0.8.20;
contract Cfg {
    address public owner;
    // function setFee(uint256 bps) external {
    //     feeBps = bps;
    // }
    function live(uint256 x) external pure returns (uint256) { return x; }
}`;
check("COF 49-4 kontrak badan dikomentari tanpa baseline -> 1 (tetap)",
  cofCount(cofContract, "Cfg.sol") === 1);
const cofMixed = `pragma solidity ^0.8.20;
interface IMix {
    function liveA() external;
    // function deadMix() external;
}
contract Mix is IMix {
    function liveA() external {}
}`;
check("COF 49-5 campuran iface+kontrak tanpa baseline -> 1 (tetap)",
  cofCount(cofMixed, "Mix.sol") === 1);
const fs49 = require("fs");
const dai49 = fs49.readFileSync(
  "/home/hatch/workspace/goals/bug-bounty-web3-immunefi/hidden_files/work/veno-source/ybUSD_IMPL/src_interface_ISavingsDai.sol", "utf8");
check("COF 49-6 ISavingsDai nyata tanpa baseline -> 0 (32 FP hilang)",
  cofCount(dai49, "ISavingsDai.sol") === 0);

// --- Seksi 50. Kalibrasi R20.2: permissionless-value-send (sesi #33,
// 19 Nov 2026 — residual hunting Veno: FA-001 YbEth.unbond).
// R20.2a: unwrap payable(...) di cabang .call{value:} sebelum cek
// pengecualian. R20.2b: payout ke parameter receiver yang haknya
// diverifikasi (isApprovedOrOwner / ownerOf vs msg.sender) dikecualikan.
const d20Count = (src, name) => runPipeline(src, name).candidates
  .filter((c) => c.detector === "permissionless-value-send").length;
const unbond50 = `pragma solidity ^0.8.20;
contract YbEth {
    address public treasury;
    function unbond(uint256 _tokenId, address _receiver) public nonReentrant returns (uint256) {
        if (!ybEthNft.isApprovedOrOwner(msg.sender, _tokenId)) { revert NotOwner(); }
        uint256 totalTokenAmount = 100;
        uint256 tokenFeeAmount = 1;
        (bool successTreasury,) = payable(treasury).call{value: tokenFeeAmount}("");
        if (!successTreasury) revert FailedTransfer();
        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;
        (bool successUser,) = payable(_receiver).call{value: tokenAmount}("");
        if (!successUser) revert FailedTransfer();
        return tokenAmount;
    }
}`;
check("D20 50-1 unbond verbatim (treasury + receiver terverifikasi) -> 0",
  d20Count(unbond50, "YbEth.sol") === 0);
const drain50 = `pragma solidity ^0.8.20;
contract Drain {
    function drain(address to, uint256 amt) public {
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 50-2 drain kontrol (param bebas, tanpa cek) -> 1",
  d20Count(drain50, "Drain.sol") === 1);
const ownerPay50 = `pragma solidity ^0.8.20;
contract OP {
    address public owner;
    function payout(uint256 amt) public {
        (bool ok,) = payable(owner).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 50-3 payable(owner) -> 0 (R20.2a unwrap)",
  d20Count(ownerPay50, "OP.sol") === 0);
const noCheck50 = `pragma solidity ^0.8.20;
contract NC {
    function withdraw(uint256 id, address recv) public {
        (bool ok,) = payable(recv).call{value: 1 ether}("");
        require(ok);
    }
}`;
check("D20 50-4 payout param tanpa cek kepemilikan -> 1",
  d20Count(noCheck50, "NC.sol") === 1);
const ownerOf50 = `pragma solidity ^0.8.20;
contract OOC {
    function redeem(uint256 id, address to) public {
        require(nft.ownerOf(id) == msg.sender, "not owner");
        (bool ok,) = payable(to).call{value: 1 ether}("");
        require(ok);
    }
}`;
check("D20 50-5 payout param + ownerOf()==msg.sender -> 0 (R20.2b)",
  d20Count(ownerOf50, "OOC.sol") === 0);
const feeOnly50 = `pragma solidity ^0.8.20;
contract FO {
    address public treasury;
    function payFee(uint256 amt) public {
        (bool ok,) = payable(treasury).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 50-6 fee ke treasury state var -> 0 (R20.2a)",
  d20Count(feeOnly50, "FO.sol") === 0);

// --- Seksi 51. Kalibrasi R20.2c: review Kiro Opus 5.5 atas R20.2
// (sesi #33, 19 Nov 2026 — vonis NEEDS WORK, F1–F5; disposisi wasit di
// `frankenaudit/docs/kiro-crew-review-2026-11-19-r20-2c-cof1b.md`).
const f1a51 = `pragma solidity ^0.8.20;
contract F1a {
    function w(uint256 id, address to) public {
        require(nft.ownerOf(id) == msg.sender, "not owner");
        (bool ok,) = payable(to).call{value: address(this).balance}("");
        require(ok);
    }
}`;
check("D20 51-1 F1 drain saldo penuh + cek -> 1 (lubang ditutup)",
  d20Count(f1a51, "F1a.sol") === 1);
const f1b51 = `pragma solidity ^0.8.20;
contract F1b {
    function w(uint256 id, address to, uint256 amt) public {
        require(nft.ownerOf(id) == msg.sender, "not owner");
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 51-2 F1 amount param + cek -> 1",
  d20Count(f1b51, "F1b.sol") === 1);
const f1d51 = `pragma solidity ^0.8.20;
contract F1d {
    function w(uint256 id, address to) public {
        require(nft.ownerOf(id) == msg.sender, "not owner");
        uint256 payout = bonds[id];
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
    }
}`;
check("D20 51-3 F1 amount state per-token + cek -> 0",
  d20Count(f1d51, "F1d.sol") === 0);
const f2a51 = `pragma solidity ^0.8.20;
contract F2a {
    function w(address treasury) external {
        (bool ok,) = payable(treasury).call{value: address(this).balance}("");
        require(ok);
    }
}`;
check("D20 51-4 F2 param treasury .call -> 1 (regresi diperbaiki)",
  d20Count(f2a51, "F2a.sol") === 1);
const f2b51 = `pragma solidity ^0.8.20;
contract F2b {
    function w(address owner) external {
        payable(owner).transfer(1 ether);
    }
}`;
check("D20 51-5 F2 param owner .transfer -> 1",
  d20Count(f2b51, "F2b.sol") === 1);
const f3a51 = `pragma solidity ^0.8.20;
contract F3a {
    function redeem(uint256 id, address to) public {
        if (nft.ownerOf(id) != msg.sender) revert NotOwner();
        uint256 payout = 1 ether;
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
    }
}`;
check("D20 51-6 F3 != + revert -> 0",
  d20Count(f3a51, "F3a.sol") === 0);
const f3b51 = `pragma solidity ^0.8.20;
contract F3b {
    function redeem(uint256 id, address to) public {
        require(nft.ownerOf(id) == _msgSender(), "not owner");
        uint256 payout = 1 ether;
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
    }
}`;
check("D20 51-7 F3 _msgSender() -> 0",
  d20Count(f3b51, "F3b.sol") === 0);
const f3c51 = `pragma solidity ^0.8.20;
contract F3c {
    function redeem(uint256 id, address to) public {
        _checkAuthorized(owner, msg.sender, id);
        uint256 payout = 1 ether;
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
    }
}`;
check("D20 51-8 F3 OZ v5 _checkAuthorized -> 0",
  d20Count(f3c51, "F3c.sol") === 0);
const f4b51 = `pragma solidity ^0.8.20;
contract F4b {
    function w(uint256 id, address to) public {
        uint256 payout = 1 ether;
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
        require(nft.ownerOf(id) == msg.sender);
    }
}`;
check("D20 51-9 F4 cek sesudah payout -> 1 (posisi)",
  d20Count(f4b51, "F4b.sol") === 1);
const f4a51 = `pragma solidity ^0.8.20;
contract F4a {
    function w(uint256 id, address to) public {
        // require(nft.ownerOf(id) == msg.sender) -- checked off-chain
        uint256 payout = 1 ether;
        (bool ok,) = payable(to).call{value: payout}("");
        require(ok);
    }
}`;
check("D20 51-10 F4 cek hanya di komentar -> 1 (artefak Kiro)",
  d20Count(f4a51, "F4a.sol") === 1);
const f5a51 = `pragma solidity ^0.8.20;
contract F5a {
    function w(address to) public {
        (bool ok,) = payable(address(to)).call{value: 1 ether}("");
        require(ok);
    }
}`;
check("D20 51-11 F5 payable(address(to)) .call -> 1",
  d20Count(f5a51, "F5a.sol") === 1);
const f5b51 = `pragma solidity ^0.8.20;
contract F5b {
    function w(address to) public {
        payable(address(to)).transfer(1 ether);
    }
}`;
check("D20 51-12 F5 payable(address(to)) .transfer -> 1",
  d20Count(f5b51, "F5b.sol") === 1);
const f5c51 = `pragma solidity ^0.8.20;
contract F5c {
    function w(uint256 id) public {
        (bool ok,) = payable(nft.ownerOf(id)).call{value: 1 ether}("");
        require(ok);
    }
}`;
check("D20 51-13 F5 receiver ownerOf(id) -> 0 (sengaja)",
  d20Count(f5c51, "F5c.sol") === 0);

// --- Seksi 52. Kalibrasi R-COF-1b: review Kiro atas R-COF-1 (sesi #33,
// temuan F7/F8 — F7 diterapkan, F8 terverifikasi dari kode asli).
const f7a52 = `pragma solidity ^0.8.20;
interface ITrim {
    function live() external;
    // function dead() external {
    //     doSomething();
    // }
}`;
check("COF 52-1 F7 iface-only + badan dikomentari -> 1 (dipertahankan)",
  cofCount(f7a52, "ITrim.sol") === 1);
const f7b52 = `pragma solidity ^0.8.20;
interface IFree {
    function live() external;
    // function dead() external;
}
function freeFn() {} `;
check("COF 52-2 F7 iface + free function -> 1 (bukan interface-only)",
  cofCount(f7b52, "IFree.sol") === 1);
const fs52 = require("fs");
const dai52 = fs52.readFileSync(
  "/home/hatch/workspace/goals/bug-bounty-web3-immunefi/hidden_files/work/veno-source/ybUSD_IMPL/src_interface_ISavingsDai.sol", "utf8");
check("COF 52-3 ISavingsDai nyata -> 0 (kontrol)",
  cofCount(dai52, "ISavingsDai.sol") === 0);
check("COF 52-4 F7 badan dikomentari + baseline absent -> 1 (badan menang)",
  cofCount(f7a52, "ITrim.sol",
    { baseline: { "ITrim.sol": "pragma solidity ^0.8.20;\ninterface ITrim {\n    function live() external;\n}" } }) === 1);

// --- Seksi 53. Kalibrasi R19.5: bukti tipe dari assignment di D19 (sesi #34,
// 19 Nov 2026 — residual cast-assignment TERBUKTI via probe wasit:
// P1/P2/P4 = 0 pra-perbaikan, N1/P6/P7/P9 = 0 kontrol, N5/N6 = 1 sanity).
// 53-1. Multi-deklarasi + cast `payable` -> 1.
check("R19.5 53-1 multi-decl second = payable(a) -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, second;
        second = payable(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
// 53-2. Multi-deklarasi tipe kontrak (IVault di cts) + cast-assignment.
// R19.5a/F6: lengan tipe-kontrak DIHAPUS (`.balance` pada var kontrak INVALID
// sejak 0.5 + multi-deklarasi INVALID, solc 0.8.20) -> kini 0.
check("R19.5a 53-2 multi-decl v2 = IVault(a) -> 0 (lengan kontrak dihapus)",
  d19("pragma solidity ^0.8.20;\ninterface IVault { function balanceOf(address a) external view returns (uint256); }\ncontract T {\n"
    + "    function sweep(address a, address token) external {\n"
    + "        IVault v1, v2;\n"
    + "        v2 = IVault(a);\n"
    + "        uint256 bal = v2.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 53-3. Plain-assignment dari param address -> 1.
check("R19.5 53-3 multi-decl second = a -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, second;
        second = a;
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
// 53-4. Rantai assignment (fixpoint) -> 1.
check("R19.5 53-4 rantai second = third; third = payable(a) -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, second, third;
        second = third;
        third = payable(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
// 53-5. Kontrol: field struct `balance` via konstruktor struct -> 0.
check("R19.5 53-5 struct Info.balance via konstruktor -> 0",
  d19("pragma solidity ^0.8.20;\nstruct Info { uint256 balance; }\ncontract T {\n"
    + "    function sweep(address a, address token) external {\n"
    + "        Info memory info;\n"
    + "        info = Info(100);\n"
    + "        uint256 bal = info.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 53-6. Self-alias `x = address(this)` -> 0 (saldo sendiri tetap dikecualikan).
check("R19.5 53-6 second = address(this) -> 0",
  d19(wrap39(`    function sweep(address token) external {
        address first, second;
        second = address(this);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 53-7. Self-alias `x = payable(msg.sender)` (spasi sebelum paren) -> 0.
check("R19.5 53-7 second = payable (msg.sender) -> 0",
  d19(wrap39(`    function sweep(address token) external {
        address first, second;
        second = payable (msg.sender);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 53-8. Panggilan fungsi lowercase bukan cast tipe -> 0.
check("R19.5 53-8 second = getAddr(a) -> 0",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, second;
        second = getAddr(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 53-9/53-10. Sanity: bentuk deklarasi sudah jalan -> 1.
check("R19.5 53-9 decl langsung payable(a) -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address payable second = payable(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
check("R19.5 53-10 decl terpisah + cast-assignment -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address second;
        second = payable(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);

// --- Seksi 54. Kalibrasi R19.5a: review Kiro Opus 5.5 atas R19.5 (sesi #34,
// 19 Nov 2026 — sesi Kiro 9bff4797, vonis NEEDS WORK, F1–F6; tiap klaim
// diverifikasi wasit via probe ke kode ASLI + solc 0.8.20).
// 54-1. F1 TERBUKTI: `Info = IVault(v).getInfo();` lalu `info.balance` -> 0.
check("R19.5a 54-1 F1 Info = IVault(v).getInfo() -> 0",
  d19("pragma solidity ^0.8.20;\nstruct Info { uint256 balance; }\ninterface IVault { function getInfo() external view returns (Info memory); }\ncontract T {\n"
    + "    function sweep(address v, address token) external {\n"
    + "        Info memory info = IVault(v).getInfo();\n"
    + "        uint256 bal = info.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-2. F1 TERBUKTI: assignment murni `info = IVault(v).getInfo();` -> 0.
check("R19.5a 54-2 F1 info = IVault(v).getInfo() -> 0",
  d19("pragma solidity ^0.8.20;\nstruct Info { uint256 balance; }\ninterface IVault { function getInfo() external view returns (Info memory); }\ncontract T {\n"
    + "    function sweep(address v, address token) external {\n"
    + "        Info memory info;\n"
    + "        info = IVault(v).getInfo();\n"
    + "        uint256 bal = info.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-3. F1 kontrol positif: cast utuh sebagai kondisi `if ((r = payable(a)) != ...)`
// dengan amount LANGSUNG `r.balance` -> 1. (Catatan wasit: varian dgn var
// perantara `bal = r.balance` di luar if tetap 0 — BUKAN cacat R19.5a, tapi
// batas lama D19: assignRe `[^;]*` menelan statement berikut bila assignment
// berada di kondisi tanpa `;` sendiri; didokumentasikan, tidak diperbaiki sesi ini.)
check("R19.5a 54-3 F1 cast utuh di kondisi if -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, r;
        if ((r = payable(a)) != address(0)) {
            IERC20(token).transfer(msg.sender, r.balance);
        }
    }`)).length === 1);
// 54-4. F2 TERBUKTI: member assignment ber-spasi `s . x = payable(a);` -> 0.
check("R19.5a 54-4 F2 s . x = payable(a) -> 0",
  d19("pragma solidity ^0.8.20;\nstruct S { address x; }\ncontract T {\n"
    + "    function sweep(address a, address token) external {\n"
    + "        S memory s;\n"
    + "        s . x = payable(a);\n"
    + "        uint256 bal = s.x.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-5. F2 TERBUKTI: member assignment baris-baru `s.` + newline + `x = ...` -> 0.
check("R19.5a 54-5 F2 s.<newline>x = payable(a) -> 0",
  d19("pragma solidity ^0.8.20;\nstruct S { address x; }\ncontract T {\n"
    + "    function sweep(address a, address token) external {\n"
    + "        S memory s;\n"
    + "        s.\n"
    + "        x = payable(a);\n"
    + "        uint256 bal = s.x.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-6. F2 kontrol: member assignment tanpa spasi `s.x = payable(a);` -> 0 (sudah benar).
check("R19.5a 54-6 F2 s.x = payable(a) -> 0",
  d19("pragma solidity ^0.8.20;\nstruct S { address x; }\ncontract T {\n"
    + "    function sweep(address a, address token) external {\n"
    + "        S memory s;\n"
    + "        s.x = payable(a);\n"
    + "        uint256 bal = s.x.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-7. F3 TERBUKTI: self-alias bersarang `payable(address(uint160(address(this))))` -> 0.
check("R19.5a 54-7 F3 self-alias uint160 bersarang -> 0",
  d19(wrap39(`    function sweep(address token) external {
        address first, r;
        r = payable(address(uint160(address(this))));
        uint256 bal = r.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 54-8. F3 kontrol: `r = IVault(address(this))` -> 0 (self via cast kontrak).
check("R19.5a 54-8 F3 r = IVault(address(this)) -> 0",
  d19("pragma solidity ^0.8.20;\ninterface IVault { function balanceOf(address a) external view returns (uint256); }\ncontract T {\n"
    + "    function sweep(address token) external {\n"
    + "        IVault first, r;\n"
    + "        r = IVault(address(this));\n"
    + "        uint256 bal = r.balance;\n"
    + "        IERC20(token).transfer(msg.sender, bal);\n"
    + "    }\n}").length === 0);
// 54-9. F4 TERBUKTI: rantai terbalik kedalaman 5 (akar terlewat) -> 1 (bound 8).
check("R19.5a 54-9 F4 rantai terbalik kedalaman 5 -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address z, x1, x2, x3, x4, x5;
        x5 = x4; x4 = x3; x3 = x2; x2 = x1; x1 = payable(a);
        uint256 bal = x5.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
// 54-10. F4 TERBUKTI: rantai terbalik kedalaman 6 (akar terlewat) -> 1.
check("R19.5a 54-10 F4 rantai terbalik kedalaman 6 -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address z, x1, x2, x3, x4, x5, x6;
        x6 = x5; x5 = x4; x4 = x3; x3 = x2; x2 = x1; x1 = payable(a);
        uint256 bal = x6.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);
// 54-11. F4 BATAS: rantai terbalik kedalaman 9 (akar terlewat) -> 0 (bound 8).
check("R19.5a 54-11 F4 rantai terbalik kedalaman 9 -> 0 (batas)",
  d19(wrap39(`    function sweep(address a, address token) external {
        address z, x1, x2, x3, x4, x5, x6, x7, x8, x9;
        x9 = x8; x8 = x7; x7 = x6; x6 = x5; x5 = x4; x4 = x3; x3 = x2; x2 = x1; x1 = payable(a);
        uint256 bal = x9.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 54-12. F5 BATAS (didokumentasikan, tidak diperbaiki): ternary `r = c ? payable(a) : b` -> 0.
check("R19.5a 54-12 F5 ternary cast -> 0 (batas diketahui)",
  d19(wrap39(`    function sweep(address a, address b, address token) external {
        address first, r;
        bool cond = a != address(0);
        r = cond ? payable(a) : b;
        uint256 bal = r.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);
// 54-13. F6 kunci: cast tipe-kontrak allowlist `second = IERC20(a)` -> 0 (lengan dihapus).
check("R19.5a 54-13 F6 second = IERC20(a) -> 0",
  d19(wrap39(`    function sweep(address a, address token) external {
        IERC20 first, second;
        second = IERC20(a);
        uint256 bal = second.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 0);

// 54-14. Chained assignment `third = second = payable(a)` -> 1.
check("R19.5a 54-14 chained third = second = payable(a) -> 1",
  d19(wrap39(`    function sweep(address a, address token) external {
        address first, second, third;
        third = second = payable(a);
        uint256 bal = third.balance;
        IERC20(token).transfer(msg.sender, bal);
    }`)).length === 1);

// --- Seksi 55. Kalibrasi R19-b: D19 encodeWithSelector transferFrom
// (residual review Kiro 17 Nov 2026, sesi #35 19 Nov 2026 — jumlah
// transferFrom ada di args[3], bukan args[2] seperti transfer).
// 55-1. transferFrom-selector + balanceOf langsung di args[3] -> 1.
check("R19-b 55-1 transferFrom-selector + balanceOf args[3] -> 1",
  d19(wrap38(`    function sweep(address token, address from, address to) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, IERC20(token).balanceOf(pool)));
    }`)).length === 1);
// 55-2. transferFrom-selector + var sweep di args[3] -> 1.
check("R19-b 55-2 transferFrom-selector + var sweep args[3] -> 1",
  d19(wrap38(`    function sweep(address token, address from, address to) external {
        uint256 bal = IERC20(token).balanceOf(pool);
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, bal));
    }`)).length === 1);
// 55-3. transfer-selector + balanceOf di args[2] -> 1 (regresi).
check("R19-b 55-3 transfer-selector + balanceOf args[2] -> 1",
  d19(wrap38(`    function sweep(address token, address to) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, IERC20(token).balanceOf(pool)));
    }`)).length === 1);
// 55-4. transferFrom-selector + amount literal -> 0.
check("R19-b 55-4 transferFrom-selector + amount literal -> 0",
  d19(wrap38(`    function sweep(address token, address from, address to) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, 100));
    }`)).length === 0);
// 55-5. transferFrom-selector + balanceOf di args[2] (posisi to) +
// amount deklarasi di args[3] -> 0 (kunci: args[2] BUKAN jumlah).
check("R19-b 55-5 transferFrom-selector + balanceOf di posisi to -> 0",
  d19(wrap38(`    function sweep(address token, address from, uint256 required) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, IERC20(token).balanceOf(pool), required));
    }`)).length === 0);
// 55-6. Selector variabel -> 0.
check("R19-b 55-6 encodeWithSelector selector variabel -> 0",
  d19(wrap38(`    function sweep(address token, address from, address to, bytes4 sel) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(sel, from, to, IERC20(token).balanceOf(pool)));
    }`)).length === 0);
// 55-7. transferFrom langsung + balanceOf -> 1 (regresi).
check("R19-b 55-7 transferFrom langsung + balanceOf -> 1",
  d19(wrap38(`    function sweep(address token, address from, address to) external {
        IERC20(token).transferFrom(from, to, IERC20(token).balanceOf(pool));
    }`)).length === 1);
// 55-8. transferFrom-selector + pool.balance (address state var) -> 1.
check("R19-b 55-8 transferFrom-selector + pool.balance -> 1",
  d19(wrap38(`    function sweep(address token, address from, address to) external {
        (bool ok, ) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, pool.balance));
    }`)).length === 1);

// --- Seksi 56. Detektor ke-22: jit-reward-accrual-sandwich (VENO-C2)
// (backlog detektor sesi BB pagi 19 Nov 2026 — YbEth stake/accrueReward/
// requestUnbond; Medium wasit, PoC-verified Foundry 4/4).
const d22 = (src, name) => runPipeline(src, name || "d22.sol").candidates
  .filter((c) => c.detector === "jit-reward-accrual-sandwich");
// 56-0. Fixture mini tiga kaki (fee default-0) -> 1 Medium @ accrueReward.
const JIT56 = "pragma solidity ^0.8.20;\ncontract JitTrap {\n"
  + "    uint256 public totalPooledEth;\n"
  + "    uint256 public totalSupply;\n"
  + "    uint256 public unbondingFee;\n"
  + "    uint256 public constant UNBONDING_FEE_DENOMINATOR = 100_000;\n"
  + "    uint256 public constant EXCHANGE_RATE_PRECISION = 1e18;\n"
  + "    mapping(string => uint256) public txnHash2Amount;\n"
  + "    mapping(uint256 => UnbondRequest) public token2UnbondRequest;\n"
  + "    struct UnbondRequest { uint256 shareAmount; uint256 exchangeRate; }\n"
  + "    mapping(address => uint256) public shares;\n"
  + "    function convertToShare(uint256 tokenAmount) public view returns (uint256) {\n"
  + "        require(totalPooledEth > 0, \"empty pool\");\n"
  + "        return (tokenAmount * totalSupply) / totalPooledEth;\n"
  + "    }\n"
  + "    function _mint(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }\n"
  + "    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }\n"
  + "    function stake(address _receiver) external payable {\n"
  + "        uint256 shareAmount = convertToShare(msg.value);\n"
  + "        _mint(_receiver, shareAmount);\n"
  + "        totalPooledEth += msg.value;\n"
  + "    }\n"
  + "    function accrueReward(uint256 amount, string calldata txnHash) external {\n"
  + "        require(txnHash2Amount[txnHash] == 0, \"dup\");\n"
  + "        totalPooledEth += amount;\n"
  + "        txnHash2Amount[txnHash] = amount;\n"
  + "    }\n"
  + "    function requestUnbond(uint256 _shareAmount) external returns (uint256) {\n"
  + "        require(totalSupply > 0, \"no shares\");\n"
  + "        require(_shareAmount <= shares[msg.sender], \"insufficient\");\n"
  + "        uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;\n"
  + "        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, exchangeRate: exchangeRate});\n"
  + "        totalPooledEth -= (_shareAmount * exchangeRate) / EXCHANGE_RATE_PRECISION;\n"
  + "        _burn(msg.sender, _shareAmount);\n"
  + "        return 1;\n"
  + "    }\n"
  + "    function unbond(uint256 _tokenId) external returns (uint256) {\n"
  + "        UnbondRequest storage req = token2UnbondRequest[_tokenId];\n"
  + "        uint256 totalTokenAmount = (req.shareAmount * req.exchangeRate) / EXCHANGE_RATE_PRECISION;\n"
  + "        uint256 tokenFeeAmount = (totalTokenAmount * unbondingFee) / UNBONDING_FEE_DENOMINATOR;\n"
  + "        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;\n"
  + "        (bool ok, ) = payable(msg.sender).call{value: tokenAmount}(\"\");\n"
  + "        require(ok, \"failed\");\n"
  + "        return tokenAmount;\n"
  + "    }\n}";
const c56 = d22(JIT56);
check("D22 56-1 fixture tiga kaki fee-0 -> 1 Medium @ accrueReward",
  c56.length === 1 && c56[0].severityGuess === "Medium"
    && c56[0].location.function === "accrueReward",
  "dapat " + JSON.stringify(c56.map((c) => c.location.function + ":" + c.severityGuess)));
// 56-2. YbEth.sol verbatim (impl terverifikasi, work/veno-source/) -> 1,
// Low mode single-file (fee dideklarasi di YbEthStorage.sol, bukan file ini).
const ybEthPath = path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "ybETH_IMPL", "src_YbEth.sol");
const ybEthSrc = fs.readFileSync(ybEthPath, "utf8");
const c56b = d22(ybEthSrc, "src_YbEth.sol");
check("D22 56-2 YbEth verbatim -> 1 Low @ accrueReward (fee lintas-file)",
  c56b.length === 1 && c56b[0].severityGuess === "Low"
    && c56b[0].location.function === "accrueReward",
  "dapat " + JSON.stringify(c56b.map((c) => c.location.function + ":" + c.severityGuess)));
// 56-2b. YbEth via runProjectPipeline (storage ikut korpus) -> 1 Medium
// (unbondingFee default-0 terbaca dari YbEthStorage.sol).
const ybEthStorageSrc = fs.readFileSync(path.join(__dirname, "..", "..", "..",
  "work", "veno-source", "ybETH_IMPL", "src_YbEthStorage.sol"), "utf8");
const c56c = runProjectPipeline([
  { name: "src_YbEth.sol", text: ybEthSrc },
  { name: "src_YbEthStorage.sol", text: ybEthStorageSrc },
]).candidates.filter((cc) => cc.detector === "jit-reward-accrual-sandwich");
check("D22 56-2b YbEth mode proyek -> 1 Medium @ accrueReward",
  c56c.length === 1 && c56c[0].severityGuess === "Medium"
    && c56c[0].location.function === "accrueReward",
  "dapat " + JSON.stringify(c56c.map((cc) => cc.location.function + ":" + cc.severityGuess)));
// 56-3. Accrual ikut mint share -> bukan accrual (harga tidak naik) -> 0.
check("D22 56-3 accrual ikut mint -> 0",
  d22(JIT56.replace("        totalPooledEth += amount;\n        txnHash2Amount[txnHash] = amount;",
    "        totalPooledEth += amount;\n        _mint(msg.sender, convertToShare(amount));\n        txnHash2Amount[txnHash] = amount;")).length === 0);
// 56-4. Stake tanpa mint (deposit biasa) -> pintu masuk hilang -> 0.
check("D22 56-4 stake tanpa mint -> 0",
  d22(JIT56.replace("        _mint(_receiver, shareAmount);\n", "")).length === 0);
// 56-5. Exit tanpa kunci rate (rate dihitung tapi tidak disimpan/dipakai) -> 0.
check("D22 56-5 exit tanpa kunci rate -> 0",
  d22(JIT56
    .replace("        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, exchangeRate: exchangeRate});\n", "")
    .replace("        totalPooledEth -= (_shareAmount * exchangeRate) / EXCHANGE_RATE_PRECISION;\n",
      "        totalPooledEth -= _shareAmount;\n")).length === 0);
// 56-6. Exit tanpa burn / tanpa pengurangan pool -> 0.
check("D22 56-6 exit tanpa burn -> 0",
  d22(JIT56
    .replace("        totalPooledEth -= (_shareAmount * exchangeRate) / EXCHANGE_RATE_PRECISION;\n", "")
    .replace("        _burn(msg.sender, _shareAmount);\n", "")).length === 0);
// 56-7. Gate holding-period (block.timestamp vs stakeTime) -> 0.
check("D22 56-7 holding-period gate -> 0",
  d22(JIT56
    .replace("    uint256 public unbondingFee;\n",
      "    uint256 public unbondingFee;\n    mapping(address => uint256) public stakeTime;\n")
    .replace("        require(totalSupply > 0, \"no shares\");\n",
      "        require(totalSupply > 0, \"no shares\");\n        require(block.timestamp >= stakeTime[msg.sender] + 1 days, \"too soon\");\n")).length === 0);
// 56-8. Fee ter-init nonzero (500) -> tetap 1, turun ke Low.
const c568 = d22(JIT56.replace("    uint256 public unbondingFee;\n",
  "    uint256 public unbondingFee = 500;\n"));
check("D22 56-8 fee nonzero -> 1 Low",
  c568.length === 1 && c568[0].severityGuess === "Low",
  "dapat " + JSON.stringify(c568.map((c) => c.location.function + ":" + c.severityGuess)));
// 56-9. Tanpa perhitungan fee sama sekali -> 1 Medium (tanpa friksi).
check("D22 56-9 tanpa fee -> 1 Medium",
  (() => {
    const s = JIT56
      .replace("    uint256 public unbondingFee;\n", "")
      .replace("        uint256 tokenFeeAmount = (totalTokenAmount * unbondingFee) / UNBONDING_FEE_DENOMINATOR;\n        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;\n",
        "        uint256 tokenAmount = totalTokenAmount;\n");
    const r = d22(s);
    return r.length === 1 && r[0].severityGuess === "Medium";
  })());
// 56-10. Accrual bernama initialize (modifier initializer) -> 0.
check("D22 56-10 accrual = initialize -> 0",
  d22(JIT56.replace("function accrueReward(uint256 amount, string calldata txnHash) external {",
    "function initialize(uint256 amount, string calldata txnHash) external initializer {")).length === 0);
// 56-11. Accrual gaya deposit() (payable, POOL += msg.value, tanpa mint) -> 1.
const c5611 = d22(JIT56.replace(
  "    function accrueReward(uint256 amount, string calldata txnHash) external {\n"
  + "        require(txnHash2Amount[txnHash] == 0, \"dup\");\n"
  + "        totalPooledEth += amount;\n"
  + "        txnHash2Amount[txnHash] = amount;\n"
  + "    }\n",
  "    function deposit() external payable {\n"
  + "        totalPooledEth += msg.value;\n"
  + "    }\n"));
check("D22 56-11 accrual gaya deposit() -> 1 @ deposit",
  c5611.length === 1 && c5611[0].location.function === "deposit",
  "dapat " + JSON.stringify(c5611.map((c) => c.location.function + ":" + c.severityGuess)));
// 56-12. Formula rate terbalik (shareAmount * POOL) / totalSupply -> 1.
check("D22 56-12 formula (X * POOL) / totalSupply -> 1",
  d22(JIT56.replace(
    "        uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;",
    "        uint256 exchangeRate = (_shareAmount * totalPooledEth) / totalSupply;")).length === 1);
// 56-13. File test/mock dilewati -> 0.
check("D22 56-13 file test dilewati -> 0",
  d22(JIT56, "test/d22.sol").length === 0
  && d22(JIT56, "YbEth.t.sol").length === 0);
// 56-14. Pool tak sama antar kaki (accrual di otherPool) -> 0.
check("D22 56-14 pool beda antar kaki -> 0",
  d22(JIT56
    .replace("    uint256 public totalPooledEth;\n",
      "    uint256 public totalPooledEth;\n    uint256 public otherPool;\n")
    .replace("        totalPooledEth += amount;\n", "        otherPool += amount;\n")).length === 0);
// 56-15. Fee dipakai tapi tak dideklarasi di file -> 1 Low (unknown).
const c5615 = d22(JIT56.replace("    uint256 public unbondingFee;\n", ""));
check("D22 56-15 fee tak terdeklarasi -> 1 Low",
  c5615.length === 1 && c5615[0].severityGuess === "Low",
  "dapat " + JSON.stringify(c5615.map((c) => c.location.function + ":" + c.severityGuess)));
// 56-16. toVerify menyebut fee live + jadwal accrual + PoC fix-flip.
check("D22 56-16 toVerify menyebut fee live + jadwal + fix-flip",
  c56.length === 1 && c56[0].toVerify.some((t) => /LIVE fee/.test(t))
  && c56[0].toVerify.some((t) => /jadwal accrual LIVE/.test(t))
  && c56[0].toVerify.some((t) => /fix-flip/.test(t)));

// --- Seksi 56b. Kalibrasi R22 review Kiro Opus 5.5 (NEEDS WORK F1-F18).
// Tiap temuan dikunci satu tes (probe wasit /tmp/probe-d22-r22.js 28/28
// PASS pasca-kalibrasi; suite 721/721 tetap hijau).
// 56b-1. F1: denominator fee literal (/ 100000) + fee 500 -> 1 Low.
check("D22 56b-1 fee denom literal -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee) / UNBONDING_FEE_DENOMINATOR", "(totalTokenAmount * unbondingFee) / 100000")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee) / UNBONDING_FEE_DENOMINATOR", "(totalTokenAmount * unbondingFee) / 100000"))[0].severityGuess === "Low");
// 56b-2. F2: nama feeBps = 500 -> 1 Low.
check("D22 56b-2 feeBps -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public feeBps = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(totalTokenAmount * feeBps)")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public feeBps = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(totalTokenAmount * feeBps)"))[0].severityGuess === "Low");
// 56b-3. F2: nama bare `fee` = 500 -> 1 Low.
check("D22 56b-3 bare fee -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public fee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(totalTokenAmount * fee)")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public fee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(totalTokenAmount * fee)"))[0].severityGuess === "Low");
// 56b-4. F3: operand fee terbalik (fee * total) -> 1 Low.
check("D22 56b-4 operand terbalik -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(unbondingFee * totalTokenAmount)")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 500;\n")
    .replace("(totalTokenAmount * unbondingFee)", "(unbondingFee * totalTokenAmount)"))[0].severityGuess === "Low");
// 56b-5. F4: constant fee = 500 -> 1 Low (dulu dilewati -> Medium).
check("D22 56b-5 constant fee -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public constant unbondingFee = 500;\n")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public constant unbondingFee = 500;\n"))[0].severityGuess === "Low");
// 56b-6. F5: immutable + constructor set 500 -> 1 Low.
check("D22 56b-6 immutable ctor 500 -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public immutable unbondingFee;\n")
    .replace("    mapping(address => uint256) public shares;\n",
      "    mapping(address => uint256) public shares;\n    constructor() { unbondingFee = 500; }\n")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public immutable unbondingFee;\n")
    .replace("    mapping(address => uint256) public shares;\n",
      "    mapping(address => uint256) public shares;\n    constructor() { unbondingFee = 500; }\n"))[0].severityGuess === "Low");
// 56b-7. F6: mintFee default-0 tidak menutupi unbondingFee = 500 -> 1 Low.
check("D22 56b-7 mintFee tak menutupi -> 1 Low",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public mintFee;\n    uint256 public unbondingFee = 500;\n")
    .replace("        _mint(_receiver, shareAmount);\n",
      "        _mint(_receiver, shareAmount);\n        uint256 mfee = (msg.value * mintFee) / UNBONDING_FEE_DENOMINATOR;\n")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public mintFee;\n    uint256 public unbondingFee = 500;\n")
    .replace("        _mint(_receiver, shareAmount);\n",
      "        _mint(_receiver, shareAmount);\n        uint256 mfee = (msg.value * mintFee) / UNBONDING_FEE_DENOMINATOR;\n"))[0].severityGuess === "Low");
// 56b-8. F7: fee = 0x00 dibaca nol -> 1 Medium.
check("D22 56b-8 fee 0x00 -> 1 Medium",
  d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 0x00;\n")).length === 1
  && d22(JIT56.replace("    uint256 public unbondingFee;\n", "    uint256 public unbondingFee = 0x00;\n"))[0].severityGuess === "Medium");
// 56b-9. F8-A1: rate paren bersarang -> 1.
check("D22 56b-9 rate paren bersarang -> 1",
  d22(JIT56.replace("    uint256 public totalSupply;\n", "    uint256 public totalSupply;\n    uint256 public bufferedEth;\n")
    .replace("uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;",
      "uint256 exchangeRate = ((totalPooledEth + bufferedEth) * EXCHANGE_RATE_PRECISION) / totalSupply();")).length === 1);
// 56b-10. F8-A2: pembagi dalam paren -> 1.
check("D22 56b-10 pembagi dalam paren -> 1",
  d22(JIT56.replace("uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;",
    "uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / (totalSupply());")).length === 1);
// 56b-11. F8-A27: mulDiv -> 1.
check("D22 56b-11 mulDiv -> 1",
  d22(JIT56.replace("uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;",
    "uint256 exchangeRate = totalPooledEth.mulDiv(EXCHANGE_RATE_PRECISION, totalSupply);")).length === 1);
// 56b-12. F8-A24: gaya Lido (_mintShares/_getTotalShares/_burnShares) -> 1.
const LIDO56 = `pragma solidity ^0.8.20;
contract LidoStyle {
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    uint256 public unbondingFee;
    mapping(uint256 => UnbondRequest) public token2UnbondRequest;
    struct UnbondRequest { uint256 shareAmount; uint256 exchangeRate; }
    mapping(address => uint256) public shares;
    function _mintShares(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }
    function _burnShares(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }
    function _getTotalShares() internal view returns (uint256) { return totalSupply; }
    function stake(address _receiver) external payable {
        uint256 shareAmount = (msg.value * totalSupply) / totalPooledEth;
        _mintShares(_receiver, shareAmount);
        totalPooledEth += msg.value;
    }
    function accrueReward(uint256 amount) external { totalPooledEth += amount; }
    function requestUnbond(uint256 _shareAmount) external returns (uint256) {
        uint256 exchangeRate = (totalPooledEth * 1e18) / _getTotalShares();
        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, exchangeRate: exchangeRate});
        totalPooledEth -= (_shareAmount * exchangeRate) / 1e18;
        _burnShares(msg.sender, _shareAmount);
        return 1;
    }
    function unbond(uint256 _tokenId) external returns (uint256) {
        UnbondRequest storage req = token2UnbondRequest[_tokenId];
        uint256 totalTokenAmount = (req.shareAmount * req.exchangeRate) / 1e18;
        uint256 tokenFeeAmount = (totalTokenAmount * unbondingFee) / 100000;
        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;
        (bool ok, ) = payable(msg.sender).call{value: tokenAmount}("");
        require(ok, "failed");
        return tokenAmount;
    }
}`;
check("D22 56b-12 gaya Lido -> 1", d22(LIDO56).length === 1);
// 56b-13. F10-A12: POOL = POOL + amount -> 1.
check("D22 56b-13 POOL = POOL + amount -> 1",
  d22(JIT56.replace("        totalPooledEth += amount;\n", "        totalPooledEth = totalPooledEth + amount;\n")).length === 1);
// 56b-14. F10-A13: alias lokal net dari param -> 1.
check("D22 56b-14 alias lokal net -> 1",
  d22(JIT56.replace("        totalPooledEth += amount;\n",
    "        uint256 net = amount - amount / 10;\n        totalPooledEth += net;\n")).length === 1);
// 56b-15. F11-A16: antrean withdrawal (amountOwed) -> 1.
const QUEUE56 = `pragma solidity ^0.8.20;
contract QueueStyle {
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    uint256 public unbondingFee;
    mapping(uint256 => UnbondRequest) public token2UnbondRequest;
    struct UnbondRequest { uint256 shareAmount; uint256 amountOwed; }
    mapping(address => uint256) public shares;
    function _mint(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }
    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }
    function stake(address _receiver) external payable {
        uint256 shareAmount = (msg.value * totalSupply) / totalPooledEth;
        _mint(_receiver, shareAmount);
        totalPooledEth += msg.value;
    }
    function accrueReward(uint256 amount) external { totalPooledEth += amount; }
    function requestUnbond(uint256 _shareAmount) external returns (uint256) {
        uint256 owed = (_shareAmount * totalPooledEth) / totalSupply;
        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, amountOwed: owed});
        totalPooledEth -= owed;
        _burn(msg.sender, _shareAmount);
        return 1;
    }
    function unbond(uint256 _tokenId) external returns (uint256) {
        UnbondRequest storage req = token2UnbondRequest[_tokenId];
        uint256 tokenFeeAmount = (req.amountOwed * unbondingFee) / 100000;
        uint256 tokenAmount = req.amountOwed - tokenFeeAmount;
        (bool ok, ) = payable(msg.sender).call{value: tokenAmount}("");
        require(ok, "failed");
        return tokenAmount;
    }
}`;
check("D22 56b-15 antrean amountOwed -> 1", d22(QUEUE56).length === 1);
// 56b-16. F12-A23: alias lokal pool (totalPooledEth = totalStaked) -> 1.
const ALIAS56 = `pragma solidity ^0.8.20;
contract AliasPool {
    uint256 public totalStaked;
    uint256 public totalSupply;
    uint256 public unbondingFee;
    mapping(uint256 => UnbondRequest) public token2UnbondRequest;
    struct UnbondRequest { uint256 shareAmount; uint256 exchangeRate; }
    mapping(address => uint256) public shares;
    function _mint(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }
    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }
    function stake(address _receiver) external payable {
        uint256 shareAmount = (msg.value * totalSupply) / totalStaked;
        _mint(_receiver, shareAmount);
        totalStaked += msg.value;
    }
    function accrueReward(uint256 amount) external { totalStaked += amount; }
    function requestUnbond(uint256 _shareAmount) external returns (uint256) {
        uint256 totalPooledEth = totalStaked;
        uint256 exchangeRate = (totalPooledEth * 1e18) / totalSupply;
        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, exchangeRate: exchangeRate});
        totalStaked -= (_shareAmount * exchangeRate) / 1e18;
        _burn(msg.sender, _shareAmount);
        return 1;
    }
    function unbond(uint256 _tokenId) external returns (uint256) {
        UnbondRequest storage req = token2UnbondRequest[_tokenId];
        uint256 totalTokenAmount = (req.shareAmount * req.exchangeRate) / 1e18;
        uint256 tokenFeeAmount = (totalTokenAmount * unbondingFee) / 100000;
        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;
        (bool ok, ) = payable(msg.sender).call{value: tokenAmount}("");
        require(ok, "failed");
        return tokenAmount;
    }
}`;
check("D22 56b-16 alias lokal pool -> 1", d22(ALIAS56).length === 1);
// 56b-17. F13-A20: emit dgn block.timestamp bukan gate -> 1.
check("D22 56b-17 emit bukan gate -> 1",
  d22(JIT56.replace("    uint256 public unbondingFee;\n",
      "    uint256 public unbondingFee;\n    mapping(address => uint256) public stakeTime;\n")
    .replace("        require(totalSupply > 0, \"no shares\");\n",
      "        emit Unbonded(block.timestamp - stakeTime[msg.sender]);\n        require(totalSupply > 0, \"no shares\");\n")).length === 1);
// 56b-18. F13b: stakeTimeout bukan holding gate -> 1.
check("D22 56b-18 stakeTimeout bukan gate -> 1",
  d22(JIT56.replace("    uint256 public unbondingFee;\n",
      "    uint256 public unbondingFee;\n    mapping(address => uint256) public stakeTimeout;\n")
    .replace("        require(totalSupply > 0, \"no shares\");\n",
      "        require(block.timestamp >= stakeTimeout[msg.sender], \"too early\");\n        require(totalSupply > 0, \"no shares\");\n")).length === 1);
// 56b-19. F14-A18: gate depositedAt -> 0.
check("D22 56b-19 gate depositedAt -> 0",
  d22(JIT56.replace("    uint256 public unbondingFee;\n",
      "    uint256 public unbondingFee;\n    mapping(address => uint256) public depositedAt;\n")
    .replace("        require(totalSupply > 0, \"no shares\");\n",
      "        require(block.timestamp >= depositedAt[msg.sender] + 1 days, \"locked\");\n        require(totalSupply > 0, \"no shares\");\n")).length === 0);
// 56b-20. F14-A19: gate di modifier afterLock -> 0.
check("D22 56b-20 gate di modifier -> 0",
  d22(JIT56.replace("    uint256 public unbondingFee;\n",
      "    uint256 public unbondingFee;\n    mapping(address => uint256) public stakeTime;\n    modifier afterLock() { require(block.timestamp >= stakeTime[msg.sender] + 1 days, \"locked\"); _; }\n")
    .replace("function requestUnbond(uint256 _shareAmount) external returns (uint256) {",
      "function requestUnbond(uint256 _shareAmount) external afterLock returns (uint256) {")).length === 0);
// 56b-21. F15-A22: tiga kaki beda kontrak satu file -> 0.
const TWOC56 = `pragma solidity ^0.8.20;
contract Vault {
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    mapping(address => uint256) public shares;
    function _mint(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }
    function stake(address _receiver) external payable {
        uint256 shareAmount = (msg.value * totalSupply) / totalPooledEth;
        _mint(_receiver, shareAmount);
        totalPooledEth += msg.value;
    }
    function accrueReward(uint256 amount) external { totalPooledEth += amount; }
}
contract Distributor {
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    mapping(address => uint256) public shares;
    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }
    function requestUnbond(uint256 _shareAmount) external returns (uint256) {
        uint256 exchangeRate = (totalPooledEth * 1e18) / totalSupply;
        totalPooledEth -= (_shareAmount * exchangeRate) / 1e18;
        _burn(msg.sender, _shareAmount);
        return exchangeRate;
    }
}`;
check("D22 56b-21 kaki beda kontrak -> 0", d22(TWOC56).length === 0);
// 56b-22. F16-A26: submit payable mint via helper = stake, bukan accrual -> 0.
check("D22 56b-22 submit via helper -> 0",
  d22(JIT56.replace("    function accrueReward(uint256 amount, string calldata txnHash) external {\n        require(txnHash2Amount[txnHash] == 0, \"dup\");\n        totalPooledEth += amount;\n        txnHash2Amount[txnHash] = amount;\n    }",
      "    function submit(uint256 amount) external payable {\n        uint256 shareAmount = (msg.value * totalSupply) / totalPooledEth;\n        _issueShares(msg.sender, shareAmount);\n        totalPooledEth += msg.value;\n    }")
    .replace("    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }\n",
      "    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }\n    function _issueShares(address to, uint256 amount) internal { _mint(to, amount); }\n")).length === 0);
// 56b-23. F17-A25: receive() sbg accrual -> 1 @receive.
check("D22 56b-23 receive() accrual -> 1",
  d22(JIT56.replace("    function accrueReward(uint256 amount, string calldata txnHash) external {\n        require(txnHash2Amount[txnHash] == 0, \"dup\");\n        totalPooledEth += amount;\n        txnHash2Amount[txnHash] = amount;\n    }",
      "    receive() external payable { totalPooledEth += msg.value; }")).length === 1
  && d22(JIT56.replace("    function accrueReward(uint256 amount, string calldata txnHash) external {\n        require(txnHash2Amount[txnHash] == 0, \"dup\");\n        totalPooledEth += amount;\n        txnHash2Amount[txnHash] = amount;\n    }",
      "    receive() external payable { totalPooledEth += msg.value; }"))[0].location.function === "receive");
// 56b-24. F18b: harnessRouter.sol (lowercase) produksi -> 1; HarnessRouter.sol
// (kapital, konvensi harness) tetap dilewati -> 0.
check("D22 56b-24 harness case-sensitive",
  d22(JIT56, "harnessRouter.sol").length === 1 && d22(JIT56, "HarnessRouter.sol").length === 0);
// 56b-25. K5var (catatan cakupan Kiro): redeem langsung, rate dipakai sbg
// nilai payout di fungsi yang sama -> 1.
const DIRECT56 = `pragma solidity ^0.8.20;
contract DirectRedeem {
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    uint256 public unbondingFee;
    mapping(address => uint256) public shares;
    function _mint(address to, uint256 amount) internal { shares[to] += amount; totalSupply += amount; }
    function _burn(address from, uint256 amount) internal { shares[from] -= amount; totalSupply -= amount; }
    function stake(address _receiver) external payable {
        uint256 shareAmount = (msg.value * totalSupply) / totalPooledEth;
        _mint(_receiver, shareAmount);
        totalPooledEth += msg.value;
    }
    function accrueReward(uint256 amount) external { totalPooledEth += amount; }
    function withdraw(uint256 _shareAmount) external returns (uint256) {
        uint256 amount = (_shareAmount * totalPooledEth) / totalSupply;
        _burn(msg.sender, _shareAmount);
        totalPooledEth -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "failed");
        return amount;
    }
}`;
check("D22 56b-25 redeem langsung -> 1", d22(DIRECT56).length === 1);

// --- Seksi 57. Detektor ke-23: refund-locked-middleware (VENO-C1)
// (backlog detektor sesi BB pagi 19 Nov 2026 — BridgeMiddleware zkCRO;
// Medium wasit, KANDIDAT laten, mock PoC 5/5 PASS).
const d23 = (src, name) => runPipeline(src, name || "d23.sol").candidates
  .filter((c) => c.detector === "refund-locked-middleware");
const MID57 = "pragma solidity ^0.8.20;\ncontract RefundTrap {\n"
  + "    IBridgeHub public bridgehub;\n"
  + "    uint256 public chainId;\n"
  + "    address public treasury;\n"
  + "    constructor(uint256 _chainId, address _bridgeHub, address _treasury) {\n"
  + "        chainId = _chainId; bridgehub = IBridgeHub(_bridgeHub); treasury = _treasury;\n"
  + "    }\n"
  + "    function withdrawEth(uint256 _amount) external {\n"
  + "        (bool ok, ) = payable(treasury).call{value: _amount}(\"\");\n"
  + "        require(ok, \"failed\");\n"
  + "    }\n"
  + "    function withdrawBaseToken(uint256 _amount) external {\n"
  + "        address baseToken = bridgehub.baseToken(chainId);\n"
  + "        IERC20(baseToken).safeTransfer(treasury, _amount);\n"
  + "    }\n"
  + "    function bridge(address _l2Receiver, address _token, uint256 _amount, address _refundRecipient) external payable returns (bytes32) {\n"
  + "        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);\n"
  + "        address sharedBridge = bridgehub.sharedBridge();\n"
  + "        IERC20(_token).approve(sharedBridge, _amount);\n"
  + "        return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));\n"
  + "    }\n}";
const c57 = d23(MID57);
check("D23 57-1 fixture mini -> 1 Medium @ bridge",
  c57.length === 1 && c57[0].severityGuess === "Medium"
    && c57[0].location.function === "bridge",
  "dapat " + JSON.stringify(c57.map((c) => c.location.function + ":" + c.severityGuess)));
// 57-2. BridgeMiddleware.sol verbatim (impl terverifikasi Etherscan,
// work/veno-source/) -> 1 Medium @ bridge (jangkar entrypoint external,
// panggilan bridge hidup di _bridgeErc20/_bridgeEth internal).
const bmPath = path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "BridgeMiddleware", "src_BridgeMiddleware.sol");
const bmSrc = fs.readFileSync(bmPath, "utf8");
const c57b = d23(bmSrc, "src_BridgeMiddleware.sol");
check("D23 57-2 BridgeMiddleware verbatim -> 1 Medium @ bridge",
  c57b.length === 1 && c57b[0].severityGuess === "Medium"
    && c57b[0].location.function === "bridge",
  "dapat " + JSON.stringify(c57b.map((c) => c.location.function + ":" + c.severityGuess)));
// 57-3. + rescueToken(token, to, amount) -> 0 (jalur keluar arbitrer ada).
check("D23 57-3 rescue ERC20 arbitrer -> 0",
  d23(MID57.replace("    function bridge(",
    "    function rescueToken(address token, address to, uint256 amount) external {\n"
    + "        IERC20(token).safeTransfer(to, amount);\n"
    + "    }\n    function bridge(")).length === 0);
// 57-4. + receive() -> tetap 1 (kaki ERC20), evidence tak lagi menyebut
// refund ETH revert.
const c574 = d23(MID57.replace("    function bridge(",
  "    receive() external payable {}\n    function bridge("));
check("D23 57-4 receive() -> tetap 1, tanpa catatan revert ETH",
  c574.length === 1 && !/tanpa receive/.test(c574[0].evidence),
  "dapat " + JSON.stringify(c574.map((c) => c.location.function + ":" + c.evidence.slice(0, 80))));
// 57-5. Tanpa panggilan bridge (hanya withdraw) -> 0.
check("D23 57-5 tanpa panggilan bridge -> 0",
  d23(MID57.replace("        return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));\n",
    "        return bytes32(0);\n")).length === 0);
// 57-6. Rescue di kontrak LAIN satu file -> tetap 1 (rescue per-kontrak).
check("D23 57-6 rescue di kontrak lain -> tetap 1",
  d23(MID57 + "\ncontract Other {\n"
    + "    function rescueToken(address token, address to, uint256 amount) external {\n"
    + "        IERC20(token).safeTransfer(to, amount);\n    }\n}").length === 1);
// 57-7. File test/mock dilewati -> 0.
check("D23 57-7 file test dilewati -> 0",
  d23(MID57, "test/d23.sol").length === 0
  && d23(MID57, "BridgeMiddleware.t.sol").length === 0);
// 57-8. Proxy (receive + delegatecall) -> 0; multicall delegatecall ke
// address(this) -> 1 (kalibrasi R23 F10: delegatecall di fungsi biasa
// bukan proxy dan tidak membungkam file).
check("D23 57-8 proxy receive+delegatecall -> 0, multicall -> 1",
  d23(MID57.replace("    function bridge(",
    "    receive() external payable { (bool ok,) = impl.delegatecall(msg.data); require(ok); }\n    function bridge(")).length === 0
  && d23(MID57.replace("    function bridge(",
    "    function multicall(bytes[] calldata d) external {\n"
    + "        for (uint i; i < d.length; i++) {\n"
    + "            (bool ok,) = address(this).delegatecall(d[i]);\n            require(ok);\n        }\n    }\n    function bridge(")).length === 1);
// 57-9. toVerify menyebut refund bridge live + saldo live + kontrak induk.
check("D23 57-9 toVerify menyebut refund live + saldo live + induk",
  c57.length === 1 && c57[0].toVerify.some((t) => /refund bridge LIVE/i.test(t))
  && c57[0].toVerify.some((t) => /saldo LIVE/i.test(t))
  && c57[0].toVerify.some((t) => /kontrak induk/i.test(t)));
// 57-10. deposit* pada objek router -> 1; pada objek generik (vault) -> 0.
check("D23 57-10 deposit via router -> 1, via vault generik -> 0",
  d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    "return router.deposit(_l2Receiver, _token, _amount);")).length === 1
  && d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    "return vault.deposit(_l2Receiver, _token, _amount);")).length === 0);
// 57-11. ETH-only (tanpa inflow token, {value:} ke bridge) + tanpa
// receive -> 1; + receive() -> 0 (refund ETH bisa masuk, tak ada yang
// terkunci di middleware).
const ETH57 = MID57
  .replace("        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);\n", "")
  .replace("        IERC20(_token).approve(sharedBridge, _amount);\n", "")
  .replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    "return bridgehub.requestL2TransactionTwoBridges{value: msg.value}(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));");
check("D23 57-11 ETH-only tanpa receive -> 1, + receive -> 0",
  d23(ETH57).length === 1
  && d23(ETH57.replace("    function bridge(",
    "    receive() external payable {}\n    function bridge(")).length === 0);
// 57-12. trap-vault: D23 tepat 1 @ bridge (RefundTrap); kontrak
// RefundTrapRescued (rescueToken) diam.
const trapD23 = runPipeline(sol, "trap-vault.sol").candidates
  .filter((c) => c.detector === "refund-locked-middleware");
check("D23 57-12 trap-vault -> tepat 1 @ bridge",
  trapD23.length === 1 && trapD23[0].location.function === "bridge",
  "dapat " + JSON.stringify(trapD23.map((c) => c.location.function)));

// --- Seksi 57b. Kalibrasi R23 review Kiro Opus 5.5 atas D23 (NEEDS WORK
// F1-F18; sesi e10bdb74) + temuan wasit W1 (rantai transitif middleware)
// + F12 (semantik refund Direct vs TwoBridges, terverifikasi
// era-contracts: Messaging.sol + L1Bridgehub.sol). Probe wasit
// /tmp/probe-d23-r23.js 35/35 PASS pasca-kalibrasi. F14 DITOLAK wasit
// (nomor baris 234 file asli BENAR — artefak stub Kiro; dikunci 57b-0).
// 57b-0. F14: baris panggilan bridge BridgeMiddleware asli = 234.
const bm57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "BridgeMiddleware", "src_BridgeMiddleware.sol"), "utf8");
check("D23 57b-0 baris panggilan bridge file asli = 234",
  d23(bm57b, "src_BridgeMiddleware.sol").length === 1
  && /\(baris 234\)/.test(d23(bm57b, "src_BridgeMiddleware.sol")[0].evidence));
// 57b-1. F12: zkCROMintAndBridge verbatim (Direct, refund ke user) -> 0.
const zk57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "zkCROMintAndBridge", "contracts_ZkCroMintAndBridge.sol"), "utf8");
check("D23 57b-1 zkCROMintAndBridge verbatim (Direct) -> 0",
  d23(zk57b, "contracts_ZkCroMintAndBridge.sol").length === 0);
// 57b-2. F12b/c: Direct refundRecipient=address(this) -> 1; =msg.sender -> 0.
const DIR57 = "return bridgehub.requestL2TransactionDirect(L2TransactionRequestDirect({chainId: chainId, mintValue: msg.value, l2Contract: _l2Receiver, l2Value: 0, l2Calldata: \"\", l2GasLimit: 100000, l2GasPerPubdataByteLimit: 800, factoryDeps: new bytes[](0), refundRecipient: RECIP}));";
check("D23 57b-2 Direct refundRecipient address(this)->1, msg.sender->0",
  d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    DIR57.replace("RECIP", "address(this)"))).length === 1
  && d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    DIR57.replace("RECIP", "msg.sender"))).length === 0);
// 57b-3. F1: cast inline IBridgehub(x).requestL2... -> 1.
check("D23 57b-3 cast inline IBridgehub(x).requestL2 -> 1",
  d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(",
    "return IBridgehub(address(bridgehub)).requestL2TransactionTwoBridges(")).length === 1);
// 57b-4. F1b: cast inline IBridgehub(b).deposit{value:} -> 1.
check("D23 57b-4 cast inline IBridgehub(b).deposit{value:} -> 1",
  d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    "return IBridgehub(address(bridgehub)).deposit{value: msg.value}(_l2Receiver, _token, _amount);")).length === 1);
// 57b-5. F2: getter bridgehub()/bridgeFee() bukan panggilan bridge.
check("D23 57b-5 getter bridgehub()/bridgeFee() -> 0 / bridge asli -> 1",
  d23("pragma solidity ^0.8.20;\ncontract S {\n"
    + "    function stake(address t, uint a) external {\n"
    + "        IERC20(t).safeTransferFrom(msg.sender, address(this), a);\n"
    + "        emit Hub(factory.bridgehub());\n    }\n}").length === 0
  && d23("pragma solidity ^0.8.20;\ncontract E {\n"
    + "    function fee() public view returns (uint256) { return registry.bridgeFee(); }\n"
    + "    function bridgeEth() external payable { l1Bridge.deposit{value: msg.value}(); }\n}").length === 1);
// 57b-6. F3: deposit pada pool1/wethGateway/tokenMessenger -> 0.
check("D23 57b-6 deposit pool1/wethGateway/tokenMessenger -> 0",
  d23(MID57.replace("return bridgehub.requestL2TransactionTwoBridges(",
    "return pool1.deposit(")).length === 0
  && d23("pragma solidity ^0.8.20;\ncontract Z {\n"
    + "    function zap() external payable { wethGateway.depositETH{value: msg.value}(pool, msg.sender, 0); }\n}").length === 0
  && d23("pragma solidity ^0.8.20;\ncontract C {\n"
    + "    function go(uint a, uint32 d, bytes32 r) external {\n"
    + "        IERC20(usdc).safeTransferFrom(msg.sender, address(this), a);\n"
    + "        tokenMessenger.depositForBurn(a, d, r, usdc);\n    }\n}").length === 0);
// 57b-7. F4: inflow _msgSender() -> 1.
check("D23 57b-7 inflow _msgSender() -> 1",
  d23(MID57.replace("IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);",
    "IERC20(_token).safeTransferFrom(_msgSender(), address(this), _amount);")).length === 1);
// 57b-8. F5: to.transfer ETH bukan rescue ERC20 -> 1.
check("D23 57b-8 to.transfer ETH bukan rescue -> 1",
  d23(MID57.replace("    function withdrawBaseToken(",
    "    function withdrawEthTo(address payable to) external onlyOwner {\n"
    + "        to.transfer(address(this).balance);\n    }\n    function withdrawBaseToken(")).length === 1);
// 57b-9. F6: dust/safeTransferFrom di fn bridge bukan rescue -> 1.
check("D23 57b-9 dust di fn bridge bukan rescue -> 1",
  d23(MID57.replace("        return bridgehub.requestL2TransactionTwoBridges(",
    "        IERC20(_token).safeTransfer(msg.sender, IERC20(_token).balanceOf(address(this)));\n        return bridgehub.requestL2TransactionTwoBridges(")).length === 1
  && d23(MID57.replace("        return bridgehub.requestL2TransactionTwoBridges(",
    "        IERC20(_token).safeTransferFrom(from, address(this), _amount);\n        return bridgehub.requestL2TransactionTwoBridges(")).length === 1);
// 57b-10. F7: rescue IERC20 / SafeERC20 / helper internal -> 0.
check("D23 57b-10 rescue IERC20/SafeERC20/helper -> 0",
  d23(MID57.replace("    function bridge(",
    "    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {\n"
    + "        token.safeTransfer(to, amount);\n    }\n    function bridge(")).length === 0
  && d23(MID57.replace("    function bridge(",
    "    function rescue2(address token, address to, uint256 amount) external onlyOwner {\n"
    + "        SafeERC20.safeTransfer(IERC20(token), to, amount);\n    }\n    function bridge(")).length === 0
  && d23(MID57.replace("    function bridge(",
    "    function rescue3(address token, address to, uint256 amount) external onlyOwner {\n"
    + "        _rescue(token, to, amount);\n    }\n"
    + "    function _rescue(address token, address to, uint256 amount) internal {\n"
    + "        IERC20(token).safeTransfer(to, amount);\n    }\n    function bridge(")).length === 0);
// 57b-11. F8: transferFrom(address(this)) / allowlist konstan -> 1.
check("D23 57b-11 transferFrom(address(this))/allowlist -> 1",
  d23(MID57.replace("    function bridge(",
    "    function rescue(address token, address to, uint256 amount) external onlyOwner {\n"
    + "        IERC20(token).transferFrom(address(this), to, amount);\n    }\n    function bridge(")).length === 1
  && d23(MID57.replace("    function bridge(",
    "    function rescueUsdc(address token, address to, uint256 amount) external onlyOwner {\n"
    + "        require(token == USDC);\n"
    + "        IERC20(token).safeTransfer(to, amount);\n    }\n    function bridge(")).length === 1);
// 57b-12. F9: rescue di parent file sama -> 0.
check("D23 57b-12 rescue di parent file sama -> 0",
  d23("pragma solidity ^0.8.20;\nabstract contract Rescuable {\n"
    + "    function rescueToken(address token, address to, uint256 amount) external {\n"
    + "        IERC20(token).safeTransfer(to, amount);\n    }\n}\n"
    + MID57.replace("contract RefundTrap {", "contract RefundTrap is Rescuable {")).length === 0);
// 57b-13. F10: multicall delegatecall -> 1 (bukan proxy).
check("D23 57b-13 multicall delegatecall -> 1",
  d23(MID57.replace("    function bridge(",
    "    function multicall(bytes[] calldata d) external {\n"
    + "        for (uint i; i < d.length; i++) {\n"
    + "            (bool ok,) = address(this).delegatecall(d[i]);\n            require(ok);\n        }\n    }\n    function bridge(")).length === 1);
// 57b-14. F11: logika bridge di library -> 1.
check("D23 57b-14 bridge di library -> 1",
  d23("pragma solidity ^0.8.20;\nlibrary BridgeLib {\n"
    + "    function go(IBridgehub h, address t, uint a) internal { h.requestL2TransactionTwoBridges(req(t, a)); }\n}\n"
    + "contract L {\n"
    + "    IBridgehub public hub;\n"
    + "    function bridge(address t, uint a) external {\n"
    + "        IERC20(t).safeTransferFrom(msg.sender, address(this), a);\n"
    + "        BridgeLib.go(hub, t, a);\n    }\n}").length === 1);
// 57b-15. F13: receive() revert + ETH-only -> 1.
const ETH57b = MID57
  .replace("        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);\n", "")
  .replace("        IERC20(_token).approve(sharedBridge, _amount);\n", "")
  .replace("return bridgehub.requestL2TransactionTwoBridges(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));",
    "return bridgehub.requestL2TransactionTwoBridges{value: msg.value}(chainId, msg.value, 0, 100000, 800, _refundRecipient, sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver));");
check("D23 57b-15 receive() revert + ETH-only -> 1",
  d23(ETH57b.replace("    function bridge(",
    "    receive() external payable { require(msg.sender == address(weth)); }\n    function bridge(")).length === 1);
// 57b-16. F15: jangkar 2 hop internal -> @ bridgeErc20 (external).
check("D23 57b-16 jangkar 2 hop -> @ bridgeErc20",
  (() => {
    const s = "pragma solidity ^0.8.20;\ncontract M {\n"
      + "    IBridgehub public bridgehub;\n"
      + "    function bridgeErc20(address r, address t, uint256 a, uint256 g) external payable {\n"
      + "        IERC20(t).safeTransferFrom(msg.sender, address(this), a);\n"
      + "        _route(r, t, a, g);\n    }\n"
      + "    function _route(address a, address b, uint256 c, uint256 d) internal { _bridgeErc20(a, b, c, d); }\n"
      + "    function _bridgeErc20(address r, address t, uint256 a, uint256 g) internal {\n"
      + "        bridgehub.requestL2TransactionTwoBridges(req(r, t, a, g));\n    }\n}";
    const r = d23(s);
    return r.length === 1 && r[0].location.function === "bridgeErc20";
  })());
// 57b-17. F16: ETH-only -> Low; upgradeable -> Low.
check("D23 57b-17 ETH-only -> Low; upgradeable -> Low",
  (() => {
    const e = d23(ETH57b);
    const u = d23(MID57.replace("contract RefundTrap {", "contract RefundTrap is UUPSUpgradeable, OwnableUpgradeable {"));
    return e.length === 1 && e[0].severityGuess === "Low"
      && u.length === 1 && u[0].severityGuess === "Low";
  })());
// 57b-18. F17: tanpa jalur ETH, hipotesis tanpa klaim REVERT.
check("D23 57b-18 tanpa jalur ETH -> hipotesis tanpa REVERT",
  (() => {
    const r = d23(MID57.replace("    function withdrawEth(uint256 _amount) external {\n"
      + "        (bool ok, ) = payable(treasury).call{value: _amount}(\"\");\n"
      + "        require(ok, \"failed\");\n    }\n", ""));
    return r.length === 1 && !/REVERT/.test(r[0].hypothesis);
  })());
// 57b-19. F18: *Mock.sol sufiks + script/*.s.sol -> 0.
check("D23 57b-19 Mock sufiks + script .s.sol -> 0",
  d23(MID57, "src/BridgeMiddlewareMock.sol").length === 0
  && d23(MID57, "script/Deploy.s.sol").length === 0);
// 57b-20. W1: ybETHBridge + ybUSDBridge verbatim (transitif) -> 0.
const yb57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "ybETHBridge", "src_YbEthBridge.sol"), "utf8");
const yu57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "ybUSDBridge", "src_YBUSDBridge.sol"), "utf8");
check("D23 57b-20 ybETH/ybUSD Bridge verbatim (transitif) -> 0",
  d23(yb57b, "src_YbEthBridge.sol").length === 0
  && d23(yu57b, "src_YBUSDBridge.sol").length === 0);
// 57b-21. C20: claimFailed penerus ke depositor -> 0 (rescue sah).
check("D23 57b-21 claimFailed penerus -> 0",
  d23(MID57.replace("    function bridge(",
    "    function claimFailedDeposit(address token, address depositor, uint256 amount) external {\n"
    + "        IERC20(token).safeTransfer(depositor, amount);\n    }\n    function bridge(")).length === 0);
// 57b-22. C31: execute arbitrer ber-guard (onlyOwner) -> 0.
check("D23 57b-22 execute arbitrer onlyOwner -> 0",
  d23(MID57.replace("    function bridge(",
    "    function execute(address target, bytes calldata data) external onlyOwner {\n"
    + "        (bool ok,) = target.call(data);\n        require(ok);\n    }\n    function bridge(")).length === 0);
// 57b-23. F19: L1Bridgehub verbatim (inti bridge) -> 0.
const l1b57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "BridgeHub_IMPL", "contracts", "core", "bridgehub", "L1Bridgehub.sol"), "utf8");
check("D23 57b-23 L1Bridgehub verbatim (inti bridge) -> 0",
  d23(l1b57b, "L1Bridgehub.sol").length === 0);
// 57b-24. F19b: AssetRouterBase verbatim (inti bridge) -> 0.
const ar57b = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "veno-source", "L1SharedBridge_IMPL", "contracts", "bridge", "asset-router", "AssetRouterBase.sol"), "utf8");
check("D23 57b-24 AssetRouterBase verbatim (inti bridge) -> 0",
  d23(ar57b, "AssetRouterBase.sol").length === 0);

// --- Seksi 58. Detektor ke-24: variant-branch-no-payload-consume (L-1)
// (backlog detektor sesi BB pagi 20 Nov 2026 — Hyperbridge Codec.DecodeHeader
// cabang Other tak konsumsi payload; Info/design, BUKAN kandidat submit).
const d24 = (src, name) => runPipeline(src, name || "d24.sol").candidates
  .filter((c) => c.detector === "variant-branch-no-payload-consume");
const MINI58 = "pragma solidity ^0.8.20;\ncontract Mini58 {\n"
  + "    uint8 constant ITEM_OTHER = 0;\n"
  + "    uint8 constant ITEM_CONSENSUS = 4;\n"
  + "    struct Item { bytes4 id; bytes data; }\n"
  + "    struct Slice { bytes data; uint256 offset; }\n"
  + "    function readByte(Slice memory s) internal pure returns (uint8) {\n"
  + "        uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b;\n"
  + "    }\n"
  + "    function decodeItem(Slice memory s) internal pure returns (Item memory) {\n"
  + "        bytes4 id = bytes4(s.data[s.offset]); s.offset += 4;\n"
  + "        uint256 len = uint256(uint8(readByte(s)));\n"
  + "        bytes memory data = new bytes(len);\n"
  + "        for (uint256 i = 0; i < len; i++) { data[i] = s.data[s.offset + i]; }\n"
  + "        s.offset += len; return Item(id, data);\n"
  + "    }\n"
  + "    function decode(bytes memory encoded) internal pure returns (Item[] memory) {\n"
  + "        Slice memory slice = Slice(encoded, 0);\n"
  + "        uint256 length = uint256(uint8(readByte(slice)));\n"
  + "        Item[] memory items = new Item[](length);\n"
  + "        for (uint256 i = 0; i < length; i++) {\n"
  + "            uint8 kind = readByte(slice);\n"
  + "            Item memory item;\n"
  + "            if (kind == ITEM_OTHER) {\n"
  + "                // hanya flag, payload tidak dibaca\n"
  + "            } else if (kind == ITEM_CONSENSUS) {\n"
  + "                item = decodeItem(slice);\n"
  + "            }\n"
  + "            items[i] = item;\n"
  + "        }\n"
  + "        return items;\n"
  + "    }\n}";
const c58 = d24(MINI58);
check("D24 58-1 fixture mini -> 1 Info @ decode, cond OTHER",
  c58.length === 1 && c58[0].severityGuess === "Info"
    && c58[0].location.function === "decode"
    && c58[0].evidence.indexOf("ITEM_OTHER") !== -1,
  "dapat " + JSON.stringify(c58.map((c) => c.location.function + ":" + c.severityGuess)));
// 58-2. Codec.sol verbatim (repo Hyperbridge @ 3cd7d227) -> 1 Info @
// DecodeHeader (cabang Other); RUNTIME_ENVIRONMENT_UPDATED tidak di-flag.
const codec58 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "hyperbridge-flow", "hyperbridge", "evm", "src", "consensus", "Codec.sol"), "utf8");
const c582 = d24(codec58, "Codec.sol");
check("D24 58-2 Codec verbatim -> 1 Info @ DecodeHeader",
  c582.length === 1 && c582[0].severityGuess === "Info"
    && c582[0].location.function === "DecodeHeader"
    && c582[0].evidence.indexOf("OTHER") !== -1
    && c582[0].evidence.indexOf("RUNTIME_ENVIRONMENT_UPDATED") === -1,
  "dapat " + JSON.stringify(c582.map((c) => c.location.function + ":" + c.severityGuess)));
// 58-3. Cabang Other ikut mengonsumsi payload (readByte) -> 0.
check("D24 58-3 Other ikut konsumsi -> 0",
  d24(MINI58.replace("                // hanya flag, payload tidak dibaca\n",
    "                item.data = new bytes(uint256(uint8(readByte(slice))));\n")).length === 0);
// 58-4. Cabang non-konsumsi satu-satunya adalah varian unit (ITEM_UNIT,
// tanpa payload di wire format) -> 0.
check("D24 58-4 hanya varian unit non-konsumsi -> 0",
  d24(MINI58.replace("if (kind == ITEM_OTHER)", "if (kind == ITEM_UNIT)")).length === 0);
// 58-5. Tanpa cabang konsumsi sama sekali -> 0.
check("D24 58-5 tanpa cabang konsumsi -> 0",
  d24(MINI58.replace("                item = decodeItem(slice);\n",
    "                // hanya flag\n")).length === 0);
// 58-6. Dispatch sekali jalan tanpa loop -> 0.
const NOLOOP58 = "pragma solidity ^0.8.20;\ncontract NoLoop58 {\n"
  + "    uint8 constant ITEM_OTHER = 0;\n"
  + "    uint8 constant ITEM_CONSENSUS = 4;\n"
  + "    struct Slice { bytes data; uint256 offset; }\n"
  + "    function readByte(Slice memory s) internal pure returns (uint8) { uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b; }\n"
  + "    function decodeItem(Slice memory s) internal pure returns (bytes memory) { s.offset += 4; return new bytes(0); }\n"
  + "    function decodeOnce(bytes memory encoded) internal pure returns (bytes memory) {\n"
  + "        Slice memory slice = Slice(encoded, 0);\n"
  + "        uint8 kind = readByte(slice);\n"
  + "        if (kind == ITEM_OTHER) { return new bytes(0); }\n"
  + "        else if (kind == ITEM_CONSENSUS) { return decodeItem(slice); }\n"
  + "        return new bytes(0);\n"
  + "    }\n}";
check("D24 58-6 tanpa loop -> 0", d24(NOLOOP58).length === 0);
// 58-7. File test/mock dilewati -> 0.
check("D24 58-7 file test dilewati -> 0",
  d24(MINI58, "test/d24.sol").length === 0
  && d24(MINI58, "Codec.t.sol").length === 0);
// 58-8. trap-vault: D24 tepat 1 @ decodeHeader (BUG 25); kontrol Q/R diam
// (juga tercakup seksi 1 negativeControls).
const trapD24 = runPipeline(sol, "trap-vault.sol").candidates
  .filter((c) => c.detector === "variant-branch-no-payload-consume");
check("D24 58-8 trap-vault -> tepat 1 @ decodeHeader",
  trapD24.length === 1 && trapD24[0].location.function === "decodeHeader",
  "dapat " + JSON.stringify(trapD24.map((c) => c.location.function)));
// 58-9. toVerify menyebut format wire + finalized.
check("D24 58-9 toVerify menyebut format wire + finalized",
  c58.length === 1 && c58[0].toVerify.some((t) => t.indexOf("wire") !== -1)
    && c58[0].toVerify.some((t) => t.indexOf("finalized") !== -1));
// 58-10. Tag literal numerik tanpa nama konstanta -> 0 (batas diketahui).
check("D24 58-10 tag literal numerik -> 0",
  d24(MINI58.replace("if (kind == ITEM_OTHER)", "if (kind == 0)")).length === 0);
// 58-11. while-loop (bukan hanya for) ikut terdeteksi -> 1.
const WHILE58 = MINI58
  .replace("        for (uint256 i = 0; i < length; i++) {\n",
    "        uint256 i = 0;\n        while (i < length) {\n")
  .replace("            items[i] = item;\n        }\n",
    "            items[i] = item;\n            i++;\n        }\n");
check("D24 58-11 while-loop -> 1 @ decode",
  d24(WHILE58).length === 1 && d24(WHILE58)[0].location.function === "decode",
  "dapat " + JSON.stringify(d24(WHILE58).map((c) => c.location.function)));

// --- Seksi 58b. Kalibrasi R24 detektor ke-24 (wasit atas review Kiro Opus 5.5
// NEEDS WORK, sesi #42 — 20 probe F1-F22 lolos; bentuk nama-konstanta F13/F14,
// F15, F19-F21, F22-j2, F18-return dikunci di sini sebagai tes suite).
const H58B = `pragma solidity ^0.8.20;
contract P58b {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    struct Digest { bool isOther; bytes other; bool isSeal; Item seal; }
    function readByte(Slice memory s) internal pure returns (uint8) {
        uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b;
    }
    function decodeItem(Slice memory s) internal pure returns (Item memory) {
        bytes4 id = bytes4(s.data[s.offset]); s.offset += 4;
        uint256 len = uint256(uint8(readByte(s)));
        bytes memory data = new bytes(len); s.offset += len;
        return Item(id, data);
    }
`;
const loop58b = (inner) => H58B + `
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        for (uint256 i = 0; i < 2; i++) {
${inner}
        }
        return d;
    }
}
`;
// 58b-1. F1: cast di tag-read `uint8(readByte(slice))` -> cursor `slice` -> 1.
check("D24 58b-1 F1 cast tag-read -> 1",
  d24(loop58b(`            uint8 kind = uint8(readByte(slice));
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-2. F1b: `uint8(slice.data[slice.offset])` -> cursor `slice` -> 1.
check("D24 58b-2 F1b nested member call -> 1",
  d24(loop58b(`            uint8 kind = uint8(slice.data[slice.offset]);
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-3. F2: cursor indeks `enc[offset]` -> 1.
const P258B = `pragma solidity ^0.8.20;
contract P2 {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Digest { bool isOther; bool isSeal; }
    function decode(bytes memory enc) internal pure returns (Digest memory) {
        uint256 offset = 0;
        Digest memory d;
        for (uint256 i = 0; i < 2; i++) {
            uint8 kind = uint8(enc[offset]); offset++;
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { uint256 len = uint256(uint8(enc[offset])); offset += 1 + len; }
        }
        return d;
    }
}
`;
check("D24 58b-3 F2 cursor indeks -> 1", d24(P258B).length === 1);
// 58b-4. F3: cast di kondisi `uint8(kind) == OTHER` -> 1.
check("D24 58b-4 F3 cast di kondisi -> 1",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (uint8(kind) == OTHER) { d.isOther = true; }
            else if (uint8(kind) == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-5. F4: Yoda `OTHER == kind` -> 1.
check("D24 58b-5 F4 Yoda -> 1",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (OTHER == kind) { d.isOther = true; }
            else if (SEAL == kind) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-6. F5: state-based no-arg `readByte()` / `decodeItem()` -> 1.
check("D24 58b-6 F5 state-based -> 1",
  d24(loop58b(`            uint8 kind = readByte();
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(); }`)).length === 1);
// 58b-7. F6: assembly yang menyebut cursor dihitung konsumsi -> 0.
check("D24 58b-7 F6 assembly -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { assembly { mstore(add(slice, 0x20), add(mload(add(slice, 0x20)), 1)) } }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-8. F7: `abi.decode` TIDAK memajukan offset -> 1.
check("D24 58b-8 F7 abi.decode -> 1",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { d.other = abi.decode(slice.data, (bytes)); }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-9. F8: helper tak dikenal `handleOther(slice)` dihitung konsumsi -> 0.
check("D24 58b-9 F8 helper tak dikenal -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { handleOther(slice); }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-10. F9: verb di luar daftar (`takeBytes`) ikut konsumsi -> 0.
check("D24 58b-10 F9 takeBytes -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { d.other = takeBytes(slice, 4); }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-11. F10a: `slice.offset == ...` (perbandingan) bukan konsumsi -> 1.
check("D24 58b-11 F10a perbandingan offset -> 1",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { if (slice.offset == slice.data.length) break; d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-12. F10b: `slice.offset = 0` (reset) bukan konsumsi -> 1.
check("D24 58b-12 F10b reset offset -> 1",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { slice.offset = 0; d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 1);
// 58b-13. F12: konstanta `Kind.A` / `Kind.B` tanpa kata hint -> 0 (batas
// cakupan nama-only, didokumentasikan).
check("D24 58b-13 F12 Kind.A/Kind.B -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == Kind.A) { d.isOther = true; }
            else if (kind == Kind.B) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-14. F13 bentuk nama: DATA_CLEARED / WITHDRAW_ALL / EXTRACTED tidak
// mengandung token hint utuh -> 0 (ketiganya).
check("D24 58b-14 F13 nama tanpa hint -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == DATA_CLEARED) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0
  && d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == WITHDRAW_ALL) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0
  && d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == EXTRACTED) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-15. F14: `kind == PING && !cfg.allowOther` — hint hanya dari operand
// konstanta (PING), `allowOther` diabaikan -> 0.
check("D24 58b-15 F14 predikat allowOther -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == PING && !cfg.allowOther) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-16. F15: tag var bernama `payloadType` tidak memicu hint (yang diuji
// hanya operand konstanta PING/MSG) -> 0.
check("D24 58b-16 F15 tag var payloadType -> 0",
  d24(loop58b(`            uint8 payloadType = readByte(slice);
            if (payloadType == PING) { d.isOther = true; }
            else if (payloadType == MSG) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-17. F16: cabang catch-all `else` flag-only -> 1 Info; else + revert -> 0.
check("D24 58b-17 F16 else flag-only -> 1 Info",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == SEAL) { d.seal = decodeItem(slice); }
            else if (kind == 4) { d.seal = decodeItem(slice); }
            else { d.isOther = true; }`)).length === 1
  && d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == SEAL) { d.seal = decodeItem(slice); }
            else if (kind == 4) { d.seal = decodeItem(slice); }
            else { d.isOther = true; }`))[0].severityGuess === "Info");
check("D24 58b-18 F16 else + revert -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == SEAL) { d.seal = decodeItem(slice); }
            else if (kind == 4) { d.seal = decodeItem(slice); }
            else { revert("unsupported"); }`)).length === 0);
// 58b-19. F17: alias cursor `s = slice` lalu `takeBytes(s, 4)` -> 0.
check("D24 58b-19 F17 alias cursor -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            Slice memory s = slice;
            if (kind == SEAL) { d.seal = decodeItem(slice); }
            else if (kind == OTHER) { d.other = takeBytes(s, 4); }`)).length === 0);
// 58b-20. F18: cabang terminasi revert / break / return -> 0 (ketiganya).
check("D24 58b-20 F18 terminator -> 0",
  d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { revert("unsupported"); }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0
  && d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { break; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0
  && d24(loop58b(`            uint8 kind = readByte(slice);
            if (kind == OTHER) { return d; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }`)).length === 0);
// 58b-21. F19: do-while -> 1; for tanpa kurawal + penugasan tag inline -> 1.
const DO58B = `pragma solidity ^0.8.20;
contract Do58b {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    struct Digest { bool isOther; bytes other; bool isSeal; Item seal; }
    function readByte(Slice memory s) internal pure returns (uint8) {
        uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b;
    }
    function decodeItem(Slice memory s) internal pure returns (Item memory) {
        bytes4 id = bytes4(s.data[s.offset]); s.offset += 4;
        return Item(id, new bytes(0));
    }
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        do {
            uint8 kind = readByte(slice);
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }
        } while (slice.offset < encoded.length);
        return d;
    }
}`;
check("D24 58b-21 F19 do-while -> 1", d24(DO58B).length === 1);
const BRACELESS58B = `pragma solidity ^0.8.20;
contract Bl58b {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    struct Digest { bool isOther; bytes other; bool isSeal; Item seal; }
    function readByte(Slice memory s) internal pure returns (uint8) {
        uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b;
    }
    function decodeItem(Slice memory s) internal pure returns (Item memory) {
        bytes4 id = bytes4(s.data[s.offset]); s.offset += 4;
        return Item(id, new bytes(0));
    }
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        uint8 kind;
        for (uint256 i = 0; i < 2; i++)
            if ((kind = readByte(slice)) == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }
        return d;
    }
}`;
check("D24 58b-22 F19 braceless inline -> 1", d24(BRACELESS58B).length === 1);
// 58b-23. F20: rantai if bersarang di badan cabang ikut dipindai -> tepat 1.
const NEST58B = `pragma solidity ^0.8.20;
contract Nest58b {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    struct Digest { bool isOther; bytes other; bool isSeal; Item seal; bytes v2; }
    function readByte(Slice memory s) internal pure returns (uint8) { uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b; }
    function decodeItem(Slice memory s) internal pure returns (Item memory) { bytes4 id = bytes4(s.data[s.offset]); s.offset += 4; return Item(id, new bytes(0)); }
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        for (uint256 i = 0; i < 2; i++) {
            uint8 version = readByte(slice);
            if (version == 1) {
                uint8 kind = readByte(slice);
                if (kind == OTHER) { d.isOther = true; }
                else if (kind == SEAL) { d.seal = decodeItem(slice); }
            } else if (version == 2) {
                d.v2 = decodeItem(slice).data;
            }
        }
        return d;
    }
}`;
check("D24 58b-23 F20 nested chain -> tepat 1",
  d24(NEST58B).length === 1 && d24(NEST58B)[0].location.function === "decode",
  "dapat " + JSON.stringify(d24(NEST58B).map((c) => c.location.function)));
// 58b-24. F21: loop bersarang — rantai yang sama tidak dilaporkan ganda.
const NESTLOOP58B = `pragma solidity ^0.8.20;
contract NestLoop58b {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    struct Digest { bool isOther; bytes other; bool isSeal; Item seal; }
    function readByte(Slice memory s) internal pure returns (uint8) { uint8 b = uint8(s.data[s.offset]); s.offset += 1; return b; }
    function decodeItem(Slice memory s) internal pure returns (Item memory) { bytes4 id = bytes4(s.data[s.offset]); s.offset += 4; return Item(id, new bytes(0)); }
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        for (uint256 j = 0; j < 2; j++) {
            for (uint256 i = 0; i < 2; i++) {
                uint8 kind = readByte(slice);
                if (kind == OTHER) { d.isOther = true; }
                else if (kind == SEAL) { d.seal = decodeItem(slice); }
            }
        }
        return d;
    }
}`;
check("D24 58b-24 F21 nested loops -> tepat 1",
  d24(NESTLOOP58B).length === 1,
  "dapat " + d24(NESTLOOP58B).length);
// 58b-25. F22: tag = parameter fungsi -> 0; tag dibaca sekali SEBELUM loop
// (bukan per-item) -> 0.
const P2258B = `pragma solidity ^0.8.20;
contract P22 {
    uint8 constant OTHER = 0;
    uint8 constant SEAL = 5;
    struct Slice { bytes data; uint256 offset; }
    struct Item { bytes4 id; bytes data; }
    function decodeItem(Slice memory s) internal pure returns (Item memory) {
        bytes4 id = bytes4(s.data[s.offset]); s.offset += 4;
        return Item(id, new bytes(0));
    }
    function f(uint8 kind, bytes memory encoded) internal pure returns (Item memory) {
        Slice memory slice = Slice(encoded, 0);
        Item memory item;
        for (uint256 i = 0; i < 2; i++) {
            if (kind == OTHER) { }
            else if (kind == SEAL) { item = decodeItem(slice); }
        }
        return item;
    }
}
`;
check("D24 58b-25 F22 param tag -> 0", d24(P2258B).length === 0);
const ONCE58B = H58B + `
    function decode(bytes memory encoded) internal pure returns (Digest memory) {
        Slice memory slice = Slice(encoded, 0);
        Digest memory d;
        uint8 kind = readByte(slice);
        for (uint256 i = 0; i < 2; i++) {
            if (kind == OTHER) { d.isOther = true; }
            else if (kind == SEAL) { d.seal = decodeItem(slice); }
        }
        return d;
    }
}`;
check("D24 58b-26 F22 tag dibaca sekali sebelum loop -> 0", d24(ONCE58B).length === 0);
// 58b-27. F23: semua kandidat D24 berseverity Info.
check("D24 58b-27 F23 severity Info",
  c58.length === 1 && c58[0].severityGuess === "Info"
    && c582.length === 1 && c582[0].severityGuess === "Info");

// --- Seksi 59. Kalibrasi R-DIV-1: guard division-no-guard bentuk
// early-return / assignment / else-branch / if-positif (sesi #44,
// hunting Resupply — 5/5 Medium GUGUR wasit, guard bukan require()).
function divCount(src) {
  return runPipeline(src, "div-guard.sol").candidates
    .filter((c) => c.detector === "division-no-guard").length;
}
// 59-1. G2: early-return — rewardPerToken Resupply (verbatim, dipangkas).
const DIV_EARLY = `pragma solidity ^0.8.20;
contract DivEarly {
    uint256 public rewardPerTokenStored;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    function totalSupply() public view returns (uint256) { return 0; }
    function lastTimeRewardApplicable() public view returns (uint256) { return 0; }
    function rewardPerToken() public view returns (uint256) {
        if (totalSupply() == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalSupply());
    }
}`;
check("D-DIV 59-1 G2 early-return -> 0", divCount(DIV_EARLY) === 0,
  "dapat " + divCount(DIV_EARLY));
// 59-2. G2 braceless: if (D == 0) return ...; tanpa kurawal.
const DIV_EARLY_BRACELESS = `pragma solidity ^0.8.20;
contract DivEarly2 {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate() public view returns (uint256) {
        if (totalSupply() == 0) return 0;
        return 1e18 / totalSupply();
    }
}`;
check("D-DIV 59-2 G2 braceless early-return -> 0", divCount(DIV_EARLY_BRACELESS) === 0,
  "dapat " + divCount(DIV_EARLY_BRACELESS));
// 59-3. G3: assignment guard — savingsRate Resupply (verbatim, dipangkas).
const DIV_ASSIGN = `pragma solidity ^0.8.20;
contract DivAssign {
    function savingsRate(uint256 totalAssets) public pure returns (uint256) {
        if(totalAssets == 0){
            totalAssets = 1;
        }
        return 1e18 / totalAssets;
    }
}`;
check("D-DIV 59-3 G3 assignment guard -> 0", divCount(DIV_ASSIGN) === 0,
  "dapat " + divCount(DIV_ASSIGN));
// 59-4. G4: pembagian di dalam if (D > 0).
const DIV_POSITIVE = `pragma solidity ^0.8.20;
contract DivPositive {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate(uint256 x) public view returns (uint256 r) {
        if(totalSupply() > 0){
            r = x * 1e18 / totalSupply();
        }
    }
}`;
check("D-DIV 59-4 G4 if-positif -> 0", divCount(DIV_POSITIVE) === 0,
  "dapat " + divCount(DIV_POSITIVE));
// 59-5. G5: else-branch lintas-variabel — convertToShares Resupply (verbatim).
const DIV_ELSE = `pragma solidity ^0.8.20;
contract DivElse {
    function totalSupply() public view returns (uint256) { return 0; }
    function totalAssets() public view returns (uint256) { return 0; }
    function convertToShares(uint256 _assets) public view returns (uint256 shares){
        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) {
            shares = _assets;
        } else {
            shares = _assets * _totalSupply / totalAssets();
        }
    }
}`;
check("D-DIV 59-5 G5 else lintas-variabel -> 0", divCount(DIV_ELSE) === 0,
  "dapat " + divCount(DIV_ELSE));
// 59-6. Kontrol negatif: pembagian tanpa guard TETAP memicu (1).
const DIV_UNGUARDED = `pragma solidity ^0.8.20;
contract DivUnguarded {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate(uint256 x) public view returns (uint256) {
        return x * 1e18 / totalSupply();
    }
}`;
check("D-DIV 59-6 tanpa guard -> 1", divCount(DIV_UNGUARDED) === 1,
  "dapat " + divCount(DIV_UNGUARDED));
// 59-7. Kontrol negatif: if (D == 0) tanpa return/revert/assign TIDAK menekan.
const DIV_NOEXIT = `pragma solidity ^0.8.20;
contract DivNoExit {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate(uint256 x) public view returns (uint256) {
        if (totalSupply() == 0) {
            x = 0;
        }
        return x * 1e18 / totalSupply();
    }
}`;
check("D-DIV 59-7 if-nol tanpa exit -> 1", divCount(DIV_NOEXIT) === 1,
  "dapat " + divCount(DIV_NOEXIT));
// 59-8. Kontrol negatif: guard atas variabel LAIN (bukan keluarga-total)
// TIDAK menekan pembagian totalSupply.
const DIV_OTHER_VAR = `pragma solidity ^0.8.20;
contract DivOtherVar {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate(uint256 x, uint256 cap) public view returns (uint256) {
        if (cap == 0) return 0;
        return x * 1e18 / totalSupply();
    }
}`;
check("D-DIV 59-8 guard var lain -> 1", divCount(DIV_OTHER_VAR) === 1,
  "dapat " + divCount(DIV_OTHER_VAR));
// 59-9. G1 tetap jalan: require(D > 0) menekan.
const DIV_REQUIRE = `pragma solidity ^0.8.20;
contract DivRequire {
    function totalSupply() public view returns (uint256) { return 0; }
    function rate(uint256 x) public view returns (uint256) {
        require(totalSupply() > 0, "empty");
        return x * 1e18 / totalSupply();
    }
}`;
check("D-DIV 59-9 G1 require -> 0", divCount(DIV_REQUIRE) === 0,
  "dapat " + divCount(DIV_REQUIRE));

// --- Seksi 60. Kalibrasi R18.5 (guard permission-record D18) +
// R-COF-2 ("Equivalent to require") — sesi #45, hunting Resupply
// (FA-001 Core.execute + FA-003/004 FixedPointMathLib, 20/20 gugur wasit).
const coc = (src) => runPipeline(src, "T.sol").candidates
  .filter((c) => c.detector === "commented-out-check");
// 60-1. R18.5: Core.execute verbatim (dipangkas) -> 0.
const R185_CORE = `pragma solidity ^0.8.20;
interface IAuthHook {
    function preHook(address caller, address target, bytes calldata data) external returns (bool);
    function postHook(bytes calldata result, address caller, address target, bytes calldata data) external returns (bool);
}
contract Core {
    struct OperatorAuth { bool authorized; IAuthHook hook; }
    mapping(address => mapping(address => mapping(bytes4 => OperatorAuth))) public operatorPermissions;
    address public voter;
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        if (msg.sender == voter) return target.functionCall(data);
        bytes4 selector = bytes4(data[:4]);
        OperatorAuth memory auth = operatorPermissions[msg.sender][address(0)][selector];
        if (!auth.authorized) {
            auth = operatorPermissions[msg.sender][target][selector];
        }
        require(auth.authorized, "!authorized");
        if (auth.hook != IAuthHook(address(0))) require(auth.hook.preHook(msg.sender, target, data), "Auth PreHook Failed");
        bytes memory result = target.functionCall(data);
        if (auth.hook != IAuthHook(address(0))) require(auth.hook.postHook(result, msg.sender, target, data), "Auth PostHook Failed");
        return result;
    }
}`;
check("D18 60-1 Core.execute verbatim (R18.5) -> 0", d18(R185_CORE).length === 0,
  "dapat " + d18(R185_CORE).length);
// 60-2. R18.5 bentuk langsung: require(map[msg.sender]... .authorized) -> 0.
const R185_DIRECT = wrap38(`    mapping(address => mapping(address => mapping(bytes4 => bool))) public perms;
    function execute(address target, bytes calldata data) external {
        require(perms[msg.sender][target][bytes4(data[:4])], "!auth");
        target.functionCall(data);
    }`);
check("D18 60-2 require langsung mapping msg.sender -> 0", d18(R185_DIRECT).length === 0,
  "dapat " + d18(R185_DIRECT).length);
// 60-3. R18.5 bentuk revert-guard: if (!auth.authorized) revert -> 0.
const R185_REVERT = wrap38(`    struct Auth { bool authorized; }
    mapping(address => mapping(address => Auth)) public perms;
    function execute(address target, bytes calldata data) external {
        Auth memory auth = perms[msg.sender][target];
        if (!auth.authorized) revert("!auth");
        target.functionCall(data);
    }`);
check("D18 60-3 if-revert permission-record -> 0", d18(R185_REVERT).length === 0,
  "dapat " + d18(R185_REVERT).length);
// 60-4. Kontrol negatif: record dimuat dari mapping TANPA msg.sender -> 1.
const R185_WRONGKEY = wrap38(`    struct Auth { bool authorized; }
    mapping(address => mapping(address => Auth)) public perms;
    function execute(address target, bytes calldata data) external {
        Auth memory auth = perms[target][owner];
        require(auth.authorized, "!auth");
        target.functionCall(data);
    }`);
check("D18 60-4 record tanpa msg.sender -> 1", d18(R185_WRONGKEY).length === 1,
  "dapat " + d18(R185_WRONGKEY).length);
// 60-5. Kontrol negatif: auth = parameter fungsi (caller yang memasok) -> 1.
const R185_PARAM = wrap38(`    struct Auth { bool authorized; }
    function execute(address target, bytes calldata data, Auth memory auth) external {
        require(auth.authorized, "!auth");
        target.functionCall(data);
    }`);
check("D18 60-5 auth parameter caller -> 1", d18(R185_PARAM).length === 1,
  "dapat " + d18(R185_PARAM).length);
// 60-6. Regresi: dispatch tanpa guard TETAP -> 1.
check("D18 60-6 dispatch tanpa guard TETAP -> 1", d18(t38a).length === 1,
  "dapat " + d18(t38a).length);
// 60-7. R-COF-2: mulDivDown verbatim (dipangkas) -> 0.
const COF_EQUIV = `pragma solidity ^0.8.20;
contract MathLib {
    uint256 internal constant MAX_UINT256 = type(uint256).max;
    function mulDivDown(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 z) {
        assembly {
            // Equivalent to require(denominator != 0 && (y == 0 || x <= type(uint256).max / y))
            if iszero(mul(denominator, iszero(mul(y, gt(x, div(MAX_UINT256, y)))))) {
                revert(0, 0)
            }
            z := div(mul(x, y), denominator)
        }
    }
}`;
check("COF 60-7 Equivalent to require (R-COF-2) -> 0", coc(COF_EQUIV).length === 0,
  "dapat " + coc(COF_EQUIV).length);
// 60-8. Kontrol negatif: require yang benar-benar dikomentari TETAP -> 1.
const COF_REAL = wrap38(`    function validateBorrow(address user, uint256 amount) external {
        // require(balances[user] >= amount, "insufficient");
        uint256 b = balances[user];
        b;
    }`);
check("COF 60-8 require dikomentari TETAP -> 1", coc(COF_REAL).length === 1,
  "dapat " + coc(COF_REAL).length);
// 60-9. R-COF-2 case-insensitive: EQUIVALENT TO -> 0.
const COF_EQUIV_UPPER = `pragma solidity ^0.8.20;
contract MathLib2 {
    function divDown(uint256 x, uint256 d) internal pure returns (uint256 z) {
        assembly {
            // EQUIVALENT TO require(d != 0)
            if iszero(d) { revert(0, 0) }
            z := div(x, d)
        }
    }
}`;
check("COF 60-9 EQUIVALENT TO kapital -> 0", coc(COF_EQUIV_UPPER).length === 0,
  "dapat " + coc(COF_EQUIV_UPPER).length);
// 60-10. Batas didokumentasikan: "Same as require" BELUM dikecualikan -> 1.
const COF_SAMEAS = `pragma solidity ^0.8.20;
contract MathLib3 {
    function divDown(uint256 x, uint256 d) internal pure returns (uint256 z) {
        assembly {
            // Same as require(d != 0)
            if iszero(d) { revert(0, 0) }
            z := div(x, d)
        }
    }
}`;
check("COF 60-10 Same as require TETAP -> 1", coc(COF_SAMEAS).length === 1,
  "dapat " + coc(COF_SAMEAS).length);

// --- Seksi 61. Kalibrasi R20.3: F8 swap-output D20 (sesi #46,
// 21 Nov 2026 — kasus nyata FA-002 Hyperbridge
// UniV3UniswapV2Wrapper.swapExactTokensForETH: amountOut hasil decode
// swap atas deposit caller, ter-flag Medium, gugur wasit sesi #26).
// Aturan: nilai = output swap HANYA bila fungsi menarik dana dari
// msg.sender (transferFrom/safeTransferFrom) atau memakai msg.value,
// DAN nilai ditugaskan dari panggilan swap (c1) atau dari abi.decode
// atas hasil multicall yang memuat panggilan swap (c2).
const R203_P1 = `pragma solidity ^0.8.17;
contract UniV3UniswapV2Wrapper {
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory) {
        address weth = _params.WETH;
        if (path[1] != weth) revert InvalidWethAddress();
        address token = path[0];
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).forceApprove(_params.swapRouter, amountIn);
        IV3SwapRouter.ExactInputSingleParams memory params = IV3SwapRouter.ExactInputSingleParams({tokenIn: token, tokenOut: weth, fee: _params.maxFee, recipient: address(this), amountIn: amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0});
        bytes memory swapCall = abi.encodeWithSelector(IV3SwapRouter.exactInputSingle.selector, params);
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory results = IMulticallExtended(_params.swapRouter).multicall(deadline, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        IWETH(weth).withdraw(amountOut);
        (bool sent,) = to.call{value: amountOut}("");
        if (!sent) revert RefundFailed();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
        return amounts;
    }
}`;
check("D20 61-1 UniV3 swapExactTokensForETH verbatim -> 0 (R20.3 c2)",
  d20Count(R203_P1, "UniV3UniswapV2Wrapper.sol") === 0,
  "dapat " + d20Count(R203_P1, "UniV3UniswapV2Wrapper.sol"));
const R203_P2 = `pragma solidity ^0.8.20;
contract DirectSwap {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external returns (uint256) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = ISwapRouter(router).exactInputSingle(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
        return amountOut;
    }
}`;
check("D20 61-2 exactInputSingle return langsung -> 0 (R20.3 c1)",
  d20Count(R203_P2, "DirectSwap.sol") === 0,
  "dapat " + d20Count(R203_P2, "DirectSwap.sol"));
const R203_P3 = `pragma solidity ^0.8.20;
contract SwapTransfer {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = router.swap(tokenIn, amountIn);
        payable(to).transfer(amountOut);
    }
}`;
check("D20 61-3 swap-output via .transfer -> 0 (R20.3 c1)",
  d20Count(R203_P3, "SwapTransfer.sol") === 0,
  "dapat " + d20Count(R203_P3, "SwapTransfer.sol"));
const R203_N1 = `pragma solidity ^0.8.20;
contract ParamAmt {
    function payout(address to, uint256 amountOut) external {
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 61-4 amountOut param tanpa swap TETAP -> 1",
  d20Count(R203_N1, "ParamAmt.sol") === 1,
  "dapat " + d20Count(R203_N1, "ParamAmt.sol"));
const R203_N2 = `pragma solidity ^0.8.20;
contract DecodeNoSwap {
    function payout(address to) external {
        bytes[] memory results = oracle.multicall(data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 61-5 decode multicall tanpa swap TETAP -> 1",
  d20Count(R203_N2, "DecodeNoSwap.sol") === 1,
  "dapat " + d20Count(R203_N2, "DecodeNoSwap.sol"));
const R203_N3 = `pragma solidity ^0.8.20;
contract SwapNoPull {
    function payout(address to) external {
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, params);
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory results = IMulticallExtended(router).multicall(deadline, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 61-6 swap decode TANPA pull dari sender TETAP -> 1",
  d20Count(R203_N3, "SwapNoPull.sol") === 1,
  "dapat " + d20Count(R203_N3, "SwapNoPull.sol"));
const R203_N4 = `pragma solidity ^0.8.20;
contract QuoteOnly {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = IQuoter(router).getAmountsOut(amountIn, tokenIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 61-7 getAmountsOut (quote, bukan swap) TETAP -> 1",
  d20Count(R203_N4, "QuoteOnly.sol") === 1,
  "dapat " + d20Count(R203_N4, "QuoteOnly.sol"));
const R203_N5 = `pragma solidity ^0.8.20;
contract Drain {
    function drain(address to, uint256 amt) public {
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 61-8 drain kontrol TETAP -> 1",
  d20Count(R203_N5, "Drain.sol") === 1,
  "dapat " + d20Count(R203_N5, "Drain.sol"));
// 61-9. DIPERBAIKI R20.3a (F7): penugasan via indeks (amounts[1]) kini
// dikenali sebagai swap-output — basis amounts diuji seperti identifier.
const R203_N6 = `pragma solidity ^0.8.20;
contract IdxAssign {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256[] memory amounts = ISwapRouter(router).swapExactTokensForETH(amountIn, tokenIn);
        (bool ok,) = payable(to).call{value: amounts[1]}("");
        require(ok);
    }
}`;
check("D20 61-9 amounts[1] indeks swap-output -> 0 (R20.3a F7)",
  d20Count(R203_N6, "IdxAssign.sol") === 0,
  "dapat " + d20Count(R203_N6, "IdxAssign.sol"));

// --- Seksi 62. Kalibrasi R20.3a atas review Kiro Opus 5.5 (sesi #46,
// 21 Nov 2026 — sesi f443d373, vonis NEEDS WORK, 20 kasus harness).
// Disposisi wasit (tiap klaim diverifikasi probe ke kode ASLI):
// F1 DITOLAK sbg artefak transport — decRe file asli escape-nya benar
// (byte mentah: semua run backslash panjang 2); P1 lolos lokal via c2.
// F2/F3/F4/F5/F6 TERBUKTI dan diperbaiki di bawah; F7 (amounts[i])
// diperbaiki (lihat 61-9). Detail:
// docs/kiro-crew-review-2026-11-21-r20-3.md.
const R203A_A1 = `pragma solidity ^0.8.20;
contract A1 {
    uint256 constant FEE = 0.01 ether;
    function payout(address tokenIn, uint256 amountIn, address to) external payable {
        require(msg.value == FEE, "fee");
        uint256 amountOut = ISwapRouter(router).exactInputSingle(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-1 A1 fee-msg.value + swap saldo kontrak (F2) -> 1",
  d20Count(R203A_A1, "A1.sol") === 1, "dapat " + d20Count(R203A_A1, "A1.sol"));
const R203A_A2 = `pragma solidity ^0.8.20;
contract A2 {
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = quoter.quoteExactInputSingle(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-2 A2 quoteExactInputSingle (F3) -> 1",
  d20Count(R203A_A2, "A2.sol") === 1, "dapat " + d20Count(R203A_A2, "A2.sol"));
const R203A_A3 = `pragma solidity ^0.8.20;
contract A3 {
    function payout(address token, uint256 amountIn, address to) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes[] memory results = IOracle(oracle).multicall(data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-3 A3 oracle multicall + pull tanpa swap -> 1",
  d20Count(R203A_A3, "A3.sol") === 1, "dapat " + d20Count(R203A_A3, "A3.sol"));
const R203A_A6 = `pragma solidity ^0.8.20;
contract A6 {
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = ISwapRouter(router).exactInputSingle(tokenIn, amountIn);
        amountOut = address(this).balance;
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-4 A6 amountOut ditimpa balance (F4) -> 1",
  d20Count(R203A_A6, "A6.sol") === 1, "dapat " + d20Count(R203A_A6, "A6.sol"));
const R203A_A8 = `pragma solidity ^0.8.20;
contract A8 {
    function payout(address token, uint256 amountIn, address to) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, params);
        bytes[] memory results = IOracle(oracle).multicall(data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-5 A8 oracle multicall + selector tak terpakai (F5) -> 1",
  d20Count(R203A_A8, "A8.sol") === 1, "dapat " + d20Count(R203A_A8, "A8.sol"));
const R203A_A9 = `pragma solidity ^0.8.20;
contract A9 {
    function payout(address token, uint256 amountIn, address to) external {
        IERC20(token).transferFrom(msg.sender, treasury, 1);
        uint256 amountOut = ISwapRouter(router).exactInputSingle(token, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-6 A9 pull 1 wei ke treasury (F2) -> 1",
  d20Count(R203A_A9, "A9.sol") === 1, "dapat " + d20Count(R203A_A9, "A9.sol"));
const R203A_A10 = `pragma solidity ^0.8.20;
contract A10 {
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        cache.amountOut = ISwapRouter(router).swap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-7 A10 cache.amountOut member (F4) -> 1",
  d20Count(R203A_A10, "A10.sol") === 1, "dapat " + d20Count(R203A_A10, "A10.sol"));
const R203A_A11 = `pragma solidity ^0.8.20;
contract A11 {
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = viewer.previewSwap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 62-8 A11 previewSwap view (F3) -> 1",
  d20Count(R203A_A11, "A11.sol") === 1, "dapat " + d20Count(R203A_A11, "A11.sol"));
const R203A_A12 = `pragma solidity ^0.8.17;
contract A12 {
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory) {
        address weth = _params.WETH;
        address token = path[0];
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(IV3SwapRouter.exactInputSingle.selector, params);
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory ww = IMulticallExtended(_params.swapRouter).multicall(deadline, data);
        uint256 amountOut = abi.decode(ww[0], (uint256));
        IWETH(weth).withdraw(amountOut);
        (bool sent,) = to.call{value: amountOut}("");
        if (!sent) revert RefundFailed();
        return amounts;
    }
}`;
check("D20 62-9 A12 P1 dgn results diganti nama -> 0",
  d20Count(R203A_A12, "A12.sol") === 0, "dapat " + d20Count(R203A_A12, "A12.sol"));
const R203A_F6 = `pragma solidity ^0.8.20;
contract F6 {
    function payout(address to, uint256 amt) external {
        IERC20(junk).transferFrom(msg.sender, address(this), amt);
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok);
    }
}`;
check("D20 62-10 F6 pull junk ERC20 lalu kirim ETH -> 1",
  d20Count(R203A_F6, "F6.sol") === 1, "dapat " + d20Count(R203A_F6, "F6.sol"));
const R203A_F6C = `pragma solidity ^0.8.20;
contract F6C {
    function swapExactTokensForETH(uint256 amountIn, uint256, address[] calldata, address to, uint256) external returns (uint256[] memory) {
        IERC20(WETH()).safeTransferFrom(msg.sender, address(this), amountIn);
        IWETH(WETH()).withdraw(amountIn);
        (bool sent,) = to.call{value: amountIn}("");
        if (!sent) revert WithdrawFailed();
        uint256[] memory out = new uint256[](1);
        out[0] = amountIn;
        return out;
    }
}`;
check("D20 62-11 F6-kontrol pull WETH + withdraw -> 0",
  d20Count(R203A_F6C, "F6C.sol") === 0, "dapat " + d20Count(R203A_F6C, "F6C.sol"));

// --- Seksi 63. Kalibrasi R20.3b atas residual R20.3a (sesi #47,
// 21 Nov 2026 — wasit lokal, TANPA pass Kiro: sesi BB pagi sedang
// memakai Kiro Web untuk pass ronde 2 Resupply; probe wasit
// /tmp/probe-d20-r203b.js 6/6 pasca-perbaikan, 4/6 gagal pra-perbaikan).
// (i) F7 residual: penugasan output swap via tuple-destructure
// `(a,b) = swap(...)` kini dikenali c1; (ii) F5 residual: penanda swap
// c2 kini TERIKAT ke argumen data multicall (literal / pengisian
// data[i]/push / RHS var yang diisikan, satu hop) — penanda di var tak
// terpakai + data quote tidak lagi men-suppress.
const R203B_T1 = `pragma solidity ^0.8.20;
contract T1 {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut;
        uint256 amountInUsed;
        (amountOut, amountInUsed) = ISwapRouter(router).swapExactTokensForETH(amountIn, tokenIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 63-1 tuple (a,b)=swap -> 0 (R20.3b F7)",
  d20Count(R203B_T1, "T1.sol") === 0, "dapat " + d20Count(R203B_T1, "T1.sol"));
const R203B_T2 = `pragma solidity ^0.8.20;
contract T2 {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (uint256 amountOut, uint256 amountInUsed) = ISwapRouter(router).exactInputSingle(tokenIn, amountIn);
        payable(to).transfer(amountOut);
    }
}`;
check("D20 63-2 tuple (uint a, uint b)=swap -> 0 (R20.3b F7)",
  d20Count(R203B_T2, "T2.sol") === 0, "dapat " + d20Count(R203B_T2, "T2.sol"));
const R203B_T3 = `pragma solidity ^0.8.20;
contract T3 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (uint256 amountOut, uint256 reserve) = IPool(router).getReserves(tokenIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 63-3 tuple dari getReserves TETAP -> 1 (R20.3b F7 kontrol)",
  d20Count(R203B_T3, "T3.sol") === 1, "dapat " + d20Count(R203B_T3, "T3.sol"));
const R203B_T4 = `pragma solidity ^0.8.20;
contract T4 {
    address public router;
    function swapOut(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (, uint256 amountOut) = ISwapRouter(router).swap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 63-4 tuple (,b)=swap -> 0 (R20.3b F7)",
  d20Count(R203B_T4, "T4.sol") === 0, "dapat " + d20Count(R203B_T4, "T4.sol"));
const R203B_C1 = `pragma solidity ^0.8.20;
contract C1 {
    function payout(address token, uint256 amountIn, address to) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, params);
        bytes memory quoteCall = abi.encodeWithSelector(IQuoter.quoteExactInputSingle.selector, params);
        bytes[] memory data = new bytes[](1);
        data[0] = quoteCall;
        bytes[] memory results = IMulticallExtended(router).multicall(deadline, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 63-5 multicall data quote + swapCall tak terpakai -> 1 (R20.3b F5)",
  d20Count(R203B_C1, "C1.sol") === 1, "dapat " + d20Count(R203B_C1, "C1.sol"));
const R203B_C2 = `pragma solidity ^0.8.20;
contract C2 {
    function payout(address token, uint256 amountIn, address to) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, params);
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory results = IMulticallExtended(router).multicall(deadline, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 63-6 multicall data=swapCall terpakai TETAP -> 0 (R20.3b F5 kontrol)",
  d20Count(R203B_C2, "C2.sol") === 0, "dapat " + d20Count(R203B_C2, "C2.sol"));

// --- Seksi 64. Kalibrasi R20.3c atas review Kiro R20.3b (sesi #48,
// 21 Nov 2026 — pass Kiro crew Opus 5.5 sesi 74ec0a1c, verdict NEEDS
// WORK 20/22 + 11 temuan; disposisi wasit via /tmp/probe-d20-r203c.js:
// TERBUKTI + diperbaiki: F1 (push), F3 (definisi pertama), F8
// (swapFee), F11 (cap tuple), T5 (nested), F2b (encodeCall, temuan
// wasit). DITOLAK sbg artefak/invalid: F2 (semua fill dicek), F4
// (backtracking tuple), F5 (cut berakhir di kirim), F6 (bukan bug),
// F10 (snippet invalid). DITUNDA: F7 (fallback, batas terdokumentasi),
// F9 (scope, butuh analisis scope).
const R203C_F1 = `pragma solidity ^0.8.20;
contract F1 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, tokenIn);
        bytes[] memory data = new bytes[](1);
        data.push(swapCall);
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-1 push(swapCall) -> 0 (R20.3c F1)",
  d20Count(R203C_F1, "F1.sol") === 0, "dapat " + d20Count(R203C_F1, "F1.sol"));
const R203C_F1B = `pragma solidity ^0.8.20;
contract F1b {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes[] memory data = new bytes[](1);
        data.push(abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, tokenIn));
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-2 push literal swap -> 0 (R20.3c F1 kontrol)",
  d20Count(R203C_F1B, "F1b.sol") === 0, "dapat " + d20Count(R203C_F1B, "F1b.sol"));
const R203C_F3 = `pragma solidity ^0.8.20;
contract F3 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.quoteExactInputSingle.selector, tokenIn);
        swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, tokenIn);
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-3 reassign quote->swap -> 0 (R20.3c F3)",
  d20Count(R203C_F3, "F3.sol") === 0, "dapat " + d20Count(R203C_F3, "F3.sol"));
const R203C_F2B = `pragma solidity ^0.8.20;
contract F2b {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeCall(ISwapRouter.exactInputSingle, (tokenIn, amountIn));
        bytes[] memory data = new bytes[](1);
        data[0] = swapCall;
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-4 encodeCall swapCall -> 0 (R20.3c F2b wasit)",
  d20Count(R203C_F2B, "F2b.sol") === 0, "dapat " + d20Count(R203C_F2B, "F2b.sol"));
const R203C_F8A = `pragma solidity ^0.8.20;
contract F8a {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = ISwapRouter(router).swapFee(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-5 c1 swapFee -> 1 (R20.3c F8)",
  d20Count(R203C_F8A, "F8a.sol") === 1, "dapat " + d20Count(R203C_F8A, "F8a.sol"));
const R203C_F8B = `pragma solidity ^0.8.20;
contract F8b {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encodeWithSelector(ISwapRouter.swapFee.selector, tokenIn);
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-6 c2 swapFee.selector -> 1 (R20.3c F8)",
  d20Count(R203C_F8B, "F8b.sol") === 1, "dapat " + d20Count(R203C_F8B, "F8b.sol"));
const R203C_F8C = `pragma solidity ^0.8.20;
contract F8c {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = ISwapRouter(router).swapTokensForExactTokens(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-7 swapTokensForExactTokens TETAP -> 0 (R20.3c F8 kontrol)",
  d20Count(R203C_F8C, "F8c.sol") === 0, "dapat " + d20Count(R203C_F8C, "F8c.sol"));
const R203C_F8D = `pragma solidity ^0.8.20;
contract F8d {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = IPool(router).swap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-8 bare swap TETAP -> 0 (R20.3c F8 kontrol)",
  d20Count(R203C_F8D, "F8d.sol") === 0, "dapat " + d20Count(R203C_F8D, "F8d.sol"));
const R203C_F11 = `pragma solidity ^0.8.20;
contract F11 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (uint256 amountOutWithAVeryLongNameForTestingPurposesOnly, uint256 amountInUsedWithAVeryLongNameForTestingPurposes, uint256 feeAmountWithAVeryLongNameForTestingPurposesOnly, uint256 extraValueWithAVeryLongNameForTestingPurposes) = ISwapRouter(router).swap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOutWithAVeryLongNameForTestingPurposesOnly}("");
        require(ok);
    }
}`;
check("D20 64-9 tuple panjang 226 karakter -> 0 (R20.3c F11)",
  d20Count(R203C_F11, "F11.sol") === 0, "dapat " + d20Count(R203C_F11, "F11.sol"));
const R203C_T5 = `pragma solidity ^0.8.20;
contract T5 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (uint256 x, (uint256 y, uint256 amountOut)) = ISwapRouter(router).swap(tokenIn, amountIn);
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-10 nested tuple -> 0 (R20.3c T5)",
  d20Count(R203C_T5, "T5.sol") === 0, "dapat " + d20Count(R203C_T5, "T5.sol"));
const R203C_F2 = `pragma solidity ^0.8.20;
contract F2 {
    address public router;
    function payout(address tokenIn, uint256 amountIn, address to) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory swapCall = abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector, tokenIn);
        bytes memory quoteCall = abi.encodeWithSelector(ISwapRouter.quoteExactInputSingle.selector, tokenIn);
        bytes[] memory data = new bytes[](2);
        data[0] = swapCall;
        data[1] = quoteCall;
        bytes[] memory results = IMulticallExtended(router).multicall(block.timestamp, data);
        uint256 amountOut = abi.decode(results[0], (uint256));
        (bool ok,) = payable(to).call{value: amountOut}("");
        require(ok);
    }
}`;
check("D20 64-11 dua fill swap+quote -> 0 (R20.3c F2 DITOLAK: semua fill dicek)",
  d20Count(R203C_F2, "F2.sol") === 0, "dapat " + d20Count(R203C_F2, "F2.sol"));

// --- Seksi 65. Kalibrasi R-COF-3: padanan hidup `if + revert
// CustomError` menekan commented-out-check (sesi #50, 21 Nov 2026 —
// triase FA-001 EFP: require dikomentari EFPListRecords baris 190 punya
// padanan hidup if+revert baris 191-196 di fungsi yang sama).
// Probe wasit: /tmp/probe-cof3.js 7/7 (file EFP asli -> 0).
const RCOF3_EFP = `pragma solidity ^0.8.20;
contract RCOF3EFP {
    mapping(uint256 => mapping(bytes32 => bytes)) public values;
    function _claimListManager(uint256 slot, address manager) internal {
        bytes memory existing = values[slot]['manager'];
        // require(existing.length != 20 || bytesToAddress(existing) == manager, "slot already claimed");
        if (existing.length == 20) {
            address existingManager = bytesToAddress(existing);
            if (existingManager != manager) {
                revert SlotAlreadyClaimed(slot, existingManager);
            }
        }
        _setMetadataValue(slot, 'manager', abi.encodePacked(manager));
    }
    function _setMetadataValue(uint256 slot, bytes32 key, bytes memory v) internal {}
    function bytesToAddress(bytes memory b) internal pure returns (address a) { assembly { a := mload(add(b, 20)) } }
}`;
check("COF 65-1 EFP verbatim _claimListManager -> 0 (R-COF-3)",
  coc(RCOF3_EFP).length === 0, "dapat " + coc(RCOF3_EFP).length);
const RCOF3_NOEQUIV = `pragma solidity ^0.8.20;
contract RCOF3NoEquiv {
    mapping(uint256 => bytes) public values;
    function _claimListManager(uint256 slot, address manager) internal {
        bytes memory existing = values[slot];
        // require(existing.length != 20 || bytesToAddress(existing) == manager, "slot already claimed");
        _setValue(slot, manager);
    }
    function _setValue(uint256 slot, address manager) internal {}
    function bytesToAddress(bytes memory b) internal pure returns (address a) { assembly { a := mload(add(b, 20)) } }
}`;
check("COF 65-2 tanpa padanan hidup -> 1",
  coc(RCOF3_NOEQUIV).length === 1, "dapat " + coc(RCOF3_NOEQUIV).length);
const RCOF3_UNRELATED = `pragma solidity ^0.8.20;
contract RCOF3Unrelated {
    mapping(uint256 => bytes) public values;
    address public admin;
    function _claimListManager(uint256 slot, address manager) internal {
        bytes memory existing = values[slot];
        // require(existing.length != 20 || bytesToAddress(existing) == manager, "slot already claimed");
        if (admin == address(0)) { revert NoAdmin(); }
        _setValue(slot, manager);
    }
    function _setValue(uint256 slot, address manager) internal {}
    function bytesToAddress(bytes memory b) internal pure returns (address a) { assembly { a := mload(add(b, 20)) } }
}`;
check("COF 65-3 guard hidup tak terkait -> 1",
  coc(RCOF3_UNRELATED).length === 1, "dapat " + coc(RCOF3_UNRELATED).length);
const RCOF3_ONEIDENT = `pragma solidity ^0.8.20;
contract RCOF3OneIdent {
    mapping(uint256 => bytes) public values;
    function _claimListManager(uint256 slot, address manager) internal {
        bytes memory existing = values[slot];
        // require(existing.length != 20 || bytesToAddress(existing) == manager, "slot already claimed");
        if (manager == address(0)) { revert ZeroManager(); }
        _setValue(slot, manager);
    }
    function _setValue(uint256 slot, address manager) internal {}
    function bytesToAddress(bytes memory b) internal pure returns (address a) { assembly { a := mload(add(b, 20)) } }
}`;
check("COF 65-4 berbagi 1 identifier saja -> 1",
  coc(RCOF3_ONEIDENT).length === 1, "dapat " + coc(RCOF3_ONEIDENT).length);
const RCOF3_SINGLESTMT = `pragma solidity ^0.8.20;
contract RCOF3SingleStmt {
    mapping(address => uint256) public deposits;
    uint256 public minDeposit = 100;
    function deposit(address user, uint256 amount) external {
        // require(deposits[user] >= minDeposit, "below minimum");
        if (deposits[user] < minDeposit) revert BelowMinimum(user, deposits[user]);
        _credit(user, amount);
    }
    function _credit(address user, uint256 amount) internal {}
}`;
check("COF 65-5 if-revert tanpa kurawal, 3 ident bersama -> 0",
  coc(RCOF3_SINGLESTMT).length === 0, "dapat " + coc(RCOF3_SINGLESTMT).length);
const RCOF3_CONSERV = `pragma solidity ^0.8.20;
contract RCOF3Conserv {
    function withdraw(uint256 amount, uint256 minAmount) external {
        // require(amount > minAmount, "too small");
        if (amount == minAmount) revert EqualAmount();
        _send(amount);
    }
    function _send(uint256 amount) internal {}
}`;
check("COF 65-6 2 ident tanpa literal/panggilan bersama -> 1 (konservatif)",
  coc(RCOF3_CONSERV).length === 1, "dapat " + coc(RCOF3_CONSERV).length);
const RCOF3_SECOND = `pragma solidity ^0.8.20;
contract RCOF3Second {
    mapping(uint256 => bytes) public values;
    uint256 public cap = 50;
    function _claimListManager(uint256 slot, address manager) internal {
        bytes memory existing = values[slot];
        // require(existing.length != 20 || bytesToAddress(existing) == manager, "slot already claimed");
        if (existing.length == 20) {
            address existingManager = bytesToAddress(existing);
            if (existingManager != manager) { revert SlotAlreadyClaimed(slot, existingManager); }
        }
        // require(cap > 0, "cap zero");
        _setValue(slot, manager);
    }
    function _setValue(uint256 slot, address manager) internal {}
    function bytesToAddress(bytes memory b) internal pure returns (address a) { assembly { a := mload(add(b, 20)) } }
}`;
check("COF 65-7 komentar ke-2 tanpa padanan tetap terdeteksi -> 1",
  coc(RCOF3_SECOND).length === 1, "dapat " + coc(RCOF3_SECOND).length);
const RCOF3_CALL = `pragma solidity ^0.8.20;
contract RCOF3Call {
    function settle(uint256 amount) external {
        // require(checkAmount(amount) > 0, "bad amount");
        if (checkAmount(amount) == 0) revert ZeroAmount();
        _send(amount);
    }
    function checkAmount(uint256 a) internal pure returns (uint256) { return a; }
    function _send(uint256 amount) internal {}
}`;
check("COF 65-8 panggilan bersama (checkAmount) -> 0",
  coc(RCOF3_CALL).length === 0, "dapat " + coc(RCOF3_CALL).length);
const RCOF3_LITERAL = `pragma solidity ^0.8.20;
contract RCOF3Literal {
    mapping(address => uint256) public tokenBalance;
    function withdraw(address user, uint256 amount) external {
        // require(tokenBalance[user] >= 100, "below minimum");
        if (tokenBalance[user] < 100) revert LowBalance();
        _send(user, amount);
    }
    function _send(address user, uint256 amount) internal {}
}`;
check("COF 65-9 literal bersama (100) + 2 ident -> 1 (R-COF-3a: aturan literal DIHAPUS — X8 Kiro membuktikan literal bersama bisa over-suppress)",
  coc(RCOF3_LITERAL).length === 1, "dapat " + coc(RCOF3_LITERAL).length);

// --- Seksi 66. Kalibrasi R-COF-3a atas review Kiro Opus 5.5 (sesi #50,
// 21 Nov 2026 — sesi Kiro d1075178, vonis NEEDS WORK, F1–F12; disposisi
// wasit via /tmp/probe-cof3a.js 8/8: F2/F3/F5/F6/F9/F11 TERBUKTI +
// diperbaiki; F1 ARTEFAK harness (fn.body pipeline sudah comment-stripped);
// F8 sesuai desain konservatif; F4/F10/F12 batas didokumentasikan).
const RCOF3A_F1 = `pragma solidity ^0.8.20;
contract RCOF3aF1 {
    mapping(address => uint256) public balances;
    function drain(uint256 amount) external {
        // if (amount > balances[msg.sender]) revert Insufficient(amount, balances[msg.sender]);
        balances[msg.sender] -= amount;
    }
}`;
check("COF 66-1 F1 artefak: komentar if+revert TIDAK menekan dirinya sendiri -> 1",
  coc(RCOF3A_F1).length === 1, "dapat " + coc(RCOF3A_F1).length);
const RCOF3A_F2 = `pragma solidity ^0.8.20;
contract RCOF3aF2 {
    address public owner;
    address public caller;
    bool public frozen;
    function act() external {
        // require(owner == caller && !frozen, "not allowed");
        emit Debug("if (owner != caller || frozen) { revert }");
        _ok();
    }
    function _ok() internal {}
    event Debug(string s);
}`;
check("COF 66-2 F2 string berisi pola if+revert palsu -> 1",
  coc(RCOF3A_F2).length === 1, "dapat " + coc(RCOF3A_F2).length);
const RCOF3A_F3 = `pragma solidity ^0.8.20;
contract RCOF3aF3 {
    mapping(address => uint256) public withdrawn;
    mapping(address => uint256) public limit;
    address public admin;
    function withdraw(address user, uint256 amount) external {
        // require(withdrawn[user] + amount <= limit[user], "over limit");
        if (msg.sender != admin) revert Unauthorized(user, amount, limit);
        _send(user, amount);
    }
    function _send(address user, uint256 amount) internal {}
}`;
check("COF 66-3 F3 identifier hanya di argumen revert -> 1",
  coc(RCOF3A_F3).length === 1, "dapat " + coc(RCOF3A_F3).length);
const RCOF3A_F5 = `pragma solidity ^0.8.20;
contract RCOF3aF5 {
    mapping(address => uint256) public balanceOf;
    function withdraw(address user, uint256 amount) external {
        // require(balanceOf[user] >= amount && amount > 0, "bad");
        if (amount == 0 || user == address(0)) revert ZeroInput();
        _send(user, amount);
    }
    function _send(address user, uint256 amount) internal {}
}`;
check("COF 66-4 F5 literal 0 bukan bukti (aturan literal dihapus) -> 1",
  coc(RCOF3A_F5).length === 1, "dapat " + coc(RCOF3A_F5).length);
const RCOF3A_F6 = `pragma solidity ^0.8.20;
contract RCOF3aF6 {
    function quote(uint256 price, uint256 fee, uint256 slippage, uint256 maxSlip) external {
        // require(price >= 1e18 && slippage <= maxSlip, "bad price");
        if (price == 0 || fee > 1e18 || slippage == 0) revert Bad();
        _go();
    }
    function _go() internal {}
}`;
check("COF 66-5 F6 X8: 1e18 + ident palsu e18 -> 1",
  coc(RCOF3A_F6).length === 1, "dapat " + coc(RCOF3A_F6).length);
const RCOF3A_F6B = `pragma solidity ^0.8.20;
contract RCOF3aF6b {
    function quote(uint256 price, uint256 fee) external {
        // require(price >= 1e18 && fee >= 1e18, "bad price");
        if (price == 0 || fee == 0) revert Bad();
        _go();
    }
    function _go() internal {}
}`;
check("COF 66-6 F6b: e18 palsu sempat jadi identifier ke-3 -> 1",
  coc(RCOF3A_F6B).length === 1, "dapat " + coc(RCOF3A_F6B).length);
const RCOF3A_F9 = `pragma solidity ^0.8.20;
contract RCOF3aF9 {
    mapping(address => uint256) public balances;
    uint256 public minBalance = 100;
    function withdraw(address user, uint256 amount) external {
        // require(balances[user] >= amount && amount >= minBalance, "bad");
        if (amount <= balances[user] && balances[user] > 0) { balances[user] -= amount; } else { revert Insufficient(); }
        _send(user, amount);
    }
    function _send(address user, uint256 amount) internal {}
}`;
check("COF 66-7 F9 revert di else-branch, 3 ident bersama -> 0",
  coc(RCOF3A_F9).length === 0, "dapat " + coc(RCOF3A_F9).length);
const RCOF3A_F11 = `pragma solidity ^0.8.20;
contract RCOF3aF11 {
    mapping(address => uint256) public tokenBalance;
    uint256 public minBalance = 100;
    function withdraw(address user, uint256 amount) external {
        // require(tokenBalance[user] >= minBalance, "below minimum");
        require(tokenBalance[user] >= minBalance, "below minimum");
        _send(user, amount);
    }
    function _send(address user, uint256 amount) internal {}
}`;
check("COF 66-8 F11 require hidup duplikat -> 0",
  coc(RCOF3A_F11).length === 0, "dapat " + coc(RCOF3A_F11).length);
const RCOF3A_F4 = `pragma solidity ^0.8.20;
contract RCOF3aF4 {
    mapping(address => bool) public isWhitelisted;
    address public treasury;
    function pay(address account) external {
        // require(isWhitelisted(account) && account != treasury, "not allowed");
        if (isWhitelisted(account) && account == treasury) revert TreasuryNotAllowed();
        _go();
    }
    function _go() internal {}
}`;
check("COF 66-9 F4 BATAS: operator terbalik 3 ident MASIH ter-suppress -> 0 (didokumentasikan, bukan diperbaiki)",
  coc(RCOF3A_F4).length === 0, "dapat " + coc(RCOF3A_F4).length);

// --- Seksi 67. Detektor ke-25: guard-asymmetry-nav-readers (H-SOMM-12)
// (backlog detektor sesi BB sore 22 Nov 2026 — Somm Cellar preview*/convert*
// tanpa cek `locked` vs totalAssets/maxWithdraw/maxRedeem yang ber-guard;
// Low/latent, BUKAN kandidat submit).
const d25 = (src, name) => runPipeline(src, name || "d25.sol").candidates
  .filter((c) => c.detector === "guard-asymmetry-nav-readers");
const MINI67 = "pragma solidity ^0.8.20;\ncontract Mini67 {\n"
  + "    bool public locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    function _nav() internal view returns (uint256 a, uint256 s) {\n"
  + "        a = address(this).balance; s = totalSupply;\n"
  + "    }\n"
  + "    function totalAssets() public view returns (uint256 assets) {\n"
  + "        require(!locked, \"REENTRANCY\");\n"
  + "        (assets, ) = _nav();\n"
  + "    }\n"
  + "    function previewRedeem(uint256 shares) public view returns (uint256 assets) {\n"
  + "        (uint256 _a, uint256 _s) = _nav();\n"
  + "        assets = shares * _a / (_s == 0 ? 1 : _s);\n"
  + "    }\n"
  + "    function convertToAssets(uint256 shares) public view returns (uint256 assets) {\n"
  + "        (uint256 _a, uint256 _s) = _nav();\n"
  + "        assets = shares * _a / (_s == 0 ? 1 : _s);\n"
  + "    }\n}";
const c67 = d25(MINI67);
check("D25 67-1 fixture mini -> 2 Low @ previewRedeem + convertToAssets",
  c67.length === 2 && c67.every((c) => c.severityGuess === "Low")
    && c67.map((c) => c.location.function).sort().join(",") === "convertToAssets,previewRedeem"
    && c67.every((c) => c.evidence.indexOf("_nav") !== -1
      && c67[0].evidence.indexOf("totalAssets") !== -1),
  "dapat " + JSON.stringify(c67.map((c) => c.location.function + ":" + c.severityGuess)));
// 67-2. Cellar.sol verbatim (repo Somm @ 07efdfa9) -> 7 Low: 6 preview/convert
// + maxDeposit (juga memanggil _getTotalAssetsAndTotalSupply tanpa guard —
// temuan detektor ini di luar daftar backlog); totalAssets/maxWithdraw/
// maxRedeem/maxMint TIDAK di-flag.
const cellar67 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "somm", "cellar-contracts", "src", "base", "Cellar.sol"), "utf8");
const c672 = d25(cellar67, "Cellar.sol");
check("D25 67-2 Cellar verbatim -> 7 Low (6 preview/convert + maxDeposit)",
  c672.length === 7 && c672.every((c) => c.severityGuess === "Low")
    && c672.map((c) => c.location.function).sort().join(",")
      === "convertToAssets,convertToShares,maxDeposit,previewDeposit,previewMint,previewRedeem,previewWithdraw",
  "dapat " + JSON.stringify(c672.map((c) => c.location.function)));
// 67-3. Semua saudara ber-guard -> 0.
check("D25 67-3 semua ber-guard -> 0",
  d25(MINI67.replace("    function previewRedeem(uint256 shares) public view returns (uint256 assets) {\n",
    "    function previewRedeem(uint256 shares) public view returns (uint256 assets) {\n        require(!locked, \"REENTRANCY\");\n")
    .replace("    function convertToAssets(uint256 shares) public view returns (uint256 assets) {\n",
      "    function convertToAssets(uint256 shares) public view returns (uint256 assets) {\n        require(!locked, \"REENTRANCY\");\n")).length === 0);
// 67-4. Semua saudara TANPA guard -> 0 (tanpa asimetri, tanpa flag).
check("D25 67-4 semua tanpa guard -> 0",
  d25(MINI67.replace("        require(!locked, \"REENTRANCY\");\n", "")).length === 0);
// 67-5. Saudara tanpa guard memanggil helper LAIN -> 0.
check("D25 67-5 helper berbeda -> 0",
  d25(MINI67.replace("        (uint256 _a, uint256 _s) = _nav();\n        assets = shares * _a / (_s == 0 ? 1 : _s);\n    }\n    function convertToAssets",
    "        (uint256 _a, uint256 _s) = _otherNav();\n        assets = shares * _a / (_s == 0 ? 1 : _s);\n    }\n    function _otherNav() internal view returns (uint256 a, uint256 s) { a = 1; s = totalSupply; }\n    function convertToAssets")
    .replace("    function convertToAssets(uint256 shares) public view returns (uint256 assets) {\n        (uint256 _a, uint256 _s) = _nav();",
      "    function convertToAssets(uint256 shares) public view returns (uint256 assets) {\n        (uint256 _a, uint256 _s) = _otherNav();")).length === 0);
// 67-6. Helper bersama PURE saja (bukan pembaca NAV) -> 0.
const PURE67 = "pragma solidity ^0.8.20;\ncontract Pure67 {\n"
  + "    bool public locked;\n"
  + "    function _mul(uint256 a, uint256 b) internal pure returns (uint256) { return a * b; }\n"
  + "    function totalAssets() public view returns (uint256) {\n"
  + "        require(!locked, \"REENTRANCY\");\n"
  + "        return _mul(1, 2);\n"
  + "    }\n"
  + "    function previewRedeem(uint256 s) public view returns (uint256) {\n"
  + "        return _mul(s, 2);\n"
  + "    }\n}";
check("D25 67-6 helper bersama pure saja -> 0", d25(PURE67).length === 0);
// 67-7. Guard via modifier nonReentrant dihitung ber-guard.
const MOD67 = MINI67.replace("        require(!locked, \"REENTRANCY\");\n",
  "").replace("function totalAssets() public view returns",
  "function totalAssets() public view nonReentrant returns");
check("D25 67-7 modifier nonReentrant = ber-guard -> tetap 2",
  d25(MOD67).length === 2
    && d25(MOD67).every((c) => c.location.function !== "totalAssets"),
  "dapat " + JSON.stringify(d25(MOD67).map((c) => c.location.function)));
// 67-8. Helper internal tanpa guard (_findMax) bukan entry point -> tidak
// di-flag; hanya previewRedeem yang di-flag.
const FIND67 = "pragma solidity ^0.8.20;\ncontract Find67 {\n"
  + "    bool public locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    mapping(address => uint256) public balanceOf;\n"
  + "    function _nav() internal view returns (uint256 a, uint256 s) { a = address(this).balance; s = totalSupply; }\n"
  + "    function _findMax(address o) internal view returns (uint256) {\n"
  + "        (uint256 _a, uint256 _s) = _nav(); return balanceOf[o] * _a / (_s == 0 ? 1 : _s);\n"
  + "    }\n"
  + "    function totalAssets() public view returns (uint256 assets) {\n"
  + "        require(!locked, \"REENTRANCY\");\n"
  + "        (assets, ) = _nav();\n"
  + "    }\n"
  + "    function maxWithdraw(address o) public view returns (uint256) {\n"
  + "        require(!locked, \"REENTRANCY\");\n"
  + "        return _findMax(o);\n"
  + "    }\n"
  + "    function previewRedeem(uint256 shares) public view returns (uint256 assets) {\n"
  + "        (uint256 _a, uint256 _s) = _nav();\n"
  + "        assets = shares * _a / (_s == 0 ? 1 : _s);\n"
  + "    }\n}";
check("D25 67-8 helper internal bukan entry point -> tepat 1 @ previewRedeem",
  d25(FIND67).length === 1 && d25(FIND67)[0].location.function === "previewRedeem",
  "dapat " + JSON.stringify(d25(FIND67).map((c) => c.location.function)));
// 67-9. File test/mock dilewati -> 0.
check("D25 67-9 file test dilewati -> 0",
  d25(MINI67, "test/d25.sol").length === 0
    && d25(MINI67, "Cellar.t.sol").length === 0);
// 67-10. trap-vault: D25 tepat 1 @ previewRedeem (BUG 26); total ground
// truth kini 29 (dicek seksi 1).
const trapD25 = runPipeline(sol, "trap-vault.sol").candidates
  .filter((c) => c.detector === "guard-asymmetry-nav-readers");
check("D25 67-10 trap-vault -> tepat 1 @ previewRedeem (BUG 26)",
  trapD25.length === 1 && trapD25[0].location.function === "previewRedeem"
    && trapD25[0].severityGuess === "Low",
  "dapat " + JSON.stringify(trapD25.map((c) => c.location.function)));
// 67-11. Dua kontrak satu file, helper bernama sama: hanya kontrak yang
// punya pasangan ber-guard + tanpa-guard yang memicu (tanpa campur).
const TWO67 = "pragma solidity ^0.8.20;\ncontract A67 {\n"
  + "    bool public locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    function _nav() internal view returns (uint256 a, uint256 s) { a = address(this).balance; s = totalSupply; }\n"
  + "    function totalAssets() public view returns (uint256 assets) { require(!locked, \"REENTRANCY\"); (assets, ) = _nav(); }\n"
  + "    function previewRedeem(uint256 shares) public view returns (uint256 assets) { (uint256 _a, uint256 _s) = _nav(); assets = shares * _a / (_s == 0 ? 1 : _s); }\n"
  + "}\ncontract B67 {\n"
  + "    uint256 public totalSupply;\n"
  + "    function _nav() internal view returns (uint256 a, uint256 s) { a = address(this).balance; s = totalSupply; }\n"
  + "    function previewRedeem(uint256 shares) public view returns (uint256 assets) { (uint256 _a, uint256 _s) = _nav(); assets = shares * _a / (_s == 0 ? 1 : _s); }\n"
  + "    function convertToAssets(uint256 shares) public view returns (uint256 assets) { (uint256 _a, uint256 _s) = _nav(); assets = shares * _a / (_s == 0 ? 1 : _s); }\n"
  + "}";
check("D25 67-11 dua kontrak, helper sama -> tepat 1 (kontrak A saja)",
  d25(TWO67).length === 1 && d25(TWO67)[0].location.function === "previewRedeem",
  "dapat " + JSON.stringify(d25(TWO67).map((c) => c.location.function)));
// 67-12. toVerify menyebut callback/hook + perbandingan saudara ber-guard.
check("D25 67-12 toVerify menyebut callback + saudara ber-guard",
  c67.length === 2 && c67[0].toVerify.some((t) => t.indexOf("callback") !== -1)
    && c67[0].toVerify.some((t) => t.indexOf("ber-guard") !== -1));

// --- Seksi 67b. Kalibrasi R25 detektor ke-25 (wasit atas review Kiro Opus 5.5
// NEEDS WORK, sesi #56 — 11 temuan F1–F11 SEMUA TERBUKTI; tiap snippet Kiro
// dijadikan probe di sini).
// 67b-1. F1: entry yang memanggil entry ber-guard ikut ber-guard -> 0.
const F1_67B = "pragma solidity ^0.8.20;\ncontract F1b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked); return _nav(); }\n"
  + "    function convertToShares(uint256 a) public view returns (uint256) { return a * totalSupply / totalAssets(); }\n"
  + "}";
check("D25 67b-1 F1 guard diteruskan lewat totalAssets() -> 0",
  d25(F1_67B).length === 0, "dapat " + d25(F1_67B).length);
// 67b-2. F2: guard via helper internal + modifier nonReentrantView -> 0.
const F2_67B = "pragma solidity ^0.8.20;\ncontract F2b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function _checkNotLocked() internal view { require(!locked); }\n"
  + "    modifier nonReentrantView() { require(!locked); _; }\n"
  + "    function totalAssets() public view returns (uint256) { _checkNotLocked(); return _nav(); }\n"
  + "    function maxWithdraw(address o) public view nonReentrantView returns (uint256) { return _nav(); }\n"
  + "    function previewRedeem(uint256 s) public view returns (uint256) { require(!locked); return _nav(); }\n"
  + "}";
check("D25 67b-2 F2 helper + modifier nonReentrantView = ber-guard -> 0",
  d25(F2_67B).length === 0, "dapat " + d25(F2_67B).length);
// 67b-3. F3: require kedua yang membawa guard (exec pertama menangkap
// isShutdown) -> previewDeposit TETAP di-flag (1).
const F3_67B = "pragma solidity ^0.8.20;\ncontract F3b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function totalAssets() public view returns (uint256) { require(!isShutdown, \"SHUT\"); require(!locked, \"REENTRANCY\"); return _nav(); }\n"
  + "    function previewDeposit(uint256 a) public view returns (uint256) { return a * _nav(); }\n"
  + "}";
check("D25 67b-3 F3 require kedua (locked) dikenali -> 1 @ previewDeposit",
  d25(F3_67B).length === 1 && d25(F3_67B)[0].location.function === "previewDeposit",
  "dapat " + JSON.stringify(d25(F3_67B).map((c) => c.location.function)));
// 67b-4. F4: bentuk guard uint/getter/member — masing-masing membuat saudara
// ber-guard sehingga preview ikut di-flag (1 per varian).
const F4BASE_67B = "pragma solidity ^0.8.20;\ncontract F4b {\n"
  + "    uint256 _held;\n"
  + "    uint256 private _status;\n"
  + "    uint256 private constant _ENTERED = 2;\n"
  + "    uint256 private constant _NOT_ENTERED = 1;\n"
  + "    struct Slot0 { bool unlocked; }\n"
  + "    Slot0 slot0;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function _reentrancyGuardEntered() internal view returns (bool) { return _status == _ENTERED; }\n"
  + "    function totalAssets() public view returns (uint256) { GUARD return _nav(); }\n"
  + "    function previewRedeem(uint256 s) public view returns (uint256) { return s * _nav(); }\n"
  + "}";
const F4VARIANTS = [
  ["_status != _ENTERED", 'require(_status != _ENTERED, "R");'],
  ["_status == _NOT_ENTERED", 'require(_status == _NOT_ENTERED, "R");'],
  ["unlocked == 1", 'require(unlocked == 1, "LOCKED");'],
  ["slot0.unlocked polos", 'require(slot0.unlocked, "LOK");'],
  ["getter if-revert", 'if (_reentrancyGuardEntered()) revert R();'],
  ["!locked && x > 0", 'require(!locked && _held > 0);'],
  ["if _status == _ENTERED revert", 'if (_status == _ENTERED) revert R();'],
];
F4VARIANTS.forEach(([label, guard], idx) => {
  const src = F4BASE_67B.replace("GUARD", guard);
  const got = d25(src);
  check("D25 67b-4 F4 guard " + label + " -> 1 @ previewRedeem",
    got.length === 1 && got[0].location.function === "previewRedeem",
    "dapat " + JSON.stringify(got.map((c) => c.location.function)));
});
// 67b-5. F5: depositsLocked BUKAN kunci reentrancy -> 0 (tanpa asimetri).
const F5_67B = "pragma solidity ^0.8.20;\ncontract F5b {\n"
  + "    uint256 _held;\n"
  + "    bool depositsLocked;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function totalAssets() public view returns (uint256) { if (depositsLocked) revert Paused(); return _nav(); }\n"
  + "    function previewMint(uint256 s) public view returns (uint256) { return s * _nav(); }\n"
  + "}";
check("D25 67b-5 F5 depositsLocked bukan guard -> 0",
  d25(F5_67B).length === 0, "dapat " + d25(F5_67B).length);
// 67b-6. F6: NAV dibaca langsung dari state tanpa helper -> 1 @ convertToShares.
const F6_67B = "pragma solidity ^0.8.20;\ncontract F6b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked); return _held; }\n"
  + "    function convertToShares(uint256 a) public view returns (uint256) { return a * totalSupply / _held; }\n"
  + "}";
check("D25 67b-6 F6 baca state langsung -> 1 @ convertToShares",
  d25(F6_67B).length === 1 && d25(F6_67B)[0].location.function === "convertToShares",
  "dapat " + JSON.stringify(d25(F6_67B).map((c) => c.location.function)));
// 67b-7. F7: panggilan member asset.balanceOf(...) tidak meresolusi ke
// balanceOf kontrak sendiri -> 0.
const F7_67B = "pragma solidity ^0.8.20;\ncontract F7b {\n"
  + "    bool locked;\n"
  + "    address asset;\n"
  + "    mapping(address => uint256) private _balances;\n"
  + "    function balanceOf(address u) public view returns (uint256) { return _balances[u]; }\n"
  + "    function decimals() public pure returns (uint8) { return 18; }\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked); return IERC20(asset).balanceOf(address(this)) * 10 ** decimals(); }\n"
  + "    function shareDecimals() external view returns (uint8) { return decimals(); }\n"
  + "    function sharesOf(address u) external view returns (uint256) { return balanceOf(u); }\n"
  + "}\ninterface IERC20 { function balanceOf(address) external view returns (uint256); }";
check("D25 67b-7 F7 panggilan member diabaikan -> 0",
  d25(F7_67B).length === 0, "dapat " + JSON.stringify(d25(F7_67B).map((c) => c.location.function)));
// 67b-8. F8: overload _calc (pure + view) — view ikut ditelusuri -> 1.
const F8_67B = "pragma solidity ^0.8.20;\ncontract F8b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    function _calc(uint256 a) internal pure returns (uint256) { return a; }\n"
  + "    function _calc() internal view returns (uint256) { return _held; }\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked); return _calc(); }\n"
  + "    function previewWithdraw(uint256 a) public view returns (uint256) { return a * _calc(); }\n"
  + "}";
check("D25 67b-8 F8 overload view ikut ditelusuri -> 1 @ previewWithdraw",
  d25(F8_67B).length === 1 && d25(F8_67B)[0].location.function === "previewWithdraw",
  "dapat " + JSON.stringify(d25(F8_67B).map((c) => c.location.function)));
// 67b-9. F9: helper _nav di base contract (span lain, satu file) -> 1.
const F9_67B = "pragma solidity ^0.8.20;\n"
  + "abstract contract Base9 {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "}\ncontract Vault9 is Base9 {\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked); return _nav(); }\n"
  + "    function previewDeposit(uint256 a) public view returns (uint256) { return a * _nav(); }\n"
  + "}";
check("D25 67b-9 F9 helper di base contract -> 1 @ previewDeposit",
  d25(F9_67B).length === 1 && d25(F9_67B)[0].location.function === "previewDeposit",
  "dapat " + JSON.stringify(d25(F9_67B).map((c) => c.location.function)));
// 67b-10. F10: blok if dengan struct literal + emit panjang tetap guard -> 1.
const F10_67B = "pragma solidity ^0.8.20;\ncontract F10b {\n"
  + "    uint256 _held;\n"
  + "    bool locked;\n"
  + "    struct Info { uint256 a; }\n"
  + "    event L(Info i);\n"
  + "    event LockedAccessAttempt(address a, uint256 b, uint256 c, uint256 d);\n"
  + "    function _nav() internal view returns (uint256) { return _held; }\n"
  + "    function totalAssets() public view returns (uint256) { if (locked) { emit L(Info({a: 1})); revert X(); } return _nav(); }\n"
  + "    function previewRedeem(uint256 s) public view returns (uint256) { return s * _nav(); }\n"
  + "}";
check("D25 67b-10 F10 if-blok struct literal tetap guard -> 1 @ previewRedeem",
  d25(F10_67B).length === 1 && d25(F10_67B)[0].location.function === "previewRedeem",
  "dapat " + JSON.stringify(d25(F10_67B).map((c) => c.location.function)));
const F10B_67B = F10_67B.replace(
  "if (locked) { emit L(Info({a: 1})); revert X(); }",
  "if (locked) { emit LockedAccessAttempt(msg.sender, block.timestamp, someLongArgumentName, anotherLongArgumentName); revert X(); }");
check("D25 67b-10b F10 if-blok emit panjang tetap guard -> 1 @ previewRedeem",
  d25(F10B_67B).length === 1 && d25(F10B_67B)[0].location.function === "previewRedeem",
  "dapat " + JSON.stringify(d25(F10B_67B).map((c) => c.location.function)));
// 67b-11. F11: parameter function-type tidak membuat _apply jadi entry/helper
// view -> 0 (preview hanya berbagi _apply, bukan NAV).
const F11_67B = "pragma solidity ^0.8.20;\ncontract F11b {\n"
  + "    bool public locked;\n"
  + "    uint256 public totalSupply;\n"
  + "    function(uint256) external returns (uint256) public fnPtr;\n"
  + "    function _nav() internal view returns (uint256) { return totalSupply; }\n"
  + "    function _apply(function(uint256) external view returns (uint256) f, uint256 x) internal returns (uint256) { return f(x); }\n"
  + "    function totalAssets() public view returns (uint256) { require(!locked, \"REENTRANCY\"); return _nav(); }\n"
  + "    function previewRedeem(uint256 s) public view returns (uint256) { return _apply(fnPtr, s); }\n"
  + "}";
check("D25 67b-11 F11 function-type param bukan helper view -> 0",
  d25(F11_67B).length === 0, "dapat " + JSON.stringify(d25(F11_67B).map((c) => c.location.function)));
// 67b-12. Regresi pasca-R25: Cellar verbatim TETAP 7 Low; maxMint dan
// getCreditPositions TIDAK ikut ter-flag (F6 dibatasi).
check("D25 67b-12 Cellar pasca-R25 tetap 7 Low, maxMint tidak ter-flag",
  c672.length === 7 && c672.every((c) => c.severityGuess === "Low")
    && c672.map((c) => c.location.function).sort().join(",")
      === "convertToAssets,convertToShares,maxDeposit,previewDeposit,previewMint,previewRedeem,previewWithdraw",
  "dapat " + JSON.stringify(c672.map((c) => c.location.function)));
// 67b-13. Regresi pasca-R25: trap-vault tetap 1 @ previewRedeem (BUG 26).
check("D25 67b-13 trap-vault pasca-R25 tetap 1 @ previewRedeem",
  trapD25.length === 1 && trapD25[0].location.function === "previewRedeem",
  "dapat " + JSON.stringify(trapD25.map((c) => c.location.function)));

// --- Seksi 68. Detektor ke-26: unbounded-loop-inflatable-set-accounting
// (H-SOMM-19 — backlog detektor sesi BB pagi 23 Nov 2026, Somm
// VestingSimple: deposit() tanpa guard menambah allUserDepositIds[receiver]
// dengan receiver bebas; vestedBalanceOf() me-loop seluruh set; PoC fork:
// brick totalAssets pada ±3.121 entri, ±9.846 gas/entri; Medium, BUKAN
// kandidat submit baru — draf BB BELUM DISERANG).
const d26 = (src, name) => runPipeline(src, name || "d26.sol").candidates
  .filter((c) => c.detector === "unbounded-loop-inflatable-set-accounting");
const MINI68 = "pragma solidity ^0.8.20;\ncontract Mini68 {\n"
  + "    mapping(address => EnumerableSet.UintSet) private allUserDepositIds;\n"
  + "    mapping(address => mapping(uint256 => uint256)) public vests;\n"
  + "    mapping(address => uint256) public currentId;\n"
  + "    uint256 public minimumDeposit = 1e14;\n"
  + "    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {\n"
  + "        require(assets >= minimumDeposit, \"too small\");\n"
  + "        shares = assets;\n"
  + "        uint256 newDepositId = currentId[receiver] + 1;\n"
  + "        currentId[receiver] = newDepositId;\n"
  + "        allUserDepositIds[receiver].add(newDepositId);\n"
  + "        vests[receiver][newDepositId] = assets;\n"
  + "    }\n"
  + "    function vestedBalanceOf(address user) public view returns (uint256 balance) {\n"
  + "        uint256[] memory depositIds = allUserDepositIds[user].values();\n"
  + "        uint256 numDeposits = depositIds.length;\n"
  + "        for (uint256 i = 0; i < numDeposits; i++) {\n"
  + "            balance += vests[user][depositIds[i]];\n"
  + "        }\n"
  + "    }\n}";
const c68 = d26(MINI68);
check("D26 68-1 fixture mini -> 1 Medium @ vestedBalanceOf",
  c68.length === 1 && c68[0].location.function === "vestedBalanceOf"
    && c68[0].severityGuess === "Medium"
    && c68[0].evidence.indexOf("deposit") !== -1,
  "dapat " + JSON.stringify(c68.map((c) => c.location.function + ":" + c.severityGuess)));
// 68-2. VestingSimple.sol verbatim (repo Somm @ 07efdfa9) -> 2 Medium:
// vestedBalanceOf + totalBalanceOf (keduanya me-loop seluruh set via
// .values()); withdrawAll/withdrawAnyFor bukan view, userDepositIds tanpa
// loop, vestedBalanceOfDeposit tanpa loop — TIDAK di-flag.
const vesting68 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "work",
  "somm", "cellar-contracts", "src", "modules", "vesting", "VestingSimple.sol"), "utf8");
const c682 = d26(vesting68, "VestingSimple.sol");
check("D26 68-2 VestingSimple verbatim -> 2 Medium (vestedBalanceOf + totalBalanceOf)",
  c682.length === 2 && c682.every((c) => c.severityGuess === "Medium")
    && c682.map((c) => c.location.function).sort().join(",") === "totalBalanceOf,vestedBalanceOf",
  "dapat " + JSON.stringify(c682.map((c) => c.location.function)));
// 68-3. Grower ber-guard (onlyOwner) -> 0.
check("D26 68-3 grower onlyOwner -> 0",
  d26(MINI68.replace("function deposit(uint256 assets, address receiver) public returns",
    "function deposit(uint256 assets, address receiver) public onlyOwner returns")).length === 0);
// 68-4. Kunci = msg.sender saja (hanya bisa membengkakkan set sendiri) -> 0.
check("D26 68-4 kunci msg.sender saja -> 0",
  d26(MINI68.replace("allUserDepositIds[receiver].add(newDepositId)",
    "allUserDepositIds[msg.sender].add(newDepositId)")).length === 0);
// 68-5. Grower ber-cap jumlah entri (require length < MAX) -> 0.
check("D26 68-5 grower ber-cap -> 0",
  d26(MINI68.replace("        require(assets >= minimumDeposit, \"too small\");\n",
    "        require(assets >= minimumDeposit, \"too small\");\n        require(allUserDepositIds[receiver].length() < 100, \"cap\");\n")).length === 0);
// 68-6. Reader berpaginasi (bound = parameter limit) -> 0.
check("D26 68-6 reader berpaginasi -> 0",
  d26(MINI68.replace("function vestedBalanceOf(address user) public view",
    "function vestedBalanceOf(address user, uint256 limit) public view")
    .replace("for (uint256 i = 0; i < numDeposits; i++)",
      "for (uint256 i = 0; i < limit && i < numDeposits; i++)")).length === 0);
// 68-7. Reader dengan `break` TANPA SYARAT di badan loop -> 0.
// (R26/F4: break bersyarat — `if (c) break;` — TIDAK lagi menekan, karena
// worst case tetap seluruh set; lihat 68b-4.)
check("D26 68-7 reader dengan break tanpa syarat -> 0",
  d26(MINI68.replace("            balance += vests[user][depositIds[i]];\n",
    "            balance += vests[user][depositIds[i]];\n            break;\n")).length === 0);
// 68-8. Varian array dinamis mapping (push + loop .length) -> 1.
const ARR68 = "pragma solidity ^0.8.20;\ncontract Arr68 {\n"
  + "    mapping(address => uint256[]) private deposits;\n"
  + "    mapping(address => mapping(uint256 => uint256)) public amounts;\n"
  + "    function deposit(uint256 assets, address receiver) public {\n"
  + "        deposits[receiver].push(assets);\n"
  + "        amounts[receiver][deposits[receiver].length - 1] = assets;\n"
  + "    }\n"
  + "    function balanceOf(address user) public view returns (uint256 balance) {\n"
  + "        for (uint256 i = 0; i < deposits[user].length; i++) {\n"
  + "            balance += amounts[user][deposits[user][i]];\n"
  + "        }\n"
  + "    }\n}";
check("D26 68-8 varian array mapping -> 1 Medium @ balanceOf",
  d26(ARR68).length === 1 && d26(ARR68)[0].location.function === "balanceOf"
    && d26(ARR68)[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(d26(ARR68).map((c) => c.location.function)));
// 68-9. Varian set polos (bukan mapping — set bersama) -> 1.
const PLAIN68 = "pragma solidity ^0.8.20;\ncontract Plain68 {\n"
  + "    EnumerableSet.UintSet private ids;\n"
  + "    mapping(uint256 => uint256) public amounts;\n"
  + "    function add(uint256 id, uint256 amt) public {\n"
  + "        ids.add(id);\n"
  + "        amounts[id] = amt;\n"
  + "    }\n"
  + "    function totalOf() public view returns (uint256 total) {\n"
  + "        for (uint256 i = 0; i < ids.length(); i++) {\n"
  + "            total += amounts[ids.at(i)];\n"
  + "        }\n"
  + "    }\n}";
check("D26 68-9 varian set polos -> 1 Medium @ totalOf",
  d26(PLAIN68).length === 1 && d26(PLAIN68)[0].location.function === "totalOf",
  "dapat " + JSON.stringify(d26(PLAIN68).map((c) => c.location.function)));
// 68-10. File test/mock dilewati -> 0.
check("D26 68-10 file test dilewati -> 0",
  d26(MINI68, "test/d26.sol").length === 0
    && d26(MINI68, "Vesting.t.sol").length === 0);
// 68-11. trap-vault: D26 tepat 1 @ vestedBalanceOf (BUG 27); total ground
// truth kini 30 (dicek seksi 1).
const trapD26 = runPipeline(sol, "trap-vault.sol").candidates
  .filter((c) => c.detector === "unbounded-loop-inflatable-set-accounting");
check("D26 68-11 trap-vault -> tepat 1 @ vestedBalanceOf (BUG 27)",
  trapD26.length === 1 && trapD26[0].location.function === "vestedBalanceOf"
    && trapD26[0].severityGuess === "Medium",
  "dapat " + JSON.stringify(trapD26.map((c) => c.location.function)));
// 68-12. toVerify menyebut rantai akuntansi + PoC fork + biaya/ambang brick.
check("D26 68-12 toVerify menyebut totalAssets + PoC fork + biaya bloat",
  c68.length === 1 && c68[0].toVerify.some((t) => t.indexOf("totalAssets") !== -1)
    && c68[0].toVerify.some((t) => t.indexOf("PoC fork") !== -1)
    && c68[0].toVerify.some((t) => t.indexOf("biaya bloat") !== -1));

// --- Seksi 68b. Kalibrasi R26 detektor ke-26 (wasit atas review Kiro Opus 5.5
// NEEDS WORK, sesi Frankenstein #59; 58 kasus: 26 benar / 12 FP / 20 FN;
// probe wasit /tmp/probe-r26.js 34/34 lolos pasca-R26). Satu cek per keluarga
// temuan F1–F12; F10 SENGAJA tetap di-flag (plain-set .add(msg.sender) bisa
// digelembungkan via sybil — perilaku disengaja, lihat 68b-10).
const R26_HEAD = "pragma solidity ^0.8.20;\ncontract R26B {\n"
  + "    mapping(address => EnumerableSet.UintSet) private ids;\n"
  + "    mapping(address => mapping(uint256 => uint256)) public v;\n"
  + "    uint256 public MAX = 100;\n";
const R26_GROW = "    function deposit(uint256 a, address r) public returns (uint256) {\n"
  + "        ids[r].add(a);\n"
  + "        v[r][a] = 1;\n"
  + "    }\n";
const R26_READ = "    function bal(address u) public view returns (uint256 t) {\n"
  + "        uint256[] memory d = ids[u].values();\n"
  + "        uint256 n = d.length;\n"
  + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; }\n"
  + "    }\n}";
const mkR26 = (grower, reader, head) => (head || R26_HEAD) + grower + reader;
// 68b-1. F1 — delapan bentuk cap jumlah entri -> 0 semua.
const caps68b = [
  ["C1 require(length<MAX)", R26_GROW.replace("        ids[r].add(a);",
    "        require(ids[r].length() < MAX);\n        ids[r].add(a);")],
  ["C2 require(MAX>length) terbalik", R26_GROW.replace("        ids[r].add(a);",
    "        require(MAX > ids[r].length());\n        ids[r].add(a);")],
  ["C3 if(length>=MAX){revert}", R26_GROW.replace("        ids[r].add(a);",
    "        if (ids[r].length() >= MAX) { revert TooMany(); }\n        ids[r].add(a);")],
  ["C6 require(length+1<=MAX)", R26_GROW.replace("        ids[r].add(a);",
    "        require(ids[r].length() + 1 <= MAX);\n        ids[r].add(a);")],
  ["C11 alias n=length; require(n<MAX)", R26_GROW.replace("        ids[r].add(a);",
    "        uint256 n = ids[r].length();\n        require(n < MAX);\n        ids[r].add(a);")],
  ["C4 cap di modifier", "    modifier capped(address r) { require(ids[r].length() < MAX); _; }\n"
    + "    function deposit(uint256 a, address r) public capped(r) returns (uint256) {\n"
    + "        ids[r].add(a);\n        v[r][a] = 1;\n    }\n"],
  ["C5 cap di helper", "    function _checkCap(address r) internal view { require(ids[r].length() < MAX); }\n"
    + "    function deposit(uint256 a, address r) public returns (uint256) {\n"
    + "        _checkCap(r);\n        ids[r].add(a);\n        v[r][a] = 1;\n    }\n"],
  ["C10 add di dalam if(length<MAX)", R26_GROW.replace(
    "        ids[r].add(a);\n        v[r][a] = 1;",
    "        if (ids[r].length() < MAX) { ids[r].add(a); }\n        v[r][a] = 1;")],
];
for (const [label, grower] of caps68b) {
  check("D26 68b-1 F1 cap " + label + " -> 0",
    d26(mkR26(grower, R26_READ)).length === 0,
    "dapat " + d26(mkR26(grower, R26_READ)).length);
}
// 68b-2. F2 — cap palsu (require !contains && batch.length<10) bukan cap -> 1.
check("D26 68b-2 F2 cap palsu batch.length -> 1",
  d26(mkR26(R26_GROW.replace("        ids[r].add(a);",
    "        uint256[] memory batch = new uint256[](0);\n        require(!ids[r].contains(a) && batch.length < 10);\n        ids[r].add(a);"), R26_READ)).length === 1);
// 68b-3. F3 — empat bentuk loop reader -> 1 semua.
const loops68b = [
  ["L3 while", "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 i = 0;\n"
    + "        while (i < d.length) { t += v[u][d[i]]; i++; }\n"
    + "    }\n}"],
  ["L4 loop mundur", "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        for (uint256 i = d.length; i > 0; i--) { t += v[u][d[i - 1]]; }\n"
    + "    }\n}"],
  ["L5 kondisi terbalik n>i", "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        for (uint256 i = 0; n > i; i++) { t += v[u][d[i]]; }\n"
    + "    }\n}"],
  ["L8 alias set.length()", "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256 n = ids[u].length();\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][ids[u].at(i)]; }\n"
    + "    }\n}"],
];
for (const [label, reader] of loops68b) {
  check("D26 68b-3 F3 loop " + label + " -> 1",
    d26(mkR26(R26_GROW, reader)).length === 1,
    "dapat " + d26(mkR26(R26_GROW, reader)).length);
}
// 68b-4. F4 — break bersyarat / break loop-dalam TIDAK membatalkan -> 1.
check("D26 68b-4 F4 break bersyarat -> 1",
  d26(mkR26(R26_GROW, "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; if (d[i] == 7) { break; } }\n"
    + "    }\n}")).length === 1);
check("D26 68b-4 F4 break di loop dalam -> 1",
  d26(mkR26(R26_GROW, "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; for (uint256 j = 0; j < 3; j++) { if (j == 1) break; } }\n"
    + "    }\n}")).length === 1);
// 68b-5. F5 — clamp sisi reader (n>50 -> n=50) -> 0.
check("D26 68b-5 F5 reader clamp -> 0",
  d26(mkR26(R26_GROW, "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        if (n > 50) n = 50;\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; }\n"
    + "    }\n}")).length === 0);
// 68b-6. F6 — kunci/grower: indeks bersarang, mapping bersarang, alias lokal,
// delegasi helper -> 1 semua.
check("D26 68b-6 F6 K4 ids[receivers[i]].add -> 1",
  d26(mkR26("    function deposit(address[] memory receivers, uint256 a) public {\n"
    + "        ids[receivers[0]].add(a);\n    }\n", R26_READ)).length === 1);
const nested68b = "pragma solidity ^0.8.20;\ncontract R26B {\n"
  + "    mapping(address => mapping(uint256 => EnumerableSet.UintSet)) private ids3;\n"
  + "    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) public v;\n"
  + "    function deposit(uint256 a, address r, uint256 pid) public {\n"
  + "        ids3[r][pid].add(a);\n    }\n"
  + "    function bal(address u, uint256 pid) public view returns (uint256 t) {\n"
  + "        uint256[] memory d = ids3[u][pid].values();\n"
  + "        uint256 n = d.length;\n"
  + "        for (uint256 i = 0; i < n; i++) { t += v[u][pid][d[i]]; }\n"
  + "    }\n}";
check("D26 68b-6 F6 K3 mapping bersarang -> 1", d26(nested68b).length === 1);
check("D26 68b-6 F6 K5 alias lokal k=r -> 1",
  d26(mkR26(R26_GROW.replace("        ids[r].add(a);",
    "        address k = r;\n        ids[k].add(a);"), R26_READ)).length === 1);
check("D26 68b-6 F6 K10 delegasi helper -> 1",
  d26(R26_HEAD + "    function _deposit(uint256 a, address r) internal {\n"
    + "        ids[r].add(a);\n        v[r][a] = 1;\n    }\n"
    + "    function deposit(uint256 a, address r) public returns (uint256) {\n"
    + "        _deposit(a, r);\n        return a;\n    }\n" + R26_READ).length === 1);
// 68b-7. F7 — kunci campuran msg.sender (namespace caller sendiri) -> 0.
const mixed68b = "pragma solidity ^0.8.20;\ncontract R26B {\n"
  + "    mapping(address => EnumerableSet.UintSet) private ids2;\n"
  + "    mapping(address => mapping(uint256 => uint256)) public v;\n"
  + "    function deposit(uint256 a, address receiver) public {\n"
  + "        ids2[keccak256(abi.encode(msg.sender, receiver))].add(a);\n    }\n"
  + "    function bal(address u) public view returns (uint256 t) {\n"
  + "        uint256[] memory d = ids2[u].values();\n"
  + "        uint256 n = d.length;\n"
  + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; }\n"
  + "    }\n}";
check("D26 68b-7 F7 kunci keccak(msg.sender,receiver) -> 0", d26(mixed68b).length === 0);
// 68b-8. F8 — prefix tipe set apa pun (alias import / Upgradeable) -> 1.
check("D26 68b-8 F8 ES.UintSet (alias import) -> 1",
  d26(mkR26(R26_GROW, R26_READ, R26_HEAD.replace("EnumerableSet.UintSet", "ES.UintSet"))).length === 1);
check("D26 68b-8 F8 EnumerableSetUpgradeable.UintSet -> 1",
  d26(mkR26(R26_GROW, R26_READ, R26_HEAD.replace("EnumerableSet.UintSet", "EnumerableSetUpgradeable.UintSet"))).length === 1);
// 68b-9. F9 — shadowing parameter / lokal atas state array -> 0.
check("D26 68b-9 F9 param shadow state array -> 0",
  d26("pragma solidity ^0.8.20;\ncontract R26B {\n"
    + "    uint256[] private holders;\n"
    + "    function add(uint256 x) public { holders.push(x); }\n"
    + "    function bal(address[] memory holders) public view returns (uint256 t) {\n"
    + "        for (uint256 i = 0; i < holders.length; i++) { t += holders[i]; }\n"
    + "    }\n}").length === 0);
check("D26 68b-9 F9 lokal shadow state array -> 0",
  d26("pragma solidity ^0.8.20;\ncontract R26B {\n"
    + "    uint256[] private holders;\n"
    + "    function add(uint256 x) public { holders.push(x); }\n"
    + "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory holders = new uint256[](3);\n"
    + "        for (uint256 i = 0; i < holders.length; i++) { t += holders[i]; }\n"
    + "    }\n}").length === 0);
// 68b-10. F10 — plain set .add(msg.sender) SENGAJA tetap di-flag (sybil:
// set bersama bisa digelembungkan lewat banyak alamat; bukan FP).
check("D26 68b-10 F10 plain set add(msg.sender) -> 1 (sybil, disengaja)",
  d26("pragma solidity ^0.8.20;\ncontract R26B {\n"
    + "    EnumerableSet.UintSet private members;\n"
    + "    mapping(uint256 => uint256) public amounts;\n"
    + "    function join(uint256 a) public { members.add(uint256(uint160(msg.sender))); amounts[uint256(uint160(msg.sender))] = a; }\n"
    + "    function total() public view returns (uint256 t) {\n"
    + "        for (uint256 i = 0; i < members.length(); i++) { t += amounts[members.at(i)]; }\n"
    + "    }\n}").length === 1);
// 68b-11. F11 — modifier only* bukan guard pemanggil -> 1; onlyOwner tetap 0.
function g11b(mod) {
  return mkR26(R26_GROW.replace("function deposit(uint256 a, address r) public returns",
    "function deposit(uint256 a, address r) public " + mod + " returns"), R26_READ);
}
check("D26 68b-11 F11 onlyWhenNotPaused -> 1", d26(g11b("onlyWhenNotPaused")).length === 1);
check("D26 68b-11 F11 onlyEOA -> 1", d26(g11b("onlyEOA")).length === 1);
check("D26 68b-11 F11 onlyValidReceiver(r) -> 1", d26(g11b("onlyValidReceiver(r)")).length === 1);
check("D26 68b-11 F11 onlyOwner -> 0", d26(g11b("onlyOwner")).length === 0);
check("D26 68b-11 F11 onlyManagerOrOwner -> 0", d26(g11b("onlyManagerOrOwner")).length === 0);
// 68b-12. F12 — reader internal via public view + warisan satu file -> 1.
check("D26 68b-12 F12 reader internal via public view -> 1",
  d26(R26_HEAD + "    function _sum(address u) internal view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; }\n"
    + "    }\n"
    + "    function bal(address u) public view returns (uint256 t) {\n"
    + "        t = _sum(u);\n"
    + "    }\n"
    + "    function deposit(uint256 a, address r) public returns (uint256) {\n"
    + "        ids[r].add(a);\n        v[r][a] = 1;\n    }\n}").length === 1);
check("D26 68b-12 F12 warisan Base/Child -> 1",
  d26("pragma solidity ^0.8.20;\ncontract Base {\n"
    + "    mapping(address => EnumerableSet.UintSet) private ids;\n"
    + "    mapping(address => mapping(uint256 => uint256)) public v;\n"
    + "    function bal(address u) public view returns (uint256 t) {\n"
    + "        uint256[] memory d = ids[u].values();\n"
    + "        uint256 n = d.length;\n"
    + "        for (uint256 i = 0; i < n; i++) { t += v[u][d[i]]; }\n"
    + "    }\n}\ncontract Child is Base {\n"
    + "    function deposit(uint256 a, address r) public {\n"
    + "        ids[r].add(a);\n    }\n}").length === 1);

// --- Ringkasan
console.log("\n" + pass + " lolos, " + fail + " gagal.");
process.exit(fail ? 1 : 0);
