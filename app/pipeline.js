// FrankenAudit — pipeline.js (M2: pattern scan nyata + normalisasi Slither)
// Format kandidat mengikuti .kiro/steering/bug-bounty.md.
// Detektor di sini HEURISTIK berbasis pola sumber — kandidat, bukan verdict.
// Verdict butuh review Kiro crew + PoC fork oleh wasit manusia.

// ---------------------------------------------------------------------------
// Normalisasi
// ---------------------------------------------------------------------------
function normalizeCandidate(raw) {
  return {
    id: raw.id,
    title: raw.title,
    location: raw.location, // { file, function }
    hypothesis: raw.hypothesis,
    preconditions: raw.preconditions || "Not yet verified.",
    impact: raw.impact || "",
    severityGuess: raw.severityGuess || "Low",
    evidence: raw.evidence || "",
    toVerify: raw.toVerify || [],
    source: raw.source || "pattern-scan",
    detector: raw.detector || "pattern-scan",
    // KALIBRASI R-COF-1b (sesi #33 — temuan Kiro F7): penanda internal
    // commented-out-function berbadan — hanya diteruskan bila ada, supaya
    // filter R-COF-1 di runPipeline bisa mempertahankannya.
    ...(raw.commentedHasBody ? { commentedHasBody: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Penghapus komentar (// dan /* */) dengan posisi baris dipertahankan:
// karakter komentar diganti spasi, newline dipertahankan, string literal
// ("...") tidak disentuh. Dipakai sebelum ekstraksi fungsi supaya detektor
// tidak salah-flag pola yang hanya ada di komentar — mis. komentar
// "// totalSupply is the normalized debt" sempat memicu division-no-guard
// di RAAC LendingPool._validateBorrow (hunting 14 Nov 2026).
// ---------------------------------------------------------------------------
function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'") {
      // String literal: salin utuh (termasuk escape). Kutip tunggal
      // JUGA string di Solidity — tanpa ini, `'ipfs://cid'` memotong
      // sisa baris sebagai komentar (review Kiro detektor #17, P8).
      const q = ch;
      out += ch; i++;
      while (i < n && source[i] !== q) {
        if (source[i] === "\\" && i + 1 < n) { out += source[i] + source[i + 1]; i += 2; }
        else { out += source[i]; i++; }
      }
      if (i < n) { out += source[i]; i++; }
    } else if (ch === "/" && next === "/") {
      // Komentar baris: ganti isi dengan spasi sampai newline.
      while (i < n && source[i] !== "\n") { out += " "; i++; }
    } else if (ch === "/" && next === "*") {
      // Komentar blok: ganti isi dengan spasi, newline dipertahankan.
      out += "  "; i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) { out += "  "; i += 2; }
    } else {
      out += ch; i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ekstraksi komentar (// dan /* */) dengan nomor baris asli.
// Dipakai detektor commented-out-check: komentar yang berisi kode cek
// (require/assert/revert) yang dikomentari = pertahanan yang dimatikan.
// String literal tidak disentuh (komentar di dalam string bukan komentar).
// ---------------------------------------------------------------------------
function extractComments(source) {
  const comments = []; // { line (0-based), text }
  let i = 0;
  const n = source.length;
  let line = 0;
  function pushComment(text, startLine) {
    const parts = text.split("\n");
    parts.forEach((p, k) => {
      comments.push({ line: startLine + k, text: p });
    });
  }
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") { line++; i++; continue; }
    if (ch === '"') {
      i++;
      while (i < n && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < n) i += 2;
        else { if (source[i] === "\n") line++; i++; }
      }
      if (i < n) i++;
    } else if (ch === "/" && next === "/") {
      const startLine = line;
      let text = "";
      i += 2;
      while (i < n && source[i] !== "\n") { text += source[i]; i++; }
      pushComment(text, startLine);
    } else if (ch === "/" && next === "*") {
      const startLine = line;
      let text = "";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        text += source[i];
        i++;
      }
      if (i < n) i += 2;
      pushComment(text, startLine);
    } else {
      i++;
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Ekstraksi BLOK komentar (// beruntun = satu blok; /* */ = satu blok),
// dengan nomor baris asli. Dipakai detektor commented-out-function:
// fungsi yang dikomentari UTUH (mis. setDebtCeiling Amply) muncul sebagai
// satu blok berisi definisi fungsi, bukan sebagai fungsi hidup.
// String literal tidak disentuh (komentar di dalam string bukan komentar).
// ---------------------------------------------------------------------------
function extractCommentBlocks(source) {
  const blocks = []; // { startLine, endLine, text }
  let i = 0;
  const n = source.length;
  let line = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") { line++; i++; continue; }
    if (ch === '"') {
      i++;
      while (i < n && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < n) i += 2;
        else { if (source[i] === "\n") line++; i++; }
      }
      if (i < n) i++;
    } else if (ch === "/" && next === "/") {
      // Run baris // berurutan = satu blok (baris kosong memutus blok).
      const startLine = line;
      const parts = [];
      while (true) {
        let text = "";
        i += 2;
        while (i < n && source[i] !== "\n") { text += source[i]; i++; }
        parts.push(text);
        // Intip baris berikut: apakah (setelah spasi) diawali // ?
        let j = i;
        if (j < n && source[j] === "\n") j++;
        let k = j;
        while (k < n && (source[k] === " " || source[k] === "\t")) k++;
        if (k + 1 < n && source[k] === "/" && source[k + 1] === "/") {
          line++; // newline yang dilewati
          i = k;
          continue;
        }
        break;
      }
      blocks.push({ startLine, endLine: line, text: parts.join("\n") });
    } else if (ch === "/" && next === "*") {
      const startLine = line;
      let text = "";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        text += source[i];
        i++;
      }
      if (i < n) i += 2;
      blocks.push({ startLine, endLine: line, text });
    } else {
      i++;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Ekstraksi fungsi (pemindai level-source; tahan signature multi-baris)
// v2 2026-11-13: versi lama berbasis satu-baris melewatkan mayoritas fungsi
// kode nyata (Aave/Amply: parameter + modifier tersebar di banyak baris) —
// hunting run Amply 83 file menghasilkan 0 kandidat karena extractor, bukan
// karena kode bersih. Versi ini: cari "function NAME(" lalu kurung seimbang,
// lalu "{" pertama sebelum ";" (deklarasi interface tanpa badan dilewati).
// ---------------------------------------------------------------------------
function extractFunctions(source) {
  const fns = [];
  const lines = source.split("\n");
  function lineOf(idx) {
    return source.slice(0, idx).split("\n").length - 1;
  }
  // Pindai satu pola: "function NAME(" atau "constructor(".
  function scan(re, isCtor) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      const name = isCtor ? "constructor" : m[1];
      // Kurung seimbang dari "(" pertama sesudah kata kunci.
      let i = m.index + m[0].length - 1; // posisi "("
      let depth = 0, j = i;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        else if (source[j] === ")") { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) continue;
      // Cari "{" pertama sebelum ";" (modifier/returns boleh multi-baris).
      let brace = -1;
      for (let k = j + 1; k < source.length; k++) {
        if (source[k] === "{") { brace = k; break; }
        if (source[k] === ";") break;
      }
      if (brace === -1) continue; // deklarasi tanpa badan
      let d = 0, end = brace;
      for (; end < source.length; end++) {
        if (source[end] === "{") d++;
        else if (source[end] === "}") { d--; if (d === 0) break; }
      }
      const startLine = lineOf(m.index);
      const endLine = lineOf(end);
      const body = source.slice(m.index, end + 1);
      const signature = source.slice(m.index, brace + 1)
        .replace(/\s+/g, " ").trim();
      fns.push({
        name,
        signature,
        startLine,
        endLine,
        // R9.1 (F9/F12): indeks char awal kata kunci `function` + akhir
        // `}` badan — pemakaian yang butuh presisi char (bukan baris).
        startIndex: m.index,
        endIndex: end,
        body,
        bodyLines: body.split("\n"),
        isConstructor: isCtor,
      });
    }
  }
  scan(/\bfunction\s+(\w+)\s*\(/g, false);
  scan(/\bconstructor\s*\(/g, true);
  // Urutkan sesuai kemunculan di source (detektor mengandalkan urutan stabil).
  fns.sort((a, b) => a.startLine - b.startLine);
  return fns;
}

// ---------------------------------------------------------------------------
// Detektor (satu fungsi -> 0..n kandidat mentah)
// ---------------------------------------------------------------------------
const MAPPING_STATE = ["balances", "shares", "debt"];
const SENSITIVE_STATE = ["owner", "admin", "feeBps", "oracle"];
const DIVISION_DENOMS = ["totalShares", "totalSupply", "totalAssets", "totalDebt"];

// Bagian MODIFIER dari signature: sesudah kurung-tutup parameter,
// sebelum `returns` / `{`. Dipakai F4 — nama PARAMETER tidak boleh
// memicu guard (kasus Kiro: param `onlyIfSuccess` / `auth` ikut cocok
// pola only*/auth bila signature utuh yang diuji).
function modifierPart(fn) {
  const sig = fn.signature;
  const open = sig.indexOf("(");
  if (open === -1) return sig;
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") {
      depth--;
      if (depth === 0) {
        let tail = sig.slice(i + 1);
        const rIdx = tail.search(/\breturns\b/);
        if (rIdx !== -1) tail = tail.slice(0, rIdx);
        const bIdx = tail.indexOf("{");
        if (bIdx !== -1) tail = tail.slice(0, bIdx);
        return tail;
      }
    }
  }
  return sig;
}

// Helper kalibrasi R18.5 (sesi #45): guard permission-record —
// `require(x.authorized)` / `if (!x.authorized) revert` di mana x
// dimuat dari mapping berindeks msg.sender, atau require langsung atas
// `map[msg.sender]... .authorized`. Kembalikan true bila ada SATU
// pola guard seperti itu di badan fungsi.
function hasPermissionRecordGuard(body) {
  // 1) Identifier yang dimuat dari mapping berindeks msg.sender:
  // `T memory x = map[msg.sender]...` / `x = map[msg.sender]...`
  // (rantaian indeks berapa pun; `[^;{]*` tidak melewati batas statement).
  const loaded = new Set();
  const loadRe = /\b([A-Za-z_$][\w$]*)\s*=\s*[^;{]*\[\s*msg\.sender\s*\]/g;
  let lm;
  while ((lm = loadRe.exec(body)) !== null) loaded.add(lm[1]);
  const fieldOk = (base) => {
    const b = base.replace(/\s+/g, "");
    // Bentuk langsung: map[msg.sender][...].authorized
    if (/\[msg\.sender\]/.test(b)) return true;
    // Bentuk via variabel: x.authorized, x dimuat dari mapping msg.sender
    if (/^[A-Za-z_$][\w$]*$/.test(b) && loaded.has(b)) return true;
    return false;
  };
  // 2a) require(...) / assert(...) atas field permission-record.
  const reqRe = /(?:require|assert)\s*\(\s*!?\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*)\s*\.\s*(?:authorized|isAuthorized)\b/g;
  let m;
  while ((m = reqRe.exec(body)) !== null) {
    if (fieldOk(m[1])) return true;
  }
  // 2b) Bentuk revert-guard: if (!x.authorized ...) revert /
  // if (x.authorized == false ...) revert.
  const ifRe = /if\s*\(\s*!?\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*)\s*\.\s*(?:authorized|isAuthorized)\b[^)]*\)\s*\{?\s*revert\b/g;
  while ((m = ifRe.exec(body)) !== null) {
    if (fieldOk(m[1])) return true;
  }
  // 2c) require(...) langsung atas mapping boolean berindeks msg.sender
  // (generalisasi F5c ke rantaian indeks berapa pun; tanpa operator
  // perbandingan lain supaya `require(balances[msg.sender] > 0)` — cek
  // saldo, BUKAN guard akses — tetap tidak menekan).
  const mapRe = /require\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])+)\s*(?:==\s*true\s*)?(?:\s*,[^)]*)?\)/g;
  while ((m = mapRe.exec(body)) !== null) {
    if (/\[msg\.sender\]/.test(m[1].replace(/\s+/g, ""))) return true;
  }
  return false;
}

function hasAccessGuard(fn) {
  // Modifier akses di signature — termasuk pola khas bridge/host
  // (restrict, onlyHost, onlyRelayer) yang sempat lolos di hunting
  // Hyperbridge 15 Nov 2026 (HostManager.onAccept ber-modifier
  // restrict(msg.sender, host) + restrict(relayer, admin) tapi
  // tetap ter-flag High).
  // KALIBRASI hunting Fulcrom 15 Nov 2026 (4/4 kandidat High adalah
  // false positive): `initializer`/`reinitializer` (OZ Initializable,
  // one-shot — PositionManager/PositionRouter.initialize), modifier
  // `onlyGov` / `onlyAdminOrGov` (idiom GMX — PositionManager.setAdmin),
  // dan panggilan guard internal `_onlyGov()` / `_onlyAdmin()` /
  // `_onlyAdminOrGov()` di badan fungsi (idiom GMX — PositionRouter.setAdmin).
  // KALIBRASI review Kiro detektor 18/19, 17 Nov 2026 (F1 — wasit: probe
  // membuktikan `onlyGateway` TIDAK dikenali → FP): keluarga modifier
  // only* khas gateway/bridge/multisig ditambahkan. Daftar ini berbasis
  // NAMA — modifier custom bernama only* yang bukan guard adalah risiko
  // penekanan yang diketahui; wasit yang memutuskan bila muncul.
  // KALIBRASI hunting re-run 17 Nov 2026 (R18.2 — wasit: 4 FP RAAC
  // LendingPool/StabilityPool lolos karena modifier majemuk tak dikenal —
  // `onlyManagerOrOwner`, `onlyStabilityPool`, `onlySupportedAdapter`):
  // pola only* kini GENERIK (`only[A-Z]...`) + `notBlacklisted` — enumerasi
  // nama terbukti selalu ketinggalan satu. Risiko: modifier only* yang
  // bukan guard caller (mis. onlyAfterDeadline) ikut menekan — batas
  // diketahui; wasit men-triase bila muncul.
  // KALIBRASI F4 (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
  // membuktikan param `onlyIfSuccess` / `auth` memicu guard bila
  // signature utuh diuji): pola modifier hanya diuji pada bagian
  // modifier (sesudah parameter, sebelum returns) — bukan nama
  // parameter, bukan nama fungsi, bukan parameter returns.
  if (/\b(only[A-Z][A-Za-z0-9_$]*|notBlacklisted|restrict|requiresAuth|initializer|reinitializer|\bauth\b)\b/.test(modifierPart(fn))) return true;
  // KALIBRASI F2 (review Kiro 17 Nov 2026 — wasit: probe membuktikan
  // `require(msg.sender == address(0))` ikut dihitung guard): RHS harus
  // identifier bernama (state var/immutable/constant), BUKAN address(0).
  if (/require\s*\(\s*msg\.sender\s*==\s*(?!address\s*\()[A-Za-z_$][\w$]*/.test(fn.body)) return true;
  if (/require\s*\(\s*hasRole\s*\(/.test(fn.body)) return true;
  if (/msg\.sender\s*==\s*owner/.test(fn.body)) return true;
  // KALIBRASI F2-lanjutan (wasit: probe membuktikan guard bentuk
  // `if (msg.sender != gateway) revert ...;` TIDAK dikenali → FP):
  // pola revert-guard dua arah, RHS identifier bernama (bukan address(0)).
  if (/if\s*\(\s*msg\.sender\s*!=\s*(?!address\s*\()[A-Za-z_$][\w$]*\s*\)\s*revert/.test(fn.body)) return true;
  if (/if\s*\(\s*(?!address\s*\()[A-Za-z_$][\w$]*\s*!=\s*msg\.sender\s*\)\s*revert/.test(fn.body)) return true;
  if (/(^|[;\n{]\s*)_only(?:Gov|Admin|AdminOrGov|Owner|Manager)\s*\(\s*\)/.test(fn.body)) return true;
  // KALIBRASI F5a (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
  // membuktikan `_checkOwner()` OZ Ownable tidak dikenali): panggilan
  // guard internal OZ `_checkOwner()` / `_checkRole(...)` /
  // `_checkAdmin()` di badan fungsi.
  if (/(^|[;\n{]\s*)_check(?:Owner|Role|Admin)\s*\(/.test(fn.body)) return true;
  // KALIBRASI F5b (review Kiro F10 — wasit: probe membuktikan bentuk
  // terbalik `require(owner() == msg.sender)` tidak dikenali):
  // identifier (dengan `()` opsional) di KIRI `== msg.sender`.
  if (/require\s*\(\s*(?!address\s*\()[A-Za-z_$][\w$]*\s*(?:\(\s*\))?\s*==\s*msg\.sender/.test(fn.body)) return true;
  // KALIBRASI F5c (review Kiro F10 — wasit: probe membuktikan
  // `require(isOperator[msg.sender])` tidak dikenali): cek keanggotaan
  // MURNI `require(X[msg.sender])` (opsional `== true`, opsional pesan
  // error sebagai argumen kedua) — tanpa operator perbandingan lain,
  // supaya `require(balances[msg.sender] > 0)` (cek saldo, BUKAN guard
  // akses) tetap tidak menekan.
  if (/require\s*\(\s*[A-Za-z_$][\w$]*\s*\[\s*msg\.sender\s*\]\s*(?:==\s*true\s*)?(?:\s*,\s*[^)]*)?\)/.test(fn.body)) return true;
  // KALIBRASI R18.5 (sesi #45, hunting Resupply — wasit: FA-001
  // Core.execute ter-flag D18 padahal ber-guard permission-mapping:
  // `OperatorAuth memory auth = operatorPermissions[msg.sender][...][selector];`
  // lalu `require(auth.authorized, "!authorized")`): guard bentuk
  // permission-record — require atas field boolean (.authorized /
  // .isAuthorized) dari struct yang dimuat dari mapping berindeks
  // msg.sender (rantaian indeks berapa pun), ATAU require langsung atas
  // field itu dari mapping berindeks msg.sender, ATAU require langsung
  // atas mapping boolean berindeks msg.sender (generalisasi F5c);
  // bentuk revert-guard `if (!x.authorized) revert` ikut dikenali.
  // Batas: pemuatan via panggilan fungsi (mis. getAuth(msg.sender))
  // tidak dikenali; field bernama lain (allowed/approved) belum
  // dikenali — konservatif = TETAP.
  if (hasPermissionRecordGuard(fn.body)) return true;
  return false;
}

function detectReentrancy(fn, fileName, id) {
  const callRe = /\.call\s*\{|\.call\s*\(|\.transfer\s*\(|\.send\s*\(/;
  const writeRe = new RegExp(
    "\\b(" + MAPPING_STATE.join("|") + ")\\s*\\[[^\\]]+\\]\\s*[-+]?=(?!=)"
    + "|\\btotalSupply\\s*[-+]?=(?!=)");
  let callIdx = -1;
  for (let k = 0; k < fn.bodyLines.length; k++) {
    if (callRe.test(fn.bodyLines[k])) callIdx = k;
    if (callIdx >= 0 && k > callIdx && writeRe.test(fn.bodyLines[k])) {
      return [normalizeCandidate({
        id, detector: "reentrancy-call-before-update",
        title: "Possible reentrancy: state update after an external call",
        location: { file: fileName, function: fn.name },
        hypothesis: "Function " + fn.name + " sends ETH/tokens before "
          + "updates state, so the receiving contract can re-enter "
          + "and repeats the withdrawal before the balance is recorded as decreased.",
        preconditions: "The receiver is a contract with a fallback/receive "
          + "that calls this function back; the victim's balance is sufficient.",
        impact: "Draining of the contract balance if the pattern is confirmed.",
        severityGuess: "High",
        evidence: "external call at line " + (fn.startLine + callIdx + 1)
          + ", state update at line " + (fn.startLine + k + 1) + ".",
        toVerify: ["Read the full sequence of function " + fn.name,
          "check whether there is a reentrancy guard (nonReentrant)",
          "Fork PoC: an attacker contract re-enters "],
        source: "pattern-scan",
      })];
    }
  }
  return [];
}

function detectMissingAccessControl(fn, fileName, id) {
  if (fn.isConstructor) return [];
  // KALIBRASI hunting Hyperbridge 15 Nov 2026 (4 dari 5 kandidat High
  // adalah false positive): fungsi internal/private TIDAK bisa dipanggil
  // langsung dari luar — yang menentukan adalah gating di entry point
  // external yang memanggilnya (mis. IntentsBase._updateParams hanya
  // dipanggil onAccept ber-modifier onlyHost+onlyRelayer;
  // EvmHost.updateHostParamsInternal hanya via updateHostParams
  // restrict(hostManager) / initialize admin-gated). Detektor ini
  // function-scoped dan tidak membangun call-graph, jadi helper internal
  // dilewati; temuan delegated-write (external tanpa guard memanggil
  // helper internal) adalah BATAS DIKETAHUI yang didokumentasikan.
  if (/\b(internal|private)\b/.test(fn.signature)) return [];
  const writeRe = new RegExp(
    "\\b(" + SENSITIVE_STATE.join("|") + ")\\s*=(?!=)"
    + "|\\bselfdestruct\\s*\\(|\\bsuicide\\s*\\(");
  // Cari match pertama yang BUKAN deklarasi variabel lokal
  // (mis. `uint256 feeBps = ...` di _updateParams — lokal, bukan state).
  const declRe = /(uint\d*|int\d*|address|bool|bytes\d*|string)\s+$/;
  let m = null;
  {
    const g = new RegExp(writeRe.source, "g");
    let cand;
    while ((cand = g.exec(fn.body)) !== null) {
      const before = fn.body.slice(0, cand.index).split("\n").pop();
      if (declRe.test(before)) continue;
      m = cand;
      break;
    }
  }
  if (!m) return [];
  if (hasAccessGuard(fn)) return [];
  return [normalizeCandidate({
    id, detector: "missing-access-control",
    title: "Critical function without access control",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " writes sensitive state ("
      + (m ? m[0].trim() : "?") + ") without an access modifier and without "
      + "require(msg.sender == ...) — anyone can call it.",
    preconditions: "The function is external/public and can be called "
      + "by any address.",
    impact: "Role takeover / asset transfer without permission if confirmed.",
    severityGuess: "High",
    evidence: "Writes sensitive state in function " + fn.name
      + " without onlyOwner/onlyRole/a sender require.",
    toVerify: ["Check modifiers & requires in " + fn.name,
      "check whether this function is intentionally open (e.g. permissionless by design)",
      "Fork PoC: call from a random address"],
    source: "pattern-scan",
  })];
}

function detectDivisionNoGuard(fn, fileName, id) {
  // KALIBRASI R-DIV-1 (sesi #44, 20 Nov 2026 — hunting perdana Resupply:
  // 5/5 kandidat Medium division-no-guard GUGUR wasit karena guard-nya
  // berbentuk early-return / assignment / else-branch / if-positif,
  // bukan require() — detektor v1 hanya mengenal require(D > 0)).
  // Bentuk guard yang kini dikenali (D = denom, mis. totalSupply):
  //  G1 require(D > 0) / require(D != 0) — bentuk lama.
  //  G2 early-exit: if (D == 0) { ... return|revert ... } SEBELUM pembagian
  //      (juga bentuk tanpa kurawal: if (D == 0) return ...;).
  //  G3 assignment: if (D == 0) { D = <literal bukan-nol>; } SEBELUM pembagian.
  //  G4 cabang positif: pembagian berada di dalam blok if (D > 0)/(D != 0),
  //      atau di dalam blok else dari if (D == 0).
  //  G5 (heuristik lintas-variabel): pembagian oleh denom keluarga-total
  //      di dalam blok else dari if (X == 0) dengan X keluarga-total juga
  //      (mis. convertToShares Resupply: else dari if (_totalSupply == 0)
  //      — vault tak-kosong). BATAS: vault dgn shares>0 tapi assets==0
  //      tetap revert (view-DoS, Low) — tidak ditangkap detektor ini.
  const out = [];
  const TOTAL_FAMILY = "(?:totalShares|totalSupply|totalAssets|totalDebt)";
  // Ekspresi denom: boleh berawalan "_" (alias lokal, mis. _totalSupply)
  // dan boleh berbentuk panggilan (totalSupply()).
  const denomExpr = (d) => "(?:_)?" + d + "(?:\\(\\))?";
  // Cari akhir blok "{...}" yang seimbang mulai dari indeks "{".
  function blockEnd(body, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }
  // Badan pernyataan if: blok "{...}" bila ada, atau sampai ";" bila tanpa kurawal.
  function ifBodyRange(body, condEndIdx) {
    let i = condEndIdx;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === "{") {
      const end = blockEnd(body, i);
      return end === -1 ? null : [i, end];
    }
    const semi = body.indexOf(";", i);
    return semi === -1 ? null : [i, semi];
  }
  for (const denom of DIVISION_DENOMS) {
    const divRe = new RegExp("/\\s*" + denom + "\\b", "g");
    const divs = [];
    let dm;
    while ((dm = divRe.exec(fn.body)) !== null) divs.push(dm.index);
    if (divs.length === 0) continue;
    // G1: require(D > 0) / require(D != 0) di mana saja di badan fungsi
    // (juga bentuk panggilan require(totalSupply() > 0) dan alias _totalSupply).
    const dExpr = denomExpr(denom);
    const guardRe = new RegExp(
      "require\\s*\\(\\s*" + dExpr + "\\s*(>|!=)\\s*0");
    if (guardRe.test(fn.body)) continue;
    let allGuarded = true;
    for (const di of divs) {
      let guarded = false;
      // G2/G3: if (D == 0) ... SEBELUM pembagian.
      const zeroIfRe = new RegExp(
        "if\\s*\\(\\s*" + dExpr + "\\s*==\\s*0\\s*\\)", "g");
      let zm;
      while (!guarded && (zm = zeroIfRe.exec(fn.body)) !== null) {
        if (zm.index > di) break; // if sesudah pembagian bukan guard
        const condEnd = zm.index + zm[0].length;
        const range = ifBodyRange(fn.body, condEnd);
        if (!range) continue;
        const stmt = fn.body.slice(range[0], range[1]);
        // G2: early-exit di dalam badan if.
        if (/\b(return|revert)\b/.test(stmt)) { guarded = true; break; }
        // G3: assignment ke literal bukan-nol di dalam badan if.
        const assignRe = new RegExp(dExpr + "\\s*=\\s*[1-9]");
        if (assignRe.test(stmt)) { guarded = true; break; }
        // G4-else: pembagian di dalam blok else dari if (D == 0) ini.
        // G5: sama, tapi if memakai variabel keluarga-total lain.
        let j = range[1] + 1;
        while (j < fn.body.length && /\s/.test(fn.body[j])) j++;
        if (fn.body.slice(j, j + 4) === "else") {
          let k = j + 4;
          while (k < fn.body.length && /\s/.test(fn.body[k])) k++;
          if (fn.body[k] === "{") {
            const elseEnd = blockEnd(fn.body, k);
            if (elseEnd !== -1 && di > k && di < elseEnd) guarded = true;
          }
        }
      }
      // G4: pembagian di dalam blok if (D > 0) / if (D != 0).
      if (!guarded) {
        const posIfRe = new RegExp(
          "if\\s*\\(\\s*" + dExpr + "\\s*(>|!=)\\s*0\\s*\\)\\s*\\{", "g");
        let pm;
        while (!guarded && (pm = posIfRe.exec(fn.body)) !== null) {
          const openIdx = pm.index + pm[0].length - 1;
          const end = blockEnd(fn.body, openIdx);
          if (end !== -1 && di > openIdx && di < end) guarded = true;
        }
      }
      // G5: pembagian di dalam blok else dari if (X == 0), X keluarga-total.
      if (!guarded) {
        const famIfRe = new RegExp(
          "if\\s*\\(\\s*(?:_)?" + TOTAL_FAMILY + "(?:\\(\\))?\\s*==\\s*0\\s*\\)", "g");
        let fm;
        while (!guarded && (fm = famIfRe.exec(fn.body)) !== null) {
          if (fm.index > di) break;
          const condEnd = fm.index + fm[0].length;
          const range = ifBodyRange(fn.body, condEnd);
          if (!range) continue;
          let j = range[1] + 1;
          while (j < fn.body.length && /\s/.test(fn.body[j])) j++;
          if (fn.body.slice(j, j + 4) !== "else") continue;
          let k = j + 4;
          while (k < fn.body.length && /\s/.test(fn.body[k])) k++;
          if (fn.body[k] !== "{") continue;
          const elseEnd = blockEnd(fn.body, k);
          if (elseEnd !== -1 && di > k && di < elseEnd) guarded = true;
        }
      }
      if (!guarded) { allGuarded = false; break; }
    }
    if (allGuarded) continue;
    out.push(normalizeCandidate({
      id, detector: "division-no-guard",
      title: "Division without a zero guard on " + denom,
      location: { file: fileName, function: fn.name },
      hypothesis: "Function " + fn.name + " divides by " + denom
        + " without require(" + denom + " > 0) — if the denominator is 0, the transaction reverts.",
      preconditions: denom + " can reach 0 (e.g. empty vault / before the first deposit).",
      impact: "DoS on the related function; price/value undefined when the denominator is 0.",
      severityGuess: "Medium",
      evidence: "Pembagian / " + denom + " in function " + fn.name
        + " without a zero guard in the function body.",
      toVerify: ["Check whether " + denom + " can genuinely be 0 via any path",
        "Fork PoC: call while " + denom + " == 0"],
      source: "pattern-scan",
    }));
    break; // satu kandidat divisi per fungsi sudah cukup
  }
  return out;
}

function detectEcrecoverNoZeroCheck(fn, fileName, id) {
  if (!/ecrecover\s*\(/.test(fn.body)) return [];
  if (/address\s*\(\s*0\s*\)/.test(fn.body)) return [];
  return [normalizeCandidate({
    id, detector: "ecrecover-no-zero-check",
    title: "ecrecover result used without an address(0) check",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " uses the ecrecover result without "
      + "require(signer != address(0)) — an invalid signature produces "
      + "address(0) that could pass if the logic compares it.",
    preconditions: "The signature (v/r/s) is invalid / forged.",
    impact: "Forged claim/authorization if address(0) passes the comparison.",
    severityGuess: "Medium",
    evidence: "ecrecover( in function " + fn.name
      + " without any address(0) occurrence in the function body.",
    toVerify: ["Read the signer comparison in " + fn.name,
      "PoC fork: kirim signature sampah (v/r/s acak)"],
    source: "pattern-scan",
  })];
}

function detectTxOrigin(fn, fileName, id) {
  if (!/tx\.origin/.test(fn.body)) return [];
  return [normalizeCandidate({
    id, detector: "tx-origin-auth",
    title: "Authorization uses tx.origin",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " uses tx.origin for authorization — "
      + "an intermediary/phishing contract can call it on the owner's behalf.",
    preconditions: "The owner has previously interacted with the attacker's contract.",
    impact: "Acting on behalf of the owner without the owner's consent, if confirmed.",
    severityGuess: "High",
    evidence: "tx.origin in function " + fn.name + ".",
    toVerify: ["Check the tx.origin usage context in " + fn.name,
      "Fork PoC: an intermediary contract calls this function"],
    source: "pattern-scan",
  })];
}

function detectUncheckedCall(fn, fileName, id) {
  for (let k = 0; k < fn.bodyLines.length; k++) {
    const line = fn.bodyLines[k];
    // Panggilan .call mandiri (tanpa penangkapan return, tanpa require).
    const m = line.match(/^\s*[\w\.\)\]]+\.call\s*[{(]/);
    if (!m) continue;
    const before = line.slice(0, m.index + m[0].indexOf(".call"));
    if (/=/.test(before)) continue; // return ditangkap: (bool ok,) = ...
    if (/require\s*\(/.test(line)) continue;
    return [normalizeCandidate({
      id, detector: "unchecked-call",
      title: "External call result ignored (unchecked call)",
      location: { file: fileName, function: fn.name },
      hypothesis: "Function " + fn.name + " calls .call without checking "
        + "return value, lalu melanjutkan seolah transfer berhasil.",
      preconditions: "Call gagal (mis. penerima revert / gas habis).",
      impact: "State changes as if the transfer succeeded when it failed — wrong accounting.",
      severityGuess: "Medium",
      evidence: "standalone .call at line " + (fn.startLine + k + 1)
        + " without return capture / require.",
      toVerify: ["Read the lines around the call in " + fn.name,
        "Fork PoC: make a call fail, then check the state afterwards"],
      source: "pattern-scan",
    })];
  }
  return [];
}

// Helper kalibrasi review Kiro detektor 18/19 (F12/F13/F3, 17 Nov 2026):
// pecah argumen panggilan pada `(` di openIdx (indeks char `(`) dengan
// hitung paren seimbang — mengembalikan {args: [teks argumen per posisi],
// end: indeks `)` penutup} atau null bila tak seimbang. Dipakai detektor
// 18 (assembly call) + 19 (posisi argumen transfer) supaya pencocokan
// TIDAK melintasi `)` ke call lain dalam statement yang sama (wasit:
// probe membuktikan span lazy `[^;]*?` menelan argumen call kedua).
function splitTopLevelArgs(src, openIdx) {
  let depth = 0, cur = "", args = [];
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0 && ch === "(") { depth = 1; continue; }
      depth++; cur += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0 && ch === ")") { args.push(cur); return { args, end: i }; }
      cur += ch;
    } else if (ch === "," && depth === 1) {
      args.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  return null;
}

// Detektor permissionless-dispatcher (detektor ke-18 — kelas H3 Hyperbridge,
// sesi BB sore 17 Nov 2026: CallDispatcher.dispatch + IntentGatewayV2
// .placeOrder, wasit Medium, PoC-verified Foundry 4/4): fungsi
// external/public TANPA guard akses yang mengeksekusi arbitrary call —
// target + data berasal dari parameter/calldata (bukan hardcoded, bukan
// msg.sender) — atas nama kontrak yang menampung dana user sementara.
// Bentuk persis: `to.call{value: call.value}(call.data)` dengan `to` /
// `call` dari `abi.decode(encoded, (Call[]))`.
// Cakupan v1 (disengaja, dikunci tes): data HARUS arbitrer — `.call{...}("")`
// (hanya kirim ETH, mis. payFee) TIDAK memicu; itu kelas lain
// (permissionless-eth-drain, belum ada detektor). Receiver `msg.sender` /
// `address(this)` / literal alamat dikecualikan. Fungsi view/pure /
// internal/private dilewati; guard dikenali via hasAccessGuard (modifier
// onlyOwner/onlyRole/onlyHandler/restrict/... + require msg.sender).
// KALIBRASI R18.3 (18 Nov 2026): bentuk data kosong juga `new bytes(0)`
// dan `abi.encode()` (kasus Amply _safeTransferETH). KALIBRASI F10
// (18 Nov 2026): one-hop forwarder external -> dispatcher internal
// (detectOneHopDispatcher); F10.1: data selector-pinned (abi.encodeCall
// dkk.) bukan aliran kendali caller di posisi data.
// BATAS DIKETAHUI: tidak memeriksa apakah kontrak memang menampung dana
// (receive/token-in) — pola arbitrary-call tanpa guard saja sudah cukup
// untuk ditandai Medium; wasit yang memutuskan by-design vs kandidat.
// Helper sink detektor permissionless-dispatcher (dipakai D18 langsung +
// F10 one-hop): cari SATU sink arbitrary-call pertama di badan fungsi —
// `.call`/`.delegatecall`/`.functionCall*` ke receiver arbitrer dengan
// data non-kosong, atau sink assembly `call`/`delegatecall`/`callcode`.
// Kembalikan {method, recv, args, viaAssembly} atau null. Aturan
// pengecualian sama persis dengan D18 v1 + kalibrasi R18.1 (F4 receiver
// terindeks, F7 sink OZ, F3 assembly; staticcall dikecualikan).
// KALIBRASI F1 (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
// membuktikan detektor hanya menganalisis sink PERTAMA: dispatcher
// internal dengan sink-1 `gateway.call(data)` + sink-2 `target.call(data)`
// lolos bila forwarder hanya mengoper target caller): semua sink
// dikumpulkan; D18 langsung tetap memakai sink pertama (perilaku sama),
// F10 memakai GABUNGAN parameter target/data dari semua sink.
function findDispatcherSinks(body) {
  const sinks = [];
  // KALIBRASI R18.3b (sesi 18 Nov 2026): argumen dibaca via
  // splitTopLevelArgs (paren seimbang), BUKAN capture lazy `([^;]*?)` —
  // capture lazy berhenti di `)` pertama sehingga `new bytes(0)` hanya
  // tertangkap `new bytes(0` dan lolos dari pengecualian data-kosong.
  const recvSrc = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\]|\\([^)]*\\))*";
  const callRe = new RegExp("(" + recvSrc + ")\\s*\\.\\s*"
    + "(functionCallWithValueAndGas|functionDelegateCallWithGas|functionDelegateCall|functionCallWithValue|functionCall|delegatecall|call)"
    + "\\s*(?:\\{[^}]*\\})?\\s*\\(", "g");
  const recvOk = new RegExp("^(" + recvSrc + ")$");
  let m;
  while ((m = callRe.exec(body)) !== null) {
    const recv = m[1].trim();
    const openIdx = m.index + m[0].length - 1;
    const parsed = splitTopLevelArgs(body, openIdx);
    if (!parsed) continue;
    const args = parsed.args.join(", ").trim();
    if (/^msg\.sender$/.test(recv)) continue;
    if (/^address\s*\(\s*this\s*\)$/.test(recv) || recv === "this") continue;
    if (/^0x[0-9a-fA-F]+$/.test(recv)) continue;
    if (!recvOk.test(recv)) continue;
    // Data harus arbitrer: literal string kosong / bytes kosong = hanya
    // kirim ETH (kelas permissionless-value-send, bukan dispatcher).
    // KALIBRASI R18.3 (sesi 18 Nov 2026 — wasit dari hunting Amply:
    // `_safeTransferETH` memakai `to.call{value: v}(new bytes(0))` —
    // bentuk bytes-kosong yang lolos dari cek `""`): bentuk kosong yang
    // dikenali: `""`, `''`, `0x...`, `new bytes(0)`, `abi.encode()`
    // (tanpa argumen = bytes kosong).
    const argsNorm = args.replace(/\s+/g, "");
    if (argsNorm === "" || argsNorm === '""' || argsNorm === "''") continue;
    if (argsNorm === "newbytes(0)" || argsNorm === "abi.encode()") continue;
    if (/^0x[0-9a-fA-F]*$/.test(args)) continue;
    sinks.push({ method: m[2], recv, args, viaAssembly: false });
  }
  for (const sp of assemblySpans(body)) {
    const asm = body.slice(sp.start, sp.end + 1);
    const asmRe = /\b(call|delegatecall|callcode)\s*\(/g;
    let am;
    while ((am = asmRe.exec(asm)) !== null) {
      const openIdx = asm.indexOf("(", am.index);
      const parsed = splitTopLevelArgs(asm, openIdx);
      if (!parsed || parsed.args.length < 2) continue;
      const target = (parsed.args[1] || "").trim();
      if (!recvOk.test(target)) continue;
      if (/^msg\.sender$/.test(target)) continue;
      if (/^address\s*\(\s*this\s*\)$/.test(target) || target === "this") continue;
      if (/^0x[0-9a-fA-F]+$/.test(target)) continue;
      sinks.push({ method: am[1], recv: target,
        args: parsed.args.slice(2).join(", "), viaAssembly: true });
    }
  }
  return sinks;
}

// Sink PERTAMA (dipakai D18 langsung — perilaku sama seperti sebelum F1).
function findDispatcherSink(body) {
  const sinks = findDispatcherSinks(body);
  return sinks.length > 0 ? sinks[0] : null;
}

function detectPermissionlessDispatcher(fn, fileName, id) {
  if (fn.isConstructor) return [];
  if (/\b(internal|private)\b/.test(fn.signature)) return [];
  if (/\b(view|pure)\b/.test(fn.signature)) return [];
  if (hasAccessGuard(fn)) return [];
  const sink = findDispatcherSink(fn.body);
  if (!sink) return [];
  const mkCandidate = (method, recv, args, viaAssembly) => normalizeCandidate({
    id, detector: "permissionless-dispatcher",
    title: "Arbitrary-call executor without access control (permissionless dispatcher)",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " executes a low-level call "
      + "ke target arbitrer (" + recv + ") with arbitrary data ("
      + args.slice(0, 40) + ") without an access modifier and without "
      + "require(msg.sender == ...) — anyone can call it and "
      + "execute any call with this contract's balance.",
    preconditions: "The contract holds funds (ETH/tokens) — e.g. from "
      + "predispatch / user deposits — when this function is called by the attacker.",
    impact: "Draining of funds stuck in the contract if confirmed "
      + "(Hyperbridge H3 class: 200 USDC of predispatch residue drained via direct dispatch).",
    severityGuess: "Medium",
    evidence: "Low-level call " + method + " in function " + fn.name
      + " — target `" + recv + "`, data `" + args.slice(0, 60)
      + "`, without an access guard in the signature/body"
      + (viaAssembly ? " (via assembly)" : "") + ".",
    toVerify: ["Check modifiers & requires in " + fn.name,
      "check whether this contract really holds user funds temporarily",
      "Fork PoC: call from a random address with a token transfer to itself"],
    source: "pattern-scan",
  });
  return [mkCandidate(sink.method, sink.recv, sink.args, sink.viaAssembly)];
}

// ---------------------------------------------------------------------------
// Kalibrasi R18.4 — dust-by-design (backlog detektor, sesi BB pagi 18 Nov
// 2026: H3 GUGUR di pass SERANG-DULU Opus 5.5): detektor ke-18 memberi
// Medium pada dispatch tanpa guard, TAPI bila proyek mendokumentasikan
// residu dispatcher sebagai dust protokol, korban kehilangan jumlah yang
// sama dgn/tanpa penyerang (precondition self-inflicted + desain dust
// terdokumentasi) — severity realistis Low/by-design, bukan Medium.
// Bukti Hyperbridge: docs `intent-gateway/overview.mdx:162` — "any tokens
// remaining in the `CallDispatcher` are swept back to the gateway and
// collected as dust"; di kode sendiri: IntentsBase `_sweepDust`,
// `event DustCollected`, NatSpec "Sweep accumulated protocol dust".
//
// KALIBRASI R18.4b (kalibrasi wasit atas review Kiro crew, sesi 12:38 WIB
// 18 Nov 2026 — harness H1–H9 9/9 PASS, vonis NEEDS WORK, 14 temuan
// F2–F15; F1 BENAR konservatif, tanpa perbaikan — `withdrawDust` tanpa
// sweep/collect memang bukan sinyal). Aturan R18.4b (tiap perbaikan
// dikunci tes seksi 46):
//  - Prosa HANYA dari komentar/NatSpec (F2: string literal kode bukan
//    dokumentasi) dan teks docs utuh; per KALIMAT, bukan per baris (F3).
//  - Kata konteks diperluas: swept, leftover, remainder, refund, excess*
//    (F4/F5); "left" telanjang DIHAPUS — hanya "left over/in/behind/there"
//    (F12: "shift left by 8" bukan dust).
//  - Negasi ditolak: kalimat berisi not/no/never/cannot/n't/unsupported/
//    disabled/stay/stuck/trapped/locked + identifier berisi
//    Not/Never/Disabled/Unsupported/Cannot (F9).
//  - Baris `import ...;` di-mask sebelum pindai identifier (F8).
//  - Path test/mock/script + file .t.sol + Mock* dikecualikan (F10).
//  - Dedup per snippet; kalimat yang bukti dust-nya hanya dari identifier
//    yang sudah bersinyal tidak dihitung dua kali (F11).
//  - Ikatan (tie) PER SINYAL, bukan per file (F6/F7/F13): terikat bila
//    (a) file yang sama, ATAU (b) file sinyal menyebut NAMA KONTRAK
//    dispatcher kandidat secara eksak (prefix I- opsional —
//    "CallDispatcher" ≠ "BridgeDispatcher"), ATAU (c) konteks sinyal
//    (kalimat/baris) menyebut nama itu atau kata "dispatcher".
//  - Aturan DUA-SUMBER: butuh >=2 sinyal terikat dengan snippet berbeda —
//    satu kata stray tidak boleh menurunkan severity (fungsi ini
//    MENURUNKAN severity, jadi false positive lebih berbahaya daripada
//    false negative). Kandidat TETAP ADA sebagai Low dengan bukti
//    eksplisit — tidak dihapus.
//  - Defensif (F14/F15): default field dulu, severity diubah PALING AKHIR.
// ---------------------------------------------------------------------------
const DUST_CONTEXT_RE = /\b(swept|sweep\w*|collect\w*|remaining|leftover\w*|remainder|refund\w*|excess\w*|residu\w*|surplus|left\s+(over|in|behind|there))\b/i;
const DUST_NEG_RE = /\b(not|no|never|cannot|can't|won't|doesn't|don't|isn't|unsupported|disabled|stay|stuck|trapped|locked)\b/i;
const DUST_ID_NEG_RE = /(not|never|disabled|unsupported|cannot)/i;
const DUST_TEST_PATH_RE = /(^|\/)(test|tests|mocks?|script|scripts)\//i;
const DUST_TEST_FILE_RE = /(^|\/)Mock[^/]*\.sol$|\.t\.sol$/i;

// Normalisasi nama dispatcher: awalan "I" interface dibuang
// ("ICallDispatcher" -> "CallDispatcher") supaya impor dan deklarasi
// kontrak yang sama bisa dicocokkan.
function normDustName(name) {
  return name.replace(/^I(?=[A-Z])/, "");
}

// Nama-nama kontrak dispatcher yang disebut di teks ini (untuk ikatan (b)).
function dispatcherNamesInText(text) {
  const out = new Set();
  const re = /\bI?[A-Z][A-Za-z0-9$]*Dispatcher\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(normDustName(m[0]));
  return out;
}

// Pecah prosa menjadi kalimat (`.`, `!`, `?`, `;` + spasi). Baris
// komentar/docs yang ter-wrap digabung dulu supaya "dust" dan kata
// konteks yang beda baris tetap satu kalimat (F3).
function splitSentences(text) {
  return text.replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.replace(/^\s*\*+\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Satu sinyal dust: {file, kind, snippet, context, dispatcherNames, norm}.
// kind: "identifier" (nama event/fungsi mengandung dust + sweep/collect)
// atau "comment" (kalimat komentar/docs mengandung dust + kata konteks).
// context: baris (identifier) / kalimat (prosa) tempat sinyal — dipakai
// ikatan (c). norm: kunci dedup + hitung dua-sumber.
function findDustSignalsInText(text, fileName, isDocs) {
  const signals = [];
  if (typeof text !== "string" || !text) return signals;
  const dispatcherNames = dispatcherNamesInText(text);
  // (a) Identifier: DustCollected / DustSwept / sweepDust / _sweepDust /
  // collectDust — nama yang mengandung "dust" SEKALIGUS sweep/collect.
  // Baris `import ...;` di-mask dulu (F8) dengan newline dipertahankan
  // supaya nomor baris konteks tetap benar.
  const masked = text.replace(/^[ \t]*import\b[^;]*;/gm,
    (m) => m.replace(/[^\n]/g, " "));
  const idRe = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  const seenIds = new Set();
  const idNames = new Set();
  while ((m = idRe.exec(masked)) !== null) {
    const name = m[1];
    if (!/dust/i.test(name)) continue;
    if (!/(sweep|swept|collect)/i.test(name)) continue;
    if (DUST_ID_NEG_RE.test(name)) continue; // F9: DustSweepNotSupported
    if (seenIds.has(name)) continue;
    seenIds.add(name);
    idNames.add(name);
    const lineStart = masked.lastIndexOf("\n", m.index) + 1;
    const lineEnd = masked.indexOf("\n", m.index);
    const context = masked.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    signals.push({ file: fileName, kind: "identifier",
      snippet: "identifier `" + name + "`", context, dispatcherNames,
      norm: "id:" + name.toLowerCase() });
  }
  // (b) Prosa — HANYA dari komentar (F2) atau teks docs utuh; per
  // kalimat (F3). Kalimat yang bukti dust-nya hanya dari identifier yang
  // sudah bersinyal tidak dihitung dua kali (F11).
  const proseTexts = isDocs ? [text]
    : extractCommentBlocks(text).map((b) => b.text);
  const seenProse = new Set();
  for (const prose of proseTexts) {
    for (let sent of splitSentences(prose)) {
      sent = sent.replace(/^\s*\*+\s*/, "").trim();
      if (!sent) continue;
      let bare = sent;
      for (const name of idNames) bare = bare.split(name).join(" ");
      if (!/\bdust\b/i.test(bare)) continue;
      if (!DUST_CONTEXT_RE.test(bare)) continue;
      if (DUST_NEG_RE.test(bare)) continue; // F9
      const norm = "prose:" + bare.toLowerCase().replace(/\s+/g, " ");
      if (seenProse.has(norm)) continue; // F11
      seenProse.add(norm);
      signals.push({ file: fileName, kind: "comment",
        snippet: "prosa `" + (sent.length > 120 ? sent.slice(0, 117) + "..." : sent) + "`",
        context: sent, dispatcherNames, norm });
    }
  }
  return signals;
}

// Kumpulkan sinyal dust atas seluruh file proyek (+ docs bila ada).
// files: [{name, text}]; docsText: string opsional (teks docs proyek,
// mis. overview.mdx) dengan label docsLabel. File test/mock/script
// dikecualikan (F10).
function collectDustSignals(files, docsText, docsLabel) {
  const out = [];
  for (const f of (files || [])) {
    if (!f || typeof f.text !== "string") continue;
    if (DUST_TEST_PATH_RE.test(f.name) || DUST_TEST_FILE_RE.test(f.name)) continue;
    out.push(...findDustSignalsInText(f.text, f.name, false));
  }
  if (typeof docsText === "string" && docsText.trim()) {
    out.push(...findDustSignalsInText(docsText, docsLabel || "docs", true));
  }
  return out;
}

// Apakah sinyal ini terikat ke dispatcher kandidat? (a) file yang sama,
// (b) file sinyal menyebut nama kontrak dispatcher kandidat secara eksak,
// (c) konteks sinyal menyebut nama itu atau kata "dispatcher".
// candidateNames: nama kontrak dispatcher di file kandidat (ternormalisasi).
function dustSignalTied(signal, fileName, candidateNames) {
  if (signal.file === fileName) return true;
  const ctx = signal.context || "";
  if (/\bdispatcher\b/i.test(ctx)) return true;
  for (const n of (candidateNames || [])) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("\\bI?" + esc + "\\b").test(ctx)) return true;
    if (signal.dispatcherNames && signal.dispatcherNames.has(n)) return true;
  }
  return false;
}

// Terapkan penurunan dust-by-design pada kandidat permissionless-
// dispatcher (D18 langsung + F10 one-hop): Medium -> Low + bukti.
// signals: hasil collectDustSignals; fileName: file kandidat ini;
// candidateNames: nama kontrak dispatcher di file kandidat.
// Syarat: >=2 sinyal terikat dengan snippet berbeda (aturan dua-sumber).
// Mengembalikan jumlah kandidat yang diturunkan.
function applyDustByDesign(candidates, signals, fileName, candidateNames) {
  let n = 0;
  for (const c of candidates) {
    if (c.detector !== "permissionless-dispatcher") continue;
    if (c.severityGuess !== "Medium") continue;
    const tied = (signals || []).filter((s) =>
      dustSignalTied(s, fileName, candidateNames));
    const distinct = [...new Set(tied.map((s) => s.norm))];
    if (distinct.length < 2) continue;
    const shown = [];
    const seenShown = new Set();
    for (const s of tied) {
      if (seenShown.has(s.norm)) continue;
      seenShown.add(s.norm);
      shown.push(s.snippet + " (" + s.file + ")");
      if (shown.length >= 2) break;
    }
    // Defensif (F14/F15): default dulu, severity diubah PALING AKHIR.
    c.evidence = (c.evidence || "") + " [dust-by-design: " + shown.join("; ")
      + " — dispatcher residue is documented as protocol dust; "
      + "severity downgraded Medium → Low. Referee: verify the context "
      + "this dust in the docs/code before closing.]";
    c.impact = (c.impact || "") + " (If dust-by-design is confirmed, the realistic impact is "
      + "= Low/by-design — the victim loses the same amount with/without "
      + "attacker; the Hyperbridge H3 class died for this reason.)";
    c.toVerify = c.toVerify || [];
    c.toVerify.push("Verify the dust-by-design context: read the docs/code "
      + "that documents dispatcher residue as protocol dust");
    c.severityGuess = "Low";
    n++;
  }
  return n;
}

// Nama parameter fungsi, URUT sesuai deklarasi (null bila parameter tanpa
// nama). `Type [location] [name]`: nama = token terakhir, KECUALI bila
// token terakhir adalah kata lokasi (memory/calldata/storage) atau hanya
// ada satu token (tipe saja) — keduanya berarti parameter tak bernama.
// Dipakai F10 untuk memetakan posisi argumen forwarder -> parameter
// dispatcher internal.
function paramNamesOf(fn) {
  const raw = functionParams(fn);
  if (!raw.trim()) return [];
  const parsed = splitTopLevelArgs("(" + raw + ")", 0);
  if (!parsed) return [];
  return parsed.args.map((seg) => {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) return null;
    const last = toks[toks.length - 1];
    if (/^(memory|calldata|storage)$/.test(last)) return null;
    if (toks.length === 1) return null;
    return last.replace(/[,;]+$/, "");
  });
}

// Apakah ekspresi memakai identifier apa pun dari himpunan `controlled`
// (batas kata — `calls2` BUKAN `calls`).
function exprUsesControlled(expr, controlled) {
  for (const name of controlled) {
    if (new RegExp("\\b" + name + "\\b").test(expr)) return true;
  }
  return false;
}

// Alias lokal dari parameter: nama yang di-assign dari ekspresi yang
// memakai nama controlled (`uint256 x = calls;`, `x = calls;`, alias dari
// alias — fixpoint maks 3 pass). Penugasan member (`a.b = ...`) dan
// perbandingan (`==`) sengaja tidak dihitung.
function collectControlledAliases(body, paramNames) {
  const controlled = new Set(paramNames);
  const assignRe = /(?:^|[;{}])\s*(?:[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*(?:\s+(?:memory|calldata|storage))?\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)([^;]{0,300});/g;
  // KALIBRASI F2 (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
  // membuktikan struct yang diisi per-field lolos: `c.to = to; c.data
  // = data; _exec(c);` — `c` tidak tertangkap sebagai alias karena
  // penugasan member tidak cocok pola `name = ...`): penugasan ke
  // member/indeks (`c.field = ...`, `c[k].field = ...`) menandai
  // identifier AKAR sebagai controlled bila RHS memakai nama controlled.
  const memberAssignRe = /(?:^|[;{}])\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]|\.[A-Za-z_$][\w$]*)+\s*=(?!=)([^;]{0,300});/g;
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    let m;
    assignRe.lastIndex = 0;
    while ((m = assignRe.exec(body)) !== null) {
      const lhs = m[1], rhs = m[2];
      if (controlled.has(lhs)) continue;
      if (exprUsesControlled(rhs, controlled)) { controlled.add(lhs); added = true; }
    }
    memberAssignRe.lastIndex = 0;
    while ((m = memberAssignRe.exec(body)) !== null) {
      const root = m[1], rhs = m[2];
      if (controlled.has(root)) continue;
      if (exprUsesControlled(rhs, controlled)) { controlled.add(root); added = true; }
    }
    if (!added) break;
  }
  return controlled;
}

// Apakah ekspresi data ini SELECTOR-PINNED — selector-nya tetap di
// compile-time sehingga data BUKAN bytes arbitrer penuh, melainkan
// pemanggilan SATU fungsi yang sudah ditentukan:
// - `abi.encodeCall(Contract.fn, (...))` — selector = fn itu;
// - `abi.encodeWithSignature("literal(...)", ...)` — string literal;
// - `abi.encodeWithSelector(X.fn.selector, ...)` — selector konstanta.
// Selector dari variabel (`abi.encodeWithSelector(sel, ...)`) TIDAK
// pinned. Dipakai F10.1: data pinned tidak dihitung sebagai aliran
// kendali caller di posisi data (kasus Hyperbridge fillOrder /
// cancelOrder -> _delegate: target modul tetap + selector fillOrder
// tetap = forwarder terbatas by-design, bukan dispatcher arbitrer).
// Target yang kendali caller TETAP memicu (diperiksa terpisah) — mis.
// `to.call(abi.encodeCall(IToken.transfer, ...))` dengan `to` pilihan
// caller tetap bentuk drain.
function isSelectorPinnedData(arg) {
  const t = arg.trim();
  if (/^abi\.encodeCall\s*\(/.test(t)) return true;
  if (/^abi\.encodeWithSignature\s*\(\s*"/.test(t)) return true;
  if (/^abi\.encodeWithSelector\s*\(/.test(t)
    || /^abi\.encodePacked\s*\(/.test(t)
    || /^bytes\.concat\s*\(/.test(t)) {
    // KALIBRASI F6 (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
    // membuktikan `abi.encodePacked(selector, ...)` / `bytes.concat(
    // selector, ...)` tidak dikenali sebagai pinned): ketiga bentuk ini
    // pinned HANYA bila argumen pertama adalah selector konstanta
    // (`.selector` / literal 4 byte / `bytes4(0x...)`); argumen pertama
    // variabel = tidak pinned. `abi.encode(...)` (tanpa selector)
    // SENGAJA tidak masuk — bytes hasil encode tanpa selector bukan
    // pemanggilan satu fungsi yang ditentukan.
    const openIdx = t.indexOf("(");
    const parsed = splitTopLevelArgs(t, openIdx);
    if (parsed && parsed.args.length > 0) {
      const first = parsed.args[0].trim();
      if (/\.selector\b/.test(first)) return true;
      if (/^bytes4\s*\(\s*0x[0-9a-fA-F]+\s*\)$/.test(first)) return true;
      if (/^0x[0-9a-fA-F]{8}$/.test(first)) return true;
    }
  }
  return false;
}

// Detektor one-hop forwarder (kalibrasi F10, residual review Kiro 17 Nov
// 2026 — kasus (e): "internal dispatcher + external forwarder lolos"):
// fungsi external/public TANPA guard yang meneruskan argumen kendali
// caller ke fungsi internal/private yang berisi sink arbitrary-call
// (findDispatcherSink). Satu hop, SATU FILE saja.
// Aturan presisi (posisi argumen): parameter dispatcher internal yang
// dipakai sebagai receiver sink (targetParams) atau sebagai data sink
// (dataParams) dipetakan ke posisi argumen pemanggilan; flag HANYA bila
// argumen pada posisi itu memakai identifier kendali caller (parameter
// forwarder atau alias lokalnya). Argumen tetap (literal / address(this) /
// msg.sender) di posisi target/data TIDAK memicu; argumen kendali caller
// HANYA di posisi lain (mis. fee) juga TIDAK memicu.
// Dikecualikan: forwarder ber-guard, dispatcher internal ber-guard,
// forwarder yang sudah ter-flag D18 langsung, pemanggilan named-args
// (`f({a: x})` — batas diketahui), rantai dua hop, dispatcher lintas
// file (butuh project-pass — batas diketahui).
function detectOneHopDispatcher(fns, fileName, startId, flaggedFns) {
  const out = [];
  let n = startId;
  // 1. Kumpulkan dispatcher internal: fungsi internal/private tanpa
  //    guard yang badannya mengandung sink arbitrary-call.
  // KALIBRASI F1/F3 (review Kiro F10, sesi 18 Nov 2026 — wasit: probe
  // membuktikan (F1) hanya sink pertama dianalisis + (F3) overload nama
  // sama runtuh jadi satu record di Map): dispatcher disimpan sebagai
  // DAFTAR record per nama; tiap record menggabungkan parameter
  // target/data dari SEMUA sink di badannya; pemanggilan dicocokkan
  // berdasarkan ARITY (jumlah argumen == jumlah parameter) supaya
  // overload yang berbeda tidak saling menutupi.
  const dispatchers = new Map();
  for (const fn of fns) {
    if (fn.isConstructor) continue;
    if (!/\b(internal|private)\b/.test(fn.signature)) continue;
    if (/\b(view|pure)\b/.test(fn.signature)) continue;
    if (hasAccessGuard(fn)) continue;
    const sinks = findDispatcherSinks(fn.body);
    if (sinks.length === 0) continue;
    const paramOrder = paramNamesOf(fn);
    const targetParams = new Set();
    const dataParams = new Set();
    for (const sink of sinks) {
      for (const pname of paramOrder) {
        if (!pname) continue;
        if (new RegExp("\\b" + pname + "\\b").test(sink.recv)) targetParams.add(pname);
        if (new RegExp("\\b" + pname + "\\b").test(sink.args)) dataParams.add(pname);
      }
    }
    // Sink yang receiver + datanya TIDAK memakai parameter apa pun
    // (target/data tetap di dalam dispatcher) tak bisa dialiri caller —
    // bukan dispatcher yang bisa di-forward.
    if (targetParams.size === 0 && dataParams.size === 0) continue;
    const rec = { fn, sink: sinks[0], sinks, paramOrder, targetParams, dataParams };
    if (!dispatchers.has(fn.name)) dispatchers.set(fn.name, []);
    dispatchers.get(fn.name).push(rec);
  }
  if (dispatchers.size === 0) return [];
  // 2. Cari forwarder: external/public tanpa guard yang memanggil
  //    dispatcher internal dengan argumen kendali caller di posisi
  //    target/data.
  for (const fn of fns) {
    if (fn.isConstructor) continue;
    if (/\b(internal|private)\b/.test(fn.signature)) continue;
    if (/\b(view|pure)\b/.test(fn.signature)) continue;
    if (hasAccessGuard(fn)) continue;
    if (flaggedFns && flaggedFns.has(fn.name)) continue;
    const params = paramNamesOf(fn).filter(Boolean);
    if (params.length === 0) continue;
    const controlled = collectControlledAliases(fn.body, params);
    for (const [dName, recs] of dispatchers) {
      const callRe = new RegExp("\\b" + dName + "\\s*\\(", "g");
      let m;
      let flagged = false;
      while (!flagged && (m = callRe.exec(fn.body)) !== null) {
        const openIdx = fn.body.indexOf("(", m.index);
        const parsed = splitTopLevelArgs(fn.body, openIdx);
        if (!parsed) continue;
        const args = parsed.args;
        // KALIBRASI F3: hanya record overload yang ARITY-nya cocok
        // (jumlah argumen pemanggilan == jumlah parameter dispatcher)
        // yang diperiksa; overload lain diabaikan untuk pemanggilan ini.
        const matches = recs.filter((r) => r.paramOrder.length === args.length);
        if (matches.length === 0) continue;
        const d = matches[0];
        // Named args (`f({target: x, data: y})` atau `f(target: x, ...)`) —
        // batas diketahui, dilewati.
        if (args.some((a) => {
          const t = a.trim();
          return /^\s*[A-Za-z_$][\w$]*\s*:/.test(t)
            || /^\{\s*[A-Za-z_$][\w$]*\s*:/.test(t);
        })) continue;
        for (let i = 0; i < args.length && i < d.paramOrder.length; i++) {
          const pname = d.paramOrder[i];
          if (!pname) continue;
          if (!d.targetParams.has(pname) && !d.dataParams.has(pname)) continue;
          // KALIBRASI F10.1 (sesi 18 Nov 2026 — wasit dari hunting
          // Hyperbridge): data selector-pinned (abi.encodeCall /
          // encodeWithSignature literal / encodeWithSelector .selector)
          // BUKAN data arbitrer — jangan hitung sebagai aliran kendali
          // caller di posisi data SAJA. Bila parameter yang sama juga
          // dipakai sebagai target sink, posisi target tetap diperiksa
          // (target kendali caller + data pinned tetap memicu).
          if (d.dataParams.has(pname) && !d.targetParams.has(pname)
            && isSelectorPinnedData(args[i])) continue;
          if (!exprUsesControlled(args[i], controlled)) continue;
          out.push(normalizeCandidate({
            id: "FA-" + String(n).padStart(3, "0"),
            detector: "permissionless-dispatcher",
            title: "Arbitrary-call executor without access control (permissionless dispatcher, one-hop forwarder)",
            location: { file: fileName, function: fn.name },
            hypothesis: "Function " + fn.name + " meneruskan argumen kendali caller "
              + "ke dispatcher internal " + dName + " (sink: " + d.sink.method
              + " ke `" + d.sink.recv + "` with data `" + d.sink.args.slice(0, 40)
              + "`) — anyone can call " + fn.name + " and executes "
              + "any call with this contract's balance in one hop.",
            preconditions: "The contract holds funds (ETH/tokens) when this function is called by an attacker; "
              + dName + " has no guard of its own.",
            impact: "Draining of funds stuck in the contract if confirmed "
              + "(kelas H3 Hyperbridge, varian forwarder).",
            severityGuess: "Medium",
            evidence: "One-hop: `" + fn.name + "` -> `" + dName + "` — positional argument #"
              + (i + 1) + " (`" + args[i].trim().slice(0, 40) + "`) uses a caller parameter and "
              + "mengalir ke parameter `" + pname + "` dispatcher (used as "
              + (d.targetParams.has(pname) ? "target" : "") + (d.targetParams.has(pname) && d.dataParams.has(pname) ? "/" : "")
              + (d.dataParams.has(pname) ? "data" : "") + " sink), without an access guard in "
              + fn.name + ".",
            toVerify: ["Check modifiers & requires in " + fn.name + " and " + dName,
              "check whether this contract really holds user funds temporarily",
              "PoC fork: panggil " + fn.name + " from a random address with a token transfer to itself"],
            source: "pattern-scan",
          }));
          n++;
          flagged = true;
          break;
        }
      }
    }
  }
  return out;
}

// Helper detektor full-balance-sweep: apakah ekspresi ini mengukur SALDO
// PENUH sebuah kontrak perantara — `balanceOf(<src>)` / `address(<src>)`
// .balance — dengan <src> BUKAN msg.sender / address(this) (saldo sendiri
// = rescue/withdraw-all by-design, dikecualikan). Saldo sendiri dicek
// bentuk eksak dulu lalu DIHAPUS dari teks — argumen balanceOf bisa
// mengandung paren bersarang (`balanceOf(address(this))`), jadi tangkap
// `[^)]*` saja akan memotong `address(this` dan lolos dari pengecualian.
// Identifier yang TERBUKTI address-typed di scope fungsi ini — dipakai
// R19.2 untuk mengenali `ident.balance` polos tanpa salah-flag field
// struct (`info.balance`). Sumber: (1) state var address-typed di file
// ini (ctx.addressStateVars, dihitung runPipeline), (2) parameter fungsi
// bertipe address/kontrak, (3) deklarasi lokal bertipe address/kontrak
// di badan fungsi (signature ikut terpindai — param tertangkap juga di
// sini, hasilnya sama). `msg.sender` / `this` / `tx.origin` TIDAK PERNAH
// masuk set ini (bukan identifier deklarasi). R19.4: tipe kontrak dari
// file lain (import) kini dikenali bila didefinisikan di korpus proyek
// (opts.projectContractTypeNames) atau bernama interface standar ERC
// (allowlist di isAddressTypeName); single-file tanpa definisi itu
// tetap konservatif 0 (kecuali allowlist).
function collectAddressTypedIdents(fn, ctx) {
  const out = new Set();
  if (!ctx) return out;
  const cts = ctx.contractTypeNames || new Set();
  const sts = ctx.structNames || new Set();
  if (ctx.addressStateVars) for (const n of ctx.addressStateVars) out.add(n);
  const params = functionParams(fn);
  const parsedParams = params ? splitTopLevelArgs("(" + params + ")", 0) : null;
  const paramParts = parsedParams ? parsedParams.args : [];
  for (const part of paramParts) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) continue;
    const name = toks[toks.length - 1];
    if (/^(calldata|memory|storage)$/.test(name)) continue; // tanpa nama
    let type = toks[0];
    if (type === "address" && toks[1] === "payable") type = "address payable";
    if (isAddressTypeName(type, cts, sts)) out.add(name);
  }
  const body = fn.body || "";
  const LOC = /^(calldata|memory|storage)$/;
  const addrRe = /\baddress\s+(?:payable\s+)?([A-Za-z_$][\w$]*)\s*(?=[=;,)])/g;
  let dm;
  while ((dm = addrRe.exec(body)) !== null) {
    if (!LOC.test(dm[1])) out.add(dm[1]);
  }
  for (const tname of cts) {
    const re = new RegExp("\\b" + tname.replace(/\$/g, "\\$") + "\\s+([A-Za-z_$][\\w$]*)\\s*(?=[=;,)])", "g");
    let cm;
    while ((cm = re.exec(body)) !== null) {
      if (!LOC.test(cm[1])) out.add(cm[1]);
    }
  }
  // R19.2a (wasit lokal sesi #28 — FP A18 TERBUKTI): deklarasi param/
  // lokal bertipe NON-address dengan nama yang sama MENUTUPI state var
  // address-typed (`Info pool` lokal menutupi `address pool` state var —
  // `pool.balance` di badan merujuk ke struct, bukan ke alamat).
  // Kumpulkan nama yang dibayangi, lalu hapus dari set. Pindai string
  // literal di-mask dulu (pesan error bisa mengandung `<Tipe> <nama>`).
  const shadowed = new Set();
  for (const part of paramParts) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) continue;
    const name = toks[toks.length - 1];
    if (/^(calldata|memory|storage)$/.test(name)) continue;
    let type = toks[0];
    if (type === "address" && toks[1] === "payable") type = "address payable";
    if (!isAddressTypeName(type, cts, sts)) shadowed.add(name);
  }
  const bodyNoStr = maskStringLiterals(body);
  const declRe = /\b([A-Za-z_$][\w$]*)(?:\s+payable)?\s+(?:(?:memory|calldata|storage)\s+)?([A-Za-z_$][\w$]*)\s*(?=[=;,)])/g;
  let dd;
  while ((dd = declRe.exec(bodyNoStr)) !== null) {
    const tname = dd[1];
    const dname = dd[2];
    // `return X;` / `delete X;` BUKAN deklarasi — kata kunci statement
    // jangan membayangi (probe wasit: `return pool;` sempat menghapus
    // state var dari set).
    if (tname === "return" || tname === "delete") continue;
    // R19.3: `fn.body` ikut memuat signature — `address[] calldata
    // addrs` di sana membuat declRe salah baca `calldata addrs` sebagai
    // deklarasi bertipe `calldata`. Lokasi data BUKAN tipe — lewati,
    // kalau tidak param array address ikut membayangi dirinya sendiri.
    if (tname === "calldata" || tname === "memory" || tname === "storage") continue;
    if (/^(calldata|memory|storage|payable)$/.test(dname)) continue;
    if (tname === "address" || isAddressTypeName(tname, cts, sts)) continue;
    shadowed.add(dname);
  }
  for (const n of shadowed) out.delete(n);
  // R19.5a (sesi #34, 19 Nov 2026 — kalibrasi wasit atas review Kiro Opus 5.5
  // sesi 9bff4797, vonis NEEDS WORK; tiap klaim diverifikasi probe ke kode
  // ASLI + solc 0.8.20 — lihat docs/kiro-crew-review-2026-11-19-r19-5a.md):
  // bukti tipe dari ASSIGNMENT: (a) cast `x = T(...)` dengan T ∈
  // {payable, address} SAJA — lengan tipe-kontrak DIHAPUS (F6 TERBUKTI via
  // solc: multi-deklarasi `address a, b;` INVALID + `.balance` pada var
  // bertipe kontrak INVALID sejak 0.5, jadi lengan itu hanya bisa
  // men-flag kode tak-valid atau FP seperti F1; `address x = IVault(a)`
  // juga INVALID — konversi implisit kontrak->address tidak ada);
  // (b) `x = y` dengan y sudah terbukti address-typed. F1: cast harus
  // menjadi KESELURUHAN RHS — `T(v).method()` bukan cast (cek kurung
  // seimbang + terminator `;`/`,`/`)` sesudahnya). F2: assignment ke MEMBER
  // (`s.x`, spasi/baris-baru antara `.` dan nama diizinkan Solidity)
  // tidak menambah nama — jalan-mundur lewati whitespace sebelum LHS.
  // F3: unwrap self-alias diperlebar (payable/address + uint/int/bytes +
  // tipe kontrak cts/allowlist + grup `(...)`, max 6 lapis) — menutup
  // `payable(address(uint160(address(this))))`. F4: fixpoint 4 -> 8 iterasi
  // (rantai terbalik sedalam 8). F5 TIDAK DIPERBAIKI (ternary `x = c ? T(a)
  // : b` tetap 0 — FN konservatif, diterima untuk detektor Low).
  // Diterapkan SETELAH penghapusan shadow. Pola regex DATAR (pelajaran F5
  // sesi #33: tanpa grup bersarang berulang).
  const assignEvRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([A-Za-z_$][\w$]*)/g;
  const evMatches = [];
  let em;
  while ((em = assignEvRe.exec(bodyNoStr)) !== null) {
    // R19.5a: izinkan match TUMPANG-TINDIH — chained assignment
    // `a = b = T(...)` menelan taut kedua bila scan melompat utuh.
    // Rewind di AWAL iterasi supaya match yang di-skip F2 pun tidak
    // menyembunyikan taut di dalamnya (`s.x = y = payable(a)`).
    assignEvRe.lastIndex = em.index + 1;
    // R19.5a/F2: lewati assignment ke member — karakter non-spasi sebelum
    // LHS adalah `.` (`s.x`, `s . x`, `s.` + baris-baru + `x`).
    let k = em.index - 1;
    while (k >= 0 && /\s/.test(bodyNoStr[k])) k--;
    if (bodyNoStr[k] === ".") continue;
    evMatches.push({ lhs: em[1], rhs: em[2], end: em.index + em[0].length });
  }
  const nextNonSpace = (i) => {
    let j = i;
    while (j < bodyNoStr.length && /\s/.test(bodyNoStr[j])) j++;
    return j;
  };
  // R19.5a: terminator RHS polos — `;`/`,`/`)`/akhir string, atau `=` tunggal
  // (chained assignment `x = y = ...`; `==` perbandingan DITOLAK — `x = y`
  // dalam `x = (y == z)` meng-assign bool, bukan address).
  const isRhsTerminator = (idx) => {
    const c = bodyNoStr[idx];
    if (c === ";" || c === "," || c === ")" || c === undefined) return true;
    if (c === "=" && bodyNoStr[idx + 1] !== "=") return true;
    return false;
  };
  // R19.5a/F1: indeks tepat sesudah `)` penutup panggilan cast (kurung
  // seimbang; string literal sudah di-mask) — -1 bila tak tertutup.
  const matchingParenEnd = (openIdx) => {
    let depth = 0;
    for (let j = openIdx; j < bodyNoStr.length; j++) {
      const ch = bodyNoStr[j];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  };
  // Argumen cast adalah `this` / `msg.sender` (unwrap max 6 lapis:
  // `payable(`/`address(`/`uint160(`/`IVault(`/grup `(...)`) → alias saldo
  // sendiri, jangan tambah. Nama lain (mis. `foo(`) TIDAK di-unwrap —
  // konservatif: hasil panggilan fungsi bukan terbukti self.
  const castArgIsSelf = (openIdx) => {
    let s = bodyNoStr.slice(openIdx + 1);
    for (let k = 0; k < 6; k++) {
      const mm = s.match(/^\s*(?:\(\s*|([A-Za-z_$][\w$]*)\s*\()/);
      if (!mm) break;
      if (mm[1] === undefined) { s = s.slice(mm[0].length); continue; }
      const name = mm[1];
      if (name === "payable" || name === "address"
        || /^(u?int\d*|bytes\d*)$/.test(name)
        || isAddressTypeName(name, cts, sts)) {
        s = s.slice(mm[0].length);
      } else break;
    }
    return /^\s*(?:this\b|msg\.sender\b)/.test(s);
  };
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const ev of evMatches) {
      if (out.has(ev.lhs)) continue;
      const openIdx = nextNonSpace(ev.end);
      const after = bodyNoStr[openIdx];
      if (after === "("
        && (ev.rhs === "payable" || ev.rhs === "address")) {
        // R19.5a/F1: cast utuh — terminator sesudah `)` penutup.
        const closeEnd = matchingParenEnd(openIdx);
        const termIdx = closeEnd === -1 ? -1 : nextNonSpace(closeEnd);
        const term = closeEnd === -1 ? "" : bodyNoStr[termIdx];
        if (closeEnd !== -1
          && (term === ";" || term === "," || term === ")" || term === undefined)
          && !castArgIsSelf(openIdx)) {
          out.add(ev.lhs); changed = true;
        }
      } else if (isRhsTerminator(openIdx) && out.has(ev.rhs)) {
        out.add(ev.lhs); changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function isFullBalanceExpr(expr, addressIdents, indexedBases) {
  if (!expr) return false;
  const rest = expr
    .replace(/\.balanceOf\s*\(\s*address\s*\(\s*this\s*\)\s*\)/g, "")
    .replace(/\.balanceOf\s*\(\s*msg\.sender\s*\)/g, "")
    .replace(/address\s*\(\s*this\s*\)\s*\.balance\b/g, "")
    .replace(/address\s*\(\s*msg\.sender\s*\)\s*\.balance\b/g, "")
    .replace(/payable\s*\(\s*this\s*\)\s*\.balance\b/g, "")
    .replace(/payable\s*\(\s*msg\.sender\s*\)\s*\.balance\b/g, "");
  if (/\.balanceOf\s*\(/.test(rest)) return true;
  // KALIBRASI F16-lite (review Kiro 17 Nov 2026): `payable(X).balance`
  // dikenali seperti `address(X).balance`.
  if (/(?:address|payable)\s*\(\s*[\w$.]+\s*\)\s*\.balance\b/.test(rest)) return true;
  // R19.2 (sesi 04:38 WIB 18 Nov 2026): `ident.balance` POLOS — hanya
  // bila ident TERBUKTI address-typed (lihat collectAddressTypedIdents);
  // field struct (`info.balance`) dan saldo sendiri (`msg.sender` /
  // `this` — tak pernah masuk set) tetap TIDAK dihitung.
  if (addressIdents && addressIdents.size > 0) {
    const balRe = /\b([A-Za-z_$][\w$]*)\.balance\b/g;
    let bm;
    while ((bm = balRe.exec(rest)) !== null) {
      if (addressIdents.has(bm[1])) return true;
    }
  }
  // R19.3 (sesi 08:38 WIB 18 Nov 2026 — residual A16 TERBUKTI):
  // `BASE[i].balance` — akses terindeks ke elemen address-typed
  // (`address[]`, `mapping(K => address)`, `IContract[]` — lihat
  // collectIndexedAddressBases). Guard `(?<!\.)`: `x.pools[0].balance`
  // (field struct/kontrak lain) BUKAN base yang sama; field struct
  // (`infos[u].balance`, elemen Info) tetap 0 karena base-nya tak masuk
  // set — elemen struct/uint BUKAN address-typed.
  if (indexedBases && indexedBases.size > 0) {
    for (const base of indexedBases) {
      const idxRe = new RegExp("(?<!\\.)\\b" + base.replace(/\$/g, "\\$")
        + "\\s*(?:\\[[^\\]]*\\])+\\s*\\.balance\\b");
      if (idxRe.test(rest)) return true;
    }
  }
  return false;
}

// R19.3 (sesi 08:38 WIB 18 Nov 2026 — residual A16): kumpulkan base
// identifier yang elemen terindeksnya TERBUKTI address-typed —
// `address[]`, `IContract[]`, `mapping(K => address|IContract)` sebagai
// state var (via ctx.indexedAddressStateBases, dipindai runPipeline),
// param, atau lokal. Deklarasi senama bertipe NON-address (plain maupun
// array, mis. lokal `uint256[] pools` / `Info pools`) MENUTUPI base
// (prinsip sama seperti R19.2a) — base itu dihapus dari set.
function collectIndexedAddressBases(fn, ctx) {
  const out = new Set();
  if (!ctx) return out;
  const cts = ctx.contractTypeNames || new Set();
  const sts = ctx.structNames || new Set();
  const elemIsAddress = (elem) => {
    if (!elem) return false;
    // R19.4: satu jalur penilaian tipe elemen — isAddressTypeName sudah
    // mencakup address / struct-guard / allowlist interface / kontrak
    // korpus; elem sudah terlucuti kurung siku oleh elemOf.
    return isAddressTypeName(String(elem).replace(/\s+/g, " ").trim(), cts, sts);
  };
  const elemOf = (type) => {
    if (!type) return "";
    const m = String(type).match(/^([A-Za-z_$][\w$]*(?:\s+payable)?)((?:\s*\[[^\]]*\])+)$/);
    return m ? m[1].trim() : "";
  };
  if (ctx.indexedAddressStateBases) for (const n of ctx.indexedAddressStateBases) out.add(n);
  const params = functionParams(fn);
  const parsedParams = params ? splitTopLevelArgs("(" + params + ")", 0) : null;
  const paramParts = parsedParams ? parsedParams.args : [];
  const shadowed = new Set();
  for (const part of paramParts) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) continue;
    const name = toks[toks.length - 1];
    if (/^(calldata|memory|storage)$/.test(name)) continue;
    const elem = elemOf(toks[0]);
    if (elem) {
      if (elemIsAddress(elem)) out.add(name);
      else shadowed.add(name);
    } else if (!isAddressTypeName(toks[0], cts, sts)) {
      shadowed.add(name);
    }
  }
  const body = fn.body || "";
  const bodyNoStr = maskStringLiterals(body);
  // Deklarasi lokal array: `Tipe[] [memory] nama = ...;`
  const arrDeclRe = /\b([A-Za-z_$][\w$]*)(?:\s+payable)?\s*((?:\[\s*\d*\s*\])+)\s+(?:(?:memory|calldata|storage)\s+)?([A-Za-z_$][\w$]*)\s*(?=[=;,)])/g;
  let ad;
  while ((ad = arrDeclRe.exec(bodyNoStr)) !== null) {
    // `ad[1]` = tipe dasar; `payable` (bila ada) tertelan grup
    // non-capturing — cek kata-utuh di match (nama tak mungkin persis
    // `payable`, dan `\bpayable\b` tak cocok `payablePool`).
    const elem = ad[1] + (/\bpayable\b/.test(ad[0]) ? " payable" : "");
    if (elemIsAddress(elem)) out.add(ad[3]);
    else shadowed.add(ad[3]);
  }
  // Deklarasi lokal plain senama (R19.2a): `uint256 pools;` menutupi
  // state var `address[] pools` — pakai pola yang sama (return/delete
  // bukan deklarasi).
  const declRe = /\b([A-Za-z_$][\w$]*)(?:\s+payable)?\s+(?:(?:memory|calldata|storage)\s+)?([A-Za-z_$][\w$]*)\s*(?=[=;,)])/g;
  let dd;
  while ((dd = declRe.exec(bodyNoStr)) !== null) {
    const tname = dd[1], dname = dd[2];
    if (tname === "return" || tname === "delete") continue;
    // R19.3: sama seperti di collectAddressTypedIdents — `fn.body`
    // memuat signature, jadi `calldata`/`memory`/`storage` sebagai
    // "tipe" adalah salah-baca atas deklarasi array, bukan deklarasi.
    if (tname === "calldata" || tname === "memory" || tname === "storage") continue;
    if (/^(calldata|memory|storage|payable)$/.test(dname)) continue;
    if (tname === "address" || isAddressTypeName(tname, cts, sts)) continue;
    shadowed.add(dname);
  }
  for (const n of shadowed) out.delete(n);
  return out;
}

// R19.3 (sesi 08:38 WIB 18 Nov 2026 — penunjang A16, level file):
// pindai deklarasi state var array/mapping yang elemennya address-typed
// — `address[] pools`, `IEscrow[] escrows`, `mapping(K => address)
// pools`. Field struct dikecualikan (bukan state var); mapping bersarang
// (`mapping(K => mapping(...))`) tidak cocok — nilai pertamanya mapping,
// bukan address (konservatif).
function scanIndexedAddressStateBases(clean, contractTypeNames, structNames) {
  const out = new Set();
  if (!clean) return out;
  const cts = contractTypeNames || new Set();
  const sts = structNames || new Set();
  const elemIsAddress = (elem) => {
    if (!elem) return false;
    // R19.4: satu jalur penilaian tipe elemen (lihat collectIndexedAddressBases).
    return isAddressTypeName(String(elem).replace(/\s+/g, " ").trim(), cts, sts);
  };
  const src = maskStringLiterals(clean);
  const structSpans = findBlockSpans(src, "struct");
  const inStruct = (idx) => structSpans.some((s) => idx >= s.start && idx <= s.end);
  const typeAlt = "(address(?:\\s+payable)?|[A-Za-z_$][\\w$]*)";
  // Array: `address[] public pools;` / `IEscrow[5] private escrows;`
  const arrRe = new RegExp("\\b" + typeAlt + "\\s*((?:\\[\\s*\\d*\\s*\\])+)\\s+"
    + "(?:(?:public|private|internal|constant|immutable|override)\\s+)*"
    + "([A-Za-z_$][\\w$]*)\\s*(?:=[^;]*)?;", "g");
  let m;
  while ((m = arrRe.exec(src)) !== null) {
    if (inStruct(m.index)) continue;
    if (elemIsAddress(m[1])) out.add(m[3]);
  }
  // Mapping: `mapping(uint256 => address) public pools;`
  const mapRe = new RegExp("\\bmapping\\s*\\(\\s*[^=]*?=>\\s*" + typeAlt
    + "\\s*\\)\\s+(?:(?:public|private|internal|constant|immutable|override)\\s+)*"
    + "([A-Za-z_$][\\w$]*)\\s*(?:=[^;]*)?;", "g");
  while ((m = mapRe.exec(src)) !== null) {
    if (inStruct(m.index)) continue;
    if (elemIsAddress(m[1])) out.add(m[2]);
  }
  return out;
}

// Detektor full-balance-sweep (detektor ke-19 — kelas H3b Hyperbridge,
// sesi BB sore 17 Nov 2026: IntentGatewayV2.placeOrder, wasit Low):
// transfer/call yang memakai SALDO PENUH sebuah kontrak perantara sebagai
// jumlah, bukan jumlah yang dideklarasikan di order — residu (mis. sisa
// predispatch yang tak terpakai) ikut tersapu ke escrow alih-alih
// dikembalikan ke user. Bentuk persis:
//   `uint256 balance = IERC20(token).balanceOf(dispatcher);`
//   `... transfer(..., balance)` / `Call({..., value: balance, ...})`.
// Jumlah yang dideklarasikan (parameter/field order) TIDAK memicu; sweep
// saldo sendiri (balanceOf(address(this)) / address(this).balance) TIDAK
// memicu (rescue by-design). Severity Low — sweep saja sering by-design
// (dust collection); ia berbahaya bila digabung eksekutor tanpa guard
// (detektor ke-18).
// Detektor full-balance-sweep (detektor ke-19 — kelas H3b Hyperbridge,
// sesi BB sore 17 Nov 2026: IntentGatewayV2.placeOrder, wasit Low):
// transfer/call yang memakai SALDO PENUH sebuah kontrak perantara sebagai
// jumlah, bukan jumlah yang dideklarasikan di order — residu (mis. sisa
// predispatch yang tak terpakai) ikut tersapu ke escrow alih-alih
// dikembalikan ke user. Bentuk persis:
//   `uint256 balance = IERC20(token).balanceOf(dispatcher);`
//   `... transfer(..., balance)` / `Call({..., value: balance, ...})`.
// Jumlah yang dideklarasikan (parameter/field order) TIDAK memicu; sweep
// saldo sendiri (balanceOf(address(this)) / address(this).balance) TIDAK
// memicu (rescue by-design). Severity Low — sweep saja sering by-design
// (dust collection); ia berbahaya bila digabung eksekutor tanpa guard
// (detektor ke-18).
// KALIBRASI review Kiro 17 Nov 2026 (R19.1 — wasit, tiap klaim diverifikasi
// probe ke kode asli): F12/F13/F20 — posisi argumen dihitung via paren
// seimbang (splitTopLevelArgs), BUKAN span lazy `[^;]*?` (probe membuktikan
// span itu menelan argumen call kedua dalam satu statement, mis.
// `emit Log(transfer(a, 1), balance)`); F17 — assignment `=(?!=)` supaya
// `==` tak tertangkap (probe: `x == balanceOf(pool)` lalu transfer(x)
// sempat ter-flag); F18 — semantik assignment TERAKHIR: var dihitung
// sweep hanya bila assignment terakhirnya ekspresi full-balance, alias
// var sweep lain, atau turunan dari dirinya sendiri (`balance - fee`);
// reassign penuh (`balance = required`) menghapus status sweep; F16-lite
// — `payable(X).balance` dikenali seperti `address(X).balance`.
// DITOLAK wasit: F15 (pengecualian recipient address(this)/msg.sender —
// membunuh target H3b placeOrder yang recipient-nya address(this),
// probe P-c4c); (c3) "Call-struct value: terlewat" — probe membuktikan
// sudah ter-flag; (c6) "assignment multi-baris terlewat" — probe
// membuktikan `\s*` sesudah `=` sudah menelan newline; F19 tak perlu.
// R19.2 (sesi 04:38 WIB 18 Nov 2026): `ident.balance` POLOS kini
// dikenali BILA ident terbukti address-typed (param/lokal/state var
// bertipe address atau kontrak/interface di file ini —
// collectAddressTypedIdents); field struct tetap TIDAK dihitung.
// BATAS DIKETAHUI (sesudah R19.4, sesi 16:38 WIB 18 Nov 2026): tipe
// kontrak dari file lain (import) kini dikenali bila didefinisikan di
// korpus proyek atau bernama interface standar ERC (allowlist);
// `x = T(addr)` (cast-assignment tanpa deklarasi) dilacak sejak R19.5,
// DIPERSEMPIT R19.5a (sesi #34): cast HANYA `payable`/`address` + harus
// menjadi keseluruhan RHS (F1) — lengan tipe-kontrak DIHAPUS (F6: `.balance`
// pada var kontrak INVALID sejak 0.5 + multi-deklarasi INVALID, solc 0.8.20;
// lengan itu hanya men-flag kode tak-valid). Batas tersisa: `x = T(addr)`
// dengan T di luar korpus/allowlist tetap 0; cast di RHS ternary tetap 0
// (F5, FN konservatif, diterima); rantai assignment terbalik >8 tetap 0
// (F4); assignment member (`s.x = ...`) tidak menambah `x` (F2).
// R19.3: akses terindeks `BASE[i].balance` SUDAH
// dikenali bila elemen BASE terbukti address-typed (residual A16 SELESAI
// sesi 08:38 WIB 18 Nov 2026); indeks sebagian pada array multi-dimensi
// (`pools[0].balance` atas `address[][]`) adalah Solidity tak valid,
// jadi tak ditangani khusus.
function detectFullBalanceSweep(fn, fileName, id, ctx) {
  if (fn.isConstructor) return [];
  const body = fn.body;
  // R19.2: identifier address-typed di scope fungsi ini (param/lokal/
  // state var) — penunjang `ident.balance` polos.
  const addressIdents = collectAddressTypedIdents(fn, ctx);
  // R19.3: base address-typed yang dipakai lewat indeks
  // (`pools[0].balance`) — penunjang `isFullBalanceExpr`.
  const indexedBases = collectIndexedAddressBases(fn, ctx);
  // 1. Pelacakan assignment (F18): var -> status sweep, mengikuti
  //    assignment TERAKHIR sebelum pemakaian, dalam urutan teks.
  const sweepVars = new Set();
  const assignRe = /\b([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;]*)/g;
  let a;
  while ((a = assignRe.exec(body)) !== null) {
    const v = a[1], rhs = (a[2] || "").trim();
    if (isFullBalanceExpr(rhs, addressIdents, indexedBases)) { sweepVars.add(v); continue; }
    // Turunan dari dirinya sendiri (balance = balance - fee) atau alias
    // var sweep lain (y = balance) mempertahankan status sweep.
    if (new RegExp("\\b" + v.replace(/\$/g, "\\$") + "\\b").test(rhs)) continue;
    if (/^[A-Za-z_$][\w$]*$/.test(rhs) && sweepVars.has(rhs)) { sweepVars.add(v); continue; }
    sweepVars.delete(v);
  }
  const isAmount = (expr) => {
    const t = (expr || "").trim();
    if (!t) return false;
    if (/^[A-Za-z_$][\w$]*$/.test(t)) return sweepVars.has(t);
    return isFullBalanceExpr(t, addressIdents, indexedBases);
  };
  const mkCandidate = (amountExpr) => normalizeCandidate({
    id, detector: "full-balance-sweep",
    title: "The escrow sweep uses the intermediary contract's full balance, not the declared amount",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " mentransfer sejumlah `" + amountExpr
      + "` — the full balance of an intermediary contract (balanceOf/balance) — "
      + "not the amount declared in the order. The excess above "
      + "the declared amount (e.g. predispatch residue) is swept along to escrow.",
    preconditions: "There is fund residue in the intermediary contract while the sweep runs "
      + "(e.g. a predispatch exact-output swap that uses less than amountInMax).",
    impact: "User residue is swept to escrow / does not return to the user; if "
      + "combined with an unguarded executor, the residue can be drained by anyone.",
    severityGuess: "Low",
    evidence: "Amount `" + amountExpr + "` comes from balanceOf/balance "
      + "intermediary contract and used as the transfer/call amount in "
      + "function " + fn.name + ".",
    toVerify: ["Read the assignment & amount usage in " + fn.name,
      "check whether the excess above the declared amount is returned / recorded",
      "Fork PoC: leave residue in the intermediary, then check where it gets swept"],
    source: "pattern-scan",
  });
  // 2. Pemakaian sebagai jumlah — posisi argumen EKSPLISIT via paren
  //    seimbang: transfer/safeTransfer -> argumen ke-2; transferFrom ->
  //    argumen ke-3; encodeWithSelector(...transfer.selector...) ->
  //    argumen ke-3, encodeWithSelector(...transferFrom.selector...) ->
  //    argumen ke-4 (R19-b, sesi #35: jumlah transferFrom ada di
  //    args[3], bukan args[2] — cek transferFrom DULU); _sendValue ->
  //    argumen ke-2.
  const callSiteRe = /\.(safeTransfer|transfer|transferFrom)\s*\(|encodeWithSelector\s*\(|_sendValue\s*\(/g;
  let cs;
  while ((cs = callSiteRe.exec(body)) !== null) {
    const openIdx = body.indexOf("(", cs.index);
    if (openIdx === -1) continue;
    const parsed = splitTopLevelArgs(body, openIdx);
    if (!parsed) continue;
    const args = parsed.args;
    let amount = null;
    if (/^\.(safeTransfer|transfer)\s*\($/.test(cs[0].trim()) || cs[0].startsWith(".safeTransfer") || cs[0].startsWith(".transfer")) {
      // transfer / safeTransfer: (to, amount). transferFrom ditangani
      // di bawah via nama (args ke-3) — bedakan dari teks match.
      if (cs[0].indexOf("transferFrom") !== -1) amount = args[2];
      else amount = args[1];
    } else if (cs[0].indexOf("encodeWithSelector") !== -1) {
      // R19-b (sesi #35, residual review Kiro 17 Nov): posisi jumlah
      // tergantung selector — transfer (to, amount) -> args[2],
      // transferFrom (from, to, amount) -> args[3]. Batas: selector
      // bentuk hash keccak256("transferFrom(...)") tanpa `.selector`
      // tidak dikenali (konservatif, tanpa FP).
      if (args[0] && /\.transferFrom\.selector/.test(args[0])) amount = args[3];
      else if (args[0] && /\.transfer\.selector/.test(args[0])) amount = args[2];
    } else if (cs[0].indexOf("_sendValue") !== -1) {
      amount = args[1];
    }
    if (amount !== null && amount !== undefined && isAmount(amount)) {
      return [mkCandidate(amount.trim())];
    }
  }
  // 3. Field `value:` (Call struct / .call{value:}) — nilai field-nya
  //    saja, sampai koma / `}` top-level berikutnya.
  const valueRe = /\bvalue\s*:\s*/g;
  let vm;
  while ((vm = valueRe.exec(body)) !== null) {
    let j = vm.index + vm[0].length, depth = 0, expr = "";
    while (j < body.length) {
      const ch = body[j];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if ((ch === "," || ch === ";") && depth === 0) break;
      expr += ch; j++;
    }
    if (isAmount(expr)) return [mkCandidate(expr.trim())];
  }
  return [];
}

// Detektor permissionless-value-send (detektor ke-20 — rekomendasi F8
// review Kiro detektor 18/19, 17 Nov 2026; wasit: probe membuktikan
// drain `to.call{value: amount}("")` dengan return dicek TIDAK ter-flag
// detektor 18 (data kosong, cakupan v1 — F9: jangan perluas detektor 18)
// maupun 19): fungsi external/public TANPA guard yang mengirim ETH ke
// target pilihan caller dengan data kosong — `.call{value:}(...)`,
// `.transfer(...)`, `.send(...)`. Receiver msg.sender / owner /
// beneficiary / address(this) dikecualikan (withdraw/owner-payout
// by-design); value literal 0 dikecualikan. Severity Medium.
//
// KALIBRASI R20.2c (sesi #33, 19 Nov 2026 — atas review Kiro Opus 5.5
// sesi bdefe1bb, vonis NEEDS WORK, F1–F8; tiap klaim diverifikasi wasit
// ke kode asli via probe): F1 pengecualian entitlement kini terikat
// jumlah (bukan saldo penuh / param mentah); F2 pengecualian nama hanya
// bila bukan parameter; F3 bentuk cek entitlement diperlebar
// (_msgSender, != + revert, OZ v5 _checkAuthorized, qualifier member);
// F4 cek hanya dihitung SEBELUM titik kirim (E5 artefak — komentar
// sudah di-strip dari fn.body; E6 if-cabang tanpa revert = batas
// diketahui); F5 bentuk bersarang `payable(IDENT(ARGS))` ditangani pola
// sempit satu level (PERCOBAAN recvSrc bersarang umum GAGAL —
// backtracking katastrofik, probe menggantung >10 dtk — JANGAN ulangi);
// F6 state-var receiver tetap ter-flag (konservatif, bukan blocker);
// F7/F8 lihat R-COF-1b. Detail + disposisi:
// `frankenaudit/docs/kiro-crew-review-2026-11-19-r20-2c-cof1b.md`.
function detectPermissionlessValueSend(fn, fileName, id) {
  if (fn.isConstructor) return [];
  if (/\b(internal|private)\b/.test(fn.signature)) return [];
  if (/\b(view|pure)\b/.test(fn.signature)) return [];
  if (hasAccessGuard(fn)) return [];
  const body = fn.body;
  const recvSrc = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\]|\\([^)]*\\))*";
  const recvOk = new RegExp("^(" + recvSrc + ")$");
  const fnParams = new Set(paramNamesOf(fn).filter(Boolean));
  // Bentuk cek entitlement (F3/F4): diuji HANYA pada teks SEBELUM titik
  // kirim (lihat pemakaian di bawah — F4/E7: cek sesudah payout tidak
  // dihitung). SENDER mencakup _msgSender() (OZ Context). Bentuk !=
  // adalah gaya if-revert custom-error; == di require. Pola ini TIDAK
  // membedakan require/if-revert dari if-cabang tanpa revert (F4/E6 —
  // bentuk itu langka; wasit men-triase bila muncul).
  const SENDER = "(?:msg\\.sender|_msgSender\\s*\\(\\s*\\))";
  const entitlementRe = new RegExp(
    "isApprovedOrOwner\\s*\\(\\s*" + SENDER + "\\b"
    + "|ownerOf\\s*\\([^)]*\\)\\s*==\\s*" + SENDER
    + "|" + SENDER + "\\s*==\\s*[^;{}=]*ownerOf\\s*\\("
    + "|ownerOf\\s*\\([^)]*\\)\\s*!=\\s*" + SENDER
    + "|" + SENDER + "\\s*!=\\s*[^;{}=]*ownerOf\\s*\\("
    + "|_checkAuthorized\\s*\\(|_isAuthorized\\s*\\("
  );
  const entitlementBefore = (text) => entitlementRe.test(text);
  const recvExcluded = (recv) => {
    if (/^msg\.sender$/.test(recv)) return true;
    if (/^address\s*\(\s*this\s*\)$/.test(recv) || recv === "this") return true;
    if (/^0x[0-9a-fA-F]+$/.test(recv)) return true;
    // KALIBRASI hunting re-run 17 Nov 2026 (R20.1 — wasit: FP wrapper
    // Uniswap `WETH().call{value: msg.value}`): receiver berupa panggilan
    // tanpa argumen (`WETH()`) mengembalikan alamat TETAP, bukan pilihan
    // caller — dikecualikan.
    if (/^[A-Za-z_$][\w$]*\(\s*\)$/.test(recv)) return true;
    // KALIBRASI R20.2c (temuan Kiro F2 — REGRESI dari R20.2a): nama
    // owner/beneficiary/treasury hanya dikecualikan bila BUKAN parameter
    // fungsi — parameter bernama `treasury` adalah alamat pilihan caller.
    if (/^(owner|beneficiary|treasury)$/.test(recv) && !fnParams.has(recv)) return true;
    // KALIBRASI R20.2c (temuan Kiro F5/D2 — diputuskan sengaja, bukan
    // kecelakaan parsing): receiver `ownerOf(...)` ditentukan kontrak
    // token, bukan pilihan caller — yang dibayar adalah pemilik token.
    if (/(?:^|\.)ownerOf\s*\(/.test(recv)) return true;
    return !recvOk.test(recv);
  };
  // KALIBRASI R20.3c (wasit atas review Kiro R20.3b — sesi #48): nama
  // entry-point swap yang sah — `swap` telanjang, atau berawalan `swap`
  // dan mengandung `Exact` (swapExact.../swapTokensForExact...), atau
  // exactInput/exactOutput. Nama seperti `swapFee` (tanpa Exact) BUKAN
  // swap dan tidak boleh membebaskan (F8). Penanda c2 juga menerima `,`
  // sebagai terminator segmen (bentuk abi.encodeCall(fn, ...) — F2b).
  const isSwapEntryPoint = (name) => name === "swap" || /^swap\w*Exact/.test(name) || /^exactInput/.test(name) || /^exactOutput/.test(name);
  const hasSwapMarker = (text) => {
    if (!text) return false;
    const re = /(?:^|[\s.(])(exactInput\w*|exactOutput\w*|swap\w*)(?:\s*\(|\s*\.\s*selector\b|\s*,)/g;
    let sm;
    while ((sm = re.exec(text)) !== null) {
      if (isSwapEntryPoint(sm[1])) return true;
    }
    return false;
  };
  // KALIBRASI R20.1 (wasit): nilai yang dikirim BUKAN dana kontrak bila
  // (a) persis `msg.value` (ETH caller sendiri yang diteruskan — wrap),
  // (b) identifier yang sebelumnya DITARIK dari msg.sender di fungsi yang
  // sama (`safeTransferFrom(msg.sender, ..., V)` — unwrap-forward 1:1,
  // mis. swapExactTokensForETH).
  // isCallerFunded(value, beforeIdx): nilai kiriman = dana caller sendiri.
  // beforeIdx = posisi kirim di badan fungsi — penugasan/pull sesudah
  // kirim tidak dihitung (R20.3a F4). Bentuk indeks amounts[i] diuji via
  // basisnya (R20.3a F7); bentuk itu tidak memakai pull-forward (b).
  const isCallerFunded = (value, beforeIdx) => {
    const raw = (value || "").trim();
    if (raw === "msg.value") return true;
    const idxM = raw.match(/^([A-Za-z_$][\w$]*)\s*\[\s*[^\]]+\s*\]$/);
    const t = idxM ? idxM[1] : raw;
    if (!/^[A-Za-z_$][\w$]*$/.test(t)) return false;
    const cut = typeof beforeIdx === "number" ? body.slice(0, beforeIdx) : body;
    const escId = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (b) pull-forward (R20.1): V ditarik dari msg.sender — HANYA bila
    // token yang ditarik WETH-ish ATAU badan memuat .withdraw( (R20.3a F6:
    // pull token junk + kirim ETH jumlah sama = drain, bukan unwrap).
    // Receiver dibaca dengan jalan-mundur dari titik ".transferFrom"
    // (hindari regex paren-bersarang — IERC20(WETH()) punya 2 level).
    if (!idxM) {
      const pullRe = new RegExp("\\.(?:safeTransferFrom|transferFrom)\\s*\\(\\s*msg\\.sender\\s*,[^,]+,\\s*" + t.replace(/\$/g, "\\$") + "\\b", "g");
      let pm;
      while ((pm = pullRe.exec(cut)) !== null) {
        let j = pm.index - 1;
        while (j >= 0 && /[A-Za-z0-9_$()\[\].]/.test(cut[j])) j--;
        const recv = cut.slice(j + 1, pm.index);
        if (/weth/i.test(recv) || /\.withdraw\s*\(/.test(cut)) return true;
      }
    }
    // KALIBRASI R20.3/R20.3a (F8 swap-output): jumlah yang dikirim adalah
    // OUTPUT SWAP atas deposit caller sendiri. Syarat (i): fungsi menarik
    // dana dari msg.sender KE address(this), jumlahnya berupa identifier
    // yang dipakai lagi di badan (R20.3a F2: pull 1 wei ke treasury dan
    // require fee atas msg.value tidak memenuhi). Cabang msg.value
    // telanjang DIHAPUS (R20.3a F2: output swap ETH butuh input token,
    // bukan msg.value). Syarat (ii): V ditugaskan dari panggilan swap
    // (c1) ATAU dari abi.decode atas hasil multicall ke router swap (c2).
    // Tanpa (i), swap yang didanai saldo kontrak TETAP ter-flag.
    let callerPulls = false; let pullPos = -1;
    const pullToThisRe = /(?:safeTransferFrom|transferFrom)\s*\(\s*msg\.sender\s*,\s*address\s*\(\s*this\s*\)\s*,\s*([A-Za-z_$][\w$]*)/g;
    let pt;
    while ((pt = pullToThisRe.exec(cut)) !== null) {
      const amtRe = new RegExp("\\b" + pt[1].replace(/\$/g, "\\$") + "\\b", "g");
      if ((cut.match(amtRe) || []).length >= 2) { callerPulls = true; pullPos = pt.index; break; }
    }
    if (!callerPulls) return false;
    // Kumpulkan SEMUA penugasan polos V sebelum kirim (bukan member,
    // mis. cache.amountOut — R20.3a F4); yang dipakai = TERAKHIR, dan
    // pull harus mendahului penugasan itu.
    // KALIBRASI R20.3b (F7 residual — sesi #47, probe wasit
    // /tmp/probe-d20-r203b.js): penugasan via tuple-destructure
    // `(a, b) = swap(...)` / `(uint a, uint b) = ...` / `(, b) = ...`
    // juga menetapkan V — kumpulkan bersama penugasan polos, urutkan
    // menurut posisi, yang dipakai tetap TERAKHIR. Elemen tuple diuji
    // per koma (kata terakhir elemen sesudah buang tipe harus V);
    // elemen member (mengandung `.`) dilewati (konservatif).
    const assigns = [];
    const assignRe = new RegExp("\\b" + escId + "\\s*=(?![=>])\\s*([^;]{0,400});", "g");
    let am;
    while ((am = assignRe.exec(cut)) !== null) {
      if (am.index > 0 && cut[am.index - 1] === ".") continue;
      assigns.push({ idx: am.index, rhs: am[1] });
    }
    const tupleRe = /\(\s*([^;{}]{0,400})\)\s*=(?![=>])\s*([^;]{0,400});/g; // R20.3c F11: cap 200 -> 400
    let tm;
    while ((tm = tupleRe.exec(cut)) !== null) {
      if (tm.index > 0 && cut[tm.index - 1] === ".") continue;
      let hasV = false;
      for (const el of tm[1].split(",")) {
        const e = el.trim().replace(/\[[^\]]*\]/g, "");
        if (!e || e.includes(".")) continue;
        const toks = e.split(/\s+/).filter(Boolean);
        if (toks.length && toks[toks.length - 1].replace(/\)+$/, "") === t) { hasV = true; break; } // R20.3c T5: kupas `)` akhir (tuple bersarang)
      }
      if (!hasV) continue;
      assigns.push({ idx: tm.index, rhs: tm[2] });
    }
    assigns.sort((a, b) => a.idx - b.idx);
    const lastAssign = assigns.length ? assigns[assigns.length - 1] : null;
    const lastRhs = lastAssign ? lastAssign.rhs : null;
    const lastAssignIdx = lastAssign ? lastAssign.idx : -1;
    if (lastRhs === null || pullPos >= lastAssignIdx) return false;
    // (c1) penugasan terakhir = panggilan swap: segmen callee TERAKHIR
    // harus DIAWALI swap/exactInput/exactOutput (R20.3a F3: quote-/
    // preview-/getSwapFee- tidak lolos).
    // R20.3c F8: segmen swap harus lolos isSwapEntryPoint (swapFee ditolak).
    const c1Re = /(?:^|[\s.(])(exactInput\w*|exactOutput\w*|swap\w*)\s*\(/g;
    let c1m; let c1Hit = false;
    while ((c1m = c1Re.exec(lastRhs)) !== null) { if (isSwapEntryPoint(c1m[1])) { c1Hit = true; break; } }
    if (c1Hit) return true;
    // (c2) penugasan terakhir = abi.decode(RESULTS[i], ...) + RESULTS =
    // ...<receiver swap/router>.multicall(... (R20.3a F5: receiver
    // multicall harus router swap — oracle tidak lolos; R20.3b F5
    // residual — sesi #47, probe wasit /tmp/probe-d20-r203b.js: penanda
    // swap harus TERIKAT ke argumen data multicall — literal di argumen,
    // pengisian data[i]/push, atau RHS var yang diisikan (satu hop) —
    // penanda di var tak terpakai + data quote tidak lagi lolos; bila
    // data tidak diisi lokal (param/helper lain), fallback ke uji global
    // lama supaya perilaku bentuk itu tidak berubah).
    const decM = lastRhs.match(/^\s*abi\.decode\s*\(\s*([A-Za-z_$][\w$]*)\s*\[/);
    if (decM) {
      const resVar = decM[1].replace(/\$/g, "\\$");
      const mcRe = new RegExp("\\b" + resVar + "\\s*=\\s*([^;]{0,300})\\.multicall\\s*\\(");
      const mm = mcRe.exec(cut);
      if (mm && /swap|router/i.test(mm[1])) {
        const openIdx = mm.index + mm[0].length - 1;
        const parsed = splitTopLevelArgs(cut, openIdx);
        if (parsed && parsed.args.length) {
          const dataArg = (parsed.args[parsed.args.length - 1] || "").trim();
          if (hasSwapMarker(dataArg)) return true;
          const idM = dataArg.match(/^([A-Za-z_$][\w$]*)$/);
          if (idM) {
            const dEsc = idM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const fills = [];
            const fillRes = [
              new RegExp("\\b" + dEsc + "\\s*\\[[^\\]]*\\]\\s*=\\s*([^;]{0,400});", "g"),
              new RegExp("\\b" + dEsc + "\\s*\\.\\s*push\\s*\\(\\s*([^;)]{0,400})[^;]*;", "g"), // R20.3c F1: tangkap argumen push tanpa `)` penutup
              new RegExp("\\b" + dEsc + "\\s*=(?![=>])\\s*([^;]{0,400});", "g"),
            ];
            for (const fr of fillRes) {
              let fm;
              while ((fm = fr.exec(cut)) !== null) fills.push(fm[1]);
            }
            if (fills.length) {
              for (const f of fills) {
                if (hasSwapMarker(f)) return true;
                const vM = f.trim().match(/^([A-Za-z_$][\w$]*)$/);
                if (vM) {
                  const vEsc = vM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                  const defRe = new RegExp("\\b" + vEsc + "\\s*=(?![=>])\\s*([^;]{0,400});", "g"); // R20.3c F3: uji SEMUA definisi var
                  let dm;
                  while ((dm = defRe.exec(cut)) !== null) {
                    if (hasSwapMarker(dm[1])) return true;
                  }
                }
              }
            } else if (/exactInput|exactOutput/.test(cut)) {
              // Data tidak diisi lokal (param / helper lain): pertahankan
              // perilaku lama (uji global) supaya bentuk itu tak berubah.
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  // KALIBRASI R20.2c (temuan Kiro F1 — LUBANG di R20.2b): pengecualian
  // entitlement HANYA bila jumlah yang dikirim bukan dana kontrak
  // sembarang — BUKAN `address(this).balance` (atau ekspresi yang
  // memuatnya) dan BUKAN parameter fungsi mentah (jumlah pilihan caller).
  // Jumlah dari state per-token (mis. `bonds[id]`) atau variabel lokal
  // hasil hitung tetap dikecualikan (kasus unbond: tokenAmount lokal).
  const isEntitledPayout = (recv, value, entitled) => {
    if (!entitled) return false;
    if (!/^[A-Za-z_$][\w$]*$/.test(recv) || !fnParams.has(recv)) return false;
    const v = (value || "").replace(/\s+/g, "");
    if (v.includes("address(this).balance")) return false;
    if (/^[A-Za-z_$][\w$]*$/.test(v) && fnParams.has(v)) return false;
    return true;
  };
  // Unwrap `payable(X)` / `address(X)` berlapis (maks 2 lapis — cukup
  // untuk `payable(address(to))`); X yang mengandung paren tidak
  // ikut di-unwrap di sini (ditangani pola bersarang di bawah).
  const unwrapCall = (r) => {
    const mm = r.match(/^(payable|address)\s*\((.*)\)\s*$/s);
    return mm ? mm[2].trim() : null;
  };
  const unwrapRecv = (recv) => {
    let r = recv;
    for (let k = 0; k < 2; k++) {
      const u = unwrapCall(r);
      if (u === null) break;
      r = u;
    }
    return r;
  };
  const mkCandidate = (method, recv, value) => normalizeCandidate({
    id, detector: "permissionless-value-send",
    title: "Send ETH without access control to a caller-chosen target (permissionless value-send)",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " sends ETH (" + method + ") ke "
      + "target pilihan caller (" + recv + ") sejumlah `" + value
      + "` without an access modifier and without require(msg.sender == ...) — "
      + "anyone can call it and drain the contract's ETH balance.",
    preconditions: "The contract holds ETH when this function is called by an attacker.",
    impact: "Draining of the contract's ETH balance if confirmed.",
    severityGuess: "Medium",
    evidence: method + " ke `" + recv + "` sejumlah `" + value
      + "` in function " + fn.name + ", without an access guard in the signature/body.",
    toVerify: ["Check modifiers & requires in " + fn.name,
      "check whether " + recv + " is really caller-chosen or predetermined",
      "Fork PoC: call from a random address to the attacker's address"],
    source: "pattern-scan",
  });
  // Kumpulkan SEMUA pengiriman ETH (bentuk utama + bentuk bersarang),
  // urutkan menurut posisi di badan fungsi, lalu proses berurutan —
  // kandidat pertama yang tidak terkecualikan menang. (Dulu dua loop
  // terpisah: semua .call dulu baru .transfer — kini urutan posisi kode.)
  const sends = [];
  // .call{value: V}("") — data kosong (bentuk utama).
  const callRe = new RegExp("(" + recvSrc + ")\\s*\\.\\s*call\\s*\\{[^}]*value\\s*:\\s*([^,}]+)\\}\\s*\\(\\s*(\"\"|'')\\s*\\)", "g");
  let m;
  while ((m = callRe.exec(body)) !== null) {
    sends.push({ index: m.index, recv: m[1].trim(), value: (m[2] || "").trim(), method: ".call{value:}" });
  }
  // Bentuk bersarang (F5 — SATU level saja): `payable(IDENT(ARGS)).call`
  // — mis. `payable(address(to))` (E3) dan `payable(ownerOf(id))` (D2).
  // Pola ini sengaja SEMPIT (argumen dalam tanpa paren) supaya tidak ada
  // backtracking katastrofik seperti percobaan recvSrc bersarang umum.
  const nestedCallRe = /payable\s*\(\s*([\w$.]+)\s*\(([^()]*)\)\s*\)\s*\.\s*call\s*\{[^}]*value\s*:\s*([^,}]+)\}\s*\(\s*(""|'')\s*\)/g;
  while ((m = nestedCallRe.exec(body)) !== null) {
    sends.push({ index: m.index, recv: m[1] + "(" + m[2] + ")", value: (m[3] || "").trim(), method: ".call{value:}" });
  }
  // .transfer(V) / .send(V) — termasuk payable(to).transfer(V).
  // Pembedanya dari ERC20 transfer(to, amount): ETH transfer/send hanya
  // punya SATU argumen (jumlah) — dihitung via paren seimbang.
  const tsRe = /((?:payable\s*\(\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\([^)]*\))*(?:\s*\))?)\s*\.\s*(transfer|send)\s*\(/g;
  while ((m = tsRe.exec(body)) !== null) {
    const recv = m[1].trim();
    const openIdx = body.indexOf("(", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const parsed = splitTopLevelArgs(body, openIdx);
    if (!parsed || parsed.args.length !== 1) continue; // ERC20: 2 argumen
    const value = (parsed.args[0] || "").trim();
    sends.push({ index: m.index, recv, value, method: "." + m[2] });
  }
  // Bentuk bersarang .transfer/.send: `payable(address(to)).transfer(V)`.
  const nestedTsRe = /payable\s*\(\s*([\w$.]+)\s*\(([^()]*)\)\s*\)\s*\.\s*(transfer|send)\s*\(/g;
  while ((m = nestedTsRe.exec(body)) !== null) {
    const openIdx = body.indexOf("(", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const parsed = splitTopLevelArgs(body, openIdx);
    if (!parsed || parsed.args.length !== 1) continue;
    const value = (parsed.args[0] || "").trim();
    sends.push({ index: m.index, recv: m[1] + "(" + m[2] + ")", value, method: "." + m[3] });
  }
  sends.sort((a, b) => a.index - b.index);
  for (const s of sends) {
    let recv = s.recv;
    const value = s.value;
    if (value === "0") continue;
    if (isCallerFunded(value, s.index)) continue;
    // KALIBRASI R20.2a (sesi #33): unwrap payable(...)/address(...) —
    // kalau tidak, `payable(treasury)` lolos dari pengecualian receiver
    // sah (kasus nyata Veno FA-001).
    recv = unwrapRecv(recv);
    if (recvExcluded(recv)) continue;
    const entitled = entitlementBefore(body.slice(0, s.index));
    if (isEntitledPayout(recv, value, entitled)) continue;
    return [mkCandidate(s.method, recv, value)];
  }
  return [];
}
// Detektor replay-signature (temuan Kiro Opus 5.5, sesi 20:38 WIB
// 2026-11-13 — temuan B, High): ecrecover tanpa nonce / domain
// separator / chainId / address(this) di digest. Satu signature sah
// bisa dipakai ulang tanpa batas, di chain lain, di deployment lain.
// Aman bila digest terikat nonce ATAU chainId/domain separator ATAU
// address(this) — salah satu pengikat itu sudah cukup menutup replay
// lintas konteks yang dideteksi di sini.
function detectReplaySignature(fn, fileName, id) {
  if (!/ecrecover\s*\(/.test(fn.body)) return [];
  if (/\bnonce\b/i.test(fn.body)) return [];
  if (/chainId|block\.chainid|DOMAIN_SEPARATOR|domainSeparator|EIP712/i.test(fn.body)) return [];
  if (/address\s*\(\s*this\s*\)/.test(fn.body)) return [];
  return [normalizeCandidate({
    id, detector: "replay-signature",
    title: "The signature can be replayed: ecrecover without nonce/domain separator",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " verifies the signature via "
      + "ecrecover, but its digest does not bind the nonce, chainId, "
      + "domain separator, or address(this) — one valid signature can "
      + "reused repeatedly (and on other chains/deployments).",
    preconditions: "The attacker obtains one valid signature "
      + "(e.g. from an earlier legitimate claim / a leaked signature).",
    impact: "Unbounded balance minting / repeated claims if confirmed.",
    severityGuess: "High",
    evidence: "ecrecover( in function " + fn.name
      + " without nonce/chainId/domain separator/address(this) in the function body.",
    toVerify: ["Read the digest construction in " + fn.name,
      "check whether the nonce is stored & marked used",
      "Fork PoC: call 2x with the same signature"],
    source: "pattern-scan",
  })];
}

// Detektor share-accounting (temuan Kiro Opus 5.5, sesi 20:38 WIB
// 2026-11-13 — temuan C, Low): fungsi penarikan mengurangi balances
// tapi tidak mengurangi shares/totalShares, padahal kontrak melacak
// akuntansi share. Harga share / nilai kembali jadi tidak sinkron.
// Hanya aktif bila kontrak memang punya state shares/totalShares.
function detectShareAccounting(fn, fileName, id, ctx) {
  if (!ctx || !ctx.hasShareState) return [];
  if (!/withdraw|redeem|\bexit\b|burn/i.test(fn.name)) return [];
  if (!/\bbalances\s*\[[^\]]+\]\s*-=/.test(fn.body)) return [];
  if (/\bshares\s*\[[^\]]+\]\s*-=/.test(fn.body)) return [];
  if (/\btotalShares\s*-=/.test(fn.body)) return [];
  if (/\btotalShares\s*=\s*totalShares\s*-/.test(fn.body)) return [];
  return [normalizeCandidate({
    id, detector: "share-accounting",
    title: "Share accounting does not decrease on withdrawal",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " decreases balances but does not "
      + "decreases shares/totalShares — share accounting out of sync "
      + "with a balance, so the sharePrice / per-share value is wrong.",
    preconditions: "The contract tracks shares/totalShares and is used "
      + "to compute a price or value.",
    impact: "Wrong share price; inaccurate claim/withdrawal values.",
    severityGuess: "Low",
    evidence: "balances[...] -= in function " + fn.name
      + " without shares[...] -= / totalShares -= in the function body.",
    toVerify: ["Check shares/totalShares usage in " + fn.name
      + " and other functions", "Fork PoC: deposit → withdraw → read sharePrice"],
    source: "pattern-scan",
  })];
}

// KALIBRASI R-COF-3a (sesi #50, 21 Nov 2026 — disposisi wasit atas
// review Kiro Opus 5.5 sesi d1075178, vonis NEEDS WORK, F1–F12):
// TERBUKTI + diperbaiki: F2 (string di body menyuntik guard palsu —
// string kini di-mask sebelum pindai), F3 (argumen revert dihitung
// sebagai bukti kondisi — token guard kini HANYA dari kondisi if,
// argumen revert tidak lagi dihitung), F5/F6 (literal 0/1 + `1e18` →
// ident palsu `e18` — literal TIDAK lagi dipakai sebagai bukti SAMA
// SEKALI: aturan (a) "literal bersama" DIHAPUS karena X8 membuktikan
// literal bersama bisa over-suppress (`price >= 1e18` vs `fee > 1e18`);
// angka kini di-mask sebelum ekstraksi identifier, satuan ether/wei/
// gwei/days/dll masuk stoplist), F9 (revert di else-branch — kini
// dikenali, token dari kondisi if + kondisi bersarang di else),
// F11 (require/assert hidup duplikat — kini dikenali sebagai padanan).
// Aturan tekan yang baru: identifier bersama >= 3, ATAU >= 2 DENGAN
// token panggilan/member bersama. Kasus EFP tetap ter-suppress (3
// identifier bersama: existing/length/manager).
// DITOLAK sbg artefak: F1 (komentar di fnBody — artefak harness Kiro;
// pipeline mengirim fn.body dari source yang SUDAH comment-stripped,
// probe W-F1: 1 kandidat, tidak ter-suppress).
// DITOLAK sbg desain: F8 (N1/N2/N6 — ambang konservatif klaim (d);
// under-suppress itu disengaja; Kiro sendiri mencatatnya demikian).
// DITOLAK sbg usulan stoplist: `length`/`balance` di F6 — keduanya
// sinyal struktural member-access (kasus EFP bergantung pada `length`).
// BATAS (didokumentasikan, tidak diperbaiki — butuh perbandingan kondisi
// ternormalisasi / analisis antar-fungsi, terlalu besar 3 hari sebelum
// freeze 24 Nov): F4 (pencocokan token buta-operator — guard dgn
// identifier sama tapi satu perbandingan terbalik bisa over-suppress,
// mis. X2), F10 (guard Yul di assembly), F12 (helper/ternary yang revert).
const COF3_STOPLIST = new Set(("require assert revert if else true false msg sender tx origin "
  + "block timestamp number gasleft address payable uint uint8 uint16 uint32 uint64 uint128 uint256 "
  + "int int8 int16 int32 int64 int128 int256 bool bytes bytes32 string memory storage calldata "
  + "public external internal private view pure returns return this super new delete for while do "
  + "break continue emit try catch assembly error using is import contract library interface "
  + "struct enum event modifier constructor function var let const unchecked virtual override "
  + "immutable constant indexed anonymous abstract fallback receive keccak256 sha256 abi type "
  + "selector gas value coinbase difficulty prevrandao chainid basefee blobhash blobbasefee "
  + "not and or "
  + "ether wei gwei finney szabo seconds minutes hours days weeks years").split(" "));
// Literal numerik (dipakai untuk masking, BUKAN bukti — lihat R-COF-3a):
// heksadesimal, desimal dgn underscore, notasi ilmiah (1e18).
const COF3_LITERAL_RE = /\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
function cof3SignalTokens(text) {
  const idents = new Set(), calls = new Set();
  if (!text) return { idents, calls };
  // String literal di-strip (isi pesan require bukan kode — "slot already
  // claimed" tidak boleh menyumbang token `slot`/`claimed`).
  let work = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  // Angka di-mask SEBELUM ekstraksi identifier (R-COF-3a F6): `1e18`
  // tidak boleh melahirkan ident palsu `e18`, `0x1626ba7e` tidak boleh
  // melahirkan `x1626ba7e`.
  work = work.replace(COF3_LITERAL_RE, (m) => " ".repeat(m.length));
  const identRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = identRe.exec(work)) !== null) {
    const name = m[0];
    if (name.length < 3 || COF3_STOPLIST.has(name)) continue;
    idents.add(name);
    const after = work[m.index + name.length];
    if (after === "(" || after === ".") calls.add(name);
  }
  return { idents, calls };
}
// Mask string literal dgn spasi sama-panjang (R-COF-3a F2): pola
// `if (...) { revert }` di dalam string tidak boleh dibaca sebagai guard.
function cof3MaskStrings(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => " ".repeat(m.length));
}
// Kondisi semua `if (...)` di teks (scan datar, kurung seimbang).
function cof3IfConditions(text) {
  const conds = [];
  const ifRe = /\bif\s*\(/g;
  let m;
  while ((m = ifRe.exec(text)) !== null) {
    const openIdx = text.indexOf("(", m.index);
    let depth = 0, closeIdx = -1;
    for (let j = openIdx; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") { depth--; if (depth === 0) { closeIdx = j; break; } }
    }
    if (closeIdx === -1) continue;
    conds.push(text.slice(openIdx + 1, closeIdx));
  }
  return conds;
}
// Cakupan sesudah kondisi `if (...)`: blok `{...}` (kurung seimbang) atau
// pernyataan tunggal sampai `;`. Mengembalikan { scope, end } atau null.
function cof3ScopeAfter(body, closeIdx) {
  let k = closeIdx + 1;
  while (k < body.length && /\s/.test(body[k])) k++;
  if (body[k] === "{") {
    let d = 0, end = -1;
    for (let j = k; j < body.length; j++) {
      if (body[j] === "{") d++;
      else if (body[j] === "}") { d--; if (d === 0) { end = j; break; } }
    }
    if (end === -1) return null;
    return { scope: body.slice(k + 1, end), end };
  }
  const semi = body.indexOf(";", k);
  if (semi === -1) return null;
  return { scope: body.slice(k, semi + 1), end: semi };
}
// Daftar guard hidup `if + revert` di badan fungsi: tiap entri = token
// sinyal dari kondisi if terluar + kondisi if bersarang di cakupannya
// (R-COF-3a F3: argumen revert TIDAK dihitung — hanya kondisi).
// R-COF-3a F9: cabang `else` yang memuat revert ikut dihitung sebagai
// guard (token dari kondisi if-nya + kondisi bersarang di else).
function cof3LiveRevertGuards(body) {
  const masked = cof3MaskStrings(body);
  const guards = [];
  const pushGuard = (parts) => {
    const merged = { idents: new Set(), calls: new Set() };
    for (const p of parts) {
      const t = cof3SignalTokens(p);
      for (const x of t.idents) merged.idents.add(x);
      for (const x of t.calls) merged.calls.add(x);
    }
    guards.push(merged);
  };
  const ifRe = /\bif\s*\(/g;
  let m;
  while ((m = ifRe.exec(masked)) !== null) {
    const openIdx = masked.indexOf("(", m.index);
    let depth = 0, closeIdx = -1;
    for (let j = openIdx; j < masked.length; j++) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")") { depth--; if (depth === 0) { closeIdx = j; break; } }
    }
    if (closeIdx === -1) continue;
    const cond = masked.slice(openIdx + 1, closeIdx);
    const thenScope = cof3ScopeAfter(masked, closeIdx);
    if (!thenScope) continue;
    if (/\brevert\b/.test(thenScope.scope)) {
      pushGuard([cond].concat(cof3IfConditions(thenScope.scope)));
    }
    // Cabang else: revert di else = guard atas negasi kondisi if.
    let e = thenScope.end + 1;
    while (e < masked.length && /\s/.test(masked[e])) e++;
    if (masked.slice(e, e + 4) === "else" && !/[A-Za-z0-9_$]/.test(masked[e + 4] || "")) {
      let f = e + 4;
      while (f < masked.length && /\s/.test(masked[f])) f++;
      if (masked.slice(f, f + 2) !== "if") { // else-if ditangani scan utama
        const es = cof3ElseScope(masked, f);
        if (es && /\brevert\b/.test(es.scope)) {
          pushGuard([cond].concat(cof3IfConditions(es.scope)));
        }
      }
    }
  }
  return guards;
}
// Cakupan cabang `else` tanpa kondisi: `{...}` atau pernyataan tunggal.
function cof3ElseScope(masked, start) {
  let k = start;
  while (k < masked.length && /\s/.test(masked[k])) k++;
  if (masked[k] === "{") {
    let d = 0, end = -1;
    for (let j = k; j < masked.length; j++) {
      if (masked[j] === "{") d++;
      else if (masked[j] === "}") { d--; if (d === 0) { end = j; break; } }
    }
    if (end === -1) return null;
    return { scope: masked.slice(k + 1, end), end };
  }
  const semi = masked.indexOf(";", k);
  if (semi === -1) return null;
  return { scope: masked.slice(k, semi + 1), end: semi };
}
// Daftar padanan hidup berupa require/assert di badan fungsi
// (R-COF-3a F11): token dari argumen panggilan (pesan string di-strip
// oleh cof3SignalTokens).
function cof3LiveRequireGuards(body) {
  const masked = cof3MaskStrings(body);
  const guards = [];
  const re = /\b(?:require|assert)\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const openIdx = masked.indexOf("(", m.index);
    let depth = 0, closeIdx = -1;
    for (let j = openIdx; j < masked.length; j++) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")") { depth--; if (depth === 0) { closeIdx = j; break; } }
    }
    if (closeIdx === -1) continue;
    guards.push(cof3SignalTokens(masked.slice(openIdx + 1, closeIdx)));
  }
  return guards;
}
// Benar bila ada satu guard hidup yang menegakkan kondisi sama dengan cek
// yang dikomentari (aturan R-COF-3a: identifier bersama >= 3, ATAU >= 2
// dgn token panggilan/member bersama).
function cof3Matches(commented, guard) {
  let sharedIdents = 0;
  for (const t of guard.idents) if (commented.idents.has(t)) sharedIdents++;
  if (sharedIdents >= 3) return true;
  if (sharedIdents < 2) return false;
  for (const t of guard.calls) if (commented.calls.has(t)) return true;
  return false;
}
function cof3HasLiveEquivalent(fnBody, commentedText) {
  if (!fnBody || !commentedText) return false;
  const commented = cof3SignalTokens(commentedText);
  if (commented.idents.size < 2) return false;
  for (const g of cof3LiveRevertGuards(fnBody)) {
    if (cof3Matches(commented, g)) return true;
  }
  for (const g of cof3LiveRequireGuards(fnBody)) {
    if (cof3Matches(commented, g)) return true;
  }
  return false;
}

// Detektor commented-out-check (backlog kelas AMP-01/AMP-02, sesi
// 20:38 WIB 2026-11-13 — Amply: require siloed-borrowing di
// ValidationLogic.validateBorrow dikomentari, setDebtCeiling dikomentari
// utuh): baris komentar di dalam badan fungsi yang berisi kode cek
// (require(/assert(/if(...)revert/revert() — pertahanan yang dimatikan.
// Hanya komentar berisi pola KODE (dengan kurung), bukan prosa
// ("we require the caller...") — prosa tidak memicu.
// BATAS: fungsi yang dikomentari UTUH (mis. setDebtCeiling Amply) tidak
// tertangkap — butuh detektor commented-out-function terpisah.
function detectCommentedOutCheck(fn, fileName, id, ctx) {
  if (!ctx || !ctx.comments) return [];
  const checkRe = COMMENTED_CHECK_RE;
  for (const c of ctx.comments) {
    if (c.line < fn.startLine || c.line > fn.endLine) continue;
    const text = c.text.trim();
    if (text.startsWith("@")) continue; // baris NatSpec, bukan kode
    // KALIBRASI R-COF-2 (sesi #45, hunting Resupply — wasit: FA-003/004
    // FixedPointMathLib mulDivDown/Up ter-flag padahal komentar
    // "Equivalent to require(...)" menjelaskan cek assembly yang ADA
    // (if iszero(...) { revert(0,0) } di baris berikut), bukan cek yang
    // dimatikan): komentar yang membuka dengan "Equivalent to" adalah
    // dokumentasi semantik kode hidup, bukan kode yang dikomentari.
    // Batas: frasa prosa lain ("Same as require", "Acts as require")
    // belum dikecualikan — konservatif = TETAP memicu bila muncul.
    if (/^equivalent\s+to\b/i.test(text)) continue;
    if (!checkRe.test(text)) continue;
    // KALIBRASI R-COF-3 (sesi #50): cek yang dikomentari punya padanan
    // hidup `if + revert CustomError` di fungsi yang sama (refactor,
    // bukan dimatikan) -> lewati komentar ini, lanjut pindai komentar
    // lain di fungsi yang sama (bukan langsung return []).
    if (cof3HasLiveEquivalent(fn.body, text)) continue;
    return [normalizeCandidate({
      id, detector: "commented-out-check",
      title: "Commented-out security check",
      location: { file: fileName, function: fn.name },
      hypothesis: "Function " + fn.name + " contains a security check that "
        + "commented out (line " + (c.line + 1) + ": \"" + text.slice(0, 90)
        + "\") — a defense that should be active is disabled instead, "
        + "so the path that used to be rejected now passes.",
      preconditions: "The commented-out check really is load-bearing (not "
        + "a duplicate of another check still active on the same path).",
      impact: "Missing validation: limits/permissions that should be enforced "
        + "no longer enforced if confirmed.",
      severityGuess: "Medium",
      evidence: "Check comment at line " + (c.line + 1)
        + " in function " + fn.name + ": " + text.slice(0, 120),
      toVerify: ["Read function " + fn.name + " in full: check what was disabled",
        "compare with upstream / the previous version (git history / diff)",
        "check whether a replacement check is still active on the same path",
        "Fork PoC: call the path that check used to reject"],
      source: "pattern-scan",
    })];
  }
  return [];
}

// Pola kode cek yang dikomentari (dipakai detektor commented-out-check
// DAN klasifikasi upstream-diff).
const COMMENTED_CHECK_RE = /\brequire\s*\(|\bassert\s*\(|\bif\s*\([^)]*\)\s*\{?\s*revert\b|\brevert\s*\(/;
// Penanda niat "dimatikan sengaja" di komentar sekitar kode yang dimatikan.
const INTENT_MARKER_RE = /\bTODO\b|MVP|disable|disabled|not enabled|deprecated|sunset|remove (this|for now)/i;

// Daftar fungsi utuh yang dikomentari (satu pemindaian, dua pakai:
// detektor commented-out-function DAN klasifikasi upstream-diff).
// Satu entri per nama fungsi per file (dedupe internal).
function listCommentedOutFunctions(ctx) {
  const items = []; // { name, startLine, endLine, text }
  if (!ctx || !ctx.commentBlocks) return items;
  const seen = new Set();
  for (const b of ctx.commentBlocks) {
    // Abaikan contoh kode dokumentasi: blok komentar NatSpec sering memuat
    // contoh `function foo() ...` di dalam pagar markdown ``` — itu contoh,
    // bukan fungsi yang dimatikan (false positive OZ AccessControl/ERC165
    // di hunting Amply 14 Nov 2026).
    const fences = [];
    let fIdx = 0;
    while (true) {
      const open = b.text.indexOf("```", fIdx);
      if (open === -1) break;
      const close = b.text.indexOf("```", open + 3);
      if (close === -1) { fences.push([open, b.text.length]); break; }
      fences.push([open, close + 3]);
      fIdx = close + 3;
    }
    const inFence = (pos) => fences.some(([a, z]) => pos >= a && pos < z);
    const re = /\bfunction\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(b.text)) !== null) {
      if (inFence(m.index)) continue;
      const name = m[1];
      if (seen.has(name)) continue;
      // Kurung seimbang dari "(" sesudah nama fungsi.
      const openIdx = b.text.indexOf("(", m.index);
      let depth = 0, closeIdx = -1;
      for (let j = openIdx; j < b.text.length; j++) {
        if (b.text[j] === "(") depth++;
        else if (b.text[j] === ")") { depth--; if (depth === 0) { closeIdx = j; break; } }
      }
      if (closeIdx === -1) continue;
      const after = b.text.slice(closeIdx + 1);
      const looksLikeDef =
        /^\s*(external|public|internal|private|override|view|pure|payable|returns)\b/.test(after)
        || /^\s*\{/.test(after)
        || /^\s*;/.test(after);
      if (!looksLikeDef) continue;
      seen.add(name);
      // KALIBRASI R-COF-1b (sesi #33 — temuan Kiro F7): badan dikomentari
      // (`{` sebelum `;` pertama sesudah `)`) BUKAN trimming interface —
      // interface tidak bisa punya badan, jadi ini kode implementasi yang
      // dimatikan lalu ditempel di file interface.
      const braceIdx = after.indexOf("{");
      const semiIdx = after.indexOf(";");
      const hasBody = braceIdx !== -1 && (semiIdx === -1 || braceIdx < semiIdx);
      items.push({ name, startLine: b.startLine, endLine: b.endLine, text: b.text, hasBody });
    }
  }
  return items;
}

// Detektor commented-out-function (backlog kelas AMP-02, sesi 04:38 WIB
// 2026-11-14 — Amply: setDebtCeiling dikomentari UTUH di 3 file, jadi
// tidak ada jalur yang bisa mengubah debt ceiling; debtCeiling 0 semua
// reserve): blok komentar yang berisi DEFINISI fungsi utuh —
// `function NAME(...) <visibility/modifier> {` (multi-baris, dengan badan)
// atau `function NAME(...) external;` (deklarasi interface satu baris).
// Hanya definisi nyata yang memicu: sesudah ")" harus langsung ada kata
// kunci visibility/modifier/returns, "{" badan, atau ";" deklarasi.
// Prosa yang menyebut signature ("lihat function foo(uint256) untuk ...")
// TIDAK memicu — sesudah ")" tidak ada penanda definisi.
// Detektor level-FILE (bukan per-fungsi): fungsi yang dikomentari bukan
// fungsi hidup, jadi lokasinya memakai nama fungsi yang dikomentari.
function detectCommentedOutFunction(fileName, idStart, ctx) {
  // KALIBRASI R-COF-1 (sesi #33, 19 Nov 2026 — residual hunting Veno):
  // penyaringan kandidat interface-only TIDAK di sini, melainkan
  // pasca-klasifikasi di runPipeline — kandidat dari file interface-only
  // hanya dipertahankan bila baseline membuktikan fungsi itu memang ada
  // di upstream (lihat filter sesudah classifyUpstreamDiff).
  const items = listCommentedOutFunctions(ctx);
  return items.map((it, n) => normalizeCandidate({
    id: "FA-" + String(idStart + n).padStart(3, "0"),
    detector: "commented-out-function",
    title: "Whole function commented out (commented-out function)",
    location: { file: fileName, function: it.name },
    hypothesis: "Function " + it.name + " commented out ENTIRELY (comment block "
      + "line " + (it.startLine + 1) + "–" + (it.endLine + 1) + ") — "
      + "functionality that should exist is missing in "
      + "bytecode: no path can execute this logic.",
    preconditions: "The commented-out function really is load-bearing "
      + "(not a dead function / already replaced by another active path).",
    impact: "The disabled capability cannot be used: limits/permissions/"
      + "the setting this function controls can no longer be changed.",
    severityGuess: "Medium",
    evidence: "Definition of function " + it.name + " inside the comment block "
      + "(line " + (it.startLine + 1) + "–" + (it.endLine + 1) + "): "
      + it.text.replace(/\s+/g, " ").trim().slice(0, 140),
    toVerify: ["Read the full comment block: what function was disabled",
      "compare with upstream / the previous version (git history / diff)",
      "check whether a replacement path is still active elsewhere",
      "Fork PoC: call the path that depends on this function"],
    source: "pattern-scan",
    ...(it.hasBody ? { commentedHasBody: true } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Detektor enum-semantic-shift (detektor ke-12, backlog kelas AMP-03,
// sesi 16:38 WIB 2026-11-14 — Amply: enum InterestRateMode upstream
// {NONE, STABLE, VARIABLE} (VARIABLE=2) dipangkas jadi {NONE, VARIABLE}
// (VARIABLE=1). Integrator yang mengirim nilai mentah konvensi Aave (2)
// kena revert (Panic 0x21 / INVALID_INTEREST_RATE_MODE_SELECTED),
// sementara nilai 1 yang di upstream berarti STABLE diam-diam jadi
// utang VARIABLE di fork — compat break, bukan fund-loss.
// Detektor level-FILE, aktif HANYA bila opts.baseline tersedia (peta
// basename -> source upstream, bentuk yang sama dengan
// classifyUpstreamDiff): bandingkan definisi enum per nama; flag bila
// ada member yang bertahan TAPI nomor urutnya (nilai numerik implisit)
// bergeser. Penambahan member DI AKHIR saja aman (tidak menggeser nilai
// lama) dan TIDAK memicu; enum identik juga tidak memicu.
// Severity Low — mengikuti klasifikasi wasit jack atas AMP-03.
function extractEnums(source) {
  const clean = stripComments(source);
  const out = [];
  const re = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const members = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    if (members.length) out.push({ name: m[1], members });
  }
  return out;
}

function detectEnumSemanticShift(source, fileName, idStart, opts) {
  const baseline = opts && opts.baseline;
  if (!baseline) return [];
  const getBase = typeof baseline.get === "function"
    ? (k) => baseline.get(k)
    : (k) => baseline[k];
  const baseName = fileName.split("/").pop();
  const baseSrc = getBase(baseName);
  if (!baseSrc) return [];
  const targetEnums = extractEnums(source);
  const baseEnums = extractEnums(baseSrc);
  const baseByName = Object.create(null);
  for (const e of baseEnums) baseByName[e.name] = e;
  const hits = [];
  for (const te of targetEnums) {
    const be = baseByName[te.name];
    if (!be) continue;
    if (te.members.length < 2 || be.members.length < 2) continue;
    const shifts = [];
    const removed = be.members.filter((m) => !te.members.includes(m));
    const added = te.members.filter((m) => !be.members.includes(m));
    for (const m of te.members) {
      const bi = be.members.indexOf(m);
      const ti = te.members.indexOf(m);
      if (bi !== -1 && bi !== ti) shifts.push(m + ": " + bi + " → " + ti);
    }
    if (!shifts.length) continue; // nilai member yang bertahan utuh
    hits.push(normalizeCandidate({
      id: "FA-" + String(idStart + hits.length).padStart(3, "0"),
      detector: "enum-semantic-shift",
      title: "Pergeseran semantik enum vs baseline (" + te.name + ")",
      location: { file: fileName, function: te.name },
      hypothesis: "Enum " + te.name + " in this fork differs from "
        + "baseline " + baseName + ": surviving members shift "
        + "its numeric value (" + shifts.join(", ") + ")"
        + (removed.length ? "; removed: " + removed.join(", ") : "")
        + (added.length ? "; added: " + added.join(", ") : "")
        + ". Code/integrators sending raw values under the convention "
        + "upstream can hit a revert — or silently gains a meaning "
        + "that differs.",
      preconditions: "This enum is used cross-contract / via the ABI "
        + "(function parameter, event, or raw value from an integrator).",
      impact: "Compat break: raw enum value under the upstream convention "
        + "means something else / reverts in the fork — an integrator can silently "
        + "gets the wrong mode (e.g. variable debt, not stable).",
      severityGuess: "Low",
      evidence: "Baseline " + baseName + ": enum " + te.name + " {"
        + be.members.join(", ") + "}; fork: {" + te.members.join(", ")
        + "}; shifted value: " + shifts.join(", "),
      toVerify: ["Read this enum's usage across the codebase (function parameters / ABI)",
        "check whether the integrator / UI sends raw values",
        "compare with the upstream version this fork uses",
        "Fork PoC: call with a raw value under the upstream convention"],
      source: "pattern-scan",
    }));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Detektor oracle-passthrough-no-staleness (detektor ke-13, backlog kelas
// AMP-06, sesi 20:38 WIB 2026-11-14 — Amply: AmplyOracle meneruskan harga
// tanpa validasi umur data; konsumen (ValidationLogic, GenericLogic,
// EModeLogic, LiquidationLogic) memakai getAssetPrice tanpa cek staleness.
// Pola yang sama PERSIS ada di upstream AaveOracle v1.19.4
// (getAssetPrice: source.latestAnswer() + cek price > 0 SAJA) — jadi
// detektor ini menangkap KELAS-nya, sementara klasifikasi upstream-diff
// (di bawah) yang memutuskan by-design vs kandidat:
//   live-identical — fungsi upstream yang sama juga passthrough tanpa
//     cek staleness → by-design, bukan deviasi fork (kasus AMP-06).
//   live-divergent — upstream membaca harga yang sama DENGAN cek
//     staleness → fork MENGHAPUS cek itu: kandidat serius.
//   live-modified — fungsi ada di upstream tapi tidak membaca harga
//     sama sekali → fork menambah konsumsi oracle di fungsi ini.
//   absent — fungsi oracle baru, tidak ada di upstream.
// Cek harga != 0 SAJA BUKAN cek staleness (AaveOracle hanya itu, tetap
// passthrough). Severity Low — mengikuti klasifikasi wasit jack atas
// AMP-06 (spekulatif; probe live 14 Nov: semua feed fresh + nonzero).
// ---------------------------------------------------------------------------
// Pola baca harga dari oracle/feed eksternal.
// KALIBRASI review Kiro 15 Nov 2026 (sesi 04:38 WIB):
// - `latestRound(` DIHAPUS — Chainlink latestRound() mengembalikan round
//   id (uint80), BUKAN harga; sempat jadi false positive.
// - Ditambah `getPriceUnsafe(` (Pyth — justru varian tanpa guard),
//   `getUnderlyingPrice(` (Compound + fork), `getRoundData(`.
// - `getPriceNoOlderThan` SENGAJA tidak masuk — fungsi itu punya guard
//   bawaan (menolak harga lebih tua dari ambang), jadi bukan passthrough.
const PRICE_READ_RE = /\blatestRoundData\s*\(|\blatestAnswer\s*\(|\bgetAssetPrice\s*\(|\bgetAssetsPrices\s*\(|\bgetPrice\s*\(|\bgetPriceUnsafe\s*\(|\bgetUnderlyingPrice\s*\(|\bgetRoundData\s*\(|\blatestPrice\s*\(|\bpeek\s*\(/;

// Cek staleness: bandingkan updatedAt dengan block.timestamp (umur data
// di bawah ambang, ATAU umur data melewati ambang lalu bail/fallback),
// atau keyword heartbeat/stale/gracePeriod/sequencer. Bentuk bail
// (`age >= ambang → fallback`) JUGA dihitung guard — kalibrasi hunting
// RAAC 14 Nov 2026. Identifier camelCase (maxStaleTime) dicocokkan
// sebagai substring, bukan kata utuh.
// KALIBRASI review Kiro 15 Nov 2026 (semua terverifikasi vs pipeline):
// - Kurung di sekitar selisih umur DITERIMA: `(block.timestamp -
//   updatedAt) <= MAX_AGE` (P1 lama gagal karena `)` memutus pola).
// - Nama variabel umur lain DITERIMA: lastUpdate/lastUpdated.
// - Idiom lewat variabel `age` DITERIMA: `age = block.timestamp -
//   updatedAt; require(age <= MAX_AGE)` (butuh pelacakan 2 langkah).
// - Bentuk revert `updatedAt < block.timestamp - MAX_AGE` dan
//   `block.timestamp > updatedAt + MAX_AGE` DITERIMA (P3 lama hanya
//   `<`/`<=` ke arah berlawanan).
// - `updatedAt > block.timestamp` SAJA BUKAN guard (hanya menolak
//   timestamp masa depan) — P2 lama salah menganggapnya guard; P2 kini
//   mensyaratkan `block.timestamp - ...` di sisi kanan.
// - `answeredInRound == roundId` DIHAPUS dari guard — field deprecated,
//   hanya menjamin round selesai, BUKAN umur data.
// - `isBorrowAllowed` DIHAPUS dari keyword guard — itu sentinel
//   sequencer Aave, bukan cek umur harga; mempertahankannya membuat
//   validateBorrow tertekan sementara jalur likuidasi
//   (isLiquidationAllowed) tetap ter-flag — tidak konsisten.
// - Keyword diuji atas body TANPA string literal: pesan revert seperti
//   "stale price" bukan bukti cek (fixture H trap-vault sempat lolos
//   lewat 2 alasan sekaligus; string-nya diubah jadi "old price").
// BATAS DIKETAHUI: detektor function-scoped — guard yang hidup di fungsi
// lain (callee, helper, modifier) TIDAK terlihat; konsumen seperti itu
// tetap ter-flag dan harus digugurkan wasit dengan membaca oracle di
// belakangnya. Pembacaan harga yang hanya untuk event/view juga
// ter-flag (tidak dibedakan dari valuasi).
function stripStrings(body) {
  return body.replace(/"([^"\\]|\\.)*"/g, (m) => "\"" + " ".repeat(m.length - 2) + "\"");
}

const TS_VAR_RE = "(updatedAt|lastUpdate|lastUpdated|updated_at)";

function hasStalenessGuard(body) {
  const ts = TS_VAR_RE;
  // P1: block.timestamp - updatedAt (boleh dalam kurung) dibanding ambang.
  // Perbandingan terhadap literal 0 (mis. `> 0`) BUKAN guard — umur data
  // hampir selalu > 0 — jadi sisi kanan 0 dikecualikan.
  if (new RegExp("\\(?\\s*block\\.timestamp\\s*-\\s*" + ts + "\\s*\\)?\\s*(<|<=|>=|>)\\s*(?!0\\b)").test(body)) return true;
  // P2: updatedAt > block.timestamp - ambang (sisi kanan HARUS ada "- ...").
  if (new RegExp(ts + "\\s*(>|>=)\\s*block\\.timestamp\\s*-").test(body)) return true;
  // P3: block.timestamp dibanding updatedAt + ambang (kedua arah).
  if (new RegExp("block\\.timestamp\\s*(<|<=)\\s*" + ts + "\\s*\\+").test(body)) return true;
  if (new RegExp("block\\.timestamp\\s*(>|>=)\\s*" + ts + "\\s*\\+").test(body)) return true;
  // P4: updatedAt dibanding block.timestamp - ambang (bentuk revert).
  if (new RegExp(ts + "\\s*(<|<=)\\s*block\\.timestamp\\s*-").test(body)) return true;
  // P5: idiom lewat variabel umur: age = block.timestamp - updatedAt,
  // lalu age dibandingkan dengan ambang (kedua arah).
  const ageAssign = new RegExp("(\\w+)\\s*=\\s*\\(?\\s*block\\.timestamp\\s*-\\s*" + ts + "\\s*\\)?");
  const am = body.match(ageAssign);
  if (am && new RegExp("\\b" + am[1] + "\\s*(<|<=|>|>=)\\s*(?!0\\b)").test(body)) return true;
  // Keyword — atas body tanpa string literal.
  const noStr = stripStrings(body);
  if (/stale|staleness|heartbeat|gracePeriod|sequencerUp/i.test(noStr)) return true;
  return false;
}

function detectOraclePassthrough(fn, fileName, id) {
  if (!PRICE_READ_RE.test(fn.body)) return [];
  if (hasStalenessGuard(fn.body)) return [];
  const m = fn.body.match(PRICE_READ_RE);
  return [normalizeCandidate({
    id, detector: "oracle-passthrough-no-staleness",
    title: "Oracle price used without a staleness check",
    location: { file: fileName, function: fn.name },
    hypothesis: "Function " + fn.name + " reads the price ("
      + (m ? m[0].trim() : "?")
      + ") without checking the data's age (updatedAt vs block.timestamp / "
      + "answeredInRound) — if the feed stalls or the updater stops, "
      + "the stale price is still used for valuation/liquidation.",
    preconditions: "The feed/oracle behind this call can go stale "
      + "(updater stopped, sequencer down, feed not updated).",
    impact: "Collateral/debt valuation uses a stale price — wrong liquidation "
      + "or debt is valued too low/high if confirmed.",
    severityGuess: "Low",
    evidence: "Price-read call in function " + fn.name
      + " without a staleness check in the function body.",
    toVerify: ["Read the oracle implementation behind this call: "
      + "does it validate staleness itself (updatedAt/heartbeat)?",
      "check whether there is a PriceOracleSentinel / grace period on the usage path",
      "compare with upstream (baseline): if the pattern is identical "
      + "with upstream, this is by-design / a known issue, not a fork deviation",
      "live check: the feed's updatedAt vs the current block.timestamp",
      "RAISE to Medium only if all three hold: (1) the price is used "
      + "for collateral/debt valuation, liquidation, mint, or redeem; (2) "
      + "realistic staleness for that feed (long heartbeat, "
      + "latestAnswer deprecated, L2 without a sentinel); (3) there is no guard "
      + "di jalur lain (fallback oracle / sentinel / circuit breaker). "
      + "High only if a PoC shows the stale-price gap can be turned "
      + "becomes excess borrowing"],
    source: "pattern-scan",
  })];
}

// Detektor free-mem-pointer-no-rounding (detektor ke-14, backlog kelas
// HYP-01, sesi 20:38 WIB 2026-11-14 — RedStone ProxyConnector._prepareMessage
// + RedstoneConsumerBase._extractDataPackage/initByteArray: assembly
// `mstore(0x40, add(ptr, bytesCount))` tanpa pembulatan 32 byte.
// KALIBRASI (sesi BB 14 Nov sore): PoC Foundry 8/8 PASS membuktikan
// misalignment NYATA tapi TIDAK ADA korupsi data (memori EVM
// byte-addressable, alokasi relatif) — HYP-01 FALSIFIED sebagai bug.
// Detektor ini Info SAJA: penanda pola, bukan kandidat bug.
// Flag bila: blok assembly menulis free-memory pointer (mstore 0x40 /
// 64 / FREE_MEMORY_PTR) dengan nilai hasil add() yang menyebut ukuran
// data-dependent dan TIDAK ada idiom pembulatan 32 byte.
// KALIBRASI review Kiro 15 Nov 2026 (semua terverifikasi vs pipeline):
// - `size`/`count` TANPA batas kata salah cocok: "account" mengandung
//   "count", "WORD_SIZE" (konstanta 32) mengandung "size". Kini
//   case-sensitive dengan batas kata / akhiran camelCase: `\bsize\b`,
//   `Size\b` (payloadSize, byteCount → `Count\b`), `\bcount\b`,
//   `\blen\b` — "account"/"discount"/"WORD_SIZE" tidak lagi cocok,
//   "encodedFunctionBytesCount"/"payloadSize" tetap cocok.
// - `mload(` dihitung sinyal ukuran: di Yul, `mload(data)` atas `bytes
//   memory` membaca prefix panjang — idiom ukuran paling umum (tidak
//   ada `.length` di Yul). `mload(0x40)` / `mload(64)` /
//   `mload(FREE_MEMORY_PTR)` DIKECUALIKAN — itu membaca pointer-nya
//   sendiri, bukan ukuran.
// - ROUNDING_RE: pola div lama (`add(...,32)`) hampir tidak pernah cocok
//   di kode nyata — idiom memakai 31/0x1f; ditambah `mul(div(add(len,
//   31), 32), 32)`, hex `0x1F`/`0x20` (regex kini case-insensitive),
//   dan mask `sub(0, 32)`.
// - Nilai lewat variabel `let` dilacak satu langkah: `let end :=
//   add(ptr, len)` lalu `mstore(0x40, end)` ikut ter-flag; sebaliknya
//   `let rounded := and(add(len,31),not(31))` lalu `add(ptr, rounded)`
//   TIDAK ter-flag (sudah dibulatkan sebelum dipakai).
// - Literal desimal `mstore(64, ...)` ikut dikenali sebagai tulis
//   free-memory pointer.
// BATAS DIKETAHUI: rantai variabel > 1 langkah dan guard di helper
// tidak dilacak; pembulatan yang dihitung di fungsi lain tidak terlihat.
const ROUNDING_RE = /not\s*\(\s*(31|0x1f)\s*\)|0x[fF]{4,}[0-9a-fA-F]*e0|div\s*\(\s*add\s*\((?:[^()]|\([^()]*\))*,\s*(32|31|0x20|0x1f)\s*\)|shl\s*\(\s*5\s*,\s*shr\s*\(\s*5|sub\s*\(\s*0\s*,\s*(32|0x20)\s*\)/i;
const SIZE_IDENT_RE = /\.length\b|\bsize\b|Size\b|\bcount\b|Count\b|\blen\b|mload\s*\(\s*(?!0[xX]40\b|64\b|FREE_MEMORY_PTR\b)/;

function detectFreeMemPointer(fn, fileName, id) {
  if (!/assembly\s*\{/.test(fn.body)) return [];
  // Lacak assignment `let VAR := <expr>` satu langkah: variabel yang
  // nilainya hasil add() berukuran data-dependent (sized) vs yang sudah
  // dibulatkan (rounded).
  const roundedVars = new Set();
  const sizedVars = new Set();
  {
    const letRe = /let\s+(\w+)\s*:=/g;
    let lm;
    while ((lm = letRe.exec(fn.body)) !== null) {
      let i = lm.index + lm[0].length;
      let depth = 0, j = i, end = i;
      for (; j < fn.body.length; j++) {
        if (fn.body[j] === "(") depth++;
        else if (fn.body[j] === ")") { depth--; if (depth === 0) { end = j + 1; break; } }
        else if (fn.body[j] === ";" && depth === 0) { end = j; break; }
      }
      const expr = fn.body.slice(i, end);
      if (ROUNDING_RE.test(expr)) roundedVars.add(lm[1]);
      else if (/add\s*\(/.test(expr) && SIZE_IDENT_RE.test(expr)) sizedVars.add(lm[1]);
    }
  }
  const writeRe = /mstore\s*\(\s*(0x40|64|FREE_MEMORY_PTR)\s*,/g;
  let m;
  while ((m = writeRe.exec(fn.body)) !== null) {
    // Ambil ekspresi nilai sampai kurung tutup mstore (seimbang).
    let i = m.index + m[0].length;
    let depth = 1, j = i;
    for (; j < fn.body.length; j++) {
      if (fn.body[j] === "(") depth++;
      else if (fn.body[j] === ")") { depth--; if (depth === 0) break; }
    }
    const valueExpr = fn.body.slice(i, j);
    // Hapus variabel yang sudah dibulatkan dari ekspresi sebelum diuji:
    // `add(ptr, roundedSize)` bukan temuan bila roundedSize hasil
    // `and(add(len,31),not(31))`.
    let expr = valueExpr;
    for (const v of roundedVars) {
      expr = expr.replace(new RegExp("\\b" + v + "\\b", "g"), " ".repeat(v.length));
    }
    const trimmed = expr.trim();
    if (!/add\s*\(/.test(expr)) {
      // Nilai lewat variabel utuh: mstore(0x40, end).
      if (sizedVars.has(trimmed)) {
        return [normalizeCandidate({
          id, detector: "free-mem-pointer-no-rounding",
          title: "Free-memory pointer updated without 32-byte rounding (Info)",
          location: { file: fileName, function: fn.name },
          hypothesis: "Function " + fn.name + " meng-update free-memory pointer "
            + "in assembly with a value from variable `" + trimmed + "` that "
            + "contains a data-dependent size addition without rounding "
            + "ke kelipatan 32 byte.",
          preconditions: "The number of bytes added is not a multiple of 32 "
            + "(e.g. arbitrary payload length).",
          impact: "Info saja (terkalibrasi PoC Foundry 8/8 PASS, sesi BB "
            + "14 Nov): REAL misalignment but NO data corruption — "
            + "EVM memory is byte-addressable and allocation is relative; do not "
            + "raise it to Medium without new corruption proof.",
          severityGuess: "Info",
          evidence: "mstore to the free-memory pointer in function " + fn.name
            + " with the variable value `" + trimmed + "` (add() berukuran "
            + "data-dependent without the 32-byte rounding idiom).",
          toVerify: ["Read the full assembly block in " + fn.name,
            "check whether the added value is always a multiple of 32",
            "Fork PoC: sequential allocations with non-multiple-of-32 lengths, "
            + "check data integrity"],
          source: "pattern-scan",
        })];
      }
      continue;
    }
    if (!SIZE_IDENT_RE.test(expr)
      && ![...sizedVars].some((v) => new RegExp("\\b" + v + "\\b").test(expr))) continue;
    if (ROUNDING_RE.test(expr)) continue; // sudah dibulatkan
    return [normalizeCandidate({
      id, detector: "free-mem-pointer-no-rounding",
      title: "Free-memory pointer updated without 32-byte rounding (Info)",
      location: { file: fileName, function: fn.name },
      hypothesis: "Function " + fn.name + " meng-update free-memory pointer "
        + "in assembly with a data-dependent size addition without "
        + "rounding to a multiple of 32 bytes — the next free pointer "
        + "can be misaligned by 32 bytes.",
      preconditions: "The number of bytes added is not a multiple of 32 "
        + "(e.g. arbitrary payload length).",
      impact: "Info saja (terkalibrasi PoC Foundry 8/8 PASS, sesi BB "
        + "14 Nov): REAL misalignment but NO data corruption — "
        + "EVM memory is byte-addressable and allocation is relative; do not "
        + "raise it to Medium without new corruption proof.",
      severityGuess: "Info",
      evidence: "mstore to the free-memory pointer in function " + fn.name
        + " with an add(...) value of data-dependent size without the idiom "
        + "pembulatan 32 byte.",
      toVerify: ["Read the full assembly block in " + fn.name,
        "check whether the added value is always a multiple of 32",
        "Fork PoC: sequential allocations with non-multiple-of-32 lengths, "
        + "check data integrity"],
      source: "pattern-scan",
    })];
  }
  return [];
}

// Detektor vacuous-identity-check (detektor ke-16, kelas FUL-REF-01,
// sesi BB sore 15 Nov 2026 — Fulcrom ReferralManager.setTraderReferralCode:
// fungsi HANYA bisa dipanggil kontrak perantara (onlyRole(HANDLER_ROLE),
// pemanggil = PositionRouter) tapi memeriksa `affiliate == msg.sender`
// seolah msg.sender adalah trader — cek itu VACUOUS: msg.sender selalu
// router, tidak pernah trader, jadi trader bisa menyetel kode referral
// miliknya sendiri (self-referral). Bandingkan jalur user langsung
// setTraderReferralCodeByUser yang memeriksa `affiliate != msg.sender`
// dengan benar — di sana msg.sender MEMANG trader.
// Flag bila: (1) fungsi external/public dengan modifier pembatas penelepon
// ke perantara (lihat gerbang v2 di bawah); DAN (2) badan membandingkan
// pengirim (msg.sender / _msgSender() / alias lokal `address X = msg.sender`)
// dengan identifier lain (parameter, lokal, state, atau `address(...)`)
// — bukan address(0) / address(this) / tx.origin.
// Severity dari POLARITAS guard (kalibrasi v2): bypass (guard tak pernah
// aktif — `require(x != sender)`, `if (x == sender) revert/return`) =
// Medium; dos (guard selalu revert — `require(x == sender)`,
// `if (x != sender) revert/return`) = Low; operand identitas perantara
// itu sendiri (mis. `msg.sender == router`) = Info (redundan).
// KALIBRASI v2 (review silang Kiro Opus 5.5, 15 Nov 21:10 WIB — 30 kasus
// uji Kiro: v1 benar 6/30, 7 FP + 22 FN; 0 hit di korpus GMX/Aave/Uniswap):
//  - Gerbang diuji HANYA pada ekor signature sesudah daftar parameter —
//    `function restrict(...)` tidak lagi cocok (FP nama fungsi).
//  - Gerbang diperlebar: modifier camel dengan prefix/suffix
//    (onlyHandlerOrOwner, onlyHandlers, onlyPositionRouter,
//    onlyRouterPlugin), `onlyRoles` Solady, `onlyRole(Roles.ROUTER)`,
//    `onlyRole(keccak256("HANDLER_ROLE"))`, `onlyRole(handlerRole)`
//    (case-insensitive), peran baru (Controller/Forwarder/Gateway/Bridge/
//    Plugin/Executor/Adapter), guard di body (`isHandler[msg.sender]`,
//    `_checkRole(HANDLER_ROLE)`).
//  - `restrict(` DIPERTAHANKAN di ekor (bukan dibuang seperti saran Kiro)
//    — bukti Hyperbridge: HostManager.onAccept ber-modifier restrict dan
//    memang perantara; ekor-scoping sudah menutup FP nama-fungsinya.
//  - Substring nama peran ditolak: `onlyRole(GHOST_ROLE)` tidak cocok
//    (batas non-huruf sebelum kata peran); residu yang diakui:
//    `onlyRole(NON_ROUTER_ADMIN)` tetap cocok (`_` pemisah).
//  - `onlyHandlerAndAbove` (GMX v1, dipegang admin/EOA) SENGAJA tidak
//    dicakup; `onlyRole(ADMIN_ROLE)`/`onlyRole(KEEPER_ROLE)` tetap tidak
//    masuk daftar (admin/keeper bisa EOA — cek di sana bermakna).
//  - SEMUA perbandingan diperiksa (matchAll), bukan hanya yang pertama —
//    `require(msg.sender != address(this))` di awal tidak lagi menutupi
//    perbandingan kedua; operand `address(...)` dibuka (bukan dibuang
//    mentah — `address(owner)` kini tertangkap, `address(0)`/`address(this)`
//    tetap dilewati); operand berindeks (`codeOwners[c]`) dan bertitik
//    (`orders[k].handler`) ditangani; `tx.origin` sebagai operand dilewati
//    (hipotesis bypass salah untuknya).
//  - Alias pengirim dikenali: `_msgSender()` + lokal
//    `address caller = msg.sender;`.
// BATAS DIKETAHUI (belum dikerjakan — saran Kiro 5.3/5.4): guard yang
// mengizinkan panggilan langsung (modifier yang juga menerima EOA —
// butuh baca body modifier di file yang sama) tidak dikenali; perbandingan
// di helper internal 1 tingkat tidak di-inline (gaya GMX `_setCode`);
// peran perantara yang dipegang EOA + tumpang-tindih dengan end-user
// (deployer memegang semua peran) tidak bisa dibedakan tanpa call-graph;
// `NON_ROUTER_ADMIN` tetap cocok (residu di atas). Satu kandidat per
// fungsi (yang severity-nya tertinggi bila ada beberapa perbandingan).
const VIC_ROLE_WORDS = "Handler|Router|Relayer|Host|EntryPoint|Forwarder|Gateway|Bridge|Plugin|Controller|Executor|Adapter";
const VIC_MOD_CAMEL_RE = new RegExp("\\bonly\\w*?(?:" + VIC_ROLE_WORDS + ")\\w*\\b");
const VIC_MOD_ROLE_RE = new RegExp("\\bonlyRoles?\\s*\\(\\s*(?:[^)]*?[^A-Za-z])?(?:" + VIC_ROLE_WORDS + ")", "i");
const VIC_BODY_GUARD_RE = /\bis(?:Handler|Router|Relayer|Host)\s*\[\s*msg\.sender\s*\]|_checkRole\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?(?:HANDLER|ROUTER|RELAYER|HOST)[\w$]*\s*\)/i;
const VIC_OPERAND_SRC = "((?:address\\s*\\(\\s*)?[A-Za-z_$][\\w$]*(?:\\s*(?:\\[[^\\]]*\\]|\\.[A-Za-z_$][\\w$]*|\\(\\s*\\)))*(?:\\s*\\))?)";
const VIC_INTERMEDIARY_OPERAND_RE = /router|handler|relayer|host|entrypoint|forwarder|gateway|bridge|plugin|controller|executor|keeper|adapter|pool/i;

// Ekor signature: bagian sesudah `)` daftar parameter — modifier hidup
// di sini, bukan di nama fungsi.
function vicSignatureTail(fn) {
  const sig = fn.signature;
  const open = sig.indexOf("(");
  if (open === -1) return sig;
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") { depth--; if (depth === 0) return sig.slice(i + 1); }
  }
  return sig;
}

// Pola pengirim: msg.sender, _msgSender(), atau alias lokal
// `address X = msg.sender;` di badan fungsi.
function vicSenderPattern(fn) {
  const senders = ["msg\\.sender", "_msgSender\\s*\\(\\s*\\)"];
  const aliasRe = /\baddress\s+([A-Za-z_$][\w$]*)\s*=\s*(?:msg\.sender|_msgSender\s*\(\s*\))/g;
  let am;
  while ((am = aliasRe.exec(fn.body)) !== null) senders.push(am[1]);
  return "(?:" + senders.join("|") + ")";
}

function vicNormalizeOperand(raw) {
  return (raw || "").trim()
    .replace(/^address\s*\(\s*/, "").replace(/\s*\)$/, "");
}

// Konteks perbandingan: di dalam require( / if( yang belum ditutup
// (tanpa ; atau } di antaranya) — menentukan polaritas guard.
function vicContext(body, idx) {
  const before = body.slice(0, idx);
  if (/require\s*\([^;{}]*$/.test(before)) return "require";
  if (/if\s*\([^;{}]*$/.test(before)) return "if";
  return "other";
}

function detectVacuousIdentityCheck(fn, fileName, id) {
  if (/\b(internal|private)\b/.test(fn.signature)) return [];
  const tail = vicSignatureTail(fn);
  const camel = tail.match(VIC_MOD_CAMEL_RE);
  // KALIBRASI v2.1 (triase hunting RAAC, sesi ini): modifier `Supported*`
  // yang argumennya adalah parameter fungsi (mis.
  // `onlySupportedAdapter(adapter)`) memvalidasi PARAMETER — bukan
  // membatasi pemanggil. Fungsi seperti itu bisa dipanggil siapa pun
  // (bukan blacklist), jadi cek `msg.sender != onBehalfOf` di sana
  // BERMAKNA (self-repay vs third-party). Modifier semacam itu bukan
  // gerbang perantara — dikecualikan di sini (hanya bila namanya memuat
  // "Supported" + semua argumennya nama parameter; `onlyRouter(router)`
  // tetap dihitung gerbang — ambigu tanpa baca body modifier).
  let camelGate = camel && !/AndAbove/.test(camel[0]);
  if (camelGate && /Supported/i.test(camel[0])) {
    const callIdx = tail.indexOf(camel[0] + "(");
    if (callIdx !== -1) {
      let depth = 0, j = callIdx + camel[0].length;
      for (; j < tail.length; j++) {
        if (tail[j] === "(") depth++;
        else if (tail[j] === ")") { depth--; if (depth === 0) break; }
      }
      const args = tail.slice(callIdx + camel[0].length + 1, j)
        .split(",").map((a) => a.trim()).filter(Boolean);
      const params = functionParams(fn).split(",").map((p) => {
        const ids = p.trim().match(/[A-Za-z_$][\w$]*/g) || [];
        return ids[ids.length - 1];
      }).filter(Boolean);
      if (args.length && args.every((a) => {
        const mId = a.match(/^[A-Za-z_$][\w$]*/);
        return mId && params.includes(mId[0]);
      })) camelGate = false;
    }
  }
  const gate = camelGate
    || VIC_MOD_ROLE_RE.test(tail)
    || /\brestrict\s*\(/.test(tail)
    || VIC_BODY_GUARD_RE.test(fn.body.slice(0, 400));
  if (!gate) return [];
  const S = vicSenderPattern(fn);
  const re = new RegExp(VIC_OPERAND_SRC + "\\s*(==|!=)\\s*" + S
    + "|" + S + "\\s*(==|!=)\\s*" + VIC_OPERAND_SRC, "g");
  // Kumpulkan semua perbandingan; kembalikan SATU kandidat per fungsi
  // (severity tertinggi: Medium bypass > Low dos > Info redundan).
  let best = null;
  const rank = { Medium: 0, Low: 1, Info: 2 };
  for (const m of fn.body.matchAll(re)) {
    // Grup regex: 1=operand (alt 1), 2=operator (alt 1), 3=operator
    // (alt 2, sender-first), 4=operand (alt 2). `S` non-capturing —
    // JANGAN pakai m[5] (bug polaritas: op undefined → default Medium).
    const op = m[2] || m[3];
    const other = vicNormalizeOperand(m[1] || m[4]);
    if (!other) continue;
    // `address` saja (tanpa isi kurung) = kata kunci cast `address(0)` /
    // `address(this)` — OPERAND tidak menangkap isi kurungnya karena `0`
    // / `this` bukan identifier biasa; `address` tak mungkin identifier
    // user, jadi selalu lewati.
    if (/^(this|0|0x0+|msg\.sender|address)$/.test(other)) continue;
    if (other.includes("tx.origin")) continue;
    const ctx = vicContext(fn.body, m.index);
    let severityGuess, cls;
    if (VIC_INTERMEDIARY_OPERAND_RE.test(other)) {
      severityGuess = "Info"; cls = "info";
    } else if (ctx === "require" && op === "==") {
      severityGuess = "Low"; cls = "dos";
    } else if (ctx === "if" && op === "!=") {
      severityGuess = "Low"; cls = "dos";
    } else {
      severityGuess = "Medium"; cls = "bypass";
    }
    const cand = { other, op, ctx, cls, severityGuess, text: (m[0] || "").trim() };
    if (!best || rank[cand.severityGuess] < rank[best.severityGuess]) best = cand;
  }
  if (!best) return [];
  const gateText = (camel && !/AndAbove/.test(camel[0]) ? camel[0]
    : (tail.match(VIC_MOD_ROLE_RE) || ["?"])[0]);
  const hypothesis = best.cls === "dos"
    ? "Function " + fn.name + " can only be called by an intermediary contract ("
      + gateText + ") tapi memeriksa `" + best.other + " " + best.op
      + " msg.sender` (" + best.text + ") di " + best.ctx
      + " — msg.sender di sini selalu perantara, jadi guard ini SELALU "
      + "fails and the function never runs (functional DoS), not "
      + "bypass — check whether this function is the only path for "
      + "aksi itu."
    : best.cls === "info"
      ? "Function " + fn.name + " can only be called by an intermediary contract ("
        + gateText + ") and compares msg.sender with `" + best.other
        + "` (" + best.text + ") — `" + best.other + "` is the identity "
        + "the intermediary itself, so this check is redundant (always true) — "
        + "Info only, not a bypass."
      : "Function " + fn.name + " can only be called by an intermediary contract ("
        + gateText + ") but compares msg.sender with `" + best.other
        + "` (" + best.text + ") — msg.sender di sini selalu perantara, "
        + "never the end-user, so that identity check never "
        + "catch the intended case (e.g. self-referral passes).";
  return [normalizeCandidate({
    id, detector: "vacuous-identity-check",
    title: best.cls === "dos"
      ? "Identity guard that always reverts in a handler-only function"
      : best.cls === "info"
        ? "Check the identity redundant against the intermediary in the handler-only function"
        : "Check the vacuous msg.sender identity in the handler-only function",
    location: { file: fileName, function: fn.name },
    hypothesis,
    preconditions: "The function is called via an intermediary contract (handler / "
      + "router / relayer), not directly by the end-user.",
    impact: best.cls === "dos"
      ? "The function can never run via this path — the action that "
        + "that should be available (e.g. set referral, withdraw, liquidation) "
        + "blocked while this guard exists."
      : best.cls === "info"
        ? "No security impact — redundant check, noise only."
        : "The intended identity guard (e.g. the self-referral ban) "
          + "does not apply on this path — the rule can be bypassed from a call "
          + "intermediary if confirmed.",
    severityGuess: best.severityGuess,
    evidence: "Perbandingan msg.sender vs `" + best.other + "` in function "
      + fn.name + " that carries an intermediary modifier (" + best.text
      + "; konteks " + best.ctx + ", kelas " + best.cls + ").",
    toVerify: ["Read who holds that intermediary role (contract vs EOA) "
      + "and who calls this function",
      "compare with the direct call path (if any) — whether "
      + "does the same check mean anything there?",
      "Fork PoC: call via the intermediary with its own identity as "
      + "parameters and see whether the guard catches it"],
    source: "pattern-scan",
  })];
}

// ---------------------------------------------------------------------------
// Detektor dead-config-storage (detektor ke-17, backlog kelas R-02, sesi
// BB sore 15 Nov 2026 — Fulcrom VaultPriceFeedV2: `favorPrimaryPrice` +
// `spreadThresholdBasisPoints` ditulis di initialize/setter tapi tak pernah
// dibaca di getPriceV1 (upstream GMX v1 MEMBACA favorPrimaryPrice di
// getPrice — fork kehilangan wiring-nya); plus statement no-op
// `secondaryPriceFeed;` di initialize (bau yang sama: config disebut tapi
// tidak dipakai — statement itu sendiri BUKAN baca/tulis, detektor ini
// mengklasifikasikannya "noop").
// Flag bila: state var (skalar / array / mapping / tipe kontrak) yang
// ditulis ≥1× di luar deklarasinya tapi TIDAK PERNAH dibaca di file ini.
// Severity Low — mengikuti klasifikasi wasit jack atas R-02 (dead config
// governance/oracle; dampak hanya bila operator mengira config itu berlaku).
// KALIBRASI v2 (review silang Kiro Opus 5.5, 16 Nov 2026 — 36 kasus
// adversarial: v1 benar 15/36, 6 FP + 13 FN + 2 salah-klasifikasi upstream;
// prototipe v2 Kiro 29/33, 4 sisa turun ke Info):
//  - P4: deklarasi event/error, fungsi tanpa badan, dan kontrak interface
//    dilewati (param senama bukan baca — N11/N12/U1).
//  - P5: shadowing lokal dilonggarkan (deklarasi di tengah baris, header
//    for, tuple lokal — N9/N10/N13) + scope per-BLOK, bukan per-fungsi
//    (baca state var sesudah blok `if` tetap dihitung — F17) + nama
//    param/return dari signature menutupi (named return — N7).
//  - P6: rantai tulis — `sstore(x.slot, v)` tulis (N1); `a[i].f = v`
//    tulis (N4); `list.push/pop(...)` tulis (N5); tuple LHS
//    `(fee, cap) = ...` tulis (N6); member-call lain baca.
//  - P7: cakupan per-KONTRAK — var senama di kontrak lain dalam file
//    yang sama bukan baca/tulis var ini (N3/U2); baca di kontrak turunan
//    (langsung/transitif) dalam file yang sama TETAP dihitung (F5).
//  - P1: baca sebagai member-call (`.name(` di kontrak/instance lain)
//    dan deklarasi `override` TIDAK menghapus hit — turun ke Info
//    (F1/F14; 10 hit korpus GMX). Project-pass lintas-file (sesi 04:38 WIB
//    2026-11-16) menghapus kandidat yang terbukti dibaca lintas-file;
//    sejak sesi 16:38 WIB 2026-11-17 ia JUGA mencabut alasan F6
//    (abstract+internal) dari kandidat yang dipertahankan bila korpus
//    penuh tidak menemukan pembaca — kembali ke Low (residual (3)).
//  - P3: tulis HANYA di constructor → dilewati (Timelock.mintReceiver).
//  - P10: assembly `sload/sstore` slot mentah (angka) → hit dipertahankan
//    tapi turun ke Info (F3 — slot angka tak membuktikan var mana).
//  - P11: allowlist metadata ERC20 — `name/symbol/decimals` public di
//    file yang menyebut ERC20 dilewati (11 hit korpus GMX).
//  - P8: string literal di-mask sebelum analisis kemunculan (nama hanya
//    di dalam string bukan baca — N8); stripComments kini kenal `'...'`.
 //  - N2: param modifier menutupi nama (baca di badan modifier = param,
//    bukan state var); baca state var di badan modifier TETAP dihitung
//    (F15).
//  - F18: deklarasi di dalam `receive()`/`fallback()` bukan state var
//    (extractFunctions tidak menangkap keduanya).
// BATAS DIKETAHUI (v2): file-scoped — var `public` bisa dibaca kontrak
// lain lewat auto-getter (hanya member-call yang terdeteksi; bila getter
// dibaca dari file lain tanpa `.name(` di file ini, tetap Low — butuh
// project-pass); baca lewat assembly `sload` slot bernama terpetakan,
// slot mentah tidak; shadowing lokal dihitung per-baris di dalam blok;
// deklarasi lokal mapping/tuple tidak dikenali sebagai bayangan.
// Klasifikasi upstream-diff (di classifyUpstreamDiff): baseline membaca
// var ini → live-divergent (fork menghapus wiring — kandidat serius);
// baseline juga tidak membaca → live-identical (by-design); var tidak
// ada di baseline → absent.
// ---------------------------------------------------------------------------
const STATE_TYPE_SRC = "(?:u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes(?:[1-9]|[12][0-9]|3[0-2])?|bool|address(?:\\s+payable)?|string|[A-Z][A-Za-z0-9_$]*)";
// R9.1 (kalibrasi wasit atas review Kiro R9): pola kepala deklarasi
// lokal — dipakai localDeclRe (project-pass) + ldRe (detektor).
// Daftar tipe DIPERLEBAR: ukuran int/uint penuh (8..256 kelipatan 8 —
// uint24 standar Uniswap, F1), bytes1-32, address payable (F2),
// mapping(...) storage (F3), dan tipe user-defined huruf kecil yang
// WAJIB disertai location (memory/storage/calldata, F4) — tanpa
// location, `return fee` akan cocok sebagai deklarasi. Batas: mapping
// bersarang >1 level tak dikenali (konservatif = baca dihitung,
// kandidat dibuang).
const LOCAL_DECL_HEAD_SRC = "(?:"
  + "(?:u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?"
  + "|bytes(?:[1-9]|[12][0-9]|3[0-2])?|bool|string"
  + "|address(?:\\s+payable)?"
  + "|mapping\\s*\\((?:[^()]|\\([^()]*\\))*\\)"
  + "|[A-Z][A-Za-z0-9_$]*)"
  + "(?:\\s*\\[[^\\]]*\\])*\\s+(?:storage\\s+|memory\\s+|calldata\\s+)?"
  + "|[A-Za-z_$][\\w$]*\\s+(?:storage\\s+|memory\\s+|calldata\\s+)"
  + ")";
const STATE_VIS_SRC = "(?:public|private|internal|immutable|constant|override|transient)";
const STATE_SCALAR_RE = new RegExp("\\b" + STATE_TYPE_SRC + "\\s*(?:\\[[^\\]]*\\])*\\s*(?:" + STATE_VIS_SRC + "\\s+)*([A-Za-z_][A-Za-z0-9_$]*)\\s*(?:=\\s*[^;]+)?;", "g");
const STATE_MAPPING_RE = new RegExp("\\bmapping\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?:" + STATE_VIS_SRC + "\\s+)*([A-Za-z_][A-Za-z0-9_$]*)\\s*;", "g");

function lineOfSrc(src, idx) {
  return src.slice(0, idx).split("\n").length - 1;
}

// --- Helper kalibrasi v2 detektor dead-config-storage (review Kiro 16 Nov) ---

// Masking string literal: isi "..." / '...' diganti spasi (panjang dan
// newline dipertahankan) supaya nama var yang hanya muncul di dalam string
// (mis. pesan error "fee too high" — N8) tidak dihitung sebagai baca.
function maskStringLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += " "; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) { out += "  "; i += 2; }
        else { out += src[i] === "\n" ? "\n" : " "; i++; }
      }
      if (i < n) { out += " "; i++; }
    } else {
      out += ch; i++;
    }
  }
  return out;
}

function lineStartOffsets(src) {
  const offs = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") offs.push(i + 1);
  return offs;
}

// Indeks `}` yang menutup blok yang dibuka di openIdx (`{`), -1 bila tak ada.
function blockEndIndex(src, openIdx) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) return i; }
  }
  return -1;
}

// Indeks `{` pembuka blok terdalam yang melingkupi idx (mencari mundur
// sampai floorIdx), -1 bila idx berada langsung di badan fungsi/kontrak.
function enclosingBlockOpenIndex(src, idx, floorIdx) {
  let d = 0;
  for (let i = idx - 1; i >= floorIdx; i--) {
    if (src[i] === "}") d++;
    else if (src[i] === "{") { if (d === 0) return i; d--; }
  }
  return -1;
}

// Residual (9): apakah kemunculan di occIdx ditutupi deklarasi lokal
// senama yang MASIH BERLAKU di titik itu? Deklarasi lokal hanya menutupi
// sampai `}` penutup blok tempatnya dideklarasi — cek prefix fungsi yang
// lama salah menutupi baca state var SESUDAH blok bersarang yang
// mendeklarasi lokal senama menutup (baca lintas-file terlewat,
// kandidat dead-config yang sebenarnya hidup ikut tertahan). Pola sama
// dengan shadowRanges P5 di analyzeStateVar. Batas: deklarasi tanpa
// kurung kurawal (`if (x) uint256 fee = 1;`, init `for`) diperlakukan
// menutupi sampai akhir fungsi (konservatif, sama seperti sebelumnya).
function isShadowedByLocalDecl(clean, fnStartIdx, fnEndIdx, occIdx, name, localDeclRe) {
  const re = new RegExp(localDeclRe.source, "g");
  const prefix = clean.slice(fnStartIdx, occIdx);
  let m;
  while ((m = re.exec(prefix)) !== null) {
    const declNameIdx = fnStartIdx + m.index + m[0].lastIndexOf(name);
    const range = localDeclShadowRange(clean, declNameIdx, fnStartIdx, fnEndIdx);
    if (range && occIdx >= range.start && occIdx <= range.end) return true;
  }
  return false;
}

// Rentang bayangan SATU deklarasi lokal: {start, end} (R9.1, kalibrasi
// wasit atas review Kiro R9).
// - start = `;` penutup pernyataan deklarasi (F8): `fee` di RHS
//   initializer (`uint256 fee = fee * 2`) masih merujuk ke state var.
//   Bila tak ada `;` (kode terpotong), start = nama deklarasi.
// - end: deklarasi di dalam (...) — for-init, try-returns, catch-param,
//   named return/param — berakhir di akhir blok {} berikut atau akhir
//   pernyataan berikut (F6/F7); selebihnya akhir blok pelingkup.
//   Khusus for-init, `;` pemisah header adalah awal bayangan: kondisi
//   + increment membaca lokal, sedangkan RHS initializer (sebelum `;`
//   pertama) membaca state var.
function localDeclShadowRange(clean, declNameIdx, fnStartIdx, fnEndIdx) {
  // Apakah deklarasi berada di dalam (...)?
  let depth = 0, parenOpen = -1;
  for (let i = declNameIdx - 1; i >= fnStartIdx; i--) {
    const ch = clean[i];
    if (ch === ")") depth++;
    else if (ch === "(") { if (depth === 0) { parenOpen = i; break; } depth--; }
    else if (ch === "{" || ch === "}" || ch === ";") break;
  }
  // Paren tuple-deklarasi (`(uint256 fee, uint256 cap) = ...`) BUKAN
  // paren cakupan: `(`-nya didahului `{`/`;`/`,`/awal, bukan
  // identifier/keyword (for/returns/catch/nama fungsi) — perlakukan
  // sebagai kasus biasa (lokal hidup sampai akhir blok).
  if (parenOpen !== -1) {
    let q = parenOpen - 1;
    while (q >= fnStartIdx && /\s/.test(clean[q])) q--;
    if (q < fnStartIdx || !/[\w$]/.test(clean[q])) parenOpen = -1;
  }
  if (parenOpen !== -1) {
    // Tutup paren pelingkup; cari `;` pemisah header (for-init) sebelum `)`.
    let d = 0, close = -1, headerSep = -1;
    for (let i = parenOpen; i < clean.length; i++) {
      if (clean[i] === "(") d++;
      else if (clean[i] === ")") { d--; if (d === 0) { close = i; break; } }
      else if (clean[i] === ";" && d >= 1 && headerSep === -1) headerSep = i;
    }
    if (close === -1) return { start: declNameIdx, end: fnEndIdx };
    const start = headerSep === -1 ? close : headerSep;
    let j = close + 1;
    while (j < clean.length && /\s/.test(clean[j])) j++;
    if (clean[j] === "{") {
      const end = blockEndIndex(clean, j);
      return { start, end: end === -1 ? fnEndIdx : end };
    }
    // Tanpa blok: akhir pernyataan berikut (`;` kedalaman brace 0).
    let bd = 0;
    for (let k = close + 1; k < clean.length; k++) {
      if (clean[k] === "{") bd++;
      else if (clean[k] === "}") { if (bd === 0) break; bd--; }
      else if (clean[k] === ";" && bd === 0) return { start, end: k };
    }
    return { start, end: fnEndIdx };
  }
  // Kasus biasa: start = `;` penutup pernyataan deklarasi.
  let bd = 0, stmtEnd = -1;
  for (let i = declNameIdx; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") bd++;
    else if (ch === "}") { if (bd === 0) break; bd--; }
    else if (ch === ";" && bd === 0) { stmtEnd = i; break; }
  }
  const start = stmtEnd === -1 ? declNameIdx : stmtEnd;
  const blockOpen = enclosingBlockOpenIndex(clean, declNameIdx, fnStartIdx);
  const end = blockOpen === -1 ? fnEndIdx : blockEndIndex(clean, blockOpen);
  return { start, end: end === -1 ? fnEndIdx : end };
}

// Apakah kemunculan di idx adalah NAMA deklarasi lokal (bukan baca)?
// Teks tepat sebelum nama harus berakhir dengan pola kepala deklarasi
// (tipe + location opsional). Dipakai R9.1: nama deklarasi yang diikuti
// `;`/`)`/`,` (`uint256 fee;`, `returns (uint256 fee)`, catch-param)
// diklasifikasi "read" oleh classifyVarOccurrence bila tak dicek.
function isLocalDeclName(clean, idx) {
  const before = clean.slice(Math.max(0, idx - 300), idx);
  return new RegExp("(?<![\\w$])" + LOCAL_DECL_HEAD_SRC + "$").test(before);
}

// Rentang blok `assembly { ... }` (char): kemunculan telanjang nama var
// di dalamnya adalah variabel Yul, bukan baca state var (R9.1/F10) —
// sejak Solidity 0.7 nama state var telanjang tak valid di Yul; baca
// nyata lewat `.slot`/`.offset` tetap dihitung (dicek pemanggil).
function assemblySpans(src) {
  const spans = [];
  const re = /\bassembly\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let brace = -1;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      if (src[i] === "{") { brace = i; break; }
      if (src[i] === ";") break;
    }
    if (brace === -1) continue;
    const end = blockEndIndex(src, brace);
    if (end === -1) continue;
    spans.push({ start: brace, end });
  }
  return spans;
}

// R9.1 (F9): varian berbasis indeks CHAR (alasan sama seperti
// enclosingFunctionAtIdx — modifier + fungsi sebaris).
function enclosingModifierAtIdx(mods, idx) {
  for (const md of mods || []) {
    if (typeof md.start === "number" && typeof md.end === "number") {
      if (idx >= md.start && idx <= md.end) return md;
    }
  }
  return null;
}

// Rentang kontrak/library/interface: [{start, end, kind, name, parents}].
// Dipakai cakupan per-kontrak (P7) + lewati interface (P4).
function contractSpans(src) {
  const out = [];
  const re = /\b(contract|library|interface)\s+([A-Za-z_$][\w$]*)\s*(?:is\b([^{]*?))?\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const braceIdx = m.index + m[0].lastIndexOf("{");
    const end = blockEndIndex(src, braceIdx);
    if (end === -1) continue;
    const parents = m[3]
      ? m[3].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
      : [];
    out.push({ start: m.index, end, kind: m[1], name: m[2], parents });
  }
  return out;
}

// Normalisasi nama kontrak untuk pencocokan fallback: sufiks versi
// di ujung nama dihapus (VaultPriceFeedV2 → VaultPriceFeed) — fork
// sering me-rename file + kontrak sekaligus.
function normContractName(s) {
  return String(s || "").replace(/V?\d+$/, "");
}

// Semua nama kontrak/library di source (interface DIKELUARKAN —
// interface tak punya state var dan namanya (mis. IERC20) rawan
// memasangkan file yang salah). Dipakai fallback rename multi-kontrak
// (residual #2 review Kiro detektor #17, sesi 16 Nov 2026): dulu hanya
// kontrak PERTAMA di file yang dipakai, sehingga file multi-kontrak
// bisa salah pasang bila kontrak target bukan yang pertama.
function listContractNames(src) {
  return contractSpans(src)
    .filter((s) => s.kind !== "interface")
    .map((s) => s.name);
}

// Nama struct yang dideklarasikan di source — untuk membedakan tipe
// kontrak/interface (address-typed) dari tipe struct saat menilai
// `ident.balance` polos (R19.2, sesi 04:38 WIB 18 Nov 2026).
function structNamesOf(src) {
  const out = new Set();
  const re = /\bstruct\s+([A-Za-z_$][\w$]*)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

// R19.4 (sesi 16:38 WIB 18 Nov 2026 — residual A17/A19 TERBUKTI):
// nama interface standar ERC — secara definisi bertipe alamat, walau
// definisinya tidak ada di korpus (dependencies OZ dikecualikan dari
// hunting). Struct senama di file ini tetap menang (cek structNames
// di isAddressTypeName di bawah) — allowlist tidak menembus struct.
// Apakah sebuah NAMA TIPE address-typed: `address` / `address payable`,
// atau nama kontrak/interface yang dideklarasikan di file ini. Struct
// (namanya ada di structNames) dan primitif lain BUKAN address-typed;
// tipe array (`address[]`) juga bukan — `arr.balance` bukan Solidity valid.
const WELL_KNOWN_INTERFACE_TYPES = new Set([
  "IERC20", "IERC20Metadata",
  "IERC721", "IERC721Metadata", "IERC721Enumerable", "IERC721Receiver",
  "IERC1155", "IERC1155MetadataURI", "IERC1155Receiver",
  "IERC4626", "IERC165", "IERC777", "IERC2981",
  "IERC3156FlashBorrower", "IERC3156FlashLender",
  "IWETH", "IWETH9",
  "ERC20", "ERC721", "ERC1155",
]);
function isAddressTypeName(typeName, contractTypeNames, structNames) {
  if (!typeName) return false;
  const t = String(typeName).replace(/\s+/g, " ").trim();
  if (t.indexOf("[") !== -1) return false;
  if (t === "address" || t === "address payable") return true;
  if (structNames && structNames.has(t)) return false;
  if (WELL_KNOWN_INTERFACE_TYPES.has(t)) return true;
  return !!contractTypeNames && contractTypeNames.has(t);
}

// Kontrak pemilik baris tertentu (0-based) di source — nama kontrak
// yang span-nya melingkupi baris itu, null bila di luar semua kontrak.
function ownerContractAtLine(src, line) {
  if (typeof line !== "number") return null;
  for (const s of contractSpans(src)) {
    if (s.kind === "interface") continue;
    const startLine = lineOfSrc(src, s.start);
    const endLine = lineOfSrc(src, s.end);
    if (line >= startLine && line <= endLine) return s.name;
  }
  return null;
}

// Modifier + nama parameternya: [{startLine, endLine, paramNames}].
// Param modifier menutupi nama state var (N2); baca state var di badan
// modifier tetap dihitung (F15).
function scanModifiers(src) {
  const out = [];
  const re = /\bmodifier\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0, j = m.index + m[0].length - 1, paramEnd = -1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { paramEnd = j; break; } }
    }
    if (paramEnd === -1) continue;
    const params = src.slice(m.index + m[0].length, paramEnd);
    const paramNames = params.split(",").map((s) => {
      const toks = s.trim().split(/\s+/).filter(Boolean);
      return toks.length >= 2 ? toks[toks.length - 1] : null;
    }).filter(Boolean);
    let brace = -1;
    for (let k = paramEnd + 1; k < src.length; k++) {
      if (src[k] === "{") { brace = k; break; }
      if (src[k] === ";") break;
    }
    if (brace === -1) continue;
    const end = blockEndIndex(src, brace);
    if (end === -1) continue;
    out.push({
      // R22: nama modifier ikut disertakan (D22 butuh badan modifier by name).
      name: m[1],
      startLine: lineOfSrc(src, m.index),
      endLine: lineOfSrc(src, end),
      paramNames,
      // R9.1 (F11): indeks char awal kata kunci `modifier` + akhir `}`.
      start: m.index,
      end,
    });
  }
  return out;
}

// Rentang badan `receive()` / `fallback()` — deklarasi di dalamnya adalah
// variabel lokal, bukan state var (F18; extractFunctions tak menangkap
// keduanya karena tanpa kata kunci `function`).
function findSpecialFnSpans(src) {
  const spans = [];
  const re = /\b(?:receive|fallback)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0, j = m.index + m[0].length - 1, close = -1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close === -1) continue;
    let brace = -1;
    for (let k = close + 1; k < src.length; k++) {
      if (src[k] === "{") { brace = k; break; }
      if (src[k] === ";") break;
    }
    if (brace === -1) continue;
    const end = blockEndIndex(src, brace);
    if (end === -1) continue;
    // R9.1 (F12): indeks char ikut disertakan (dulu hanya baris).
    spans.push({ startLine: lineOfSrc(src, brace), endLine: lineOfSrc(src, end), start: brace, end });
  }
  return spans;
}

// Nama param + named return dari sebuah signature (sudah dinormalisasi
// spasi oleh extractFunctions): tiap item `TYPE [loc] name` → name;
// item tanpa nama (hanya tipe) diabaikan.
function signatureNames(sig) {
  const names = [];
  const sections = [];
  const open = sig.indexOf("(");
  if (open !== -1) {
    let depth = 0, close = -1;
    for (let i = open; i < sig.length; i++) {
      if (sig[i] === "(") depth++;
      else if (sig[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close !== -1) sections.push(sig.slice(open + 1, close));
  }
  const ret = sig.match(/\breturns\s*\(/);
  if (ret) {
    const ro = sig.indexOf("(", ret.index);
    let depth = 0, close = -1;
    for (let i = ro; i < sig.length; i++) {
      if (sig[i] === "(") depth++;
      else if (sig[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close !== -1) sections.push(sig.slice(ro + 1, close));
  }
  for (const sec of sections) {
    for (const item of sec.split(",")) {
      const toks = item.trim().split(/\s+/).filter(Boolean);
      if (toks.length < 2) continue;
      const last = toks[toks.length - 1].replace(/\[.*\]$/, "");
      if (/^(memory|calldata|storage)$/.test(last)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(last)) names.push(last);
    }
  }
  return names;
}

// Rentang yang dilewati analisis dead-config (P4/P9): deklarasi event /
// error, deklarasi fungsi tanpa badan, dan seluruh kontrak interface.
// Sesudah `)` penutup, hanya boleh ada karakter bukan `{` sebelum `;` —
// supaya badan fungsi yang berisi `;` tidak ikut terlewat.
function skipSpansForDeadConfig(clean, contracts) {
  const spans = [];
  const pushRe = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(clean)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  };
  pushRe(/\b(?:event|error)\s+[A-Za-z_$][\w$]*\s*\([^;{]*\)\s*;/g);
  pushRe(/\bfunction\s+[A-Za-z_$][\w$]*\s*\([^;{]*\)[^;{]*;/g);
  pushRe(/\bmodifier\s+[A-Za-z_$][\w$]*\s*\([^;{]*\)[^;{]*;/g);
  for (const c of contracts) {
    if (c.kind === "interface") spans.push({ start: c.start, end: c.end });
  }
  return spans;
}

// Rentang baris blok `struct NAME { ... }` / `modifier NAME(...) { ... }`
// — deklarasi di dalamnya (field struct, variabel lokal modifier) bukan
// state var. R5: tiap span juga membawa indeks char `start` (kurung `{`
// pembuka) dan `end` (kurung `}` penutup) supaya pemakaian yang butuh
// rentang char (scanStateVarDecls, analyzeStateVar, cabang inheritance
// project-pass) tidak perlu mengonversi baris→char sendiri.
function findBlockSpans(clean, keyword) {
  const spans = [];
  const re = new RegExp("\\b" + keyword + "\\s+[A-Za-z_][A-Za-z0-9_$]*", "g");
  let m;
  while ((m = re.exec(clean)) !== null) {
    let brace = -1;
    for (let i = m.index + m[0].length; i < clean.length; i++) {
      if (clean[i] === "{") { brace = i; break; }
      if (clean[i] === ";") break;
    }
    if (brace === -1) continue;
    let d = 0, end = brace;
    for (; end < clean.length; end++) {
      if (clean[end] === "{") d++;
      else if (clean[end] === "}") { d--; if (d === 0) break; }
    }
    spans.push({ startLine: lineOfSrc(clean, brace), endLine: lineOfSrc(clean, end), start: brace, end });
  }
  return spans;
}

// Pindai deklarasi state var: [{name, nameIndex, line, immutable, constant}].
// Nama diambil lewat regex berjangkar akhir-match (nama = identifier
// terakhir sebelum `;` / `= ...;`) supaya initializer yang menyebut nama
// lain (mis. `= maxSize;`) tidak salah dibaca sebagai nama.
function scanStateVarDecls(clean) {
  const out = [];
  const seen = new Set();
  // R5-7b (kalibrasi lanjutan review Kiro): string literal di-mask dulu
  // — teks di dalam string yang mirip deklarasi (`"uint256 ghost;"`)
  // sebelumnya tertangkap sebagai var PHANTOM dan membayangi rantai
  // inheritance di project-pass (baca warisan tak dikenali). Masking
  // mempertahankan panjang/newline sehingga nameIndex/line tetap benar;
  // deklarasi asli tidak mungkin berada di dalam string.
  const src = maskStringLiterals(clean);
  // R5 (residual 5 review kalibrasi project-pass): deklarasi di dalam
  // blok struct adalah FIELD struct, bukan state var — tanpa filter ini
  // field senama var dead ikut tertangkap sebagai "var" kontrak dan
  // men-shadow seluruh rantai inheritance di project-pass (over-shadow),
  // serta mengacaukan klasifikasi baseline di classifyUpstreamDiff.
  const structSpans = findBlockSpans(src, "struct");
  const inStruct = (idx) => structSpans.some((s) => idx >= s.start && idx <= s.end);
  for (const re of [STATE_MAPPING_RE, STATE_SCALAR_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      // `(?![>])` sesudah `=`: panah mapping `=>` BUKAN assignment —
      // tanpa ini, `mapping(address => uint256) public deadMap;` salah
      // dibaca sebagai var bernama `address` (bug tes mapping 15 Nov).
      const nm = m[0].match(/([A-Za-z_][A-Za-z0-9_$]*)\s*(?:=(?![>])\s*[^;]+)?;$/);
      if (!nm) continue;
      const name = nm[1];
      // R19.2 (sesi 04:38 WIB 18 Nov 2026): simpan juga NAMA TIPE
      // deklarasi — dipakai runPipeline untuk menghitung state var
      // address-typed (penunjang `ident.balance` polos di D19).
      const typeM = m[0].match(/^\s*([A-Za-z_$][\w$]*(?:\s+payable)?(?:\s*\[[^\]]*\])?)/);
      const type = typeM ? typeM[1].replace(/\s+/g, " ") : "";
      const nameIndex = m.index + nm.index;
      if (inStruct(nameIndex)) continue; // R5: field struct, bukan state var
      const key = name + "@" + nameIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name, nameIndex, type,
        line: lineOfSrc(src, nameIndex),
        immutable: /\bimmutable\b/.test(m[0]),
        constant: /\bconstant\b/.test(m[0]),
        isPublic: /\bpublic\b/.test(m[0]),
        override: /\boverride\b/.test(m[0]),
      });
    }
  }
  out.sort((a, b) => a.nameIndex - b.nameIndex);
  return out;
}

// R9.1 (F9): varian berbasis indeks CHAR — dua fungsi sebaris berbagi
// startLine/endLine, jadi pencarian berbasis baris bisa mengembalikan
// fungsi yang salah (param fungsi tetangga ikut menutupi).
function enclosingFunctionAtIdx(fns, idx) {
  for (const fn of fns) {
    if (typeof fn.startIndex === "number" && typeof fn.endIndex === "number") {
      if (idx >= fn.startIndex && idx <= fn.endIndex) return fn;
    }
  }
  return null;
}

function functionParams(fn) {
  const sig = fn.signature;
  const open = sig.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") { depth--; if (depth === 0) return sig.slice(open + 1, i); }
  }
  return "";
}

function hasParamNamed(fn, name) {
  return new RegExp("\\b" + name + "\\b").test(functionParams(fn));
}

// Klasifikasi SATU kemunculan nama var: "read" | "write" | "noop" | "skip"
// | "member-call".
// - "noop": statement utuh `name;` (kasus Fulcrom `secondaryPriceFeed;`).
// - "skip": akses member objek lain (`obj.name`), kecuali `this.name`.
// - "member-call": `.name(` — getter dipanggil di instance/kontrak lain
//   (P1: hit dipertahankan tapi turun ke Info, bukan dihapus).
// - "write": `name = ...` / `+=` / `++` / `delete name` / `sstore(name.slot, ...)`
//   / rantai `name[k].field = ...` / `name.push/pop(...)` / tuple LHS
//   `(name, ...) = ...` (P6).
// - "read": sisanya (require/if/return/emit/argumen/`name[k]`/`.slot`/
//   `sload(name.slot)` / member-call lain).
function classifyVarOccurrence(clean, i, name) {
  let p = i - 1;
  while (p >= 0 && /\s/.test(clean[p])) p--;
  const prevCh = p >= 0 ? clean[p] : "";
  if (prevCh === ".") {
    let q = p - 1;
    while (q >= 0 && /[\w$]/.test(clean[q])) q--;
    // `this.name` and `super.name` membaca var file ini (F16: getter
    // kontrak induk via super adalah baca, bukan member-call).
    const objName = clean.slice(q + 1, p);
    if (objName === "this" || objName === "super") return "read";
    // `.name(` = pemanggilan getter/member di objek lain (P1).
    let a = i + name.length;
    while (a < clean.length && /\s/.test(clean[a])) a++;
    return clean[a] === "(" ? "member-call" : "skip";
  }
  let n = i + name.length;
  while (n < clean.length && /\s/.test(clean[n])) n++;
  const nextCh = n < clean.length ? clean[n] : "";
  if ((prevCh === ";" || prevCh === "{" || prevCh === "}" || prevCh === "") && nextCh === ";") return "noop";
  if (p >= 1 && (clean.slice(p - 1, p + 1) === "++" || clean.slice(p - 1, p + 1) === "--")) return "write";
  if (/\bdelete\s*$/.test(clean.slice(Math.max(0, i - 8), i))) return "write";
  // Tulis assembly: `sstore(name.slot, v)` (N1) — sload tetap baca.
  if (/\bsstore\s*\(\s*$/.test(clean.slice(Math.max(0, i - 12), i))) return "write";
  // Tuple LHS: kemunculan di dalam "(...)" yang diawali batas statement
  // dan sesudah ")" penutupnya ada "=(?!=)" (N6).
  if (isTupleLhs(clean, i)) return "write";
  // Rantai indeks/member sesudah nama: `name[k]`, `name[k].field`,
  // `name.push(...)` (P6).
  let j = n;
  for (;;) {
    while (j < clean.length && /\s/.test(clean[j])) j++;
    if (clean[j] === "[") {
      let d = 0;
      do { if (clean[j] === "[") d++; else if (clean[j] === "]") d--; j++; } while (j < clean.length && d > 0);
      continue;
    }
    if (clean[j] === ".") {
      const mm = clean.slice(j).match(/^\.\s*([A-Za-z_$][\w$]*)\s*(\()?/);
      if (!mm) break;
      if (mm[2]) {
        // Pemanggilan member: push/pop menulis array (N5), lainnya baca.
        return /^(push|pop)$/.test(mm[1]) ? "write" : "read";
      }
      j += mm[0].length;
      continue;
    }
    break;
  }
  const rest = clean.slice(j);
  if (/^(?:\+\+|--)/.test(rest)) return "write";
  if (/^(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=|=)(?!=)/.test(rest)) return "write";
  return "read";
}

// Apakah kemunculan di idx adalah elemen kiri tuple assignment, mis.
// `(fee, cap) = abi.decode(...)`? Cari "(" pembuka ke belakang sampai
// batas statement; "(" itu harus di awal statement (atau sesudah `return`);
// lalu ")" penutupnya harus diikuti "=(?!=)".
function isTupleLhs(clean, idx) {
  let open = -1;
  for (let k = idx - 1; k >= 0; k--) {
    const ch = clean[k];
    if (ch === "(") { open = k; break; }
    if (ch === ";" || ch === "{" || ch === "}" || ch === "=") break;
  }
  if (open === -1) return false;
  let b = open - 1;
  while (b >= 0 && /\s/.test(clean[b])) b--;
  const prevCh = b >= 0 ? clean[b] : "";
  if (prevCh !== ";" && prevCh !== "{" && prevCh !== "}" && prevCh !== "") {
    const word = clean.slice(Math.max(0, b - 6), b + 1);
    if (!/\breturn$/.test(word)) return false;
  }
  let d = 0, close = -1;
  for (let k = open; k < clean.length; k++) {
    if (clean[k] === "(") d++;
    else if (clean[k] === ")") { d--; if (d === 0) { close = k; break; } }
  }
  if (close === -1) return false;
  let n = close + 1;
  while (n < clean.length && /\s/.test(clean[n])) n++;
  return clean[n] === "=" && clean[n + 1] !== "=";
}

// Analisis satu state var: tulis (dengan fungsi + baris), baca, no-op,
// member-call. Kalibrasi v2: string di-mask (N8), cakupan per-kontrak
// (P7), skip event/error/fungsi-tanpa-badan/interface (P4), shadowing
// signature (param + named return, N7) + param modifier (N2) + lokal
// per-blok (P5/F17/N9/N10/N13).
function analyzeStateVar(clean, decl, fns) {
  const name = decl.name;
  const masked = maskStringLiterals(clean);
  const maskedLines = masked.split("\n");
  const offs = lineStartOffsets(masked);
  const contracts = contractSpans(masked);
  const modifiers = scanModifiers(masked);
  const skip = skipSpansForDeadConfig(masked, contracts);
  // R5: isi blok struct bukan kemunculan state var — deklarasi field
  // (`uint256 fee;`) maupun akses field-nya tidak membaca state var
  // senama; tanpa ini deklarasi field terhitung "read" oleh
  // classifyVarOccurrence dan var dead lolos dari detektor.
  for (const sp of findBlockSpans(masked, "struct")) {
    skip.push({ start: sp.start, end: sp.end + 1 });
  }
  const inSkip = (idx) => skip.some((s) => idx >= s.start && idx < s.end);
  // Rentang kontrak yang diizinkan: kontrak pemilik + kontrak turunannya
  // (transitif) dalam file yang sama (P7/F5).
  let allowed = null;
  const owner = contracts.find((c) => decl.nameIndex >= c.start && decl.nameIndex <= c.end);
  if (owner) {
    const names = new Set([owner.name]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of contracts) {
        if (!names.has(c.name) && c.parents.some((p) => names.has(p))) {
          names.add(c.name); grew = true;
        }
      }
    }
    allowed = contracts.filter((c) => names.has(c.name));
  }
  const inAllowed = (idx) => !allowed || allowed.some((c) => idx >= c.start && idx <= c.end);
  // Bayangan lokal per-blok: [{start, end}] indeks char (P5).
  // R9.1: pola deklarasi dari LOCAL_DECL_HEAD_SRC (ukuran penuh,
  // mapping, lowercase+location) + rentang via localDeclShadowRange
  // (awal = `;` penutup pernyataan — F8; akhir sadar-paren — F6/F7)
  // + cakupan modifier ikut dipindai (lokal di badan modifier, F11).
  const shadowRanges = [];
  const LD_HEAD = "(?:^|[;{}(,])\\s*";
  const LD_TAIL = "(?![\\w$])\\s*(?=[=;,)]))";
  const ldRe = new RegExp(LD_HEAD + LOCAL_DECL_HEAD_SRC + "(" + name + LD_TAIL, "g");
  const scopes = [...fns];
  for (const md of modifiers) {
    scopes.push({
      startLine: md.startLine, endLine: md.endLine,
      bodyLines: maskedLines.slice(md.startLine, md.endLine + 1),
    });
  }
  for (const fn of scopes) {
    const fnStartIdx = offs[fn.startLine] || 0;
    const fnEndIdx = offs[fn.endLine + 1] !== undefined ? offs[fn.endLine + 1] : masked.length;
    for (let k = 0; k < fn.bodyLines.length; k++) {
      const lineIdx = fn.startLine + k;
      const lineText = maskedLines[lineIdx] || "";
      ldRe.lastIndex = 0;
      let lm;
      while ((lm = ldRe.exec(lineText)) !== null) {
        const namePos = lm.index + lm[0].lastIndexOf(name);
        const declIdx = (offs[lineIdx] || 0) + namePos;
        const range = localDeclShadowRange(masked, declIdx, fnStartIdx, fnEndIdx);
        if (range) shadowRanges.push(range);
      }
    }
  }
  const inShadow = (idx) => shadowRanges.some((r) => idx >= r.start && idx <= r.end);
  // R9.1/F10: blok assembly — kemunculan telanjang = variabel Yul.
  const asmSpans = assemblySpans(masked);
  const inAssembly = (idx) => asmSpans.some((s) => idx >= s.start && idx <= s.end);
  const occRe = new RegExp("(?<![\\w$])" + escapeRegExp(name) + "(?![\\w$])", "g");
  const writes = [];
  let reads = 0, noops = 0, memberCalls = 0;
  let m;
  while ((m = occRe.exec(masked)) !== null) {
    if (m.index === decl.nameIndex) continue; // deklarasi itu sendiri
    if (inSkip(m.index)) continue; // event/error/fungsi-tanpa-badan/interface (P4)
    if (isLocalDeclName(masked, m.index)) continue; // nama deklarasi lokal, bukan baca (R9.1)
    if (inAssembly(m.index)) {
      // Baca nyata di assembly hanya lewat `.slot`/`.offset`.
      const after = masked.slice(m.index + name.length, m.index + name.length + 12);
      if (!/^\s*\.\s*(?:slot|offset)\b/.test(after)) continue;
    }
    // Member-call `.name(` dihitung DULU, sebelum filter cakupan kontrak:
    // pemanggilan getter di instance/kontrak lain justru buktinya (P1/F1).
    const kind0 = classifyVarOccurrence(masked, m.index, name);
    if (kind0 === "member-call") { memberCalls++; continue; }
    if (!inAllowed(m.index)) continue; // kontrak lain, bukan pemilik/turunan (N3/U2)
    if (inShadow(m.index)) continue; // lokal menutupi (P5)
    const line = lineOfSrc(masked, m.index);
    // Deklarasi fungsi interface `function NAME(...)` — bukan baca.
    const lineStart = masked.lastIndexOf("\n", m.index - 1) + 1;
    if (/\bfunction\s+$/.test(masked.slice(lineStart, m.index))) continue;
    // R9.1 (F9): pencarian fungsi/modifier berbasis indeks CHAR.
    const fn = enclosingFunctionAtIdx(fns, m.index);
    if (fn) {
      // Param + named return dari signature menutupi (N7; param lama).
      if (signatureNames(fn.signature).includes(name)) continue;
    } else {
      // Di dalam modifier: param modifier menutupi (N2).
      const mod = enclosingModifierAtIdx(modifiers, m.index);
      if (mod && mod.paramNames.includes(name)) continue;
    }
    const kind = kind0; // member-call sudah ditangani di atas
    if (kind === "write") writes.push({ line, fn: fn ? fn.name : null });
    else if (kind === "read") reads++;
    else if (kind === "noop") noops++;
  }
  return { name, declLine: decl.line, writes, reads, noops, memberCalls };
}

// Daftar state var yang dead-config di source ini (dipakai detektor +
// klasifikasi upstream-diff atas baseline). Kalibrasi v2: P3 (tulis hanya
// di constructor dilewati), P10 (slot mentah → Info), P11 (metadata
// ERC20 dilewati), P1/F14/F6 (alasan turun ke Info dicatat).
function findDeadConfigVars(source) {
  const clean = stripComments(source);
  const fns = extractFunctions(clean);
  const contracts = contractSpans(clean);
  // R9.1 (F12): pengecualian berbasis indeks CHAR, bukan baris — state
  // var yang berbagi baris dengan sebuah fungsi (`uint256 public fee;
  // function setFee...`) sebelumnya ikut terbuang.
  const excluded = [];
  for (const fn of fns) excluded.push({ start: fn.startIndex, end: fn.endIndex });
  for (const sp of findBlockSpans(clean, "struct")) excluded.push(sp);
  for (const sp of findBlockSpans(clean, "modifier")) excluded.push(sp);
  for (const sp of findSpecialFnSpans(clean)) excluded.push(sp);
  const inExcluded = (idx) => excluded.some((s) => idx >= s.start && idx <= s.end);
  const decls = scanStateVarDecls(clean)
    .filter((d) => !d.immutable && !d.constant && !inExcluded(d.nameIndex));
  // Heuristik file-level: assembly slot mentah (P10) — slot angka tak
  // membuktikan var mana yang dibaca.
  const rawSlot = /\bsload\s*\(\s*\d|\bsstore\s*\(\s*\d/.test(clean);
  // Allowlist metadata ERC20 (P11).
  const isErc20 = /ERC20/.test(clean);
  const out = [];
  for (const d of decls) {
    if (d.isPublic && isErc20 && /^(name|symbol|decimals)$/.test(d.name)) continue;
    const a = analyzeStateVar(clean, d, fns);
    if (a.writes.length >= 1 && a.reads === 0) {
      // P3: tulis HANYA di constructor → bukan config (bukan pola R-02).
      if (a.writes.every((w) => w.fn === "constructor")) continue;
      const infoReasons = [];
      if (a.memberCalls > 0) infoReasons.push("member-call: the `.name(` getter is read on another instance/contract (P1)");
      if (d.override) infoReasons.push("override-getter: interface getter, read off-chain/via the interface (F14)");
      if (rawSlot) infoReasons.push("raw-slot: assembly sload/sstore numeric slot in this file (P10)");
      // F6 (heuristik): kontrak abstract + var non-public → pembaca bisa
      // ada di kontrak turunan file lain. Single-file (runPipeline) ini
      // tetap Info; bila dijalankan lewat runProjectPipeline,
      // applyProjectPass mencabut alasan ini bila korpus penuh tidak
      // menemukan pembaca (residual (3), sesi 16:38 WIB 2026-11-17).
      const ownerC = contracts.find((c) => d.nameIndex >= c.start && d.nameIndex <= c.end);
      const isAbstract = ownerC && ownerC.kind === "contract"
        && /\babstract\b/.test(clean.slice(Math.max(0, ownerC.start - 16), ownerC.start));
      if (isAbstract && !d.isPublic) {
        infoReasons.push("abstract-internal: may be read by a derived contract in another file (F6)");
      }
      out.push({
        name: a.name, declLine: a.declLine,
        firstWriter: a.writes[0], writes: a.writes,
        reads: a.reads, noops: a.noops, memberCalls: a.memberCalls,
        infoReasons,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detektor empty-sublist-proof-advances-height (detektor ke-21, kelas K-1,
// sesi 20:38 WIB 2026-11-18 — Hyperbridge EcdsaBeefy.verifyParachainHeaderProof
// + verify() + HandlerV2.handleConsensus; wasit sesi BB sore 18 Nov 2026:
// Low, liveness/censorship, $0 — BUKAN kandidat submit).
// Detektor level-FILE: flag bila SATU file memuat ketiganya:
//   (A) verifikasi bukti yang dilewati bila sub-daftar kosong — gerbang
//       panjang-positif (`len > 0`, `len != 0`, `len >= 1`, `0 < len`,
//       bentuk `.length` langsung, atau gabungan `&&`) yang badannya
//       memanggil verifikasi (`*verify*` bukan `emit`, atau
//       `calculate/compute/check*Root`) — tanpa guard panjang-positif /
//       zero-revert / else-revert-return di fungsi gerbang ATAU pemanggilnya;
//   (B) kemajuan height monotonik — penugasan ke member `.latestHeight`
//       (atau nama height sekelas: currentHeight/lastHeight/latestBlock/
//       latestBlockNumber), bentuk `=`, `+=`, `++`, atau struct-literal
//       `latestHeight: <blockNumber>` — DI LUAR badan gerbang (A);
//   (C) penolakan stale — `if (H >= B)` / `if (B <= H)` (B = blockNumber
//       atau var darinya) yang return/revert, atau `require(B > H)` /
//       `require(H < B)`; `>` saja TIDAK dihitung (proof blok sama lolos).
// Serta (D) keterkaitan jalur: fungsi stale-check harus SAMA dengan, atau
// memanggil langsung, fungsi gerbang dan fungsi penugasan height.
// Mekanisme persis (EcdsaBeefy.sol @ 3cd7d227): proof BEEFY valid dengan
// `parachains = []` → verifyParachainHeaderProof mengembalikan array
// kosong tanpa verifikasi (len == 0 → blok `if (len > 0)` dilewati) →
// verifyMmrUpdateProof tetap `trustedState.latestHeight = latestHeight`
// → proof jujur blok yang sama kena stale-check di verify() dan
// handleConsensus() early-return → commitment blok itu hilang (pesan
// tertunda sampai commitment berikut). Dampak: sensor satu interval
// komitmen per tx penyerang (biaya gas verifikasi ECDSA); pulih via
// commitment berikut.
// Severity Low — mengikuti klasifikasi wasit K-1. Satu kandidat per file.
// KALIBRASI R21.1 (wasit, review Kiro Opus 5.5 sesi 8da7a082 — vonis NEEDS
// WORK, 42 kasus: 8 benar, 15 FP, 19 FN; probe lokal /tmp/probe-d21.js
// membuktikan 22/24 klaim): F1 guard gerbang `.length` langsung; F2 guard
// diperlebar (require/assert, `!= 0`, `< 1`, `if (len==0) {revert}`,
// escapeRegExp untuk `$`); F3 guard di pemanggil; F4 else rapuh (tanpa
// kurawal + komentar + else-return); F5 keterkaitan jalur (D) + advance
// di dalam gerbang bukan flag (G13); F7 `emit Verify*` bukan verifikasi;
// F8 filter deklarasi berbasis statement; F9 bentuk gerbang diperlebar
// (!=, >= 1, tanpa kurawal, 0 < .length, `&&`); F10 lenDeclRe 1-huruf +
// panggilan fungsi; F11 `calculateRoot` sebagai verifikasi; F12 nama
// height diperlebar; F13 stale-check diperlebar (tanpa kurawal, require,
// terbalik, var blockNumber); F14 `+=`/`++`/struct-literal; F6 (daftar
// kosong terikat komitmen) masuk toVerify, tanpa perubahan kode; F15
// (lingkup level-file) + F16-bukti (evidence SUDAH memuat nomor baris —
// temuan Kiro artefak tempelan terpotong; fallback nama kontrak bila
// gerbang di modifier tetap batas diketahui).
// Batas diketahui: pola lintas-file (verifikasi di file A, height di file
// B) tidak terlihat; panggilan tak langsung (via perantara) tidak
// dihitung keterkaitan; `>` saja di stale-check sengaja tidak dihitung.
// ---------------------------------------------------------------------------
const D21_HEIGHT_NAMES = ["latestHeight", "currentHeight", "lastHeight", "latestBlock", "latestBlockNumber"];

function d21EscapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectEmptySublistProofAdvancesHeight(source, fileName, idStart) {
  if (/(^|\/)(mocks?|test|tests?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/i.test(fileName)) return [];
  const clean = stripComments(source);
  const lineOf = (idx) => clean.slice(0, idx).split("\n").length - 1;
  const heightAlt = D21_HEIGHT_NAMES.join("|");
  // Util: isi blok `{...}` yang dimulai di idx (posisi `{`), kurung
  // seimbang; kembalikan { text, endIndex } atau null.
  function braceBlock(idx) {
    let d = 0;
    for (let j = idx; j < clean.length; j++) {
      if (clean[j] === "{") d++;
      else if (clean[j] === "}") {
        d--;
        if (d === 0) return { text: clean.slice(idx, j + 1), endIndex: j };
      }
    }
    return null;
  }
  // Util: isi `(...)` yang dimulai di idx (posisi `(`), paren seimbang.
  function parenContent(idx) {
    let d = 0;
    for (let j = idx; j < clean.length; j++) {
      if (clean[j] === "(") d++;
      else if (clean[j] === ")") {
        d--;
        if (d === 0) return { text: clean.slice(idx + 1, j), endIndex: j };
      }
    }
    return null;
  }
  // Util: kondisi + badan `if (...)` yang dimulai di idx (posisi `if`).
  // R21.1 (F9/F13): badan boleh satu statement tanpa kurawal (sampai `;`).
  function ifParts(idx) {
    const open = clean.indexOf("(", idx);
    if (open === -1) return null;
    const pc = parenContent(open);
    if (!pc) return null;
    const cond = pc.text;
    let k = pc.endIndex + 1;
    while (k < clean.length && /\s/.test(clean[k])) k++;
    if (clean[k] === "{") {
      const blk = braceBlock(k);
      if (!blk) return null;
      return { cond, bodyStart: k, body: blk.text, endIndex: blk.endIndex, braced: true };
    }
    const semi = clean.indexOf(";", k);
    if (semi === -1) return null;
    return { cond, bodyStart: k, body: clean.slice(k, semi + 1), endIndex: semi, braced: false };
  }
  const fns = extractFunctions(clean);
  function fnAt(idx) {
    for (const fn of fns) {
      if (idx >= fn.startIndex && idx <= fn.endIndex) return fn;
    }
    return null;
  }
  function callsFn(caller, callee) {
    if (!caller || !callee) return false;
    if (caller === callee) return true;
    return new RegExp("\\b" + d21EscapeRegExp(callee.name) + "\\s*\\(").test(caller.body);
  }
  // Peta variabel panjang: `len = <expr>.length` (R21.1 F10: expr 1-huruf
  // + panggilan fungsi `paras(proof).length` ikut dikenali).
  const lenVars = new Map();
  const lenDeclRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_][A-Za-z0-9_$\.\[\]\(\)]*)\.length\b/g;
  let m;
  while ((m = lenDeclRe.exec(clean)) !== null) {
    lenVars.set(m[1], m[2]);
  }
  // Peta variabel nomor blok: `x = <expr>.blockNumber` (R21.1 F13/N10).
  const blockNumVars = new Set();
  const bnDeclRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*[\w\.\[\]\(\)]+\.blockNumber\b/g;
  while ((m = bnDeclRe.exec(clean)) !== null) {
    blockNumVars.add(m[1]);
  }
  function isBlockNumExpr(expr) {
    const e = expr.trim();
    if (/\bblockNumber\b/.test(e)) return true;
    for (const v of blockNumVars) {
      if (new RegExp("\\b" + d21EscapeRegExp(v) + "\\b").test(e)) return true;
    }
    return false;
  }
  // --- (A) length-gated verification -------------------------------------
  // Satu suku `&&` adalah gerbang bila ia SALAH saat panjang == 0
  // (R21.1 F9: `> 0`, `!= 0`, `>= 1`, `0 < x`, `> 1`, `== 1`, gabungan
  // `&&` — semuanya melewatkan verifikasi untuk daftar kosong).
  function lenOfExpr(expr) {
    const t = expr.trim();
    let mm = t.match(/^([A-Za-z_][A-Za-z0-9_$]*)$/);
    if (mm && lenVars.has(mm[1])) return { lenVar: mm[1], listExpr: lenVars.get(mm[1]) };
    mm = t.match(/^([A-Za-z_][A-Za-z0-9_$\.\[\]\(\)]*)\.length$/);
    if (mm) return { lenVar: null, listExpr: mm[1] };
    return null;
  }
  function gatePart(part) {
    const p = part.trim();
    const m = p.match(/^(.*?)\s*(>=|<=|>|<|!=|==)\s*(.*?)$/);
    if (!m) return null;
    const a = m[1].trim(), op = m[2], b = m[3].trim();
    const numA = /^\d+$/.test(a), numB = /^\d+$/.test(b);
    let lenSide = null, num = 0, flipped = false;
    const la = lenOfExpr(a), lb = lenOfExpr(b);
    if (la && numB) { lenSide = la; num = parseInt(b, 10); }
    else if (lb && numA) { lenSide = lb; num = parseInt(a, 10); flipped = true; }
    else return null;
    const effOp = flipped
      ? { ">": "<", "<": ">", ">=": "<=", "<=": ">=", "!=": "!=", "==": "==" }[op]
      : op;
    let falseAt0 = false;
    if (effOp === ">") falseAt0 = num >= 0;
    else if (effOp === ">=") falseAt0 = num >= 1;
    else if (effOp === "!=") falseAt0 = num === 0;
    else if (effOp === "==") falseAt0 = num !== 0;
    else if (effOp === "<") falseAt0 = num <= 0;
    else if (effOp === "<=") falseAt0 = num < 0;
    return falseAt0 ? lenSide : null;
  }
  // Belah kondisi pada `&&` level-teratas (R21.1 F9/N20).
  function splitTopAnd(cond) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < cond.length; i++) {
      const ch = cond[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && ch === "&" && cond[i + 1] === "&") {
        parts.push(cond.slice(start, i));
        i++;
        start = i + 1;
      }
    }
    parts.push(cond.slice(start));
    return parts;
  }
  // Guard panjang-positif di satu scope teks (R21.1 F1/F2/F3): require /
  // assert `X > 0 | != 0 | >= 1` (X = var panjang atau `<expr>.length`),
  // atau `if (X == 0 | <= 0 | < 1) revert/return` (dipar parsing, bukan
  // regex — bentuk `{ revert ...; }` ikut tertangkap, F2/G06).
  function scopeHasZeroGuard(text, exprs) {
    const re = /\bif\s*\(/g;
    let mm2;
    while ((mm2 = re.exec(text)) !== null) {
      const open = text.indexOf("(", mm2.index);
      if (open === -1) continue;
      let d = 0, j = open, ok = false;
      for (; j < text.length; j++) {
        if (text[j] === "(") d++;
        else if (text[j] === ")") { d--; if (d === 0) { ok = true; break; } }
      }
      if (!ok) continue;
      const cond = text.slice(open + 1, j).trim();
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      let body = "";
      if (text[k] === "{") {
        let dd = 0, e = k;
        for (; e < text.length; e++) {
          if (text[e] === "{") dd++;
          else if (text[e] === "}") { dd--; if (dd === 0) break; }
        }
        body = text.slice(k, e + 1);
      } else {
        const semi = text.indexOf(";", k);
        if (semi === -1) continue;
        body = text.slice(k, semi + 1);
      }
      for (const x of exprs) {
        const zr = new RegExp("^\\s*" + x + "\\s*(?:==|<=)\\s*0\\s*$");
        const lt = new RegExp("^\\s*" + x + "\\s*<\\s*1\\s*$");
        if ((zr.test(cond) || lt.test(cond)) && /\b(?:revert|return)\b/.test(body)) return true;
      }
    }
    return false;
  }
  function hasLengthGuard(scopeText, lenVar, listExpr) {
    const exprs = [];
    if (lenVar) exprs.push(d21EscapeRegExp(lenVar));
    if (listExpr) exprs.push(d21EscapeRegExp(listExpr) + "\\.length");
    for (const x of exprs) {
      const posRe = new RegExp("(?:require|assert)\\s*\\(\\s*(?:" + x + "\\s*(?:>|!=)\\s*0|" + x + "\\s*>=\\s*1|0\\s*(?:<|!=)\\s*" + x + ")\\s*[,)]");
      if (posRe.test(scopeText)) return true;
    }
    return scopeHasZeroGuard(scopeText, exprs);
  }
  // Panggilan verifikasi di badan gerbang (R21.1 F7/F11): `*verify*` yang
  // BUKAN `emit`, atau `calculate/compute/check*Root`.
  function bodyHasVerification(body) {
    const vRe = /\b\w*[Vv]erify\w*\s*\(/g;
    let vm;
    while ((vm = vRe.exec(body)) !== null) {
      const before = body.slice(Math.max(0, vm.index - 12), vm.index);
      if (/emit\s*$/.test(before)) continue;
      return true;
    }
    if (/\b\w*(?:calculate|compute|check)\w*Root\w*\s*\(/.test(body)) return true;
    return false;
  }
  let gate = null;
  const ifRe = /\bif\s*\(/g;
  while ((m = ifRe.exec(clean)) !== null) {
    const parts = ifParts(m.index);
    if (!parts) continue;
    let found = null;
    for (const part of splitTopAnd(parts.cond)) {
      found = gatePart(part);
      if (found) break;
    }
    if (!found) continue;
    if (!bodyHasVerification(parts.body)) continue;
    // Guard di fungsi gerbang + di pemanggilnya (R21.1 F3): guard pada
    // listExpr dicari juga di fungsi yang memanggil fungsi gerbang.
    const fn = fnAt(m.index);
    const scopes = [];
    if (fn) {
      scopes.push({ text: fn.body, lenVar: found.lenVar, listExpr: found.listExpr });
      for (const other of fns) {
        if (other !== fn && callsFn(other, fn)) {
          scopes.push({ text: other.body, lenVar: null, listExpr: found.listExpr });
        }
      }
    } else {
      scopes.push({ text: clean, lenVar: found.lenVar, listExpr: found.listExpr });
    }
    let guarded = false;
    for (const sc of scopes) {
      if (hasLengthGuard(sc.text, sc.lenVar, sc.listExpr)) { guarded = true; break; }
    }
    if (guarded) continue;
    // Else-guard (R21.1 F4): `else` sesudah blok — kurawal / tanpa kurawal /
    // `else { return ...; }` ikut dihitung; komentar sudah jadi spasi.
    let k = parts.endIndex + 1;
    while (k < clean.length && /\s/.test(clean[k])) k++;
    if (clean.slice(k, k + 4) === "else" && !/[A-Za-z0-9_$]/.test(clean[k + 4] || "")) {
      let e = k + 4;
      while (e < clean.length && /\s/.test(clean[e])) e++;
      let elseBody = "";
      if (clean[e] === "{") {
        const blk = braceBlock(e);
        elseBody = blk ? blk.text : "";
      } else {
        const semi = clean.indexOf(";", e);
        elseBody = semi === -1 ? "" : clean.slice(e, semi + 1);
      }
      if (/\b(?:revert|return)\b/.test(elseBody)) continue;
    }
    gate = { idx: m.index, fn, lenVar: found.lenVar, listExpr: found.listExpr, line: lineOf(m.index), bodyStart: parts.bodyStart, endIndex: parts.endIndex };
    break;
  }
  if (!gate) return [];
  // --- (B) kemajuan height monotonik --------------------------------------
  // R21.1 F12: nama height diperlebar; F14: `+=`/`++`/struct-literal;
  // F8: filter deklarasi berbasis statement; F5/G13: advance DI DALAM
  // badan gerbang bukan kemajuan (perbaikan yang benar).
  let advance = null;
  const advMemberRe = new RegExp("\\.\\s*(?:" + heightAlt + ")\\s*(?:=(?!=)|\\+=|\\+\\+)", "g");
  while ((m = advMemberRe.exec(clean)) !== null) {
    if (m.index >= gate.bodyStart && m.index <= gate.endIndex) continue;
    advance = { idx: m.index, line: lineOf(m.index) };
    break;
  }
  if (!advance) {
    const advPlainRe = new RegExp("\\b(?:" + heightAlt + ")\\s*(?:=(?!=)|\\+=|\\+\\+)", "g");
    while ((m = advPlainRe.exec(clean)) !== null) {
      if (m.index >= gate.bodyStart && m.index <= gate.endIndex) continue;
      // Abaikan bila didahului `.` (sudah tercakup bentuk member).
      if (clean[m.index - 1] === ".") continue;
      // Filter deklarasi (F8): kata kunci tipe/visibilitas di statement
      // yang sama sebelum match (deklarasi multi-baris ikut tertangkap).
      const stmtStart = Math.max(clean.lastIndexOf(";", m.index), clean.lastIndexOf("{", m.index), clean.lastIndexOf("}", m.index)) + 1;
      const before = clean.slice(stmtStart, m.index);
      if (/\b(?:uint\d*|int\d*|bytes\d*|address|bool|string|public|private|internal|constant|immutable)\b/.test(before)) continue;
      advance = { idx: m.index, line: lineOf(m.index) };
      break;
    }
  }
  if (!advance) {
    // Struct-literal: `latestHeight: <expr bernomor blok>` (N16).
    const advStructRe = new RegExp("\\b(?:" + heightAlt + ")\\s*:\\s*[^,}\\)]*", "g");
    while ((m = advStructRe.exec(clean)) !== null) {
      if (m.index >= gate.bodyStart && m.index <= gate.endIndex) continue;
      if (!isBlockNumExpr(m[0].split(":").slice(1).join(":"))) continue;
      advance = { idx: m.index, line: lineOf(m.index) };
      break;
    }
  }
  if (!advance) return [];
  // --- (C) penolakan stale --------------------------------------------------
  // R21.1 F13: if tanpa kurawal, require, bentuk terbalik, var blockNumber.
  let stale = null;
  const ifRe2 = /\bif\s*\(/g;
  while ((m = ifRe2.exec(clean)) !== null) {
    const parts = ifParts(m.index);
    if (!parts) continue;
    const cond = parts.cond;
    const hM = cond.match(new RegExp("\\b(?:" + heightAlt + ")\\b"));
    if (!hM) continue;
    const hName = hM[0];
    const hEsc = d21EscapeRegExp(hName);
    // Nama height boleh berkualifikasi member (`s.latestHeight`,
    // `cfg.latestHeight`) — R21.1b (probe N12/N13).
    const hQual = "(?:[A-Za-z_][A-Za-z0-9_$]*\\.)*" + hEsc + "\\b";
    // Bentuk langsung: `H >= B` / terbalik `B <= H` (B bernomor blok).
    const directRe = new RegExp(hQual + "\\s*>=\\s*[^;{}]*");
    const revRe = new RegExp("[^;{}]*?<=\\s*" + hQual);
    let hit = false;
    const dm = cond.match(directRe);
    if (dm && isBlockNumExpr(dm[0].split(">=").slice(1).join(">="))) hit = true;
    if (!hit) {
      const rm = cond.match(revRe);
      if (rm && isBlockNumExpr(rm[0].split("<=").slice(0, -1).join("<="))) hit = true;
    }
    if (!hit) continue;
    if (!/\breturn\b|\brevert\b/.test(parts.body)) continue;
    stale = { idx: m.index, line: lineOf(m.index) };
    break;
  }
  if (!stale) {
    // Bentuk require: `require(B > H)` / `require(H < B)` (ketat — `>=`
    // membolehkan blok sama, jadi BUKAN sensor).
    const reqRe = /\brequire\s*\(/g;
    while ((m = reqRe.exec(clean)) !== null) {
      const pc = parenContent(m.index + "require".length);
      if (!pc) continue;
      const cond = pc.text;
      const hM = cond.match(new RegExp("\\b(?:" + heightAlt + ")\\b"));
      if (!hM) continue;
      const hEsc = d21EscapeRegExp(hM[0]);
      const hQual = "(?:[A-Za-z_][A-Za-z0-9_$]*\\.)*" + hEsc + "\\b";
      const gtRe = new RegExp("^(?:[^,()]*?)>\\s*" + hQual);
      const ltRe = new RegExp("^\\s*" + hQual + "\\s*<\\s*([^,()]*?)(?:,|$)");
      let hit = false;
      const gm = cond.match(gtRe);
      if (gm && isBlockNumExpr(gm[0].split(">").slice(0, -1).join(">"))) hit = true;
      if (!hit) {
        const lm = cond.match(ltRe);
        if (lm && isBlockNumExpr(lm[1])) hit = true;
      }
      if (!hit) continue;
      stale = { idx: m.index, line: lineOf(m.index) };
      break;
    }
  }
  if (!stale) return [];
  // --- (D) keterkaitan jalur (R21.1 F5) -------------------------------------
  // Fungsi stale-check harus SAMA dengan, atau memanggil langsung, fungsi
  // gerbang dan fungsi penugasan height. Null (mis. gerbang di modifier)
  // dianggap terikat (konservatif).
  const gateFn = gate.fn;
  const advanceFn = fnAt(advance.idx);
  const staleFn = fnAt(stale.idx);
  const legGate = !staleFn || !gateFn || staleFn === gateFn || callsFn(staleFn, gateFn);
  const legAdv = !staleFn || !advanceFn || staleFn === advanceFn || callsFn(staleFn, advanceFn);
  if (!legGate || !legAdv) return [];
  const contractName = (clean.match(/\bcontract\s+([A-Za-z_][A-Za-z0-9_$]*)/) || [])[1]
    || fileName.split("/").pop();
  const fnName = gateFn ? gateFn.name : contractName;
  return [normalizeCandidate({
    id: "FA-" + String(idStart).padStart(3, "0"),
    detector: "empty-sublist-proof-advances-height",
    title: "Empty sub-list consensus proof advances the height + stale-rejection censors honest proofs",
    location: { file: fileName, function: fnName },
    hypothesis: "Verification proof is skipped when the sub-list is empty (`if (len > 0)`, line "
      + (gate.line + 1) + ") — without proof, without a stored commitment — but the height still advances ("
      + "height assignment, line " + (advance.line + 1) + "); an honest proof for the same block "
      + "then rejected by the stale-check (line " + (stale.line + 1) + ") so that block's commitment is lost "
      + "until the next commitment.",
    preconditions: "The attacker sends a valid consensus proof (quorum signatures) with an empty sub-list "
      + "BEFORE an honest relayer submits a proof of the same block; the honest relayer cannot force the commitment "
      + "that block enters after the height has advanced.",
    impact: "Censoring one commitment interval per attacker tx (liveness/censorship, not fund-loss): messages "
      + "ISMP for that block is delayed until the next commitment; the header can still be re-proven at "
      + "the next commitment until it is superseded. Attacker cost = ECDSA verification gas per interval.",
    severityGuess: "Low",
    evidence: "Empty-length gate line " + (gate.line + 1) + " (`if ("
      + (gate.lenVar ? gate.lenVar + " > 0" : gate.listExpr + ".length > 0")
      + ")` contains a verification call, without a require/revert guard when empty)"
      + "; height assignment line " + (advance.line + 1)
      + "; stale-check line " + (stale.line + 1) + " (`latestHeight >= ...blockNumber` + return/revert)"
      + "; path linkage: the stale-check calls the gate function + the height-assignment function.",
    toVerify: ["Read the full verification function: does an empty list really return without proof AND without reverting",
      "check whether the height advances on the same path (same state as the stale-check)",
      "check whether the empty sub-list commitment really is missing (not stored elsewhere)",
      "check whether the empty sub-list is bound to the commitment (hash/leafCount) — if empty is cryptographically valid, this candidate dies",
      "A fork PoC needs a real consensus-proof fixture (2/3 validator signatures + an MMR proof of a real relay block) — without it, verification stops at the code trace"],
    source: "pattern-scan",
  })];
}

// ---------------------------------------------------------------------------
// Detektor ke-22: sandwich JIT reward-accrual (kelas VENO-C2 YbEth, sesi BB
// pagi 19 Nov 2026 — Medium wasit, PoC-verified Foundry 4/4).
// Pola ekonomi temporal, tiga kaki dalam SATU file atas var pool yang sama:
//   (a) ACCRUAL: fungsi external/public menambah var pool (`POOL += <param
//       atau msg.value>`) TANPA mint share — reward masuk pool, harga share
//       naik untuk semua pemegang saat itu juga.
//   (b) STAKE: fungsi external/public payable yang mint share pada rate
//       saat itu (`_mint` + `POOL += msg.value`) — pintu masuk sebelum accrual.
//   (c) EXIT: fungsi external/public yang menghitung rate dari pool/total
//       share (`(POOL * X) / totalSupply`), MENGUNCI rate itu (field struct
//       `.exchangeRate =` / literal `exchangeRate:` / dipakai di payout fungsi
//       yang sama) dan membakar share (`_burn` / `POOL -= ...`) — keluar
//       pada rate pasca-accrual.
// Severity: Medium bila fee keluar default-0 (deklarasi tanpa initializer
// atau `= 0`) atau TIDAK ADA perhitungan fee di file ini (tanpa friksi);
// Low bila fee nonzero-initialized atau fee dipakai tapi deklarasinya tidak
// ditemukan di file ini (nilai live tak diketahui — cek live).
// Kalibrasi R22 (sesi #36, review Kiro Opus 5.5 "Audit D22 JIT Reward
// Accrual", NEEDS WORK F1-F18): 27/28 probe wasit terhadap kode asli
// membuktikan klaim Kiro (F8-A3 gugur — alias supply sudah ditangani;
// klaim "severity YbEth asli tidak berjalan" gugur — test 56-2/56-2b
// membuktikan fee terbaca). Perbaikan: denominator fee boleh literal
// (F1), nama fee bare/kapital (F2), operand terbalik (F3), constant ikut
// dinilai (F4), assignment ctor/initialize menang atas initializer (F5),
// fee dinilai per fungsi exit/rate, bukan first-wins file-wide (F6),
// zero-init 0x00/0 ether/0e18 (F7), formula rate via jalan-mundur paren +
// mulDiv + pembagi _totalSupply/getTotalShares (F8), mint/burn gaya Lido
// (F9), accrual `POOL = POOL + X` + alias lokal param-derived (F10), kunci
// rate digeneralisasi (field apa pun / payout-value, F11 + varian redeem
// langsung), alias lokal pool diselesaikan ke state var (F12), emit bukan
// gate + sufiks holding berbatas (F13), nama holding + gate modifier (F14),
// kaki satu kontrak (F15), mint/burn tak langsung via helper (F16),
// receive()/fallback() sbg kaki accrual (F17), pengecualian Mock|Harness
// case-sensitive (F18b). DITOLAK: commission/tax sbg nama fee (terlalu
// luas); F18a (lineOf DIPAKAI di hypothesis/evidence — format location
// tanpa nomor baris = konvensi proyek).
// Batas diketahui (v2): jadwal accrual (keteraturan bot) TIDAK bisa dibaca
// statis — wajib cek live (event AccrueReward); var pool warisan (storage
// file lain, mis. YbEthStorage) dikenali lewat pola nama totalPooled*/dst.,
// bukan deklarasi; fee yang dideklarasikan di file lain hanya terlihat lewat
// opts.projectStateVarInits (mode proyek); holding-period HANYA dikenali
// lewat nama (stakeTime/depositTime/dst.); rate dua langkah (via helper
// convertToShare di fungsi lain) tidak dilacak; gate di helper yang dipanggil
// exit (bukan modifier) tidak dilacak; fee var lokal di dalam fungsi tidak
// diselesaikan nilainya (unknown -> Low).
// ---------------------------------------------------------------------------
const D22_HOLDING_NAMES = ["stakeTime", "depositTime", "lastStake", "stakedAt", "stakeTimestamp", "depositTimestamp", "lastDeposit", "stakeStart", "stakedSince", "lastStakeTime", "depositedAt", "depositAt", "stakeAt"];
const D22_SHARE_TOTALS = ["totalSupply", "totalShares", "totalShareAmount"];
const D22_POOL_NAME_RE = /^(totalPooled|totalAssets|totalUnderlying|totalStaked|totalDeposited|totalValueLocked)/i;

function d22EscapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Initializer state var dari teks deklarasi di sekitar nameIndex: kembalikan
// { found, hasInit, init } — init = teks sesudah `=` sampai `;` (atau null).
function d22StateVarInit(clean, nameIndex) {
  const semi = clean.indexOf(";", nameIndex);
  if (semi === -1) return { found: false, hasInit: false, init: null };
  const seg = clean.slice(nameIndex, semi);
  const m = seg.match(/^[A-Za-z_][A-Za-z0-9_$]*\s*(?:=\s*([\s\S]+))?$/);
  if (!m) return { found: false, hasInit: false, init: null };
  return { found: true, hasInit: !!m[1], init: m[1] ? m[1].trim() : null };
}

function d22IsZeroInit(init) {
  if (init === null || init === undefined) return true;
  const t = init.trim().replace(/_/g, "");
  // R22 (F7): 0x00, 0 ether, 0e18, 0.0 ikut nol (dulu hanya "0"/"0x0").
  return /^(0[xX]0+|0+(\.0+)?([eE]\d+)?(\s*(ether|wei|gwei|finney|szabo))?)$/.test(t);
}

// Deklarasi state var SEJATI (R22, F12): scanStateVarDecls (regex) ikut
// membaca lokal di badan fungsi (`uint256 x = ...;` di dalam fn) — saring
// ke deklarasi di luar semua badan fungsi. Tanpa ini, lokal bernama
// totalPooledEth/pooled membayangi state var dan menggagalkan resolusi
// alias pool (probe A23) serta mencemari initMap fee (lokal `fee = 0`
// terbaca seolah state var).
function d22TrueStateDecls(clean) {
  const spans = extractFunctions(clean).concat(d22SpecialFns(clean))
    .map((fn) => ({ start: fn.startIndex, end: fn.endIndex }));
  return scanStateVarDecls(clean).filter((d) => !spans.some((s) => d.nameIndex >= s.start && d.nameIndex <= s.end));
}

// Peta nama state var -> info initializer, dari SATU file (dipakai D22
// file-lokal; runProjectPipeline membangun gabungan proyeknya).
function d22StateVarInitMap(clean) {
  const map = new Map();
  for (const d of d22TrueStateDecls(clean)) {
    if (map.has(d.name)) continue;
    const info = d22StateVarInit(clean, d.nameIndex);
    map.set(d.name, { hasInit: info.hasInit, init: info.init, constant: d.constant });
  }
  return map;
}

// R22 (F17): receive()/fallback() tidak ditangkap extractFunctions (tanpa
// kata kunci `function`) — bangun pseudo-fn agar bisa jadi kaki accrual
// (receive() payable yang menambah pool tanpa mint). Bentuk dikembalikan
// mengikuti extractFunctions (body = teks utuh dari kata kunci s/d `}`).
function d22SpecialFns(clean) {
  const out = [];
  const re = /\b(receive|fallback)\s*\(/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    let depth = 0, j = m.index + m[0].length - 1, close = -1;
    for (; j < clean.length; j++) {
      if (clean[j] === "(") depth++;
      else if (clean[j] === ")") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close === -1) continue;
    let brace = -1;
    for (let k = close + 1; k < clean.length; k++) {
      if (clean[k] === "{") { brace = k; break; }
      if (clean[k] === ";") break;
    }
    if (brace === -1) continue;
    const end = blockEndIndex(clean, brace);
    if (end === -1) continue;
    const mods = clean.slice(close + 1, brace).trim().replace(/\s+/g, " ");
    out.push({
      name: m[1],
      signature: m[1] + "() " + mods,
      body: clean.slice(m.index, end + 1),
      startIndex: m.index,
      endIndex: end,
      startLine: lineOfSrc(clean, brace),
      isConstructor: false,
    });
  }
  return out;
}

function detectJitRewardAccrualSandwich(source, fileName, idStart, opts) {
  // R22 (F18b): pengecualian nama file (Mock|Harness) case-SENSITIVE —
  // file produksi seperti HarnessRouter.sol tidak lagi terlewat; direktori
  // test/mocks tetap case-insensitive.
  if (/(^|\/)(mocks?|test|tests?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/.test(fileName)) return [];
  const clean = stripComments(source);
  const lineOf = (idx) => clean.slice(0, idx).split("\n").length - 1;
  const fns = extractFunctions(clean).concat(d22SpecialFns(clean));
  const stateDecls = d22TrueStateDecls(clean);
  const stateVarNames = new Set(stateDecls.map((d) => d.name));
  const initMap = d22StateVarInitMap(clean);
  const projectInits = (opts && opts.projectStateVarInits) || null;
  const spans = contractSpans(clean);
  // R22 (F15): kaki harus satu kontrak — contractOf(null) = fungsi bebas /
  // file tanpa kontrak (fallback: perilaku file-wide lama).
  const contractOf = (fn) => {
    const s = spans.find((sp) => sp.kind !== "interface" && fn.startIndex >= sp.start && fn.startIndex <= sp.end);
    return s ? s.name : null;
  };
  const isCallable = (fn) => /\b(external|public)\b/.test(fn.signature) && !fn.isConstructor;
  // R22 (F9): mint/burn gaya Lido (_mintShares/.mintShares/bare mint).
  const hasMint = (body) => /\b_?mint[A-Za-z0-9_$]*\s*\(|\.mint[A-Za-z0-9_$]*\s*\(/.test(body);
  const hasBurn = (body) => /\b_?burn[A-Za-z0-9_$]*\s*\(|\.burn[A-Za-z0-9_$]*\s*\(/.test(body);
  // R22 (F16): helper yang memanggil mint/burn — pemanggilnya ikut mint/burn
  // secara tak langsung (mis. _issueShares -> _mint). Per kontrak.
  const helperNames = (kind) => {
    const map = new Map();
    for (const fn of fns) {
      const c = contractOf(fn);
      if (!map.has(c)) map.set(c, new Set());
      if (kind === "mint" ? hasMint(fn.body) : hasBurn(fn.body)) map.get(c).add(fn.name);
    }
    return map;
  };
  const mintHelpers = helperNames("mint");
  const burnHelpers = helperNames("burn");
  const callsHelper = (fn, map) => {
    const set = map.get(contractOf(fn));
    if (!set) return false;
    for (const n of set) {
      if (n !== fn.name && new RegExp("\\b" + d22EscapeRegExp(n) + "\\s*\\(").test(fn.body)) return true;
    }
    return false;
  };
  const hasMintAny = (fn) => hasMint(fn.body) || callsHelper(fn, mintHelpers);
  const hasBurnAny = (fn) => hasBurn(fn.body) || callsHelper(fn, burnHelpers);
  // Var pool sah: dideklarasi di file ini ATAU bernama seperti total pool
  // (var warisan dari file storage lain — mis. totalPooledEth YbEth yang
  // dideklarasi di YbEthStorage.sol, bukan di YbEth.sol).
  const isPoolVar = (name) => stateVarNames.has(name) || D22_POOL_NAME_RE.test(name);
  // Identifier total-share per fungsi: nama kanonik + lokal yang di-assign
  // dari totalSupply()/totalShares().
  function shareTotals(fn) {
    const set = new Set(D22_SHARE_TOTALS);
    const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*(?:[A-Za-z_][A-Za-z0-9_$\.]*\.)?(?:totalSupply|totalShares)\s*\(\s*\)/g;
    let m;
    while ((m = re.exec(fn.body)) !== null) set.add(m[1]);
    return set;
  }
  // Formula rate (R22, F8): cari situs pembagian `/ TOTAL` (TOTAL = total
  // share; pembagi boleh dalam paren / berupa getTotalShares()), lalu jalan
  // mundur menyeimbangkan paren untuk mengambil numerator — paren bersarang
  // (A1), mulDiv (A27), dan pembagi _totalSupply/getTotalShares() (A24)
  // ikut tertangkap; alias lokal total (A3) sudah ditangani shareTotals.
  // Kembalikan { pool, total, rateVar, index } atau null.
  function rateFormula(fn) {
    const totals = new Set(shareTotals(fn));
    totals.add("_totalSupply");
    totals.add("_totalShares");
    const totalAlt = [...totals].map(d22EscapeRegExp).join("|");
    const totalRe = totalAlt + "|_?getTotalShares\\s*\\(\\s*\\)|_?getTotalSupply\\s*\\(\\s*\\)";
    // Selesaikan satu identifier pool ke state var (R22, F12): bila itu
    // lokal/param, cari aliasnya (`lokal = STATEVAR;`) — alias dicek DULU
    // (nama lokal boleh netral, mis. `pooled = totalStaked`); tanpa alias
    // -> null (shadowing murni dilewati).
    function resolvePool(id) {
      if (!stateVarNames.has(id)) {
        const params = new Set(paramNamesOf(fn).filter(Boolean));
        const isLocal = params.has(id)
          || new RegExp("\\b(?:uint\\d*|int\\d*|address|bool|bytes\\d*|string)\\s+" + d22EscapeRegExp(id) + "\\b").test(fn.body);
        if (isLocal) {
          const am = fn.body.match(new RegExp("\\b" + d22EscapeRegExp(id) + "\\s*=\\s*([A-Za-z_][A-Za-z0-9_$]*)\\s*;"));
          if (am && (stateVarNames.has(am[1]) || D22_POOL_NAME_RE.test(am[1]))) return am[1];
          return null;
        }
      }
      return isPoolVar(id) ? id : null;
    }
    // Var yang di-assign oleh formula: `IDENT = <formula>` di statement yang
    // sama (toleran terhadap bentuk datar `amount = share * POOL / TOTAL`).
    function rateVarBefore(idx) {
      const stmtStart = Math.max(fn.body.lastIndexOf(";", idx - 1), fn.body.lastIndexOf("{", idx - 1), fn.body.lastIndexOf("}", idx - 1)) + 1;
      const prefix = fn.body.slice(stmtStart, idx);
      const am = prefix.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*[^;=]*$/);
      return am ? am[1] : null;
    }
    // Teks numerator sebelum situs pembagian di posisi slashIdx.
    function numeratorBefore(slashIdx) {
      let j = slashIdx - 1;
      while (j >= 0 && /\s/.test(fn.body[j])) j--;
      if (j < 0) return null;
      if (fn.body[j] === ")") {
        let depth = 0;
        for (let k = j; k >= 0; k--) {
          if (fn.body[k] === ")") depth++;
          else if (fn.body[k] === "(") {
            depth--;
            if (depth === 0) return { text: fn.body.slice(k + 1, j), start: k };
          }
        }
        return null;
      }
      const m = fn.body.slice(0, j + 1).match(/([A-Za-z_][A-Za-z0-9_$\.\[\]]+)\s*$/);
      return m ? { text: m[1], start: j + 1 - m[1].length } : null;
    }
    const divRe = new RegExp("\\/\\s*\\(?\\s*(" + totalRe + ")\\s*\\)?", "g");
    let m;
    while ((m = divRe.exec(fn.body)) !== null) {
      const num = numeratorBefore(m.index);
      if (!num) continue;
      const ids = num.text.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
      let pool = null;
      for (const id of ids) { pool = resolvePool(id); if (pool) break; }
      if (!pool) continue;
      return { pool, total: m[1], rateVar: rateVarBefore(num.start), index: num.start };
    }
    // mulDiv: `POOL.mulDiv(F, TOTAL)` / `Math.mulDiv(POOL, F, TOTAL)`.
    const mulRe = new RegExp("(?:\\b([A-Za-z_][A-Za-z0-9_$]*)\\s*\\.\\s*mulDiv\\s*\\(\\s*[^,]{1,80}?,\\s*|Math\\.mulDiv\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_$]*)\\s*,\\s*[^,]{1,80}?,\\s*)(" + totalRe + ")", "g");
    while ((m = mulRe.exec(fn.body)) !== null) {
      const pool = resolvePool(m[1] || m[2]);
      if (!pool) continue;
      return { pool, total: m[3], rateVar: rateVarBefore(m.index), index: m.index };
    }
    return null;
  }
  // Gate holding-period (R22, F13/F14): statement yang membandingkan
  // block.timestamp dengan waktu stake/deposit pemanggil. Emit BUKAN gate
  // (A20); nama harus berbatas kata + sufiks yang sah (At/Time/Timestamp/
  // Date) agar `stakeTimeout` tidak ikut terhitung; daftar nama diperluas
  // (depositedAt/depositAt/stakeAt, A18).
  function hasHoldingGate(body) {
    const names = [...D22_HOLDING_NAMES].sort((a, b) => b.length - a.length);
    const holdRe = new RegExp("\\b(?:" + names.map(d22EscapeRegExp).join("|") + ")(?:At|Time|Timestamp|Date)?\\b");
    for (const stmt of body.split(";")) {
      // Statement pertama fn.body memuat signature + `{`, jadi emit dicek
      // lewat `(^|{) emit`, bukan startsWith (R22, perbaikan F13-A20).
      if (/(?:^|\{)\s*emit\s/.test(stmt)) continue;
      if (/block\.timestamp/.test(stmt) && holdRe.test(stmt)) return true;
    }
    return false;
  }
  // Nama modifier di signature (sesudah `)`, buang kata kunci visibilitas/
  // mutability/returns) — R22 (F14): gate di badan modifier ikut menggugur.
  function modifierNamesOf(sig) {
    const close = sig.indexOf(")");
    if (close === -1) return [];
    const afterParams = sig.slice(close + 1);
    const noReturns = afterParams.replace(/\breturns\b[\s\S]*$/, "");
    return noReturns.split(/[\s,()]+/).filter((t) => t
      && !/^(external|public|internal|private|view|pure|payable|virtual|override|nonpayable|nonReentrant|whenNotPaused)$/i.test(t));
  }
  // Kaki exit: formula rate + rate dikunci + share dibakar / pool dikurangi.
  function exitLeg(fn) {
    if (!isCallable(fn)) return null;
    const formula = rateFormula(fn);
    if (!formula) return null;
    const after = fn.body.slice(formula.index);
    // Kunci rate (R22, F11): rate disimpan ke field struct/member APA PUN
    // (`field: rateVar` / `.field = ...rateVar`), dipakai di payout fungsi
    // yang sama (`* rateVar`), atau dipakai sebagai nilai payout
    // (`call{value: rateVar}` / transfer / send) — varian redeem langsung
    // (K5var) ikut tertangkap; A16 (amountOwed) tertangkap via (i).
    let locked = false;
    if (formula.rateVar) {
      const rv = d22EscapeRegExp(formula.rateVar);
      locked = new RegExp("[A-Za-z_][A-Za-z0-9_$]*\\s*:\\s*" + rv + "\\b\\s*[,}]").test(after)
        || new RegExp("\\.[A-Za-z_][A-Za-z0-9_$]*\\s*=\\s*[^;]{0,120}?\\b" + rv + "\\b").test(after)
        || new RegExp("\\b" + rv + "\\s*\\*|\\*\\s*" + rv + "\\b").test(after)
        || new RegExp("(?:call\\s*\\{\\s*value\\s*:|\\.transfer\\s*\\(|\\.send\\s*\\()\\s*[^;]{0,80}?\\b" + rv + "\\b").test(after);
    }
    if (!locked) return null;
    const burn = hasBurnAny(fn)
      || new RegExp("\\b" + d22EscapeRegExp(formula.pool) + "\\s*-=").test(fn.body);
    if (!burn) return null;
    if (hasHoldingGate(fn.body)) return null;
    // Gate di modifier yang menempel pada fungsi exit (F14/A19).
    const mods = modifierNamesOf(fn.signature);
    if (mods.length > 0) {
      for (const mod of scanModifiers(clean)) {
        if (mods.includes(mod.name)
          && hasHoldingGate(clean.slice(mod.start, mod.end))) return null;
      }
    }
    return { fn, formula };
  }
  // Kaki stake: payable + mint (langsung / via helper, F16) + POOL += msg.value.
  function stakeLeg(fn, pool) {
    if (!isCallable(fn)) return false;
    if (!/\bpayable\b/.test(fn.signature)) return false;
    if (!hasMintAny(fn)) return false;
    return new RegExp("\\b" + d22EscapeRegExp(pool) + "\\s*\\+=\\s*msg\\.value\\b").test(fn.body);
  }
  // Kaki accrual (R22, F10/F16): POOL += <param|msg.value|alias-lokal-param>
  // atau POOL = POOL + <...>; tanpa mint (langsung / via helper).
  function accrualLeg(fn, pool) {
    if (!isCallable(fn)) return false;
    if (/^initialize\b/i.test(fn.name) || /\binitializer\b/.test(fn.signature)) return false;
    if (hasMintAny(fn)) return false;
    const params = new Set(paramNamesOf(fn).filter(Boolean));
    // Lokal yang diturunkan dari param (fixpoint ≤3 iterasi): `net = amount
    // - amount/10` -> net dianggap param-derived (A13); lokal dari msg.value
    // ikut dihitung; var pool sendiri dikeluarkan dari himpunan.
    const derived = new Set(params);
    derived.add("msg.value");
    for (let it = 0; it < 3; it++) {
      let added = false;
      const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([^;]{1,120}?);/g;
      let m;
      while ((m = re.exec(fn.body)) !== null) {
        if (derived.has(m[1])) continue;
        const rhsIds = m[2].match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
        if (/\bmsg\.value\b/.test(m[2]) || rhsIds.some((id) => derived.has(id))) { derived.add(m[1]); added = true; }
      }
      if (!added) break;
    }
    derived.delete(pool);
    const srcAlt = [...derived].map(d22EscapeRegExp).join("|");
    const poolRe = d22EscapeRegExp(pool);
    return new RegExp("\\b" + poolRe + "\\s*\\+=\\s*(?:" + srcAlt + ")\\b").test(fn.body)
      || new RegExp("\\b" + poolRe + "\\s*=\\s*" + poolRe + "\\s*\\+\\s*(?:" + srcAlt + ")\\b").test(fn.body)
      || new RegExp("\\b" + poolRe + "\\s*=\\s*(?:" + srcAlt + ")\\s*\\+\\s*" + poolRe + "\\b").test(fn.body);
  }
  // Analisis fee keluar (R22, F1-F6): pola `(X * <feeVar>) / <DENOM>` dengan
  // DENOM identifier ATAU literal numerik (F1); feeVar bernama *fee*
  // case-insensitive, boleh berdiri sendiri (`fee`, `feeBps`, `FEE`, F2) di
  // posisi operand mana pun (F3). Vonis per var: (a) assignment literal di
  // constructor/initialize menang atas initializer (F5 — immutable /
  // upgradeable); (b) constant ikut dinilai dari init-nya, bukan dilewati
  // (F4); (c) tanpa init + tanpa assignment -> default-0; (d) dipakai tapi
  // tak terdeklarasi -> unknown. Bila beberapa fee var, yang dipakai di
  // fungsi exit / fungsi yang menyebut rate yang menang (F6); seri -> urutan
  // sumber.
  function feeVerdict(exitFns) {
    const feeVarRe = "(?:[A-Za-z_][A-Za-z0-9_$]*[Ff][Ee][Ee][A-Za-z0-9_$]*|[Ff][Ee][Ee][A-Za-z0-9_$]*)";
    const denomRe = "(?:[A-Za-z_][A-Za-z0-9_$]*|\\d[\\d_]*(?:\\.\\d+)?(?:[eE]\\d+)?|\\([^()]*\\))";
    const re = new RegExp("\\(\\s*([^()]{1,120}?)\\s*\\)\\s*\\/\\s*" + denomRe, "g");
    const found = new Map(); // var -> { score, firstIndex }
    for (const fn of fns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(fn.body)) !== null) {
        const operands = m[1].split("*").map((s) => s.trim().replace(/^[A-Za-z_][A-Za-z0-9_$]*\./, ""));
        for (const op of operands) {
          const vm = op.match(new RegExp("^" + feeVarRe + "$"));
          if (!vm) continue;
          const v = vm[0];
          const isExit = exitFns.some((e) => e.fn === fn);
          const score = isExit ? 2 : (/\bexchangeRate\b/.test(fn.body) ? 1 : 0);
          const idx = fn.startIndex + m.index;
          const prev = found.get(v);
          if (!prev || score > prev.score || (score === prev.score && idx < prev.firstIndex)) {
            found.set(v, { score, firstIndex: idx });
          }
        }
      }
    }
    if (found.size === 0) return { kind: "absent", var: null };
    const ordered = [...found.entries()].sort((a, b) => b[1].score - a[1].score || a[1].firstIndex - b[1].firstIndex);
    // Assignment di constructor/initialize (override initializer).
    function initAssignment(v) {
      for (const fn of fns) {
        if (!fn.isConstructor && !/^initialize/i.test(fn.name)) continue;
        const am = fn.body.match(new RegExp("\\b" + d22EscapeRegExp(v) + "\\s*=\\s*([^;]{1,60}?);"));
        if (!am) continue;
        const rhs = am[1].trim();
        if (/^(0[xX]0+|0+(\.0+)?([eE]\d+)?(\s*(ether|wei|gwei))?)$/i.test(rhs)) return { kind: "zero", var: v };
        if (/^\d[\d_]*(?:\.\d+)?(?:[eE]\d+)?$/.test(rhs) || /^0[xX][0-9a-fA-F]+$/.test(rhs)) return { kind: "nonzero", var: v };
        return { kind: "unknown", var: v };
      }
      return null;
    }
    for (const [v] of ordered) {
      const asg = initAssignment(v);
      if (asg) return asg;
      const local = initMap.get(v);
      if (local) {
        return local.hasInit && !d22IsZeroInit(local.init)
          ? { kind: "nonzero", var: v }
          : { kind: "zero", var: v };
      }
      if (projectInits && projectInits.has(v)) {
        const p = projectInits.get(v);
        return p.hasInit && !d22IsZeroInit(p.init)
          ? { kind: "nonzero", var: v }
          : { kind: "zero", var: v };
      }
    }
    return { kind: "unknown", var: ordered[0][0] };
  }
  const exits = [];
  for (const fn of fns) {
    const leg = exitLeg(fn);
    if (leg) exits.push(leg);
  }
  if (exits.length === 0) return [];
  const fee = feeVerdict(exits);
  const out = [];
  const seenPools = new Set();
  for (const exit of exits) {
    const pool = exit.formula.pool;
    // R22 (F15): stake + accrual harus di kontrak yang sama dengan exit;
    // dedup per kontrak+pool (dua kontrak boleh punya pool bernama sama).
    const c = contractOf(exit.fn);
    if (seenPools.has(c + "::" + pool)) continue;
    const stakeFn = fns.find((fn) => contractOf(fn) === c && stakeLeg(fn, pool));
    if (!stakeFn) continue;
    const accrualFn = fns.find((fn) => contractOf(fn) === c && accrualLeg(fn, pool));
    if (!accrualFn) continue;
    seenPools.add(c + "::" + pool);
    const severity = (fee.kind === "zero" || fee.kind === "absent") ? "Medium" : "Low";
    const feeNote = fee.kind === "zero"
      ? "exit fee `" + fee.var + "` default-0 (declared without an initializer or `= 0`)"
      : fee.kind === "absent"
        ? "there is no exit-fee computation in this file (no friction)"
        : fee.kind === "nonzero"
          ? "exit fee `" + fee.var + "` initialized nonzero (friction exists, but does not necessarily close the capture)"
          : "exit fee `" + fee.var + "` is used but its declaration was not found in this file (live value unknown)";
    out.push(normalizeCandidate({
      id: "FA-" + String(idStart + out.length).padStart(3, "0"),
      detector: "jit-reward-accrual-sandwich",
      title: "JIT reward-accrual sandwich: stake before the accrual, lock the rate after ",
      location: { file: fileName, function: accrualFn.name },
      hypothesis: "Function `" + accrualFn.name + "` (line " + (lineOf(accrualFn.startIndex) + 1)
        + ") adds `" + pool + "` without minting shares — the share price rises for all holders. `"
        + stakeFn.name + "` (line " + (lineOf(stakeFn.startIndex) + 1)
        + ") mints shares at the pre-accrual rate, and `" + exit.fn.name + "` (line "
        + (lineOf(exit.fn.startIndex) + 1) + ") locks the post-accrual rate (`"
        + (exit.formula.rateVar || "exchangeRate") + " = (" + pool + " * ...) / " + exit.formula.total
        + "`) then burns shares — an attacker who stakes right before the accrual and requests unbond "
        + "right after it, drains the reward share belonging to old stakers. " + feeNote + ".",
      preconditions: "Accrual is called on a schedule predictable to an attacker (scheduled bot / tx visible in the mempool); no minimum stake→unbond delay; " + feeNote + ".",
      impact: "Repeated extraction of old stakers' rewards — per cycle, the attacker's share ≈ stake / (pool + stake) × the accrued reward; with no fee and no delay, profit is bounded only by gas + pool size.",
      severityGuess: severity,
      evidence: "Accrual `" + accrualFn.name + "` (line " + (lineOf(accrualFn.startIndex) + 1) + "): `"
        + pool + " += <param>` without `_mint`; stake `" + stakeFn.name + "` (line "
        + (lineOf(stakeFn.startIndex) + 1) + "): `_mint` + `" + pool + " += msg.value`; exit `"
        + exit.fn.name + "` (line " + (lineOf(exit.fn.startIndex) + 1) + "): rate `(" + pool
        + " * ...) / " + exit.formula.total + "` is locked, then shares are burned; " + feeNote + ".",
      toVerify: ["Check the LIVE exit fee value (`" + (fee.var || "fee") + "`) — if 0, Medium severity is confirmed; if nonzero, compute the per-cycle capture vs the fee",
        "check the LIVE accrual schedule (AccrueReward events / bot caller): if rigidly scheduled (e.g. same time daily), the timing attack is practical",
        "check for a minimum stake→unbond delay / minimum stake in code + live (if one exists, this candidate dies)",
        "hitung capture live: stake / (pool + stake) × reward per accrual vs biaya gas 3 tx (stake + request + unbond)",
        "Fork PoC: stake before accrueReward, requestUnbond after it, compare the payout vs the initial stake; the fee-1% control (fix-flip) must flip the profit into a loss"],
      source: "pattern-scan",
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detektor ke-23: refund-locked-middleware (kelas VENO-C1 BridgeMiddleware
// zkCRO, sesi BB pagi 19 Nov 2026 — KANDIDAT laten, mock PoC 5/5 PASS).
// Pola: kontrak middleware yang meneruskan deposit user ke bridge/hub
// eksternal (kontrak ini tercatat sebagai deposit sender di bridge), tapi
// (a) tidak punya fungsi rescue untuk ERC20 arbitrer — withdraw yang ada
// hanya token tertentu (base token via lookup) atau ETH ke treasury — dan
// (b) tanpa receive()/fallback() sehingga refund ETH revert di bridge.
// Kaki per kontrak (satu file boleh berisi beberapa kontrak):
//   A. bridge-forward: panggilan member ke entrypoint deposit bridge
//      (requestL2Transaction*, bridge*, sendToL2*, *TwoBridges*, atau
//      deposit* pada objek bernama *bridge*) + aliran dana user masuk
//      (safeTransferFrom/transferFrom dari msg.sender/_msgSender(), atau
//      payable + {value:} ke panggilan bridge). Panggilan ke kontrak
//      *middleware* lain BUKAN bridge-forward (W1: deposit sender-nya
//      middleware itu, bukan kontrak ini). Jalur Direct
//      (requestL2TransactionDirect) hanya dihitung bila refundRecipient
//      = address(this) — bila refund ke user lain, l2Value kembali ke
//      user di L2, bukan terkunci (F12, terverifikasi era-contracts:
//      Messaging.sol refundRecipient + L1Bridgehub Direct tanpa
//      pencatatan nullifier; hanya TwoBridges yang kembali ke
//      _depositSender via claimFailedDeposit).
//   B. tanpa rescue ERC20 arbitrer: tidak ada fungsi external/public di
//      kontrak yang sama (ATAU induknya di file yang sama) yang
//      mentransfer token dari PARAMETER (IERC20(p).transfer/safeTransfer,
//      p.safeTransfer bila p bertipe IERC20, SafeERC20.safeTransfer,
//      helper internal 1 hop, execute arbitrer ber-guard). Transfer ETH
//      (p.transfer) BUKAN rescue; transferFrom BUKAN rescue (revert tanpa
//      self-allowance); rescue allowlist konstan BUKAN rescue; fungsi yang
//      berisi panggilan bridge BUKAN rescue (dust di tx yang sama tidak
//      menolong refund yang mendarat belakangan).
//   C. (bukti saja) tanpa receive()/fallback() yang dapat menerima refund
//      — receive() yang revert / membatasi pengirim dihitung tak ada.
// Kandidat: A + B. Bila aliran masuk hanya ETH (tanpa token), kandidat
// hanya bila C juga benar (refund ETH revert — dana tertahan di bridge).
// Severity Medium; Low bila jalur hanya-ETH atau kontrak upgradeable
// (rescue bisa ditambah lewat upgrade). toVerify menuntut semantik refund
// bridge live + saldo live + rescue di kontrak induk luar-file.
// Batas diketahui: rescue di kontrak induk luar-file tak terlihat; bridge
// yang refund langsung ke user asli (bukan deposit sender) tak dibedakan
// di luar jalur Direct — toVerify butir 1.
// ---------------------------------------------------------------------------
const D23_STRONG_METHOD_RE = /^(?:requestL2Transaction\w*|requestDeposit\w*|sendToL2\w*|requestL2\w*|.*TwoBridges.*)$/;
const D23_BRIDGE_VERB_RE = /^bridge\w*$/;
const D23_DEPOSIT_METHOD_RE = /^deposit\w*$/;
const D23_GETTER_RE = /^(?:get\w+|is\w+|has\w+|bridgehub|bridgeFee|bridgeAddress|baseToken|sharedBridge|balanceOf|allowance|decimals|symbol|name|totalSupply)$/;
const D23_DIRECT_RE = /^requestL2Transaction(Direct)?$/;

function d23EscapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pisah nama identifier camelCase/underscore menjadi token huruf kecil.
// Awalan `I` antarmuka (IBridgehub) dibuang — token `bridgehub` tetap
// dikenali sebagai bridge.
function d23NameTokens(name) {
  return name.replace(/^I(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/)
    .map((t) => t.toLowerCase()).filter(Boolean);
}

function detectRefundLockedMiddleware(source, fileName, idStart, opts) {
  // F18: lewati file test/mock/script + .t.sol/.s.sol + Mock|Harness
  // sebagai prefix ATAU sufiks nama file (case-sensitive, konvensi D22).
  if (/(^|\/)(mocks?|test|tests?|script|scripts?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /\.s\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/.test(fileName)
    || /(Mock|Harness)\.sol$/.test(fileName)) return [];
  const clean = stripComments(source);
  // F10: skip file HANYA bila receive()/fallback() mendelegasikan
  // (proxy) — multicall delegatecall ke address(this) bukan proxy.
  if (/(?:receive|fallback)\s*\([^)]*\)[^{]*\{[^}]{0,600}?delegatecall\s*\(/.test(clean)) return [];
  const lineOf = (idx) => clean.slice(0, idx).split("\n").length - 1;
  const allSpans = contractSpans(clean);
  const spans = allSpans.filter((s) => s.kind === "contract");
  const fns = extractFunctions(clean);
  const contractOf = (fn) => {
    const s = spans.find((sp) => fn.startIndex >= sp.start && fn.startIndex <= sp.end);
    return s ? s.name : null;
  };
  const spanTextOf = (name) => {
    const s = spans.find((sp) => sp.name === name);
    return s ? clean.slice(s.start, s.end) : "";
  };
  // F9: leluhur file-lokal (transitif, aman siklus) untuk pencarian rescue.
  function ancestorsOf(name) {
    const out = new Set();
    const queue = [name];
    while (queue.length > 0) {
      const cur = queue.shift();
      const sp = allSpans.find((s) => s.name === cur);
      if (!sp) continue;
      for (const p of (sp.parents || [])) {
        if (!out.has(p) && p !== name) { out.add(p); queue.push(p); }
      }
    }
    return out;
  }
  // F11: badan fungsi library (kind library) untuk resolusi 1 hop.
  const libFns = new Map();
  for (const sp of allSpans) {
    if (sp.kind !== "library") continue;
    for (const fn of fns) {
      if (fn.startIndex >= sp.start && fn.startIndex <= sp.end) {
        libFns.set(sp.name + "." + fn.name, fn);
      }
    }
  }
  // Teks argumen panggilan: dari `(` di parenIdx, jalan seimbang.
  function parenArgs(body, parenIdx) {
    let depth = 0;
    for (let i = parenIdx; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") {
        depth--;
        if (depth === 0) return body.slice(parenIdx + 1, i);
      }
    }
    return "";
  }
  // Semua panggilan bridge dalam satu badan fungsi (F1 cast inline, F2
  // skor bukan first-match): kembalikan kandidat terbaik atau null.
  // Bentuk objek: identifier ATAU cast `Type(args)` sebelum titik.
  function bridgeCallIn(body) {
    const cands = [];
    const re = /\.\s*([A-Za-z_][\w$]*)\s*(?:\{[^}]*\})?\s*\(/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const method = m[1];
      const dotIdx = m.index;
      // Mundur dari titik: identifier polos atau `)` dari cast.
      let j = dotIdx - 1;
      while (j >= 0 && /\s/.test(body[j])) j--;
      let obj = null;
      if (j >= 0 && /[A-Za-z0-9_$]/.test(body[j])) {
        let k = j;
        while (k >= 0 && /[A-Za-z0-9_$]/.test(body[k])) k--;
        obj = body.slice(k + 1, j + 1);
      } else if (j >= 0 && body[j] === ")") {
        let depth = 0, k = j;
        for (; k >= 0; k--) {
          if (body[k] === ")") depth++;
          else if (body[k] === "(") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (k < 0) continue;
        let t = k - 1;
        while (t >= 0 && /\s/.test(body[t])) t--;
        let s = t;
        while (s >= 0 && /[A-Za-z0-9_$]/.test(body[s])) s--;
        obj = body.slice(s + 1, t + 1);
      }
      if (!obj || obj === "this" || obj === "super") continue;
      // W1: panggilan ke kontrak *middleware* lain = delegasi, bukan
      // deposit langsung ke bridge (deposit sender-nya middleware itu).
      if (/middleware/i.test(obj)) continue;
      // F2: getter bukan entrypoint (bridgehub()/bridgeFee()/get*).
      if (D23_GETTER_RE.test(method)) continue;
      const parenIdx = body.indexOf("(", m.index + m[0].length - 1);
      const hasValue = /\{\s*value\s*:/.test(m[0]);
      let score = 0;
      if (D23_STRONG_METHOD_RE.test(method)) score = 3;
      else if (D23_BRIDGE_VERB_RE.test(method)) score = 2;
      // F3: deposit* hanya pada objek bridge/router (token camelCase) —
      // `pool1`/`wethGateway`/`tokenMessenger` bukan bridge (substring
      // `l1`/`gateway`/`messenger` dulu ikut cocok).
      else if (D23_DEPOSIT_METHOD_RE.test(method)
        && d23NameTokens(obj).some((t) => t === "bridge" || t.startsWith("bridge") || t === "router")) score = 2;
      else continue;
      // F12: jalur Direct — refund l2Value kembali ke refundRecipient di
      // L2; hanya hitung bila refundRecipient = address(this).
      if (D23_DIRECT_RE.test(method)) {
        const args = parenIdx >= 0 ? parenArgs(body, parenIdx) : "";
        if (/refundRecipient\s*:/.test(args)
          && !/refundRecipient\s*:\s*address\s*\(\s*this\s*\)/.test(args)) continue;
      }
      cands.push({ obj, method, index: dotIdx, hasValue, score, parenIdx });
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => b.score - a.score || a.index - b.index);
    return cands[0];
  }
  // Cari panggilan bridge di badan fn; bila tak ada, cari 1 hop ke
  // fungsi library yang dipanggil fn itu (F11) — indeks dikembalikan ke
  // situs pemanggilan library supaya nomor baris tetap benar.
  function bridgeCallOf(fn) {
    const direct = bridgeCallIn(fn.body);
    if (direct) return direct;
    const re = /\b([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(fn.body)) !== null) {
      const libFn = libFns.get(m[1] + "." + m[2]);
      if (!libFn || libFn === fn) continue;
      const lbc = bridgeCallIn(libFn.body);
      if (lbc) return { ...lbc, index: m.index, libFn: libFn.name };
    }
    return null;
  }
  // Nama parameter bertipe address / IERC20 dari signature fungsi.
  function tokenParams(fn) {
    const addr = [];
    const ierc = [];
    let m;
    const ar = /\baddress\s+(?:payable\s+)?([A-Za-z_][\w$]*)/g;
    while ((m = ar.exec(fn.signature)) !== null) addr.push(m[1]);
    const ir = /\b(?:IERC20\w*|ERC20\w*)\s+(?:memory\s+|calldata\s+|storage\s+)?([A-Za-z_][\w$]*)/g;
    while ((m = ir.exec(fn.signature)) !== null) ierc.push(m[1]);
    return { addr, ierc };
  }
  // Apakah badan fn berisi transfer rescue atas parameter token p
  // (p bertipe address -> wajib via IERC20(...)/SafeERC20; p bertipe
  // IERC20 -> boleh bare p.transfer). transferFrom TIDAK dihitung (F8:
  // revert tanpa self-allowance). F5: p.transfer polos atas address =
  // transfer ETH, bukan rescue ERC20.
  function bodyHasRescueTransfer(body, fn) {
    const { addr, ierc } = tokenParams(fn);
    // Allowlist konstan (F8b): require(p == KONSTANTA) -> bukan rescue
    // arbitrer. `!=` / `if-revert` bukan allowlist.
    const allowlisted = (p) => {
      const pr = d23EscapeRegExp(p);
      return new RegExp("\\brequire\\s*\\([^;]{0,150}?\\b" + pr
        + "\\s*==\\s*(?!address\\s*\\(\\s*0\\s*\\))").test(body);
    };
    for (const p of addr) {
      if (allowlisted(p)) continue;
      const pr = d23EscapeRegExp(p);
      if (new RegExp("(?:IERC20\\w*|ERC20\\w*)\\s*\\(\\s*" + pr
        + "\\s*\\)\\s*\\.\\s*(?:safeTransfer|transfer)\\s*\\(").test(body)) return true;
      if (new RegExp("SafeERC20\\s*\\.\\s*safeTransfer\\s*\\(\\s*(?:(?:IERC20\\w*|ERC20\\w*)\\s*\\(\\s*" + pr + "\\s*\\))").test(body)) return true;
    }
    for (const p of ierc) {
      if (allowlisted(p)) continue;
      const pr = d23EscapeRegExp(p);
      if (new RegExp("\\b" + pr + "\\s*\\.\\s*(?:safeTransfer|transfer)\\s*\\(").test(body)) return true;
      if (new RegExp("SafeERC20\\s*\\.\\s*safeTransfer\\s*\\(\\s*" + pr + "\\s*,").test(body)) return true;
    }
    return false;
  }
  // Helper internal yang me-rescue: nama -> info (dipakai F7c).
  const rescueHelpers = new Map();
  for (const fn of fns) {
    if (/\b(external|public)\b/.test(fn.signature) || fn.isConstructor) continue;
    if (bridgeCallIn(fn.body)) continue; // fn bridge bukan helper rescue
    const { addr, ierc } = tokenParams(fn);
    if ((addr.length > 0 || ierc.length > 0) && bodyHasRescueTransfer(fn.body, fn)) {
      rescueHelpers.set(fn.name, fn);
    }
  }
  // Rescue ERC20 arbitrer di kontrak ini ATAU induk file-lokal (F9):
  // transfer rescue langsung, delegasi helper 1 hop (F7c), atau
  // execute arbitrer ber-guard (C31). Fungsi berisi panggilan bridge
  // dikecualikan (F6: dust di tx yang sama bukan jalur keluar refund).
  function findRescue(contractName) {
    const scope = new Set([contractName, ...ancestorsOf(contractName)]);
    for (const fn of fns) {
      if (!scope.has(contractOf(fn))) continue;
      if (!/\b(external|public)\b/.test(fn.signature) || fn.isConstructor) continue;
      if (bridgeCallIn(fn.body)) continue;
      if (bodyHasRescueTransfer(fn.body, fn)) return { fn, kind: "transfer" };
      // Delegasi helper: fn memanggil helper rescue sambil meneruskan
      // salah satu parameter token-nya.
      const { addr, ierc } = tokenParams(fn);
      const toks = [...addr, ...ierc];
      for (const [hName, hFn] of rescueHelpers) {
        if (contractOf(hFn) !== contractName && !scope.has(contractOf(hFn))) continue;
        if (!new RegExp("\\b" + d23EscapeRegExp(hName) + "\\s*\\(").test(fn.body)) continue;
        if (toks.some((t) => new RegExp("\\b" + d23EscapeRegExp(hName)
          + "\\s*\\([^)]*\\b" + d23EscapeRegExp(t) + "\\b").test(fn.body))) {
          return { fn, kind: "helper" };
        }
      }
      // Execute arbitrer ber-guard: owner dapat memanggil token apa pun.
      if (hasAccessGuard(fn)) {
        for (const p of addr) {
          const pr = d23EscapeRegExp(p);
          if (new RegExp("\\b" + pr + "\\s*\\.\\s*(?:call|delegatecall)\\s*(?:\\{|\\()").test(fn.body)) {
            return { fn, kind: "execute" };
          }
        }
      }
    }
    return null;
  }
  // Badan receive()/fallback() di span kontrak (F13): revert / batas
  // pengirim -> refund ETH tetap tak bisa masuk.
  function receiveBlocked(cText) {
    const rm = cText.match(/receive\s*\(\s*\)\s*external[^{]*\{([\s\S]{0,500}?)\}/);
    if (rm && /revert|require\s*\(\s*msg\.sender\s*==/.test(rm[1])) return true;
    const fm = cText.match(/fallback\s*\([^)]*\)\s*external[^{]*\{([\s\S]{0,500}?)\}/);
    if (fm && /revert|require\s*\(\s*msg\.sender\s*==/.test(fm[1])) return true;
    return false;
  }
  const out = [];
  for (const sp of spans) {
    const cName = sp.name;
    // R23-F19: kontrak inti infrastruktur bridge (bridgehub / asset
    // router / shared bridge / nullifier) BUKAN middleware — panggilan
    // deposit di dalamnya adalah plumbing protokol (bridgehubDeposit-
    // BaseToken, bridgeBurn), bukan penerusan deposit user; refund
    // bukan kembali ke kontrak-kontrak ini sebagai deposit sender.
    if (/bridgehub|assetrouter|sharedbridge|nullifier/i.test(cName)) continue;
    const cFns = fns.filter((fn) => contractOf(fn) === cName);
    if (cFns.length === 0) continue;
    // Kaki A: cari panggilan bridge + aliran dana user masuk.
    let bridgeFn = null, bridgeCall = null;
    for (const fn of cFns) {
      const bc = bridgeCallOf(fn);
      if (bc) { bridgeFn = fn; bridgeCall = bc; break; }
    }
    if (!bridgeFn) continue;
    // F4: inflow dari msg.sender ATAU _msgSender().
    const tokenInflow = cFns.some((fn) =>
      /\.\s*(?:safeTransferFrom|transferFrom)\s*\(\s*(?:msg\.sender|_msgSender\s*\(\s*\))\s*,/.test(fn.body));
    // Jalur ETH ke bridge HANYA bila panggilan bridge membawa {value:} —
    // payable + msg.value sebagai mintValue saja bukan aliran ETH ke
    // bridge (mintValue gas dibayar terpisah; refund ETH hanya relevan
    // bila value diteruskan ke bridge).
    const ethForward = bridgeCall.hasValue;
    if (!tokenInflow && !ethForward) continue;
    // Kaki B: tanpa rescue ERC20 arbitrer di kontrak/leluhur ini.
    if (findRescue(cName)) continue;
    // Kaki C (bukti saja): tanpa receive()/fallback() yang dapat
    // menerima refund (F13: receive revert/terbatas = tak ada).
    const cText = spanTextOf(cName);
    const hasReceive = /\breceive\s*\(\s*\)/.test(cText);
    const hasFallback = /\bfallback\s*\(/.test(cText);
    const recvBlocked = (hasReceive || hasFallback) && receiveBlocked(cText);
    const noRecv = (!hasReceive && !hasFallback) || recvBlocked;
    // Aliran masuk hanya ETH -> kandidat hanya bila refund ETH revert
    // (tanpa receive/fallback); token masuk -> refund ERC20 terkunci
    // di middleware apa pun status receive-nya.
    if (!tokenInflow && !noRecv) continue;
    // Jangkar (F15): entrypoint external/public yang mencapai fungsi
    // bridge secara transitif (<=3 hop); bila tak ada, fungsi itu sendiri.
    let anchor = bridgeFn;
    if (!/\b(external|public)\b/.test(bridgeFn.signature)) {
      const callers = new Map();
      for (const fn of cFns) {
        const calls = new Set();
        const re = /\b([A-Za-z_][\w$]*)\s*\(/g;
        let m;
        while ((m = re.exec(fn.body)) !== null) calls.add(m[1]);
        callers.set(fn.name, calls);
      }
      const reach = new Map([[bridgeFn.name, 0]]);
      const queue = [bridgeFn.name];
      while (queue.length > 0) {
        const cur = queue.shift();
        const d = reach.get(cur);
        if (d >= 3) continue;
        for (const fn of cFns) {
          if (reach.has(fn.name)) continue;
          if ((callers.get(fn.name) || new Set()).has(cur)) {
            reach.set(fn.name, d + 1);
            queue.push(fn.name);
          }
        }
      }
      let best = null, bestD = 99;
      for (const fn of cFns) {
        if (!/\b(external|public)\b/.test(fn.signature) || fn.isConstructor) continue;
        const d = reach.get(fn.name);
        if (d !== undefined && d >= 1 && d < bestD) { best = fn; bestD = d; }
      }
      if (best) anchor = best;
    }
    // Withdraw yang ada (bukti: hanya token tertentu / ETH ke treasury).
    const withdraws = cFns
      .filter((fn) => /\b(external|public)\b/.test(fn.signature) && !fn.isConstructor
        && /(withdraw|rescue|sweep|claim)/i.test(fn.name))
      .map((fn) => fn.name + "(" + paramNamesOf(fn).join(", ") + ")");
    // F16: severity — Low bila jalur hanya-ETH atau kontrak upgradeable.
    const upgradeable = /Upgradeable/.test(sp.parents.join(" "))
      || /_authorizeUpgrade\s*\(/.test(cText);
    const severity = (!tokenInflow || upgradeable) ? "Low" : "Medium";
    // F17: catatan ETH hanya bila ada jalur ETH; tanpa klaim hard-coded
    // soal tujuan withdraw (daftar withdraw sudah menyebutkannya).
    const ethNote = !ethForward ? ""
      : noRecv
        ? " This contract has no receive()/fallback() that can accept a refund — the ETH refund from the bridge REVERTS at the transfer point (funds stuck at the bridge, not the middleware)."
        : " This contract has receive()/fallback() — ETH refunds can come in, but ERC20 refunds stay locked (no rescue).";
    out.push(normalizeCandidate({
      id: "FA-" + String(idStart + out.length).padStart(3, "0"),
      detector: "refund-locked-middleware",
      title: "Failed-deposit refund locked in the middleware with no exit path",
      location: { file: fileName, function: anchor.name },
      hypothesis: "Function `" + anchor.name + "` (line " + (lineOf(anchor.startIndex) + 1)
        + ") meneruskan deposit user ke bridge eksternal lewat `" + bridgeCall.obj + "."
        + bridgeCall.method + "` (line " + (lineOf(bridgeFn.startIndex + bridgeCall.index) + 1)
        + ") — the bridge records THIS CONTRACT as the deposit sender, not the user."
        + (tokenInflow ? " User tokens are pulled into this contract first (`transferFrom(msg.sender, address(this), ...)`)."
          : " User ETH is forwarded with `{value:}`.")
        + " If an L2 deposit fails, the bridge returns the funds to the deposit sender = this contract."
        + " There is no rescue function for arbitrary ERC20 in this contract"
        + (withdraws.length > 0 ? " (the only ones present: " + withdraws.join(", ") + ")" : " (there is no withdraw/rescue function at all)")
        + " — an ERC20 refund landing here is locked permanently." + ethNote,
      preconditions: "The L2 deposit fails (user/frontend gas limit or L2 conditions) so the bridge executes the refund path; the live bridge returns the funds to the deposit sender (not the original user).",
      impact: "User principal from a failed deposit is locked permanently in the middleware (ERC20) or stuck at the bridge (ETH without receive/fallback) — conditional loss, no victim until a failed deposit is recorded.",
      severityGuess: severity,
      evidence: "Panggilan bridge `" + bridgeCall.obj + "." + bridgeCall.method + "` di `"
        + bridgeFn.name + "` (line " + (lineOf(bridgeFn.startIndex + bridgeCall.index) + 1) + ")"
        + (bridgeCall.libFn ? " via library `" + bridgeCall.libFn + "`" : "")
        + (tokenInflow ? "; inflow token `transferFrom(msg.sender, address(this), ...)`" : "; forward ETH `{value:}`")
        + "; no arbitrary ERC20 rescue"
        + (withdraws.length > 0 ? "; existing withdraws: " + withdraws.join(", ") : "")
        + "; " + (noRecv ? "without a receive()/fallback() that can accept a refund" : "with a receive()/fallback()") + ".",
      toVerify: ["Confirm the LIVE bridge refund semantics (router/hub returns failed-deposit funds to the deposit sender = this contract, not the original user) — read claimFailedDeposit / _depositSender in the live bridge implementation; for the Direct path, make sure refundRecipient = address(this)",
        "Check this contract's LIVE balance (non-base token > 0 or a ClaimedFailedDeposit event to this address = a victim already exists; 0 = latent)",
        "Check inherited/base contracts outside this file: an arbitrary ERC20 rescue function may live in an out-of-file parent (the detector only sees local-file parents) — if one exists, this candidate dies; also check custom proxies that have their own receive() without delegation",
        "Mock PoC: a deposit fails via the middleware, the refund lands in the middleware, prove the existing withdraws do not touch it (positive control: base token + ETH can be withdrawn)"],
      source: "pattern-scan",
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detektor ke-24: variant-branch-no-payload-consume (kelas L-1 Hyperbridge
// Codec.DecodeHeader, sesi BB pagi 20 Nov 2026 — Info/design, BUKAN kandidat
// submit: header harus genuinely finalized (ZK-proven vs authority set +
// MMR), penyerang tak bisa menyisip digest pilihan; worst-case liveness).
// Pola: loop atas item-item yang di-dispatch berdasarkan tag/kind; satu
// cabang varian opaque (Other/Unknown/Custom/...) hanya menandai flag tanpa
// mengonsumsi payload dari cursor bersama, sementara cabang lain membaca
// payload (decode*/read*/skip* + advance offset). Item berikutnya lalu
// ter-parse dari posisi salah (offset desync) — digest konsensus/ISMP palsu,
// field `other` tak pernah terisi.
// Syarat: (a) rantai if/else-if atas satu variabel tag di dalam loop
// for/while/do-while; (b) tag punya penugasan di badan loop sebelum rantai
// (tag yang dibaca sekali sebelum loop / parameter fungsi BUKAN dispatch
// per-item, F22); (c) >=1 cabang mengonsumsi payload lewat cursor yang sama;
// (d) cabang yang di-flag TIDAK mengonsumsi apa pun dan TIDAK terminasi
// (revert/break/return, F18); (e) nama konstanta cabang mengandung petunjuk
// varian opaque/payload (whole-token: other|unknown|custom|generic|raw|
// opaque|extra|extension|arbitrary|payload; data|bytes hanya sebagai token
// terakhir) — varian unit (mis. RuntimeEnvironmentUpdated, DATA_CLEARED,
// WITHDRAW_ALL) SENGAJA tidak di-flag. Cabang catch-all `else` yang
// flag-only dan non-terminating ikut di-flag sebagai Info.
// Severity Info (wasit: heuristik nama saja tak bisa konfirmasi payload-
// bearing; nama konstanta bisa salah label — F23). Batas diketahui: switch-
// statement belum ditangani; rantai if bersarang kini dipindai (F20, satu
// kandidat per rantai); loop tanpa kurawal hanya bila badannya satu rantai
// if dengan penugasan tag inline (F19); tag berupa literal numerik tanpa
// nama konstanta tidak ter-flag; format wire varian harus dikonfirmasi dari
// spec upstream (toVerify butir 1). Kalibrasi R24 (sesi #42, wasit atas
// review Kiro Opus 5.5 NEEDS WORK F1-F23): tag var dari irisan identifier
// per-cabang, hint dari operand konstanta saja, cursor via aturan panggilan
// terdalam/indeks/fallback, konsumsi via panggilan apa pun dengan cursor +
// assembly + advance offset ketat, alias cursor, terminator, else, do-while,
// dedupe loop bersarang.
// ---------------------------------------------------------------------------
// Token petunjuk varian opaque (whole-token, F13): `data`/`bytes` hanya
// dihitung bila menjadi token TERAKHIR nama konstanta (Kind.Data, ITEM_DATA
// — bukan BYTES32_ROOT / METADATA_HASH).
const D24_STRONG_HINT_TOKENS = new Set(["other", "unknown", "custom", "generic", "raw", "opaque", "extra", "extension", "arbitrary", "payload"]);
const D24_WEAK_HINT_LAST_TOKENS = new Set(["data", "bytes"]);
const D24_TYPE_NAMES = new Set(["uint8", "uint16", "uint32", "uint64", "uint128", "uint256", "int8", "int16", "int32", "int64", "int128", "int256", "uint", "int", "bytes", "bytes32", "address", "bool", "string"]);
const D24_CONSUME_VERB_RE = /^(?:decode\w*|read\w*|parse\w*|consume\w*|skip\w*|advance\w*|extract\w*|next\w*)$/i;

// Pecah nama konstanta menjadi token (garis bawah + batas camelCase +
// digit): DIGEST_ITEM_OTHER -> [digest, item, other]; DATA_CLEARED ->
// [data, cleared]; EXTRACTED -> [extracted]; BYTES32_ROOT -> [bytes32, root].
function d24NameTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

// Apakah operand konstanta mengandung petunjuk varian opaque/payload?
function d24ConstantHasPayloadHint(constText) {
  if (!constText) return false;
  const toks = d24NameTokens(constText);
  if (toks.length === 0) return false;
  if (toks.some((t) => D24_STRONG_HINT_TOKENS.has(t))) return true;
  return D24_WEAK_HINT_LAST_TOKENS.has(toks[toks.length - 1]);
}

// Operand konstanta dari kondisi `TAG == CONST` / `CONST == TAG` (juga bila
// kondisi majemuk `TAG == CONST && ...`): sisi yang TIDAK memuat variabel
// tag; ambil identifier pertama (boleh member-access `Kind.Other`). Tag var
// bernama `payloadType` (F15) atau predikat `!cfg.allowOther` (F14) tak
// pernah sampai ke uji hint karena yang diuji hanya operand konstanta ini.
function d24ConstantOf(cond, tagVar) {
  const parts = cond.split("==");
  if (parts.length < 2) return null;
  const tagRe = new RegExp("\\b" + d24EscapeRegExp(tagVar) + "\\b");
  for (const p of parts) {
    if (tagRe.test(p)) continue;
    const m = p.match(/([A-Za-z_][\w.]*)/);
    if (m) return m[1];
  }
  return null;
}

// Akhir `)` yang seimbang mulai di `(` pada openIdx; -1 bila tak seimbang.
function d24ParenEnd(text, openIdx) {
  let d = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") d++;
    else if (text[i] === ")") { d--; if (d === 0) return i; }
  }
  return -1;
}

// Parse rantai if/else-if/else mulai di indeks `if` (teks sudah
// stripComments). Kembalikan { branches: [{ cond, condStart, body,
// bodyStart, bodyEnd, isElse }], end } atau null bila bentuk tak dikenali.
function d24ParseIfChain(text, ifIdx) {
  const branches = [];
  const continuations = [];
  let pos = ifIdx;
  let first = true;
  while (true) {
    let cond = null, condStart = -1;
    if (!first) {
      // pos menunjuk "else": lewati spasi, cek "if" berikut atau else polos.
      let j = pos + 4;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text.slice(j, j + 2) === "if" && !/\w/.test(text[j + 2] || "")) {
        continuations.push(j);
        pos = j;
      } else {
        let b = j;
        while (b < text.length && /\s/.test(text[b])) b++;
        if (text[b] !== "{") return null;
        const end = blockEndIndex(text, b);
        if (end === -1) return null;
        branches.push({ cond: null, condStart: -1, body: text.slice(b + 1, end), bodyStart: b + 1, bodyEnd: end, isElse: true });
        return { branches, continuations, end: end + 1 };
      }
    }
    // Parse kondisi: `if (` ... `)`.
    let p = pos + 2;
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text[p] !== "(") return null;
    const close = d24ParenEnd(text, p);
    if (close === -1) return null;
    cond = text.slice(p + 1, close);
    condStart = pos;
    // Badan: `{` ... `}` atau satu statement `...;`.
    let b = close + 1;
    while (b < text.length && /\s/.test(text[b])) b++;
    let body, bodyEnd;
    if (text[b] === "{") {
      const end = blockEndIndex(text, b);
      if (end === -1) return null;
      body = text.slice(b + 1, end);
      bodyEnd = end + 1;
    } else {
      const semi = text.indexOf(";", b);
      if (semi === -1) return null;
      body = text.slice(b, semi + 1);
      bodyEnd = semi + 1;
    }
    branches.push({ cond, condStart, body, bodyStart: b, bodyEnd, isElse: false });
    // Lanjut: `else` sesudah badan?
    let e = bodyEnd;
    while (e < text.length && /\s/.test(text[e])) e++;
    if (text.slice(e, e + 4) === "else" && !/\w/.test(text[e + 4] || "")) {
      pos = e;
      first = false;
      continue;
    }
    return { branches, continuations, end: bodyEnd };
  }
}

function d24EscapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Panggilan yang TIDAK memajukan cursor (view/pure/terminating/emit) dan
// kata kunci kontrol yang bukan panggilan: `abi.*` (abi.decode tidak
// memajukan offset, F7) ditangani terpisah.
const D24_PURE_CALLS = new Set(["require", "assert", "revert", "keccak256", "sha256", "ripemd160", "ecrecover", "addmod", "mulmod"]);
const D24_SKIP_CALLS = new Set(["if", "for", "while", "do", "return", "switch", "catch", "try", "new", "delete"]);

// Apakah badan cabang mengonsumsi payload?
// - cursor null (mode state-based, F5): panggilan kata-kerja consume apa
//   pun (kecuali `abi.*`) dihitung konsumsi.
// - cursor dikenal: (a) advance offset (`cursor.offset +=/++/= cursor...`
//   atau `cursor +=/++` untuk cursor indeks, F2/F10); (b) blok `assembly`
//   yang menyebut cursor (konservatif, F6); (c) panggilan apa pun (kecuali
//   `abi.*` + panggilan murni/view + `emit` + kata kunci) yang argumennya
//   menyebut cursor/alias ATAU receiver-nya cursor/alias — helper tak
//   dikenal yang menerima cursor bisa memajukannya (struct memory
//   by-reference), F8/F9. `require`/`assert`/pure builtins tidak memajukan.
//   Alias (F17) dihitung sebagai cursor.
function d24BranchConsumes(body, cursor, aliases) {
  const names = aliases && aliases.size > 0 ? aliases : (cursor ? new Set([cursor]) : new Set());
  // (b) assembly yang menyebut cursor.
  if (cursor && /\bassembly\b/.test(body)) {
    for (const n of names) {
      if (new RegExp("\\b" + d24EscapeRegExp(n) + "\\b").test(body)) return true;
    }
  }
  if (!cursor) {
    // Mode state-based: kata kerja consume saja.
    const callRe = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
    let m;
    while ((m = callRe.exec(body)) !== null) {
      if (m[1] === "abi") continue;
      if (D24_CONSUME_VERB_RE.test(m[2])) return true;
    }
    return false;
  }
  // (a) advance offset — `=` di sini HANYA bila RHS menyebut offset yang
  // sama; `offset == ...` (perbandingan) dan `offset = 0` (reset) TIDAK
  // dihitung (F10). `(?<!\.)` mencegah `slice.offset` cocok untuk cursor
  // indeks bernama `offset`.
  for (const n of names) {
    const esc = d24EscapeRegExp(n);
    if (new RegExp("\\b" + esc + "\\.offset\\s*(?:\\+=|\\+\\+|=(?!=)[^;]*\\b" + esc + "\\.offset\\b)").test(body)) return true;
    if (new RegExp("(?<!\\.)\\b" + esc + "\\s*(?:\\+=|\\+\\+|=(?!=)[^;]*\\b" + esc + "\\b)").test(body)) return true;
  }
  // (c) panggilan apa pun dengan cursor sebagai argumen/receiver.
  const callRe = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
  let m;
  while ((m = callRe.exec(body)) !== null) {
    const recv = m[1] || null;
    const verb = m[2];
    if (recv === "abi") continue;
    if (D24_PURE_CALLS.has(verb)) continue;
    if (D24_SKIP_CALLS.has(verb)) continue;
    if (/emit\s*$/.test(body.slice(0, m.index))) continue;
    if (recv && names.has(recv)) return true;
    const openIdx = m.index + m[0].length - 1;
    const close = d24ParenEnd(body, openIdx);
    if (close === -1) continue;
    const args = body.slice(openIdx + 1, close);
    for (const n of names) {
      if (new RegExp("\\b" + d24EscapeRegExp(n) + "\\b").test(args)) return true;
    }
  }
  return false;
}

// Teks depth-0 badan cabang (di luar semua `{...}`, string literal di-mask)
// untuk cek terminator tingkat atas.
function d24TopLevelText(body) {
  let out = "", depth = 0, i = 0, q = null;
  while (i < body.length) {
    const ch = body[i];
    if (q) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; i++; continue; }
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0) out += ch;
    i++;
  }
  return out;
}

// Cabang yang terminasi di tingkat atas (`revert`/`break`/`return` sebagai
// statement sendiri) tidak bisa men-desync item berikutnya (F18);
// `revert` kondisional (`if (x) revert ...;`) TIDAK dihitung karena jalur
// lain tetap lanjut tanpa konsumsi.
function d24BranchTerminates(body) {
  const top = d24TopLevelText(body);
  return top.split(";").some((st) => /^\s*(revert|break|return)\b/.test(st));
}

// Alias cursor: `Type alias = cursor;` / `alias = cursor;` sebelum rantai
// (F17: `ByteSlice memory s = slice;` lalu `readBytes(s)` ikut memajukan
// `slice.offset`). Diulang 2 putaran untuk rantai alias.
function d24FindAliases(textBefore, cursor) {
  const aliases = new Set([cursor]);
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (const a of [...aliases]) {
      const re = new RegExp("([A-Za-z_]\\w*)\\s*=\\s*" + d24EscapeRegExp(a) + "\\s*;", "g");
      let m;
      while ((m = re.exec(textBefore)) !== null) {
        if (m[1] !== a && !aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
      }
    }
    if (!changed) break;
  }
  return aliases;
}

// Cari nama cursor: (1) dari penugasan variabel tag di badan loop sebelum
// rantai (`kind = Bytes.readByte(slice)` -> `slice`); (2) fallback:
// identifier argumen paling umum di panggilan consume cabang-cabang.
// Cari nama cursor dari penugasan variabel tag (`kind = ...`) di badan loop
// sebelum rantai; null bila tak dapat diturunkan (mode state-based:
// konsumsi dinilai dari kata kerja saja). Urutan: (a) panggilan terdalam
// yang argumen pertamanya identifier polos / member-access polos
// (`uint8(readByte(slice))` -> `slice`; `Bytes.toUint8(Bytes.read(slice,1))`
// -> `slice`; `readByte(slice.data)` -> `slice`); (b) ekspresi indeks
// `arr[idx]` -> `idx` (cursor indeks: `enc[offset]` -> `offset`); (c) bila
// RHS tanpa panggilan: identifier pertama (`slice.data[...]` -> `slice`);
// (d) fallback: identifier argumen paling umum di panggilan consume
// cabang-cabang. (a)/(b) memperbaiki F1/F2; (d) yang kosong -> null (F5).
function d24FindCursor(loopBody, chainStart, tagVar, branches) {
  const before = loopBody.slice(0, chainStart);
  const assignRe = new RegExp("(?:^|[;{}])\\s*(?:[A-Za-z_][\\w.]*\\s+){0,2}" + d24EscapeRegExp(tagVar)
    + "\\s*=(?!=)\\s*([^;]+);", "g");
  let m, last = null;
  while ((m = assignRe.exec(before)) !== null) last = m[1];
  if (last) {
    // (a) panggilan terdalam: kumpulkan semua panggilan di RHS; ambil
    // kandidat TERAKHIR yang argumen pertamanya identifier polos /
    // member-access polos (tanpa parens/bracket di argumennya).
    const callRe = /(?:\w+\s*\.\s*)?\w+\s*\(/g;
    let cm, candidate = null;
    while ((cm = callRe.exec(last)) !== null) {
      const openIdx = cm.index + cm[0].length - 1;
      const close = d24ParenEnd(last, openIdx);
      if (close === -1) continue;
      const args = last.slice(openIdx + 1, close).split(",").map((a) => a.trim()).filter(Boolean);
      if (args.length === 0) continue;
      const firstArg = args[0];
      if (/[(\[]/.test(firstArg)) continue;
      const plain = firstArg.match(/^([A-Za-z_]\w*)$/);
      if (plain) { candidate = plain[1]; continue; }
      const member = firstArg.match(/^([A-Za-z_]\w*)\./);
      if (member) candidate = member[1];
    }
    if (candidate) return candidate;
    // (b) ekspresi indeks `arr[idx]`: identifier pertama di dalam `[...]`.
    const idxM = last.match(/\[([^\]]*)\]/);
    if (idxM) {
      const idIn = idxM[1].match(/([A-Za-z_]\w*)/);
      if (idIn) return idIn[1];
    }
    // (c) RHS tanpa panggilan: identifier pertama.
    if (!/\(/.test(last)) {
      const id = last.match(/([A-Za-z_]\w*)/);
      if (id) return id[1];
    }
    // RHS berupa panggilan tanpa argumen identifier (mis. `readByte()`)
    // -> null (mode state-based).
    return null;
  }
  const counts = new Map();
  for (const b of branches) {
    const callRe = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(b.body)) !== null) {
      if (!D24_CONSUME_VERB_RE.test(cm[2])) continue;
      const openIdx = cm.index + cm[0].length - 1;
      const close = d24ParenEnd(b.body, openIdx);
      if (close === -1) continue;
      const args = b.body.slice(openIdx + 1, close);
      for (const idm of args.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
        counts.set(idm[1], (counts.get(idm[1]) || 0) + 1);
      }
    }
  }
  let best = null, bestN = 0;
  for (const [k, v] of counts) { if (v > bestN) { best = k; bestN = v; } }
  return best;
}

// Variabel tag = identifier yang muncul di SEMUA kondisi rantai (minus
// nama tipe), dan punya penugasan di badan loop sebelum rantai (gerbang
// F22/j2: tag yang dibaca sekali sebelum loop / parameter fungsi bukan
// dispatch per-item). Bila >1 kandidat, pilih yang punya penugasan; bila
// tak ada yang unik -> null.
function d24TagVarFromConds(conds, loopBodyBefore, firstCond) {
  const perBranch = conds.map((c) => {
    const ids = new Set();
    for (const m of c.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      if (!D24_TYPE_NAMES.has(m[1])) ids.add(m[1]);
    }
    return ids;
  });
  let common = perBranch[0] || new Set();
  for (const s of perBranch.slice(1)) {
    common = new Set([...common].filter((x) => s.has(x)));
  }
  const hasAssign = (name) => new RegExp("(?:^|[;{}])\\s*(?:[A-Za-z_][\\w.]*\\s+){0,2}" + d24EscapeRegExp(name) + "\\s*=(?!=)").test(loopBodyBefore)
    || new RegExp("\\b" + d24EscapeRegExp(name) + "\\s*=(?!=)").test(firstCond);
  const assigned = [...common].filter(hasAssign);
  if (assigned.length === 1) return assigned[0];
  return null;
}

// Daftar badan loop dalam satu fungsi: {text, start, braceless} — start =
// indeks awal teks badan di dalam fn.body. Mencakup for/while ber-kurawal,
// do-while ber-kurawal, dan for/while tanpa kurawal yang badannya satu
// rantai if (braceless, F19 — gerbang tag dibatasi penugasan inline di
// kondisi pertama).
function d24FindLoopBodies(fnBody) {
  const out = [];
  const re = /\b(for|while|do)\b/g;
  let m;
  while ((m = re.exec(fnBody)) !== null) {
    const kw = m[1];
    let p = m.index + m[0].length;
    if (kw === "do") {
      while (p < fnBody.length && /\s/.test(fnBody[p])) p++;
      if (fnBody[p] !== "{") continue;
      const end = blockEndIndex(fnBody, p);
      if (end === -1) continue;
      out.push({ text: fnBody.slice(p + 1, end), start: p + 1, braceless: false });
      continue;
    }
    // for/while: header (...).
    while (p < fnBody.length && /\s/.test(fnBody[p])) p++;
    if (fnBody[p] !== "(") continue;
    const close = d24ParenEnd(fnBody, p);
    if (close === -1) continue;
    let b = close + 1;
    while (b < fnBody.length && /\s/.test(fnBody[b])) b++;
    if (fnBody[b] === "{") {
      const end = blockEndIndex(fnBody, b);
      if (end === -1) continue;
      out.push({ text: fnBody.slice(b + 1, end), start: b + 1, braceless: false });
    } else if (fnBody.slice(b, b + 2) === "if" && !/\w/.test(fnBody[b + 2] || "")) {
      // Braceless: badan = rantai if itu sendiri.
      const chain = d24ParseIfChain(fnBody, b);
      if (!chain) continue;
      out.push({ text: fnBody.slice(b, chain.end), start: b, braceless: true });
    }
  }
  return out;
}

function detectVariantBranchNoPayloadConsume(source, fileName, idStart) {
  // Lewati file test/mock/script seperti detektor lain (konvensi D22/D23).
  if (/(^|\/)(mocks?|test|tests?|script|scripts?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /\.s\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/.test(fileName)
    || /(Mock|Harness)\.sol$/.test(fileName)) return [];
  const clean = stripComments(source);
  const lineOf = (idx) => clean.slice(0, idx).split("\n").length - 1;
  const fns = extractFunctions(clean);
  const out = [];
  for (const fn of fns) {
    const body = fn.body;
    const seenChains = new Set();
    for (const loop of d24FindLoopBodies(body)) {
      const loopBody = loop.text;
      const loopBodyStart = loop.start;
      const skipIfs = new Set();
      const ifRe = /\bif\s*\(/g;
      let im;
      while ((im = ifRe.exec(loopBody)) !== null) {
        if (skipIfs.has(im.index)) continue;
        const chain = d24ParseIfChain(loopBody, im.index);
        if (!chain || chain.branches.length < 2) continue;
        for (const c of chain.continuations || []) skipIfs.add(c);
        const conds = chain.branches.filter((br) => br.cond !== null);
        if (conds.length < 1) continue;
        const tagVar = d24TagVarFromConds(conds.map((br) => br.cond), loopBody.slice(0, im.index), conds[0].cond);
        if (!tagVar) continue;
        const cursor = d24FindCursor(loopBody, im.index, tagVar, conds);
        const aliases = cursor ? d24FindAliases(body.slice(0, loopBodyStart + im.index), cursor) : null;
        const allBranches = chain.branches;
        const consumes = allBranches.map((br) => d24BranchConsumes(br.body, cursor, aliases));
        if (!consumes.some(Boolean)) continue;
        // Dedupe: rantai yang sama bisa ditemukan lewat loop luar + loop
        // dalam (F21) — kunci posisi absolut di badan fungsi.
        const dedupeKey = fn.name + ":" + (loopBodyStart + im.index);
        if (seenChains.has(dedupeKey)) continue;
        seenChains.add(dedupeKey);
        for (let k = 0; k < allBranches.length; k++) {
          if (consumes[k]) continue;
          const br = allBranches[k];
          if (d24BranchTerminates(br.body)) continue;
          let condLabel;
          if (br.cond === null) {
            condLabel = "catch-all `else`";
          } else {
            if (!d24ConstantHasPayloadHint(d24ConstantOf(br.cond, tagVar))) continue;
            condLabel = "`" + br.cond.trim().replace(/\s+/g, " ") + "`";
          }
          const consumerConds = allBranches.filter((_, j) => consumes[j])
            .map((c) => c.cond === null ? "catch-all `else`" : "`" + c.cond.trim().replace(/\s+/g, " ") + "`").join(", ");
          const condPos = br.cond === null ? br.bodyStart : br.condStart;
          const lineNo = lineOf(fn.startIndex + loopBodyStart + condPos) + 1;
          out.push(normalizeCandidate({
            id: "FA-" + String(idStart + out.length).padStart(3, "0"),
            detector: "variant-branch-no-payload-consume",
            title: "Cabang varian " + condLabel
              + " does not consume the payload — offset desync for the next item",
            location: { file: fileName, function: fn.name },
            hypothesis: "Di `" + fn.name + "` (line " + lineNo + "), the loop reads items"
              + " item by item from cursor `" + (cursor || "(state-based)") + "` and dispatches based on `"
              + tagVar + "`; cabang " + condLabel
              + " only sets a flag without reading any payload from the cursor,"
              + " while another branch consumes the payload (" + consumerConds + ")."
              + " The cursor does not advance in this branch, so the next item is parsed "
              + " from the wrong position (offset desync) — this branch's payload field "
              + " (e.g. `other`) is never filled and the item after it can "
              + " decoded as a fake tag/field.",
            preconditions: "There is an opaque variant item (Other/Unknown/Custom/...) that "
              + " actually appears in the stream with a length-prefixed payload "
              + " after its tag; the loop continues to the next item (not "
              + " last item / not the only variant in use).",
            impact: "Header/stream parsing desync: the digest/item after the variant "
              + " opaque ter-decode salah — worst-case liveness (revert / root"
              + " garbage is rejected downstream) if the stream must be genuinely "
              + " finalized; not a direct fund-loss — severity Info.",
            severityGuess: "Info",
            evidence: "Cabang " + condLabel
              + " di `" + fn.name + "` (line " + lineNo + ") without any "
              + " read/decode/skip calls over cursor `" + (cursor || "(state-based)") + "`;"
              + " another branch in the same chain consumes the payload ("
              + consumerConds + ").",
            toVerify: ["Confirm this variant's wire format from the upstream spec"
              + " (e.g. Substrate SCALE `DigestItem::Other(Vec<u8>)`): if "
              + " this variant really is unit (no payload), this candidate is DEAD"
              + " — the detector only flags the opaque variant's name",
              "Check whether the stream/header can contain an opaque variant from "
              + " attacker OR must be genuinely finalized (if finalized + "
              + " ZK-proven, worst-case liveness only)",
              "Check downstream usage of this branch's payload field (e.g. "
              + " `Digest.other`): if never read, the impact is limited "
              + " on the desync of the following item",
              "Fork PoC: encode a header with a payload-bearing Other item in "
              + " mid item-sequence, decode, compare the result vs expectation"],
            source: "pattern-scan",
          }));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detektor ke-25: guard-asymmetry-nav-readers (kelas H-SOMM-12 Somm Cellar —
// sesi BB sore 22 Nov 2026, backlog detektor TERBUKA; sesi Frankenstein #56).
// Pola: di satu kontrak, SEBAGIAN fungsi view pembaca NAV yang sama
// ber-guard kunci reentrancy (require(!locked) / modifier nonReentrant),
// sementara saudara sekandungnya membaca NAV yang sama TANPA guard.
// Contoh nyata: Cellar.sol — totalAssets()/totalAssetsWithdrawable()/
// maxWithdraw()/maxRedeem() DO require(!locked, "REENTRANCY"), sementara
// convertToAssets/convertToShares/previewMint/previewWithdraw/
// previewDeposit/previewRedeem (+ maxDeposit, temuan detektor ini) membaca
// NAV lewat _getTotalAssetsAndTotalSupply() -> _calculateTotalAssets...()
// tanpa cek locked; jalur baca lintas-Cellar nyata via
// CellarAdaptor.balanceOf -> previewRedeem. Severity Low: latent/hardening
// — reachability butuh jalur callback ber-hook (ERC777/ERC1363, flash-loan
// callback, adaptor hook) di tengah tx saat locked=true; tanpa itu hanya
// pembacaan NAV basi, bukan fund-loss langsung.
// Cara kerja (level-file, per kontrak): entry point = fungsi public/
// external view/pure; guard = require(!X)/require(X==false)/assert(!X)/
// if (X) revert atas var bernama kunci-reentrancy (lock/reentr/entered/
// status/incall) ATAU modifier *reentr*; dua entry point dianggap
// "saudara NAV" bila closure panggilan transitifnya beririsan pada helper
// view internal yang sama (helper pure dikecualikan — matematika murni
// seperti _convertToAssets bukan pembacaan NAV), ATAU bila keduanya membaca
// langsung state var yang sama dengan saudara ber-guard. Kelompok saudara
// dengan >=1 ber-guard DAN >=1 tanpa guard -> tiap yang tanpa guard
// di-flag Low. Guard diteruskan lewat closure (entry yang memanggil fungsi
// ber-guard ikut ber-guard).
// KALIBRASI R25 (wasit atas review Kiro Opus 5.5 NEEDS WORK, sesi #56,
// 11 temuan F1–F11 SEMUA TERBUKTI — detail di
// docs/kiro-crew-review-2026-11-22-d25.md): F1 propagasi guard lewat closure;
// F2 guard via helper internal + modifier *reentr*; F3 matchAll per pola;
// F4 bentuk guard uint/getter/member (_status != _ENTERED, unlocked == 1,
// slot0.unlocked, _reentrancyGuardEntered()); F5 nama jebakan ditolak
// (depositsLocked, timelocked, lockedUntil, unlocked polaritas-terbalik);
// F6 baca state langsung jadi kunci kelompok hanya bila var itu juga dibaca
// langsung saudara ber-guard (tanpa ini maxMint Cellar ikut ter-flag lewat
// shareSupplyCap + getCreditPositions lewat creditPositions); F7 panggilan
// member x.f() diabaikan; F8 byName multimap + pengecualian-diri per objek;
// F9 resolusi helper lintas-span satu file (unik / induk warisan); F10
// if-revert dicek pemindai kurung-seimbang; F11 kepala signature dikupas
// dari isi kurung sebelum uji visibility/mutabilitas.
// Batas diketahui: helper view trivial yang membaca state (mis. decimals()
// view) masih bisa jadi kunci kelompok — residual diketahui; panggilan
// super./this. tidak ditelusuri; shadowing lokal senama state var bisa
// salah-hitung baca; guard via require di constructor/initializer tidak
// diteruskan; nomor baris dihitung dari `clean` — stripComments
// mempertahankan newline, jadi nomor baris sama dengan source asli.
// ---------------------------------------------------------------------------
const D25_SKIP_CALLS = new Set(["if", "for", "while", "do", "return",
  "switch", "catch", "try", "new", "delete", "require", "assert", "revert",
  "keccak256", "sha256", "ripemd160", "ecrecover", "addmod", "mulmod"]);
// State var generik yang BUKAN NAV — dibaca hampir semua fungsi view
// (denominator/akuntansi ERC20) sehingga tidak boleh jadi kunci kelompok.
const D25_STATE_DENY = new Set(["totalSupply", "balanceOf", "totalShares"]);
const D25_HEAD_KNOWN = new Set(["function", "public", "external", "internal",
  "private", "view", "pure", "payable", "override", "virtual", "returns"]);

// F5: nama var kunci-reentrancy — tolak nama jebakan (depositsLocked,
// timelocked, lockedUntil; `unlocked` hanya sah pada polaritas positif).
function d25GuardNameOk(rawName, positive) {
  const last = String(rawName).split(".").pop();
  const low = last.toLowerCase();
  if (/deposit|timelock|until/.test(low)) return false;
  if (/unlocked/.test(low)) return !!positive;
  return /(lock|reentr|entered|status|incall)/.test(low);
}
// F4: nama "terbuka" untuk polaritas positif (unlocked / _status == 1).
function d25UnlockedNameOk(rawName) {
  const last = String(rawName).split(".").pop();
  const low = last.toLowerCase();
  if (/deposit|timelock|until/.test(low)) return false;
  return /(unlocked|status)/.test(low);
}
// F4: guard dua sisi — `!=` sah bila satu sisi status/lock dan sisi lain
// sentinel ENTERED/LOCKED; `==` sah bila sisi lain sentinel NOT_ENTERED.
function d25TwoSideGuard(a, b, op) {
  const la = String(a).split(".").pop().toLowerCase();
  const lb = String(b).split(".").pop().toLowerCase();
  const statusLike = (s) => /(status|lock|reentr)/.test(s);
  const enteredLike = (s) => /(entered|locked)/.test(s);
  const notEnteredLike = (s) => /(not_entered|notentered|unlocked)/.test(s);
  if (op === "!=") {
    return (statusLike(la) && enteredLike(lb))
      || (statusLike(lb) && enteredLike(la));
  }
  return (statusLike(la) && notEnteredLike(lb))
    || (statusLike(lb) && notEnteredLike(la));
}
// F11: kupas isi kurung (parameter + returns + argumen modifier) dari
// signature sebelum uji visibility/mutabilitas/modifier.
function d25StripParens(s) {
  let out = "", depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
function d25Head(fn) {
  return d25StripParens(fn.signature || "");
}
// F10: sesudah `if (cond)` — `revert` di badan-if? Pemindai kurung-seimbang:
// blok `{...}` hanya sampai kurung tutupnya (else bukan bagian if);
// pernyataan tunggal hanya sampai `;` pertama.
function d25IfReverts(body, end) {
  let i = end;
  while (i < body.length && /\s/.test(body[i])) i++;
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c || "");
  const hasRevertAt = (j) => body.slice(j, j + 6) === "revert"
    && !isWord(body[j + 6]) && (j === 0 || !isWord(body[j - 1]));
  if (body[i] === "{") {
    let depth = 0;
    for (let j = i; j < body.length && j < i + 600; j++) {
      const ch = body[j];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return false; }
      else if (depth >= 1 && hasRevertAt(j)) return true;
    }
    return false;
  }
  for (let j = i; j < body.length && j < i + 600; j++) {
    const ch = body[j];
    if (ch === ";" || ch === "{") return false;
    if (hasRevertAt(j)) return true;
  }
  return false;
}
// F10: semua kemunculan `if (cond)` — uji bentuk kondisi + pemindai revert.
function d25FindIfGuard(body) {
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < body.length; j++) {
      if (body[j] === "(") depth++;
      else if (body[j] === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const cond = body.slice(m.index + m[0].length, j).trim();
    const end = j + 1;
    let ok = false, mm;
    // `if (locked)` / `if (locked == true)` — revert saat kunci aktif.
    // `if (!locked)` SENGAJA tidak dihitung (itu require(locked), bukan guard).
    if ((mm = /^([A-Za-z_][\w.]*)\s*(?:\(\s*\))?$/.exec(cond))) {
      ok = d25GuardNameOk(mm[1], false);
    } else if ((mm = /^([A-Za-z_][\w.]*)\s*==\s*true$/.exec(cond))) {
      ok = d25GuardNameOk(mm[1], false);
    } else if ((mm = /^([A-Za-z_][\w.]*)\s*==\s*([A-Za-z_][\w.]*)$/.exec(cond))) {
      // if-form polaritas TERBALIK dari require: `if (A == ENTERED) revert`
      // = guard, `if (A == NOT_ENTERED) revert` = bukan guard.
      ok = d25TwoSideGuard(mm[1], mm[2], "!=");
    } else if ((mm = /^([A-Za-z_][\w.]*)\s*!=\s*([A-Za-z_][\w.]*)$/.exec(cond))) {
      ok = d25TwoSideGuard(mm[1], mm[2], "==");
    }
    if (ok && d25IfReverts(body, end)) {
      return body.slice(m.index, Math.min(body.length, end + 40))
        .replace(/\s+/g, " ").trim();
    }
  }
  return null;
}
// Bentuk guard dalam satu fungsi — SEMUA kecocokan per pola (F3), bukan
// exec pertama. Mengembalikan teks kecocokan pertama yang lolos, atau null.
function d25GuardForm(fn) {
  const head = d25Head(fn);
  // F2: modifier bernama *reentr* (nonReentrantView dst.).
  for (const tok of head.split(/\s+/)) {
    if (!tok || D25_HEAD_KNOWN.has(tok) || tok === fn.name) continue;
    if (/reentr/i.test(tok)) return "modifier " + tok;
  }
  const body = fn.body || "";
  // F4: require/assert bentuk negasi (termasuk `!locked && ...`) + getter.
  const negPats = [
    /require\s*\(\s*!\s*([A-Za-z_][\w.]*)\b/g,
    /require\s*\(\s*([A-Za-z_][\w.]*)\s*==\s*false\b/g,
    /require\s*\(\s*([A-Za-z_][\w.]*)\s*!=\s*true\b/g,
    /assert\s*\(\s*!\s*([A-Za-z_][\w.]*)\b/g,
    /require\s*\(\s*!\s*([A-Za-z_][\w.]*)\s*\(\s*\)/g,
  ];
  for (const re of negPats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      if (d25GuardNameOk(m[1], false)) {
        return m[0].replace(/\s+/g, " ").trim().replace(/,\s*$/, "");
      }
    }
  }
  // F4: require dua sisi (_status != _ENTERED / _status == _NOT_ENTERED).
  const two = /require\s*\(\s*([A-Za-z_][\w.]*)\s*(!=|==)\s*([A-Za-z_][\w.]*)\b/g;
  let tm;
  two.lastIndex = 0;
  while ((tm = two.exec(body)) !== null) {
    if (d25TwoSideGuard(tm[1], tm[3], tm[2])) {
      return tm[0].replace(/\s+/g, " ").trim();
    }
  }
  // F4: polaritas positif (unlocked == 1 / _status == 1 / require(unlocked)).
  const posPats = [
    /require\s*\(\s*([A-Za-z_][\w.]*)\s*==\s*(?:1|true)\b/g,
    /require\s*\(\s*([A-Za-z_][\w.]*)\s*(?:,|\))/g,
  ];
  for (const re of posPats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      if (d25UnlockedNameOk(m[1])) {
        return m[0].replace(/\s+/g, " ").trim().replace(/,\s*$/, "");
      }
    }
  }
  // F10: if (...) revert.
  return d25FindIfGuard(body);
}
// F7: nama panggilan dalam badan (sesudah `{` pertama — nama fungsi sendiri
// di signature bukan panggilan); panggilan member x.f( diabaikan.
function d25CalledNames(fn) {
  const out = new Set();
  const body = fn.body || "";
  const code = body.slice(body.indexOf("{"));
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (D25_SKIP_CALLS.has(m[1])) continue;
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (k >= 0 && code[k] === ".") continue;
    out.add(m[1]);
  }
  return out;
}
// F6: state var yang dibaca langsung dalam badan fungsi (sesudah `{`).
function d25StateReads(fn, stateVars) {
  const out = new Set();
  const body = fn.body || "";
  const code = body.slice(body.indexOf("{"));
  for (const v of stateVars) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("\\b" + esc + "\\b").test(code)) out.add(v);
  }
  return out;
}
function detectGuardAsymmetryNavReaders(source, fileName, idStart) {
  // Lewati file test/mock/script seperti detektor lain (konvensi D22/D23).
  if (/(^|\/)(mocks?|test|tests?|script|scripts?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)Mock/i.test(fileName)) return [];
  const clean = stripComments(source);
  const fns = extractFunctions(clean);
  if (fns.length < 2) return [];
  // State var per kontrak (F6): nama + indeks, untuk kunci baca-langsung.
  const allStateVars = scanStateVarDecls(clean);
  const hits = [];
  // Indeks file-level untuk resolusi lintas-span (F9).
  const fileByName = new Map();
  for (const span of contractSpans(clean)) {
    for (const f of fns) {
      if (f.startIndex < span.start || f.startIndex > span.end) continue;
      if (!fileByName.has(f.name)) fileByName.set(f.name, []);
      fileByName.get(f.name).push({ fn: f, span });
    }
  }
  function d25Resolve(name, span, byName) {
    if (byName.has(name)) return byName.get(name);
    const cands = (fileByName.get(name) || []).filter((c) => c.span !== span);
    if (!cands.length) return [];
    if (cands.length === 1) return [cands[0].fn];
    const parents = new Set(span.parents || []);
    const inParents = cands.filter((c) => parents.has(c.span.name));
    if (inParents.length === 1) return [inParents[0].fn];
    return []; // ambigu lintas kontrak — konservatif, lewati
  }
  // Per kontrak (bukan per file): dua kontrak satu file dengan helper
  // bernama sama tidak boleh tercampur.
  for (const span of contractSpans(clean)) {
    if (span.kind === "interface") continue;
    const inSpan = fns.filter((f) =>
      f.startIndex >= span.start && f.startIndex <= span.end);
    // F8: multimap — semua overload ditelusuri.
    const byName = new Map();
    for (const f of inSpan) {
      if (!byName.has(f.name)) byName.set(f.name, []);
      byName.get(f.name).push(f);
    }
    const spanStateVars = allStateVars
      .filter((d) => d.nameIndex >= span.start && d.nameIndex <= span.end)
      .map((d) => d.name)
      .filter((n) => !D25_STATE_DENY.has(n)
        && !d25GuardNameOk(n, false) && !d25GuardNameOk(n, true));
    const entries = inSpan.filter((f) =>
      !f.isConstructor
      && /\b(?:public|external)\b/.test(d25Head(f))
      && /\b(?:view|pure)\b/.test(d25Head(f)));
    if (entries.length < 2) continue;
    // Closure per entry: helper view + semua callee (untuk propagasi guard).
    const closures = entries.map((e) => {
      const seen = new Set();
      const stack = [];
      for (const n of d25CalledNames(e)) {
        for (const r of d25Resolve(n, span, byName)) stack.push(r);
      }
      const viewHelpers = new Set();
      const calledFns = new Set();
      while (stack.length) {
        const callee = stack.pop();
        if (!callee || seen.has(callee) || callee === e) continue;
        seen.add(callee);
        calledFns.add(callee);
        const h = d25Head(callee);
        if (/\bview\b/.test(h) && !/\bpure\b/.test(h)) viewHelpers.add(callee);
        for (const n of d25CalledNames(callee)) {
          for (const r of d25Resolve(n, span, byName)) {
            if (!seen.has(r)) stack.push(r);
          }
        }
      }
      return { viewHelpers, calledFns,
        directReads: d25StateReads(e, spanStateVars) };
    });
    // Guard status: bentuk sendiri ATAU lewat closure (F1/F2).
    const guardForms = entries.map((e, i) => {
      const own = d25GuardForm(e);
      if (own) return own;
      for (const c of closures[i].calledFns) {
        const g = d25GuardForm(c);
        if (g) return g + " (via " + c.name + ")";
      }
      return null;
    });
    // F6: kunci baca-langsung hanya sah bila var itu juga dibaca langsung
    // oleh saudara ber-guard (tanpa ini maxMint/getCreditPositions Cellar
    // ikut ter-flag).
    const guardedDirectReads = new Set();
    entries.forEach((e, i) => {
      if (guardForms[i]) {
        for (const v of closures[i].directReads) guardedDirectReads.add(v);
      }
    });
    const keySets = entries.map((e, i) => {
      const keys = new Set(closures[i].viewHelpers);
      for (const v of closures[i].directReads) {
        if (guardedDirectReads.has(v)) keys.add("var:" + v);
      }
      return keys;
    });
    // Union-find: entry point bersaudara bila kunci beririsan.
    const parent = entries.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        for (const k of keySets[i]) {
          if (keySets[j].has(k)) { union(i, j); break; }
        }
      }
    }
    const groups = new Map();
    entries.forEach((_, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    });
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      const guarded = idxs.filter((i) => guardForms[i]);
      const unguarded = idxs.filter((i) => !guardForms[i]);
      if (!guarded.length || !unguarded.length) continue;
      const guardedNames = guarded.map((i) => entries[i].name);
      const guardedKeys = new Set();
      for (const i of guarded) {
        for (const k of keySets[i]) guardedKeys.add(k);
      }
      for (const i of unguarded) {
        const shared = [...keySets[i]].filter((k) => guardedKeys.has(k));
        if (!shared.length) continue;
        const fn = entries[i];
        const line = clean.slice(0, fn.startIndex).split("\n").length;
        const sharedNames = shared.map((k) =>
          typeof k === "string" ? "state `" + k.slice(4) + "`" : "helper `" + k.name + "`");
        hits.push(normalizeCandidate({
          id: "FA-" + String(idStart + hits.length).padStart(3, "0"),
          detector: "guard-asymmetry-nav-readers",
          title: "NAV reader without a reentrancy check, its sibling is guarded",
          location: { file: fileName, function: fn.name },
          hypothesis: "`" + fn.name + "` (line " + line + ") reads the NAV via "
            + sharedNames.join(", ") + " WITHOUT a reentrancy-lock check, while its sibling `"
            + guardedNames.join("`, `") + "` reads the same NAV WITH a guard ("
            + guarded.map((g) => guardForms[g]).join("; ") + ") — the value read "
            + " can be stale/misleading if called mid deposit/withdraw while the lock is active.",
          preconditions: "There is a call path to `" + fn.name + "` while the reentrancy lock is active"
            + " (hooked-token callback, flash-loan callback, adaptor hook, or cross-contract reader"
            + " such as an adaptor balanceOf) — without that path this read is only latent.",
          impact: "Low — stale NAV read cross-contract can move deposit/withdraw decisions/"
            + "another contract's redeem; needs a permissionless callback path to become fund-loss — currently "
            + " latent/hardening, not a submission candidate.",
          severityGuess: "Low",
          evidence: "`" + fn.name + "` without a reentrancy-lock check; `" + guardedNames.join("`, `")
            + "` is guarded; both read the NAV via " + sharedNames.join(", ") + ".",
          toVerify: ["Check whether `" + fn.name + "` can be called mid-callback while the lock is active"
            + " (token ber-hook ERC777/ERC1363, flash-loan callback, adaptor hook)",
            "Check whether the sibling guard is the same reentrancy lock (not pause/role)",
            "Check cross-contract readers that rely on this value (e.g. adaptor balanceOf -> " + fn.name + ")",
            "Fork PoC: activate the lock via reentrancy, then read `" + fn.name + "` — compare with the sibling "
            + " guarded, which reverts"],
          source: "pattern-scan",
        }));
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Detektor ke-26: unbounded-loop-inflatable-set-accounting (kelas H-SOMM-19
// Somm VestingSimple — sesi BB pagi 23 Nov 2026, backlog detektor TERBUKA;
// sesi Frankenstein #59).
// Pola: (kaki tumbuh) fungsi external/public TANPA kontrol akses yang
// menambah entri ke sebuah set/array state dengan KUNCI PILIHAN CALLER
// (parameter fungsi — bukan msg.sender saja), sehingga siapa pun bisa
// menggelembungkan set MILIK KORBAN; (kaki baca) fungsi view di kontrak
// yang sama yang me-loop SELURUH set itu tanpa batas/paginasi
// (`.values()` lalu `for (i < arr.length)`, atau `.length()` langsung)
// dan mengerjakan tiap elemen. Contoh nyata: VestingSimple.deposit()
// (public, tanpa guard) menambah `allUserDepositIds[receiver]` dengan
// receiver bebas + minimum 0,0001 token; `vestedBalanceOf()` me-loop
// seluruh `allUserDepositIds[user].values()`; jalur akuntansi nyata:
// Cellar.totalAssets -> _balanceOf -> VestingSimpleAdaptor.balanceOf
// -> vestedBalanceOf — PoC fork sesi BB pagi 23 Nov: ±9.846 gas/entri,
// brick totalAssets pada ±3.121 entri (vestedBalanceOf OutOfGas eksplisit
// pada gas 30M; biaya serang ±31,2 GHO + ±0,31 ETH @1 gwei); draf
// finding Medium (BELUM DISERANG — TIDAK SIAP SUBMIT). Severity Medium:
// mengikuti draf BB — DoS atas view akuntansi yang dipakai semua alur
// user (deposit/withdraw/redeem/callOnAdaptor); dana beku sampai
// intervensi governance (force-out).
// Cara kerja (level-file, per kontrak + warisan satu file): set/array
// state dikenali dari deklarasi (mapping ke <Prefix>.UintSet/
// AddressSet/Bytes32Set — prefix apa pun, mis. EnumerableSet,
// EnumerableSetUpgradeable, alias import — set polos, atau array
// dinamis mapping/polos); grower = external/public tanpa guard pemanggil
// + `.add(` / `.push(` dengan kunci ber-parameter (mapped) atau tanpa
// kunci (polos — set bersama, sybil-growable); reader = external/
// public view (atau internal view yang dipanggil view public) yang
// me-loop panjang penuh (`.length` array hasil `.values()`, alias
// panjangnya — termasuk alias dari `<set>.length()` — `.length()` set,
// atau `.length` array; loop `for`/`while`, maju/mundur, kondisi
// terbalik) sambil mengindeks elemen (arr[i] / .at(i)), tanpa `break`
// tanpa syarat di badan loop; paginasi (bound = parameter limit/count/
// offset) tidak cocok dengan pola panjang-penuh sehingga tidak ter-flag.
// Penekanan (anti-FP): grower ber-guard pemanggil (only* yang benar-benar
// membatasi caller — lihat d26HasCallerGuard) ditekan; kunci = msg.sender
// saja ATAU mengandung msg.sender di mana pun ditekan (namespace milik
// caller sendiri); cap jumlah entri ditekan — require/if-revert langsung,
// operand terbalik, `length()+1`, alias panjang, cap di modifier, cap di
// helper internal satu hop, dan `.add` di dalam blok `if (length < MAX)`;
// file test/mock dilewati (konvensi D22/D23/D25).
// KALIBRASI R26 (wasit atas review Kiro Opus 5.5 NEEDS WORK, sesi #59,
// 58 kasus: 26 benar / 12 FP / 20 FN; probe wasit /tmp/probe-r26.js
// 5/34 pra-kalibrasi — SEMUA klaim TERBUKTI kecuali F10): F1 cap
// diperlebar (terbalik, blok-revert, +1, alias, modifier, helper,
// guarded-add); F2 cap palsu diperbaiki (panjang harus milik set itu,
// bukan identifier lain); F3 loop while/mundur/terbalik + alias
// set.length(); F4 break bersyarat / break loop-dalam tidak lagi
// membatalkan; F5 clamp sisi reader; F6 kunci kurung-bersarang, mapping
// bersarang, alias lokal, delegasi helper satu hop; F7 kunci campuran
// msg.sender; F8 prefix tipe set apa pun; F9 shadowing parameter/lokal;
// F11 guard pemanggil khusus D26 (modifier keadaan/waktu/jenis +
// validator parameter *Valid* bukan guard); F12 reader internal via
// public view + warisan satu file. DITOLAK sbg artefak/desain: F10
// (plain-set `.add(msg.sender)` SENGAJA di-flag — set bersama bisa
// digelembungkan via sybil, didokumentasikan). Detail:
// docs/kiro-crew-review-2026-11-23-d26.md.
// Batas diketahui: minimum deposit tidak diperiksa (biaya bloat per
// entri = toVerify — cap ekonomi vs cap jumlah entri berbeda); rantai
// panggil ke totalAssets/balanceOf lintas-file tidak dibuktikan statis
// di sini (toVerify); `.add(` dengan argumen konstanta tetap ter-flag
// (kasus langka — wasit men-triase); set di dalam FIELD STRUCT (K9)
// belum dikenali; lintas-file (X1) di luar cakupan; cap di kontrak
// INDUK (modifier/helper di luar span) tidak ditelusuri; grower yang
// menambah lewat helper >1 hop tidak ditelusuri.
// ---------------------------------------------------------------------------
// Pola deklarasi set/array state (D26). Regex /g — lastIndex di-reset
// pemanggil sebelum tiap pemakaian. Tipe set: prefix apa pun
// (`EnumerableSet.`, `EnumerableSetUpgradeable.`, alias import `ES.`)
// atau tanpa prefix (F8).
const D26_SET_RE = [
  // mapping(K => <Prefix>.XSet) name; — tipe set adalah VALUE mapping.
  { kind: "mappedSet", re: /mapping\s*\([^;{]*?=>\s*(?:mapping\s*\([^)]*?=>\s*(?:[A-Za-z_][\w$]*\.)?(?:UintSet|AddressSet|Bytes32Set)\s*\)|(?:[A-Za-z_][\w$]*\.)?(?:UintSet|AddressSet|Bytes32Set))\s*\)\s*(?:public|private|internal)?\s*([A-Za-z_][A-Za-z0-9_$]*)\s*;/g },
  // <Prefix>.XSet name; (polos — set bersama)
  { kind: "plainSet", re: /(?:[A-Za-z_][\w$]*\.)?(?:UintSet|AddressSet|Bytes32Set)\s+(?:public|private|internal)?\s*([A-Za-z_][A-Za-z0-9_$]*)\s*;/g },
  // mapping(K => Type[]) name;
  { kind: "mappedArr", re: /mapping\s*\([^;{]*?=>\s*(?:mapping\s*\([^)]*?=>\s*[A-Za-z_$][\w$.]*\[\]\s*\)|[A-Za-z_$][\w$.]*\[\])\s*\)\s*(?:public|private|internal)?\s*([A-Za-z_][A-Za-z0-9_$]*)\s*;/g },
  // Type[] name; (polos)
  { kind: "plainArr", re: /(?:^|[;{}])\s*[A-Za-z_$][\w$.]*\[\]\s+(?:public|private|internal)?\s*([A-Za-z_][A-Za-z0-9_$]*)\s*;/g },
];
// Indeks akhir pasangan kurung seimbang (kurawal/paren/bracket) dari posisi buka.
function d26Balanced(text, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// Indeks `[` pembuka yang seimbang dengan `]` di closeIdx (scan mundur).
function d26MatchingOpenBracket(text, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (text[i] === "]") depth++;
    else if (text[i] === "[") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// Semua loop `for`/`while` di badan fungsi: { kind, header, body, startIndex }.
// header = isi paren (for: `init; cond; incr`, while: kondisi); body tanpa
// kurung luar (atau pernyataan tunggal sampai `;` bila tanpa kurawal).
function d26Loops(body) {
  const out = [];
  const re = /\b(for|while)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const kind = m[1];
    const openParen = m.index + m[0].length - 1;
    const closeParen = d26Balanced(body, openParen, "(", ")");
    if (closeParen === -1) continue;
    const header = body.slice(openParen + 1, closeParen);
    let j = closeParen + 1;
    while (j < body.length && /\s/.test(body[j])) j++;
    let loopBody = "";
    if (body[j] === "{") {
      const closeBrace = d26Balanced(body, j, "{", "}");
      if (closeBrace === -1) continue;
      loopBody = body.slice(j + 1, closeBrace);
    } else {
      const semi = body.indexOf(";", j);
      if (semi === -1) continue;
      loopBody = body.slice(j, semi + 1);
    }
    out.push({ kind, header, body: loopBody, startIndex: m.index });
  }
  return out;
}
// Semua akses `<var>[...][...]` di teks (kurung seimbang — K4/K3):
// [{ expr, keys, startIdx, endIdx }]. minKeys 1 untuk mapped, 0 untuk polos.
function d26SetAccesses(text, varName, minKeys) {
  const out = [];
  const re = new RegExp("\\b" + varName + "\\b", "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    let j = m.index + m[0].length;
    const keys = [];
    let expr = varName;
    for (;;) {
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] !== "[") break;
      const close = d26Balanced(text, k, "[", "]");
      if (close === -1) break;
      keys.push(text.slice(k + 1, close));
      expr += text.slice(j, close + 1);
      j = close + 1;
    }
    if (keys.length < (minKeys || 0)) continue;
    out.push({ expr, keys, startIdx: m.index, endIdx: j });
  }
  return out;
}
// Ekspresi `<var>[...]` tepat sebelum `.values(` (dotIdx = indeks `.`):
// null bila basisnya bukan var ini.
function d26ValuesBase(text, dotIdx, varName) {
  let i = dotIdx - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;
  while (i >= 0 && text[i] === "]") {
    const open = d26MatchingOpenBracket(text, i);
    if (open === -1) return null;
    i = open - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
  }
  let j = i;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j])) j--;
  if (text.slice(j + 1, i + 1) !== varName) return null;
  return { expr: text.slice(j + 1, dotIdx), baseStart: j + 1 };
}
// Apakah ekspresi (trimmed) adalah panjang-penuh set ini:
// `<akses>.length[(...)]` — akses harus menutupi seluruh ekspresi.
function d26ExprIsSetLength(rhs, v) {
  const e = String(rhs).trim();
  const m = e.match(/^(.*?)\.length\s*(?:\(\s*\))?$/);
  if (!m) return false;
  const base = m[1].trim();
  const minKeys = (v.kind === "mappedSet" || v.kind === "mappedArr") ? 1 : 0;
  const accs = d26SetAccesses(base, v.name, minKeys);
  return accs.some((a) => a.startIdx === 0 && a.endIdx === base.length);
}
// Apakah ekspresi adalah panjang-penuh (set / array .values() / alias).
function d26IsLengthExpr(expr, v, arrNames, lenAliases) {
  const e = String(expr).trim();
  if (lenAliases.has(e)) return true;
  for (const a of arrNames) {
    if (e === a + ".length") return true;
  }
  return d26ExprIsSetLength(e, v);
}
// Hapus `+ N` / `- N` di ujung ekspresi (C6: `length() + 1 <= MAX`).
function d26StripArith(e) {
  return String(e).trim().replace(/\s*[+\-]\s*\d+\s*$/, "");
}
// Apakah SATU klausa perbandingan membatasi panjang (length < bound)?
// Arah: length di kiri dengan < / <=, atau length di kanan dengan > / >=.
function d26ClauseCapsLength(clause, v, arrNames, lenAliases) {
  const c = String(clause).trim();
  const m = c.match(/^(.+?)\s*(<|<=|>|>=|==|!=)\s*(.+?)$/);
  if (!m) return false;
  const op = m[2];
  const left = d26StripArith(m[1]), right = d26StripArith(m[3]);
  const leftIsLen = d26IsLengthExpr(left, v, arrNames, lenAliases);
  const rightIsLen = d26IsLengthExpr(right, v, arrNames, lenAliases);
  if (leftIsLen && !rightIsLen) return op === "<" || op === "<=";
  if (rightIsLen && !leftIsLen) return op === ">" || op === ">=";
  return false;
}
// Apakah SATU klausa membuktikan panjang MELEBIHI batas (length >= bound —
// dipakai pola `if (length >= MAX) revert`)?
function d26ClauseExceedsLength(clause, v, arrNames, lenAliases) {
  const c = String(clause).trim();
  const m = c.match(/^(.+?)\s*(<|<=|>|>=|==|!=)\s*(.+?)$/);
  if (!m) return false;
  const op = m[2];
  const left = d26StripArith(m[1]), right = d26StripArith(m[3]);
  const leftIsLen = d26IsLengthExpr(left, v, arrNames, lenAliases);
  const rightIsLen = d26IsLengthExpr(right, v, arrNames, lenAliases);
  if (leftIsLen && !rightIsLen) return op === ">" || op === ">=";
  if (rightIsLen && !leftIsLen) return op === "<" || op === "<=";
  return false;
}
// Alias panjang lokal di badan: `x = <length-expr>` / `x = <alias>`.
// Sekali jalan sesuai urutan sumber (dipakai cap C11 + reader L8).
function d26LengthAliases(body, v, arrNames) {
  const aliases = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const rhs = m[2].trim();
    if (aliases.has(rhs) || d26IsLengthExpr(rhs, v, arrNames, aliases)) {
      aliases.add(m[1]);
    }
  }
  return aliases;
}
// `if (cond)` — apakah badan-if (blok seimbang / pernyataan tunggal)
// mengandung `revert`? (pola D25-F10, dipakai cap C3.)
function d26IfReverts(body, condEnd) {
  let i = condEnd;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (body[i] === "{") {
    const close = d26Balanced(body, i, "{", "}");
    if (close === -1) return false;
    return /\brevert\b/.test(body.slice(i + 1, close));
  }
  const semi = body.indexOf(";", i);
  if (semi === -1) return false;
  return /\brevert\b/.test(body.slice(i, semi + 1));
}
// Cap LANGSUNG di satu badan teks: require(length < MAX) /
// require(MAX > length) / if (length >= MAX) revert (termasuk blok
// `{ revert ...; }`) — atas panjang set ini atau aliasnya. (F2: panjang
// HARUS milik set ini — `batch.length < 10` bukan cap.)
function d26BodyCapsLength(body, v) {
  const aliases = d26LengthAliases(body, v, new Set());
  const reqRe = /\brequire\s*\(/g;
  let m;
  while ((m = reqRe.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = d26Balanced(body, open, "(", ")");
    if (close === -1) continue;
    const cond = body.slice(open + 1, close);
    for (const clause of cond.split(/&&|\|\|/)) {
      if (d26ClauseCapsLength(clause, v, new Set(), aliases)) return true;
    }
  }
  const ifRe = /\bif\s*\(/g;
  while ((m = ifRe.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = d26Balanced(body, open, "(", ")");
    if (close === -1) continue;
    const cond = body.slice(open + 1, close);
    for (const clause of cond.split(/&&|\|\|/)) {
      if (d26ClauseExceedsLength(clause, v, new Set(), aliases)
        && d26IfReverts(body, close + 1)) return true;
    }
  }
  return false;
}
// Apakah panggilan .add/.push di indeks addIdx berada di dalam blok `if`
// yang mensyaratkan panjang < MAX (C10)? Satu pernyataan juga dihitung.
function d26AddIsGuarded(body, addIdx, v) {
  const aliases = d26LengthAliases(body, v, new Set());
  const ifRe = /\bif\s*\(/g;
  let m;
  while ((m = ifRe.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = d26Balanced(body, open, "(", ")");
    if (close === -1) continue;
    const cond = body.slice(open + 1, close);
    let caps = false;
    for (const clause of cond.split(/&&|\|\|/)) {
      if (d26ClauseCapsLength(clause, v, new Set(), aliases)) { caps = true; break; }
    }
    if (!caps) continue;
    let j = close + 1;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] === "{") {
      const end = d26Balanced(body, j, "{", "}");
      if (end !== -1 && addIdx > j && addIdx < end) return true;
    } else {
      const semi = body.indexOf(";", j);
      if (semi !== -1 && addIdx > j && addIdx < semi) return true;
    }
  }
  return false;
}
// Cap jumlah entri untuk satu grower: langsung di badan, ATAU di modifier
// yang dipakai grower itu, ATAU di helper internal yang dipanggilnya
// (satu hop — C4/C5). spanFns = fungsi-fungsi kontrak ini,
// spanText = teks kontrak ini.
function d26HasEntryCap(fn, spanFns, spanText, v) {
  if (d26BodyCapsLength(fn.body, v)) return true;
  // Modifier: cari definisi `modifier <nama> ... { ... }` di span ini.
  const mp = modifierPart(fn);
  const modRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\))?/g;
  let m;
  const seenMods = new Set();
  while ((m = modRe.exec(mp)) !== null) {
    const name = m[1];
    if (seenMods.has(name)) continue;
    seenMods.add(name);
    if (/^(public|external|internal|private|view|pure|payable|virtual|override|returns)$/.test(name)) continue;
    const defRe = new RegExp("\\bmodifier\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
    const dm = defRe.exec(spanText);
    if (!dm) continue;
    const open = dm.index + dm[0].length - 1;
    const close = d26Balanced(spanText, open, "{", "}");
    if (close === -1) continue;
    if (d26BodyCapsLength(spanText.slice(open + 1, close), v)) return true;
  }
  // Helper internal satu hop: panggilan di badan grower.
  const callRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  const seenHelpers = new Set();
  while ((m = callRe.exec(fn.body)) !== null) {
    const name = m[1];
    if (seenHelpers.has(name) || name === fn.name) continue;
    seenHelpers.add(name);
    const callee = spanFns.find((f) => f.name === name);
    if (!callee) continue;
    if (d26BodyCapsLength(callee.body, v)) return true;
  }
  return false;
}
// Modifier yang BUKAN guard pemanggil (F11): keadaan/waktu/jenis, atau
// validator parameter bernama *Valid* (argumennya semua parameter fungsi).
function d26NonGuardModifierNames(fn) {
  const params = new Set(paramNamesOf(fn).filter(Boolean));
  const mp = modifierPart(fn);
  const out = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*(\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(mp)) !== null) {
    const name = m[1];
    if (/^(public|external|internal|private|view|pure|payable|virtual|override|returns)$/.test(name)) continue;
    const argStr = m[3];
    if (/^(only)?(whenNotPaused|whenPaused|paused|unpaused|notPaused)$/i.test(name)
      || /^only(After|Before)[A-Z]/.test(name)
      || /^onlyEOA$/.test(name)) { out.push(name); continue; }
    if (/^onlyValid[A-Z]/.test(name) && argStr !== undefined) {
      const args = argStr.split(",").map((s) => s.trim()).filter(Boolean);
      if (args.length > 0 && args.every((a) => params.has(a))) out.push(name);
    }
  }
  return out;
}
// Guard pemanggil khusus D26: hasAccessGuard, kecuali bila satu-satunya
// penyebabnya adalah modifier bukan-guard (F11) — modifier itu dibuang
// dari signature lalu hasAccessGuard diuji ulang atas salinannya.
function d26HasCallerGuard(fn) {
  if (!hasAccessGuard(fn)) return false;
  const excused = d26NonGuardModifierNames(fn);
  if (!excused.length) return true;
  let sig = fn.signature;
  for (const name of excused) {
    sig = sig.replace(new RegExp("\\b" + name + "\\s*(\\([^)]*\\))?", "g"), " ");
  }
  const probe = Object.assign({}, fn, { signature: sig.replace(/\s+/g, " ").trim() });
  return hasAccessGuard(probe);
}
// Alias lokal satu langkah: `k = <param>` / `<type> k = <param>` —
// kunci boleh memakai alias parameter (K5). Fixpoint kecil (rantai).
function d26LocalParamAliases(fn) {
  const params = new Set(paramNamesOf(fn).filter(Boolean));
  const map = new Map();
  const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_][A-Za-z0-9_$]*)\s*;/g;
  let m;
  let changed = true;
  for (let round = 0; round < 3 && changed; round++) {
    changed = false;
    re.lastIndex = 0;
    while ((m = re.exec(fn.body)) !== null) {
      const lhs = m[1], rhs = m[2];
      const resolved = params.has(rhs) ? rhs : (map.get(rhs) || null);
      if (resolved && !map.has(lhs)) { map.set(lhs, resolved); changed = true; }
    }
  }
  return map;
}
// Apakah nama var di-shadow di fungsi ini (parameter / deklarasi lokal)?
// (F9 — parameter/lokal `holders` bukan state var.)
function d26IsShadowed(fn, varName) {
  if (paramNamesOf(fn).filter(Boolean).includes(varName)) return true;
  const re = new RegExp("(?:^|[;{}])\\s*[A-Za-z_$][\\w$.]*(?:\\[\\])?\\s+(?:memory|calldata|storage)?\\s*" + varName + "\\s*(?:=|;|,)");
  return re.test(fn.body);
}
// Kunci mengandung msg.sender / _msgSender() di mana pun → namespace
// milik caller sendiri, bukan korban (F7).
function d26KeyHasCaller(keyExpr) {
  return /\bmsg\.sender\b/.test(keyExpr) || /_msgSender\s*\(/.test(keyExpr);
}
// Resolusi alias lokal atas ekspresi kunci (K5).
function d26ResolveKeyAliases(keyExpr, aliasMap) {
  let out = keyExpr;
  for (const [alias, param] of aliasMap) {
    out = out.replace(new RegExp("\\b" + alias + "\\b", "g"), param);
  }
  return out;
}
// Pertumbuhan di satu badan teks: akses set + `.add(`/`.push(` sesudahnya.
// Mengembalikan { addIdx, keyParam } atau null. Kunci di-resolusi alias
// lokal; kunci ber-msg.sender ditolak (F7).
function d26GrowthInBody(body, v, minKeys, verb, params, aliasMap) {
  for (const acc of d26SetAccesses(body, v.name, minKeys)) {
    let j = acc.endIdx;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== ".") continue;
    const callM = body.slice(j).match(/^\.\s*(add|push)\s*\(/);
    if (!callM || callM[1] !== verb) continue;
    if (minKeys === 0) return { addIdx: acc.startIdx, keyParam: null };
    const rawKey = acc.keys.join(" ");
    const keyExpr = d26ResolveKeyAliases(rawKey, aliasMap);
    if (d26KeyHasCaller(keyExpr)) continue;
    const hitParam = params.find((p) => new RegExp("\\b" + p + "\\b").test(keyExpr));
    if (!hitParam) continue;
    return { addIdx: acc.startIdx, keyParam: hitParam };
  }
  return null;
}
// Helper yang dipanggil fn (satu hop): [{ fn: callee, args }].
function d26CalledHelpers(fn, spanFns) {
  const out = [];
  const seen = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(fn.body)) !== null) {
    const name = m[1];
    if (seen.has(name) || name === fn.name) continue;
    seen.add(name);
    const callee = spanFns.find((f) => f.name === name);
    if (!callee || callee === fn) continue;
    const open = m.index + m[0].length - 1;
    const parsed = splitTopLevelArgs(fn.body, open);
    if (!parsed) continue;
    out.push({ fn: callee, args: parsed.args.map((a) => a.trim()) });
  }
  return out;
}
// Pertumbuhan via helper: petakan argumen pemanggil ke parameter helper
// (substitusi nama parameter helper dengan argumennya di badan helper),
// lalu uji seperti pertumbuhan langsung dengan parameter pemanggil.
function d26GrowthViaHelper(callerFn, helper, v, minKeys, verb, callerParams) {
  const calleeParams = paramNamesOf(helper.fn).filter(Boolean);
  if (calleeParams.includes(v.name)) return null;
  const subst = new Map();
  calleeParams.forEach((p, i) => {
    if (i < helper.args.length) subst.set(p, helper.args[i]);
  });
  let helperBody = helper.fn.body;
  const names = [...subst.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    helperBody = helperBody.replace(new RegExp("\\b" + name + "\\b", "g"), "(" + subst.get(name) + ")");
  }
  return d26GrowthInBody(helperBody, v, minKeys, verb, callerParams, new Map());
}
// Kaki tumbuh: external/public tanpa guard pemanggil yang menambah entri
// ke set — langsung di badan, atau satu hop via helper internal (K10).
// Mapped: kunci harus mengandung nama parameter (pilihan caller);
// polos: set bersama — panggilan .add/.push apa pun sudah menggelembungkan
// (sengaja: sybil — lihat F10).
function d26FindGrowers(spanFns, spanText, v) {
  const growers = [];
  const minKeys = (v.kind === "mappedSet" || v.kind === "mappedArr") ? 1 : 0;
  const verb = (v.kind === "mappedSet" || v.kind === "plainSet") ? "add" : "push";
  for (const fn of spanFns) {
    if (fn.isConstructor) continue;
    if (!/\b(?:external|public)\b/.test(fn.signature)) continue;
    if (d26HasCallerGuard(fn)) continue;
    if (d26IsShadowed(fn, v.name)) continue;
    const params = paramNamesOf(fn).filter(Boolean);
    const aliasMap = d26LocalParamAliases(fn);
    // (a) Pertumbuhan langsung di badan grower.
    const direct = d26GrowthInBody(fn.body, v, minKeys, verb, params, aliasMap);
    if (direct) {
      if (d26HasEntryCap(fn, spanFns, spanText, v)) continue;
      if (d26AddIsGuarded(fn.body, direct.addIdx, v)) continue;
      growers.push({ fn, keyParam: direct.keyParam, via: null });
      continue;
    }
    // (b) Delegasi satu hop ke helper internal (K10).
    for (const helper of d26CalledHelpers(fn, spanFns)) {
      if (d26HasCallerGuard(helper.fn)) continue;
      const mapped = d26GrowthViaHelper(fn, helper, v, minKeys, verb, params);
      if (!mapped) continue;
      if (d26HasEntryCap(fn, spanFns, spanText, v)) continue;
      growers.push({ fn, keyParam: mapped.keyParam, via: helper.fn.name });
      break;
    }
  }
  return growers;
}
// Apakah kondisi (tanpa &&/||) adalah perbandingan panjang-penuh:
// satu sisi variabel loop, sisi lain ekspresi panjang.
function d26CondIsFullLength(cond, v, arrNames, lenAliases) {
  const c = String(cond).trim();
  if (/&&|\|\|/.test(c)) return false;
  const m = c.match(/^(.+?)\s*(<|<=|>|>=|==|!=)\s*(.+?)$/);
  if (!m) return false;
  const left = m[1].trim(), right = m[3].trim(), op = m[2];
  const leftIsLen = d26IsLengthExpr(left, v, arrNames, lenAliases);
  const rightIsLen = d26IsLengthExpr(right, v, arrNames, lenAliases);
  const leftIsVar = /^[A-Za-z_][\w$]*$/.test(left);
  const rightIsVar = /^[A-Za-z_][\w$]*$/.test(right);
  if (leftIsVar && rightIsLen) return op === "<" || op === "<=" || op === "!=";
  if (rightIsVar && leftIsLen) return op === ">" || op === ">=" || op === "!=";
  return false;
}
// Apakah satu loop me-loop panjang penuh set ini? `for` maju/mundur,
// kondisi terbalik, dan `while` ikut dihitung (F3).
function d26LoopIsFullLength(lp, v, arrNames, lenAliases) {
  if (lp.kind === "while") {
    return d26CondIsFullLength(lp.header, v, arrNames, lenAliases);
  }
  const parts = lp.header.split(";");
  if (parts.length < 2) return false;
  if (d26CondIsFullLength(parts[1], v, arrNames, lenAliases)) return true;
  // Loop mundur: init `i = <LEN>` + kondisi `i > 0` / `i >= 0` / `i != 0`.
  if (/^\s*[A-Za-z_][\w$]*\s*(>|>=|!=)\s*0\s*$/.test(parts[1].trim())) {
    const initM = parts[0].match(/=\s*(.+?)\s*$/);
    if (initM && d26IsLengthExpr(initM[1], v, arrNames, lenAliases)) return true;
  }
  return false;
}
// Apakah badan loop punya `break` TANPA SYARAT (F4)? `break` di dalam
// blok bersyarat / loop dalam TIDAK membatalkan (worst case tetap
// seluruh set); `break` di level atas badan loop, atau `if (c) break;`
// tanpa kurawal yang terakhir, ikut dihitung bersyarat.
function d26HasUnconditionalBreak(loopBody) {
  const re = /\bbreak\s*;/g;
  let m;
  while ((m = re.exec(loopBody)) !== null) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (loopBody[i] === "{") depth++;
      else if (loopBody[i] === "}") depth--;
    }
    if (depth >= 1) continue;
    const before = loopBody.slice(0, m.index);
    const stmtStart = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"),
      before.lastIndexOf("}")) + 1;
    const stmt = before.slice(stmtStart).trim();
    if (/^if\s*\(.*\)\s*$/.test(stmt)) continue;
    return true;
  }
  return false;
}
// Apakah badan loop mengerjakan tiap elemen: arr[i] / .at(i) / akses set.
function d26LoopTouches(loopBody, v, arrNames) {
  if (/\.at\s*\(/.test(loopBody)) return true;
  for (const a of arrNames) {
    if (new RegExp("\\b" + a + "\\s*\\[").test(loopBody)) return true;
  }
  const minKeys = (v.kind === "mappedSet" || v.kind === "mappedArr") ? 1 : 0;
  return d26SetAccesses(loopBody, v.name, minKeys).length > 0;
}
// Alias yang di-CLAMP sebelum indeks loopStartIdx (F5): `if (a > N) a = ...`,
// `a = min(a, N)`, atau ternary `a = a > N ? ... : ...`.
function d26ClampedAliases(body, loopStartIdx, aliases) {
  const out = new Set();
  const prefix = body.slice(0, loopStartIdx);
  for (const a of aliases) {
    if (new RegExp("\\bif\\s*\\(\\s*" + a + "\\s*>[^;{]*\\)\\s*\\{?\\s*" + a + "\\s*=").test(prefix)
      || new RegExp("\\b" + a + "\\s*=\\s*(?:[A-Za-z_$][\\w$.]*\\.)?min\\s*\\(\\s*" + a + "\\b").test(prefix)
      || new RegExp("\\b" + a + "\\s*=\\s*" + a + "\\s*>[^?]+\\?").test(prefix)) {
      out.add(a);
    }
  }
  return out;
}
// Kaki baca: external/public view yang me-loop panjang penuh set itu
// sambil mengindeks tiap elemen — atau internal view yang dipanggil view
// public (L13; kandidat berjangkar di pemanggil public).
function d26FindReaders(spanFns, v) {
  const readers = [];
  const seen = new Set();
  function analyze(fn) {
    if (fn.isConstructor) return null;
    if (d26IsShadowed(fn, v.name)) return null;
    const body = fn.body;
    // Array lokal dari .values() atas set ini.
    const arrNames = new Set();
    const valRe = /\.values\s*\(/g;
    let m;
    while ((m = valRe.exec(body)) !== null) {
      const base = d26ValuesBase(body, m.index, v.name);
      if (!base) continue;
      const before = body.slice(0, base.baseStart);
      const assignM = before.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*$/);
      if (assignM) arrNames.add(assignM[1]);
    }
    const lenAliases = d26LengthAliases(body, v, arrNames);
    for (const lp of d26Loops(body)) {
      const clamped = d26ClampedAliases(body, lp.startIndex, lenAliases);
      const effective = new Set([...lenAliases].filter((a) => !clamped.has(a)));
      if (!d26LoopIsFullLength(lp, v, arrNames, effective)) continue;
      if (d26HasUnconditionalBreak(lp.body)) continue;
      if (!d26LoopTouches(lp.body, v, arrNames)) continue;
      return { fn, loop: lp };
    }
    return null;
  }
  // (a) Pembaca langsung: external/public view.
  for (const fn of spanFns) {
    if (fn.isConstructor) continue;
    if (!/\b(?:external|public)\b/.test(fn.signature)) continue;
    if (!/\bview\b/.test(fn.signature)) continue;
    if (analyze(fn)) { readers.push({ fn, via: null }); seen.add(fn.name); }
  }
  // (b) Pembaca internal view yang dipanggil view public (L13).
  for (const fn of spanFns) {
    if (fn.isConstructor) continue;
    if (/\b(?:external|public)\b/.test(fn.signature)) continue;
    if (!/\bview\b/.test(fn.signature)) continue;
    if (!analyze(fn)) continue;
    for (const caller of spanFns) {
      if (caller.isConstructor || caller === fn) continue;
      if (!/\b(?:external|public)\b/.test(caller.signature)) continue;
      if (!/\bview\b/.test(caller.signature)) continue;
      if (seen.has(caller.name)) continue;
      if (new RegExp("\\b" + fn.name + "\\s*\\(").test(caller.body)) {
        readers.push({ fn: caller, via: fn.name });
        seen.add(caller.name);
        break;
      }
    }
  }
  return readers;
}
function detectUnboundedLoopInflatableSet(source, fileName, idStart) {
  // Lewati file test/mock/script seperti detektor lain (konvensi D22/D23/D25).
  if (/(^|\/)(mocks?|test|tests?|script|scripts?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)Mock/i.test(fileName)) return [];
  const clean = stripComments(source);
  const fns = extractFunctions(clean);
  if (fns.length < 2) return [];
  const spans = contractSpans(clean);
  const structSpans = findBlockSpans(clean, "struct");
  // Variabel set/array per span (deklarasi sendiri saja).
  const spanVars = new Map();
  const spanByName = new Map();
  for (const span of spans) {
    if (span.kind === "interface") continue;
    if (!spanByName.has(span.name)) spanByName.set(span.name, span);
    const spanFns = fns.filter((f) =>
      f.startIndex >= span.start && f.startIndex <= span.end);
    const fnRanges = spanFns.map((f) => [f.startIndex, f.endIndex]);
    const inFn = (idx) => fnRanges.some(([a, b]) => idx >= a && idx <= b);
    const inStruct = (idx) => structSpans.some((s) => idx >= s.start && idx <= s.end);
    const vars = [];
    const seen = new Set();
    for (const def of D26_SET_RE) {
      def.re.lastIndex = 0;
      let m;
      while ((m = def.re.exec(clean)) !== null) {
        const name = m[1];
        const idx = m.index + m[0].indexOf(name);
        if (idx < span.start || idx > span.end) continue;
        if (inFn(idx) || inStruct(idx)) continue;
        const key = def.kind + ":" + name;
        if (seen.has(key)) continue;
        seen.add(key);
        vars.push({ name, kind: def.kind,
          declLine: clean.slice(0, idx).split("\n").length - 1 });
      }
    }
    spanVars.set(span, vars);
  }
  // Closure warisan: span + semua leluhurnya (transitif) — T3.
  function ancestorSpans(span) {
    const out = [span];
    const seen = new Set([span]);
    const queue = [span];
    while (queue.length) {
      const cur = queue.shift();
      for (const p of (cur.parents || [])) {
        const ps = spanByName.get(p);
        if (ps && !seen.has(ps)) { seen.add(ps); out.push(ps); queue.push(ps); }
      }
    }
    return out;
  }
  const hits = [];
  const seenCand = new Set();
  const allVars = [];
  for (const [span, vars] of spanVars) {
    for (const v of vars) allVars.push({ v, declSpan: span });
  }
  for (const { v, declSpan } of allVars) {
    // Span-span yang melihat var ini: span deklarasi + turunannya.
    const visibleSpans = spans.filter((s) => s.kind !== "interface"
      && ancestorSpans(s).includes(declSpan));
    const growers = [];
    const readers = [];
    for (const s of visibleSpans) {
      const sFns = fns.filter((f) => f.startIndex >= s.start && f.startIndex <= s.end);
      const sText = clean.slice(s.start, s.end + 1);
      for (const g of d26FindGrowers(sFns, sText, v)) {
        if (!growers.some((x) => x.fn === g.fn)) growers.push({ fn: g.fn, keyParam: g.keyParam, via: g.via, span: s });
      }
      for (const r of d26FindReaders(sFns, v)) {
        if (!readers.some((x) => x.fn === r.fn)) readers.push({ fn: r.fn, via: r.via, span: s });
      }
    }
    if (!growers.length) continue;
    for (const r of readers) {
      const key = v.name + "@" + r.fn.name;
      if (seenCand.has(key)) continue;
      seenCand.add(key);
      const g = growers[0];
      const rLine = clean.slice(0, r.fn.startIndex).split("\n").length;
      const gLine = clean.slice(0, g.fn.startIndex).split("\n").length;
      const rSpanNote = r.span !== declSpan ? " (contract " + r.span.name + ")" : "";
      const gSpanNote = g.span !== declSpan ? " (contract " + g.span.name + ")" : "";
      hits.push(normalizeCandidate({
        id: "FA-" + String(idStart + hits.length).padStart(3, "0"),
        detector: "unbounded-loop-inflatable-set-accounting",
        title: "Unbounded loop over a set that anyone can inflate permissionlessly",
        location: { file: fileName, function: r.fn.name },
        hypothesis: "`" + r.fn.name + "` (line " + rLine + rSpanNote + ") loops over the ENTIRE contents of set `" + v.name
          + "` without a cap/pagination"
          + (r.via ? " lewat helper internal `" + r.via + "`" : "")
          + ", sementara `" + g.fn.name + "` (line " + gLine + gSpanNote + ") adds an entry to that set"
          + " WITHOUT access control with a caller-chosen key"
          + (g.keyParam ? " (parameter `" + g.keyParam + "`)" : "")
          + (g.via ? " lewat helper internal `" + g.via + "`" : "")
          + " — anyone can inflate the victim's set until the read "
          + " this accounting runs out of gas (OutOfGas) and every flow that reads it reverts.",
        preconditions: "Pembaca `" + r.fn.name + "` reachable from the accounting path (totalAssets/balanceOf "
          + " or similar) and the grower `" + g.fn.name + "` can still be called by anyone"
          + " (no guard in another contract / no entry-count cap outside this file).",
        impact: "Medium — DoS on the accounting view: deposit/withdraw/redeem and every check "
          + " totalAssets before/after that call this reader also revert; the position's funds "
          + " beku sampai intervensi governance (force-out). Biaya serang = minimum deposit ×"
          + " entry count + gas (real example, Somm: ±3,121 entries brick totalAssets).",
        severityGuess: "Medium",
        evidence: "Grower `" + g.fn.name + "` (line " + gLine + gSpanNote + ") without access control adds `"
          + v.name + "`" + (g.keyParam ? " with the parameter key `" + g.keyParam + "`" : "")
          + (g.via ? " lewat helper internal `" + g.via + "`" : "")
          + "; reader `" + r.fn.name + "` (line " + rLine + rSpanNote + ") loops over the full length of that set"
          + (r.via ? " lewat helper internal `" + r.via + "`" : "")
          + " without an unconditional `break`/pagination; set declaration line " + (v.declLine + 1) + ".",
        toVerify: ["Check the call chain: does `" + r.fn.name + "` is read from totalAssets/balanceOf (the accounting path) — if only read directly by users, the impact is self-DoS",
          "Check the bloat cost per entry (minimum deposit + grower gas) and the brick threshold (gas/entry × block gas limit)",
          "Check for an entry-count cap / pagination in other contracts or in the deployed version",
          "Check the post-brick recovery path (force-out / governance) and whether funds can exit without this reader",
          "PoC fork: bloat set sampai ambang lalu panggil `" + r.fn.name + "` + totalAssets with the block gas limit — must revert OutOfGas"],
        source: "pattern-scan",
      }));
    }
  }
  return hits;
}

function detectDeadConfigStorage(source, fileName, idStart) {
  if (/(^|\/)(mocks?|test|tests?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/i.test(fileName)) return [];
  const dead = findDeadConfigVars(source);
  const contractName = (source.match(/\bcontract\s+([A-Za-z_][A-Za-z0-9_$]*)/) || [])[1]
    || fileName.split("/").pop();
  return dead.map((d, k) => {
    const writerList = d.writes.map((w) => (w.fn || "?") + " (line " + (w.line + 1) + ")").join(", ");
    const isInfo = d.infoReasons.length > 0;
    const cand = normalizeCandidate({
      id: "FA-" + String(idStart + k).padStart(3, "0"),
      detector: "dead-config-storage",
      title: "Dead config: `" + d.name + "` written but never read",
      location: { file: fileName, function: d.firstWriter.fn || contractName },
      hypothesis: "State var `" + d.name + "` (declaration line " + (d.declLine + 1) + ") ditulis "
        + d.writes.length + "× di " + writerList + " but is NEVER read in this file"
        + (d.noops > 0 ? " (plus " + d.noops + "× statement no-op `" + d.name + ";` — mentioned but not used)" : "")
        + " — config set by governance changes no contract behavior at all.",
      preconditions: "The setter/initialize is still callable (governance active) and no reader in another file was missed.",
      impact: "The operator/governance believes this config applies when it does not — decisions (e.g. picking the primary vs secondary oracle, spread thresholds) silently have no effect; if upstream READS this var, the fork has lost its wiring (see the upstream-diff annotation).",
      severityGuess: isInfo ? "Info" : "Low",
      evidence: "Written in " + writerList + "; 0 reads in this file"
        + (d.noops > 0 ? "; " + d.noops + "× statement no-op `" + d.name + ";`" : "")
        + "; declaration line " + (d.declLine + 1) + "."
        + (isInfo ? " [Info: " + d.infoReasons.join("; ") + "]" : ""),
      toVerify: ["Check whether this var is read via a public getter by other contracts / off-chain (a `public` auto-getter can still be read cross-contract)",
        "compare with upstream: if upstream READS this var, the fork removed its wiring",
        "check whether its setter is still callable by governance — if yes, this config misleads the operator",
        "Fork PoC: set the var, then call the path that should be affected, compare behavior"],
      source: "pattern-scan",
    });
    cand.varName = d.name;
    // Baris deklarasi (0-based) — dipakai classifyUpstreamDiff untuk
    // menentukan kontrak pemilik var ini (fallback rename multi-kontrak).
    cand.declLine = d.declLine;
    // Alasan Info — dipakai applyProjectPass (residual (3), sesi 16:38 WIB
    // 2026-11-17) untuk mencabut alasan abstract-internal bila
    // project-pass membuktikan tidak ada pembaca lintas-file.
    cand.infoReasons = d.infoReasons.slice();
    return cand;
  });
}

// ---------------------------------------------------------------------------
// Detektor eth-locked-receive (detektor ke-15, kelas AMP-05, sesi 08:38 WIB
// 2026-11-15 — Amply Pool punya receive() external payable yang TIDAK ada
// di upstream Aave, sementara rescueTokens hanya menarik ERC20: ETH yang
// terkirim ke kontrak terkunci (kesalahan transfer user, bukan fund-loss
// attacker).
// Detektor level-FILE: cari receive()/fallback() payable di source tanpa
// komentar (extractFunctions TIDAK menangkap keduanya — tanpa kata kunci
// `function`); flag bila file TIDAK memuat satu pun idiom keluar-ETH.
// transfer() polos SENGAJA tidak dihitung — itu ERC20, persis jebakan
// AMP-05: rescueTokens mentransfer token tapi ETH tetap terkunci.
// Severity Info — mengikuti klasifikasi wasit jack atas AMP-05; naik ke
// Low bila ETH masuk lewat alur normal protokol (IWETH.withdraw atau
// refund ke address(this)) — kalibrasi review Kiro 15 Nov.
// KALIBRASI v3 (review silang Kiro Opus 5.5, 15 Nov 12:47 WIB, 26 kasus
// uji di Node: 14 FP + 7 FN sebelum kalibrasi):
//  - Idiom keluar-ETH diperlebar: {value:} umum (deposit{value:},
//    new B{value:}, entryPoint.depositTo{value:}), cast payable
//    bersarang (payable(owner())), address payable immutable/constant
//    + array (rs[i]), SafeTransferLib/TransferHelper safeTransferETH,
//    functionCallWithValue, .value( legacy (<=0.6), msg.sender/tx.origin
//    transfer/send, assembly call(gas(),...).
//  - sendValue/withdrawTo/withdrawStake dihitung sebagai PEMANGGILAN
//    saja — deklarasi `function withdrawTo(...)` (mis. gaya ERC20Wrapper)
//    tidak lagi menekan.
//  - Regex receive/fallback: modifier dalam urutan apa pun (payable
//    external, virtual external payable, onlyX external payable),
//    fallback lama `function() external payable`, dan HANYA bila ada
//    badan `{` — deklarasi abstract/interface `... payable virtual;`
//    tidak lagi ter-flag.
//  - Proxy: file yang memuat delegatecall(/_delegate(/_fallback( tidak
//    di-flag — logika keluar-ETH ada di implementasi (file lain).
//  - Path test/mock (mocks/, test/, *.t.sol, Mock*/Harness*) dilewati.
// Batas diketahui (dicatat, belum dikerjakan — butuh cakupan per-kontrak):
// file-scoped — jalur rescue di kontrak/proxy lain tidak terlihat;
// outflow di kontrak LAIN dalam file yang sama ikut menekan (butuh
// pemecahan per-contract + rantai `is`); receive() yang langsung
// revert() masih ter-flag; call{value: 0} / passthrough msg.value
// masih menekan; create/create2 assembly belum ditangani.
// ---------------------------------------------------------------------------
function detectEthLockedReceive(source, fileName, idStart) {
  // Lewati file test/mock — komentar "test-only" tidak andal karena
  // stripComments membuangnya; filter path lebih andal (review Kiro).
  if (/(^|\/)(mocks?|test|tests?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/i.test(fileName)) return [];
  const clean = stripComments(source);
  // Proxy: receive/fallback hanya meneruskan ke implementasi — logika
  // keluar-ETH ada di file lain, jadi flag di sini hampir pasti FP.
  if (/\bdelegatecall\s*\(/.test(clean)
    || /\b_delegate\s*\(/.test(clean)
    || /\b_fallback\s*\(/.test(clean)) return [];
  // Variabel yang dideklarasi `address payable` (state var, parameter,
  // lokal) — `.transfer`/`.send` atasnya adalah keluar-ETH, bukan ERC20.
  // v3: modifier immutable/constant/override ikut diizinkan + array
  // `address payable[]` (declRe lama menangkap `immutable` sebagai nama).
  const payableVars = new Set();
  const declRe = /\baddress\s+payable(?:\s*\[[^\]]*\])*\s+(?:(?:public|private|internal|immutable|constant|override)\s+)*([A-Za-z_][A-Za-z0-9_]*)/g;
  let dm;
  while ((dm = declRe.exec(clean)) !== null) payableVars.add(dm[1]);
  let varOutflow = false;
  for (const v of payableVars) {
    if (new RegExp("\\b" + v + "(?:\\s*\\[[^\\]]*\\])*\\s*\\.\\s*(?:transfer|send)\\s*\\(").test(clean)) {
      varOutflow = true;
      break;
    }
  }
  // Pola pemanggilan (bukan deklarasi): `function withdrawTo(...)`
  // tidak boleh menekan — lookbehind mengecualikan awalan `function `.
  const callOnly = (name) =>
    new RegExp("(?<!function\\s)(?:\\." + name + "|" + name + ")\\s*\\(").test(clean);
  const hasEthOutflow =
    // Opsi {value:} umum: call{value:}, deposit{value:},
    // entryPoint.depositTo{value:}, new B{salt:.., value:..}.
    /\b[A-Za-z_]\w*\s*\{\s*(?:\w+\s*:\s*[^,{}]+,\s*)*value\s*:/.test(clean)
    // Cast payable bersarang: payable(owner()).transfer / .send.
    || /\bpayable\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:transfer|send)\s*\(/.test(clean)
    || /\bselfdestruct\s*\(/.test(clean)
    // Helper transfer ETH: Solady/Solmate/Uniswap safeTransferETH dkk.
    || /\b\w*(?:[Tt]ransfer|[Ss]end)(?:ETH|Eth|Native)\w*\s*\(/.test(clean)
    || /\bfunctionCallWithValue\s*\(/.test(clean)
    // Sintaks lama (<=0.6): to.call.value(x)("").
    || /\.value\s*\(/.test(clean)
    // msg.sender/tx.origin transfer/send (aman: di 0.8 tidak compile
    // untuk ERC20 — review Kiro).
    || /\b(?:msg\.sender|tx\.origin)\s*\.\s*(?:transfer|send)\s*\(/.test(clean)
    // Assembly: call(gas(), to, value, ...) — keluar-ETH mentah.
    || /\bcall\s*\(\s*gas\s*\(\)/.test(clean)
    // Idiom keluar-ETH tak langsung (kalibrasi hunting Hyperbridge
    // 15 Nov 2026): OZ Address.sendValue / helper internal _sendValue
    // (call{value:} di dalamnya) dan EntryPoint.withdrawTo/withdrawStake
    // (paymaster: ETH keluar ke treasury lewat EntryPoint).
    || callOnly("sendValue")
    || callOnly("withdrawTo")
    || callOnly("withdrawStake")
    || varOutflow;
  if (hasEthOutflow) return [];
  // Naik ke Low bila ETH masuk lewat alur normal protokol, bukan
  // kesalahan pengguna: file memanggil IWETH/WETH.withdraw, atau kontrak
  // menjadi refundAddress/refundTo = address(this) (bridge/messaging).
  // v3.1: `.withdraw(` polos TIDAK cukup — HostManager Hyperbridge
  // punya IHostManager(...).withdraw() (tarik revenue bridge, bukan
  // WETH) dan sempat ter-elevasi palsu ke Low; wajib ada WETH di
  // receiver (IWETH(...) cast atau variabel bernama *weth*).
  const elevateToLow =
    /\b(?:IWETH\s*\([^)]*\)|\w*[Ww][Ee][Tt][Hh]\w*)\s*\.\s*withdraw\s*\(/.test(clean)
    || /\brefund(?:Address|To)?\s*=\s*address\s*\(\s*this\s*\)/.test(clean);
  const severity = elevateToLow ? "Low" : "Info";
  const hits = [];
  // v3: modifier dalam urutan apa pun + wajib ada badan `{` (deklarasi
  // abstract/interface tanpa badan tidak ter-flag) + fallback lama
  // `function() external payable` (<=0.5). Grup 2 = deret modifier;
  // flag hanya bila grup 2 memuat kata `payable`.
  const re = /(?:\b(receive|fallback)\s*\([^)]*\)|\bfunction\s*\(\s*\))((?:\s+(?!returns\b)[A-Za-z_]\w*(?:\s*\([^)]*\))?)*)\s*(?:returns\s*\([^)]*\)\s*)?\{/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (!/\bpayable\b/.test(m[2])) continue;
    const line = clean.slice(0, m.index).split("\n").length;
    const kind = m[1] || "fallback";
    hits.push(normalizeCandidate({
      id: "FA-" + String(idStart + hits.length).padStart(3, "0"),
      detector: "eth-locked-receive",
      title: "payable receive()/fallback() without an ETH exit path",
      location: { file: fileName, function: kind },
      hypothesis: "This contract has " + kind + "() external payable "
        + "(line " + line + ") but there is NOT a single ETH-exit idiom "
        + "in this file (call{value:}, payable(...).transfer/send, "
        + "selfdestruct, safeTransferETH, {value:}) — ETH entering via "
        + kind + "() has no exit path in this file.",
      preconditions: "There is no ETH rescue path in another contract/proxy "
        + "(mis. gateway WETH / admin rescue terpisah).",
      impact: severity + " — ETH sent "
        + (severity === "Low"
          ? "(enters via the normal protocol flow: IWETH.withdraw / refund to address(this)) "
          : "(biasanya kesalahan transfer user) ")
        + "locked in the contract; not attacker fund-loss.",
      severityGuess: severity,
      evidence: kind + "() external payable at line " + line
        + " without an ETH-exit idiom in the file."
        + (severity === "Low" ? " Sinyal Low: IWETH.withdraw / refund=address(this)." : ""),
      toVerify: ["Check whether there is an ETH exit path in another contract/proxy",
        "check rescueTokens/rescue: is it only ERC20",
        "compare with upstream: is this receive() a fork addition",
        "Fork PoC: send ETH, then try to withdraw it"],
      source: "pattern-scan",
    }));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Klasifikasi upstream-diff (detektor ke-11, sesi 12:38 WIB 2026-11-14)
// Pelajaran Amply: kode yang dikomentari belum tentu bug — cluster
// "fitur MVP dimatikan" (setDebtCeiling, setSiloedBorrowing, setUserEMode,
// resetIsolationModeTotalDebt, cek siloed di validateBorrow) semuanya
// IDENTIK dengan upstream Aave v1.19.4 yang masih hidup + berlabel TODO
// MVP — jadi by-design, bukan diam-diam. Lapisan ini TIDAK menambah
// kandidat; ia MENGANOTASI kandidat commented-out-check /
// commented-out-function yang sudah ada dengan konteks baseline:
//   live-identical — fungsi/cek yang sama HIDUP di upstream, isi sama
//     (cakupan token baseline ≥ 0.85) → kemungkinan dimatikan sengaja.
//   live-modified — hidup di upstream tapi isi berubah (0.5–0.85) →
//     periksa: modifikasi itu sengaja atau menyembunyikan sesuatu.
//   live-divergent — hidup di upstream tapi isi jauh berbeda (< 0.5).
//   absent — tidak ada di upstream (kode baru/fork yang dimatikan).
// Plus penanda niat (intentMarker): komentar sekitar mengandung
// TODO/MVP/disable/dll. → "dimatikan sengaja" makin kuat bila keduanya
// cocok; "live-identical TANPA penanda niat" tetap layak ditanya ke tim.
// Tanpa baseline (opts.baseline kosong) kandidat dibiarkan tanpa anotasi.
// ---------------------------------------------------------------------------
function normalizeCodeText(t) {
  return String(t).replace(/\s+/g, " ").trim();
}
function tokenSetOf(t) {
  return new Set(normalizeCodeText(t).match(/[A-Za-z0-9_$]+/g) || []);
}
// Cakupan token baseline oleh teks yang dikomentari: |B ∩ C| / |B|.
// Dipakai, bukan Jaccard, karena blok komentar wajar membawa pengiring
// (baris TODO + NatSpec) yang membengkakkan himpunan komentar — Jaccard
// menghukum pengiring itu (kasus nyata Amply: Jaccard 0.31–0.69 padahal
// isi fungsi upstream hadir utuh di blok komentar, cakupan 1.00).
function tokenCoverage(commentedTokens, baselineTokens) {
  if (!baselineTokens.size) return 0;
  let inter = 0;
  for (const t of baselineTokens) if (commentedTokens.has(t)) inter++;
  return inter / baselineTokens.size;
}

function classifyUpstreamDiff(source, fileName, candidates, opts) {
  const baseline = opts && opts.baseline;
  if (!baseline) return candidates;
  const getBase = typeof baseline.get === "function"
    ? (k) => baseline.get(k)
    : (k) => baseline[k];
  let baseName = fileName.split("/").pop();
  let baseSrc = getBase(baseName);
  const cleanSource = stripComments(source);
  const liveFns = extractFunctions(cleanSource);
  const fnByName = Object.create(null);
  for (const f of liveFns) fnByName[f.name] = f;
  const commentedFns = listCommentedOutFunctions(
    { commentBlocks: extractCommentBlocks(source) });
  const comments = extractComments(source);
  // Indeks baseline per nama kontrak (dibangun malas, sekali per
  // panggilan): [{file, src, names}] — nama kontrak/library tiap file
  // baseline. Dipakai fallback rename BILA basename miss.
  let baselineIndex = null;
  function getBaselineIndex() {
    if (baselineIndex) return baselineIndex;
    const entries = typeof baseline.entries === "function"
      ? Array.from(baseline.entries())
      : Object.entries(baseline);
    baselineIndex = entries
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => ({
        file: k, src: v, names: listContractNames(stripComments(v)),
      }));
    return baselineIndex;
  }
  // Cari file baseline yang memuat kontrak bernama `name`:
  // skor 2 = nama persis, 1 = sama sesudah normalisasi sufiks versi
  // (VaultPriceFeedV2 vs VaultPriceFeed); seri → file pertama
  // (urutan iterasi peta baseline). Null bila tak ada yang cocok.
  // KALIBRASI multi-kontrak (residual #2 review Kiro detektor #17,
  // sesi 16 Nov 2026): dulu hanya kontrak PERTAMA tiap file yang
  // dibandingkan — file multi-kontrak bisa salah pasang atau gagal
  // total bila kontrak target bukan yang pertama. Kini SEMUA nama
  // kontrak di kedua sisi dibandingkan.
  function resolveBaselineByName(name) {
    if (!name) return null;
    const norm = normContractName(name);
    let best = null, bestScore = 0;
    for (const e of getBaselineIndex()) {
      let score = 0;
      for (const n of e.names) {
        if (n === name) { score = 2; break; }
        if (normContractName(n) === norm) score = Math.max(score, 1);
      }
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return bestScore > 0 ? best : null;
  }
  if (!baseSrc) {
    // Fallback nama kontrak (saran review Kiro detektor #17): file yang
    // di-rename (mis. Fulcrom VaultPriceFeedV2.sol vs upstream GMX
    // VaultPriceFeed.sol) dicari lewat nama kontrak di seluruh peta
    // baseline. Basename yang cocok tetap menang; fallback hanya bila
    // basename miss. Semua kontrak live dicoba (urutan kemunculan di
    // file); skor tertinggi menang — nama persis mengalahkan
    // normalisasi sufiks versi.
    let best = null, bestScore = 0;
    for (const n of listContractNames(cleanSource)) {
      const hit = resolveBaselineByName(n);
      if (!hit) continue;
      const score = hit.names.includes(n) ? 2 : 1;
      if (score > bestScore) { best = hit; bestScore = score; }
    }
    if (best) { baseSrc = best.src; baseName = best.file; }
  }
  if (!baseSrc) return candidates;
  // Konteks klasifikasi per file baseline — di-cache per nama file
  // supaya resolusi per-kandidat tidak mem-parse ulang baseline.
  const ctxCache = new Map();
  function makeCtx(bSrc, bName) {
    if (ctxCache.has(bName)) return ctxCache.get(bName);
    const bFns = extractFunctions(stripComments(bSrc));
    // Object.create(null): nama fungsi "constructor" akan menabrak
    // Object.prototype bila memakai {} biasa (bug probe 14 Nov 2026).
    const bByName = Object.create(null);
    for (const bf of bFns) {
      (bByName[bf.name] = bByName[bf.name] || []).push(bf);
    }
    const ctx = { baseSrc: bSrc, baseName: bName, baseFns: bFns, baseByName: bByName };
    ctxCache.set(bName, ctx);
    return ctx;
  }
  const fileCtx = makeCtx(baseSrc, baseName);
  // Kontrak pemilik kandidat — dipakai memilih baseline per-kandidat:
  // file multi-kontrak bisa punya baseline berbeda per kontrak, dan
  // baseline level-file (kontrak pertama yang cocok) bisa salah pasang
  // untuk kandidat dari kontrak lain di file yang sama.
  function ownerContractOf(c) {
    if (c.detector === "dead-config-storage") {
      const byDecl = ownerContractAtLine(cleanSource, c.declLine);
      if (byDecl) return byDecl;
    }
    const fnName = c.location && c.location.function;
    if (!fnName) return null;
    if (c.detector === "commented-out-function") {
      const item = commentedFns.find((it) => it.name === fnName);
      if (item) return ownerContractAtLine(cleanSource, item.startLine);
      return null;
    }
    const fn = fnByName[fnName];
    if (fn) return ownerContractAtLine(cleanSource, fn.startLine);
    // location.function bisa berupa nama kontrak (fallback detektor
    // dead-config bila tak ada writer fn) — pakai langsung bila memang
    // nama kontrak di file ini.
    if (listContractNames(cleanSource).includes(fnName)) return fnName;
    return null;
  }
  // Konteks klasifikasi untuk satu kandidat: baseline kontrak
  // pemiliknya bila ada dan berbeda dari baseline level-file; bila
  // pemilik tak teridentifikasi / tak ada baseline-nya, pakai
  // baseline level-file.
  function ctxFor(c) {
    const owner = ownerContractOf(c);
    if (!owner) return fileCtx;
    const hit = resolveBaselineByName(owner);
    if (!hit || hit.file === baseName) return fileCtx;
    return makeCtx(hit.src, hit.file);
  }

  function classifyFn(name, commentedText, ctx) {
    const intentMarker = INTENT_MARKER_RE.test(commentedText);
    const bases = ctx.baseByName[name];
    if (!bases || !bases.length) {
      // Fallback deklarasi: di file interface, fungsi hanya dideklarasi
      // (`function NAME(...) external;`) tanpa badan — extractFunctions
      // melewatkannya. Bandingkan deklarasi baseline dengan teks komentar.
      const declRe = new RegExp("\\bfunction\\s+" + name + "\\s*\\(");
      const m = declRe.exec(ctx.baseSrc);
      if (m) {
        const semi = ctx.baseSrc.indexOf(";", m.index);
        const brace = ctx.baseSrc.indexOf("{", m.index);
        if (semi !== -1 && (brace === -1 || semi < brace)) {
          const decl = ctx.baseSrc.slice(m.index, semi + 1);
          const cov = tokenCoverage(tokenSetOf(commentedText), tokenSetOf(decl));
          if (cov >= 0.85) {
            return {
              classification: "live-identical", intentMarker,
              similarity: Math.round(cov * 100) / 100,
            };
          }
          if (cov >= 0.5) {
            return {
              classification: "live-modified", intentMarker,
              similarity: Math.round(cov * 100) / 100,
            };
          }
        }
      }
      return { classification: "absent", intentMarker };
    }
    const cTokens = tokenSetOf(commentedText);
    let best = 0;
    for (const bf of bases) {
      best = Math.max(best,
        tokenCoverage(cTokens, tokenSetOf(bf.signature + " " + bf.body)));
    }
    const classification = best >= 0.85 ? "live-identical"
      : best >= 0.5 ? "live-modified" : "live-divergent";
    return {
      classification, intentMarker,
      similarity: Math.round(best * 100) / 100,
    };
  }

  for (const c of candidates) {
    // Baseline per-kandidat (fallback rename multi-kontrak): kandidat
    // dari kontrak kedua dst. di file yang sama bisa punya baseline
    // berbeda dari baseline level-file.
    const ctx = ctxFor(c);
    if (c.detector === "commented-out-function") {
      const item = commentedFns.find((it) => it.name === c.location.function);
      if (!item) continue;
      const r = classifyFn(c.location.function, item.text, ctx);
      c.upstream = { ...r, baselineFile: ctx.baseName };
      c.evidence += " [upstream-diff: " + r.classification
        + (r.similarity !== undefined
          ? " (cakupan token baseline " + r.similarity + ")" : "")
        + "; penanda niat: " + (r.intentMarker ? "ya" : "not")
        + "; baseline " + ctx.baseName + "]";
    } else if (c.detector === "commented-out-check") {
      const fn = fnByName[c.location.function];
      if (!fn) continue;
      const fnComments = comments.filter((cm) =>
        cm.line >= fn.startLine && cm.line <= fn.endLine);
      const checkLine = fnComments.find((cm) =>
        COMMENTED_CHECK_RE.test(cm.text.trim())
        && !cm.text.trim().startsWith("@"));
      const intentMarker = fnComments.some((cm) =>
        INTENT_MARKER_RE.test(cm.text));
      const bases = ctx.baseByName[c.location.function];
      let r;
      if (!bases || !bases.length) {
        r = { classification: "absent", intentMarker };
      } else {
        const checkNorm = normalizeCodeText(checkLine ? checkLine.text : "");
        let found = false, partial = false;
        for (const bf of bases) {
          const bodyNorm = normalizeCodeText(bf.body);
          if (checkNorm && bodyNorm.includes(checkNorm)) { found = true; break; }
          if (checkNorm && checkNorm.length >= 40
            && bodyNorm.includes(checkNorm.slice(0, 40))) partial = true;
        }
        r = {
          classification: found ? "live-identical"
            : partial ? "live-modified" : "live-divergent",
          intentMarker,
        };
      }
      c.upstream = { ...r, baselineFile: ctx.baseName };
      c.evidence += " [upstream-diff: " + r.classification
        + "; penanda niat: " + (r.intentMarker ? "ya" : "not")
        + "; baseline " + ctx.baseName + "]";
    } else if (c.detector === "oracle-passthrough-no-staleness") {
      // Aturan klasifikasi by-design-vs-kandidat BERBASIS BASELINE PER
      // FEED (backlog AMP-06): bandingkan fungsi yang sama di upstream —
      // apakah ia juga membaca harga tanpa cek staleness?
      const bases = ctx.baseByName[c.location.function];
      let r;
      if (!bases || !bases.length) {
        r = { classification: "absent", intentMarker: false };
      } else {
        const baseReads = bases.filter((bf) => PRICE_READ_RE.test(bf.body));
        if (!baseReads.length) {
          r = { classification: "live-modified", intentMarker: false };
        } else if (baseReads.some((bf) => !hasStalenessGuard(bf.body))) {
          r = { classification: "live-identical", intentMarker: false };
        } else {
          // Upstream membaca harga yang sama DENGAN cek staleness —
          // fork menghapus cek itu: kandidat serius.
          r = { classification: "live-divergent", intentMarker: false };
        }
      }
      c.upstream = { ...r, baselineFile: ctx.baseName };
      c.evidence += " [upstream-diff: " + r.classification
        + "; baseline " + ctx.baseName + "]";
    } else if (c.detector === "dead-config-storage") {
      // Aturan klasifikasi by-design-vs-kandidat BERBASIS BASELINE
      // (backlog R-02): bandingkan var yang sama di upstream — apakah
      // upstream MEMBACA var ini?
      //   live-divergent — upstream membaca var ini → fork MENGHAPUS
      //     wiring-nya: kandidat serius (kasus R-02 Fulcrom vs GMX v1).
      //   live-identical — upstream juga tidak membaca → by-design.
      //   absent — var tidak ada di upstream (config baru fork).
      const varName = c.varName;
      let r;
      if (!varName) {
        r = { classification: "absent", intentMarker: false };
      } else {
        const baseClean = stripComments(ctx.baseSrc);
        const baseDecl = scanStateVarDecls(baseClean)
          .find((d) => d.name === varName);
        if (!baseDecl) {
          r = { classification: "absent", intentMarker: false };
        } else {
          const baseFns = extractFunctions(baseClean);
          const a = analyzeStateVar(baseClean, baseDecl, baseFns);
          r = {
            classification: a.reads > 0 ? "live-divergent" : "live-identical",
            intentMarker: false,
          };
        }
      }
      c.upstream = { ...r, baselineFile: ctx.baseName };
      c.evidence += " [upstream-diff: " + r.classification
        + "; baseline " + ctx.baseName + "]";
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// buildBaselineMap — peta baseline untuk UI app (wiring baseline, sesi
// 00:38 WIB 2026-11-15). Input: daftar file {name, text} (name boleh
// berisi path — diambil basename-nya). Output: {map, collisions}.
// Semantik SAMA dengan runner hunting (run-amply-hunt.js): first-wins per
// basename; file kedua dst. dengan basename yang sama DITOLAK dan dicatat
// di collisions (dedup, urut kemunculan). Map memakai Object.create(null)
// supaya basename "constructor" tidak menabrak Object.prototype (bug yang
// sama pernah muncul di classifyUpstreamDiff, sesi 12:38 WIB 14 Nov).
// Fungsi murni — dipakai browser (upload file) maupun Node (test/runner).
// ---------------------------------------------------------------------------
function buildBaselineMap(files) {
  const map = Object.create(null);
  const collisions = [];
  const seenCollision = Object.create(null);
  for (const f of files || []) {
    if (!f || typeof f.text !== "string") continue;
    const base = String(f.name || "").split("/").pop().split("\\").pop();
    if (!base) continue;
    if (Object.prototype.hasOwnProperty.call(map, base)) {
      if (!seenCollision[base]) {
        seenCollision[base] = true;
        collisions.push(base);
      }
      continue;
    }
    map[base] = f.text;
  }
  return { map, collisions };
}

// ---------------------------------------------------------------------------
// Project-pass lintas-file (residual P1/P2 review Kiro detektor #17, sesi
// 04:38 WIB 2026-11-16): detektor dead-config-storage sejauh ini hanya
// melihat SATU file — var yang dibaca lewat getter publik oleh kontrak
// lain (`vault.feeBps()` di VaultUtils) atau oleh kontrak turunan di file
// lain (`is Vault` + baca `feeBps`) hanya turun ke Info lewat heuristik
// (P1 member-call, F14 override, F6 abstract-internal). Project-pass
// memindai SELURUH file proyek dan MENGHAPUS kandidat dead-config yang
// terbukti dibaca lintas-file, dengan bukti lokasi pembacanya. Kandidat
// yang DIPERTAHANKAN namun satu-satunya alasan Info-nya F6 dinaikkan
// kembali ke Low (hipotesis F6 sudah diuji di korpus ini — residual (3),
// sesi 16:38 WIB 2026-11-17); alasan Info lain tidak disentuh.
//   "getter" — file lain memanggil `.varName(` (atau membaca `.varName`)
//     pada identifier yang dideklarasi bertipe kontrak pemilik / interface
//     `I<kontrak>` (state var, parameter, atau lokal). File itu harus
//     menyebut nama kontrak/interface pemilik (atau mengimpor file
//     pemilik) — tanpa itu, nama var yang sama di kontrak lain tidak
//     boleh menghapus kandidat.
//   "inheritance" — kontrak di file lain yang `is <Pemilik>` membaca
//     varName langsung (termasuk via `super.varName`); bayangan
//     (shadowing) oleh deklarasi state var / parameter / lokal senama di
//     kontrak turunan itu diperhitungkan.
// Batas diketahui: pemanggilan lewat cast (`IVault(addr).varName()`),
// fungsi yang mengembalikan instance (`vault().varName()`), dan pembaca
// di file yang TIDAK masuk korpus proyek (mis. Timelock Fulcrom tidak
// ada di source explorer) tidak terlihat — kandidat seperti itu tetap
// Info/Low seperti sebelumnya, bukan dihapus.
// Hanya kandidat dead-config-storage yang disentuh; detektor lain tetap
// per-file.
// ---------------------------------------------------------------------------
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Indeks proyek: per file, kontrak + state var yang dideklarasikannya.
function buildProjectIndex(files) {
  const perFile = [];
  const contractsByName = Object.create(null);
  for (const f of files || []) {
    if (!f || typeof f.text !== "string") continue;
    const clean = stripComments(f.text);
    // P7-5: alias import dinormalisasi di klausa `is` — `contract Child
    // is V` (V alias Vault) berarti mewarisi Vault; prefix namespace
    // (`is NS.Vault`) dipangkas ke nama kontraknya. Alias hanya berlaku
    // bila nama parent tanpa titik (bentuk `NS.X` tidak dicari di peta).
    const aliasMap = new Map();
    const importNamedRe = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
    let im;
    while ((im = importNamedRe.exec(clean)) !== null) {
      for (const ent of im[1].split(",")) {
        const mm = ent.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (mm) aliasMap.set(mm[2], mm[1]);
      }
    }
    // Dipakai filter 9b di bawah + perFile (sekali saja per file).
    const fns = extractFunctions(clean);
    // R9.1 (F11): modifier ikut diindeks (param + lokal badannya).
    const mods = scanModifiers(clean);
    const contracts = contractSpans(clean).map((c) => {
      const vars = scanStateVarDecls(clean)
        .filter((d) => d.nameIndex >= c.start && d.nameIndex <= c.end)
        // Residual (9b): deklarasi lokal di dalam badan fungsi BUKAN
        // state var — tanpa filter ini `uint256 fee = 1;` di fungsi
        // Child tercatat sebagai var kontrak dan men-shadow seluruh
        // rantai inheritance di project-pass (baca warisan terlewat,
        // kandidat dead-config yang hidup ikut tertahan). Pola sama
        // dengan pengecualian badan fungsi di ownerTypedStateVars.
        // R9.1 (F12): bandingkan indeks CHAR, bukan baris — var yang
        // berbagi baris dengan sebuah fungsi sebelumnya ikut terbuang.
        .filter((d) => !fns.some((fn) => d.nameIndex >= fn.startIndex && d.nameIndex <= fn.endIndex))
        .map((d) => ({ name: d.name, isPublic: d.isPublic, override: d.override, line: d.line }));
      return {
        name: c.name, kind: c.kind,
        parents: (c.parents || []).map((p) => {
          if (p.includes(".")) return p.split(".").pop();
          return aliasMap.get(p) || p;
        }),
        start: c.start, end: c.end, file: f.name, vars,
      };
    });
    for (const c of contracts) {
      (contractsByName[c.name] = contractsByName[c.name] || []).push(c);
    }
    perFile.push({ name: f.name, text: f.text, clean, contracts, fns, mods, aliasMap });
  }
  return { perFile, contractsByName };
}

// Nama file test/mock — pola yang sama dipakai detektor untuk melewati
// file test (sesi 15 Nov). Dipakai project-pass P3: baca di file
// test/mock bukan bukti read lintas-file (file test tidak di-deploy).
function isTestOrMockFile(name) {
  return /(^|\/)(mocks?|test|tests?)\//i.test(name)
    || /\.t\.sol$/i.test(name)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/i.test(name);
}

// Rantai inheritance dari ct ke ancestor (TRANSITIF): [ct, ..., induk]
// tanpa ancestor itu sendiri; null bila ancestor tak terjangkau.
// Dipakai P8 (cucu/cicit ikut dihitung) + shadowing perantara (baca
// merujuk ke var perantara bila perantara mendeklarasi ulang nama yang
// sama). BFS atas contractsByName (name-keyed — tabrakan nama antar
// file adalah batas yang didokumentasikan, sama seperti gerbang
// relevansi di bawah).
function ancestorChain(index, ct, ancestorName) {
  const queue = [[ct]];
  const seen = new Set([ct.name + "@" + ct.file]);
  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];
    for (const p of cur.parents || []) {
      if (p === ancestorName) return path;
      for (const nx of index.contractsByName[p] || []) {
        const key = nx.name + "@" + nx.file;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([...path, nx]);
      }
    }
  }
  return null;
}

// Semua leluhur (transitif) sebuah kontrak, berdasarkan nama.
// Dipakai P9a (interface yang diimplementasi pemilik/turunannya).
function collectAncestorNames(index, ct) {
  const out = new Set();
  const queue = [ct];
  const seen = new Set([ct.name + "@" + ct.file]);
  while (queue.length) {
    const cur = queue.shift();
    for (const p of cur.parents || []) {
      if (out.has(p)) continue;
      out.add(p);
      for (const nx of index.contractsByName[p] || []) {
        const key = nx.name + "@" + nx.file;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(nx);
      }
    }
  }
  return out;
}

// Resolve import relatif terhadap file pembaca ("./", "../"); null
// bila tak bisa di-resolve (remapping "@/" atau ".." melewati root).
// Dipakai validasi alias P7-6: alias hanya sah bila path-nya menunjuk
// file pendefinisi tipe yang sebenarnya.
function resolveImportPath(fromFile, importPath) {
  if (importPath.startsWith("@")) return null;
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of importPath.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join("/");
}

// Closure import transitif per file (residual (6)).
// Solidity: import bersifat transitif — file yang mengimpor Mid.sol
// juga melihat simbol global yang Mid.sol impor (mis. Child dari
// Child.sol). Sebelum perbaikan ini, project-pass hanya mengakui
// import LANGSUNG untuk nama turunan/interface/alias (P9b-3/P7-6),
// sehingga baca `c.fee()` via tipe yang hanya terlihat transitif
// terlewat → dead-config false positive. Closure dihitung atas nama
// file korpus (BFS, aman terhadap siklus); path "@..." tak bisa
// di-resolve (null) → tidak masuk closure (konservatif, sama seperti
// validasi alias P7-6). Pemeriksaan basename langsung di
// findCrossFileReads tetap dipertahankan sebagai jaring pengaman
// untuk kasus remapping tersebut.
// Peta file korpus untuk resolusi import (R6 wasit).
// byName: nama file (apa adanya) → entry perFile (pertama menang).
// byBase: basename → DAFTAR nama file (dipakai fallback unik saja).
function buildFileMaps(index) {
  const byName = new Map();
  const byBase = new Map();
  for (const pf of index.perFile) {
    if (!byName.has(pf.name)) byName.set(pf.name, pf);
    const base = pf.name.split("/").pop().split("\\").pop();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(pf.name);
  }
  return { byName, byBase };
}

// Resolve satu import ke file korpus (R6 wasit — dipakai closure +
// validasi alias, menggantikan resolveImportPath mentah).
// - "@..." → null TANPA fallback basename (remap tak diketahui; W3a:
//   "@app/Child.sol" sempat lolos sebagai Child.sol korpus → false drop).
// - Path non-relatif ("src/Child.sol") dicoba dulu sebagai path dari
//   root korpus (semantik base path solc / gaya Foundry — W2b/11c),
//   baru fallback basename.
// - Import relatif ("./", "../") TIDAK dapat fallback basename:
//   path hasil resolve adalah lokasi eksplisit penulis (P7-6).
// - Fallback basename hanya bila basename UNIK di korpus (W2b: dua
//   Child.sol → ambigu = null, konservatif; dulu pemenang tergantung
//   urutan file).
function resolveImportTarget(fromName, importPath, byName, byBase) {
  if (importPath.startsWith("@")) return null;
  const rel = resolveImportPath(fromName, importPath);
  if (rel !== null && byName.has(rel)) return rel;
  // P7-6: import RELATIF ("./", "../") menunjuk lokasi eksplisit —
  // bila path hasil resolve tak ada di korpus, file itu memang tak ada
  // di korpus; fallback basename DILARANG (dulu "../legacy/Vault.sol"
  // lolos sebagai Vault.sol pemilik → false drop alias).
  if (importPath.startsWith("./") || importPath.startsWith("../")) return null;
  // Path non-relatif ("src/Child.sol"): coba dulu sebagai path dari
  // root korpus (semantik base path solc / gaya Foundry — W2b/11c),
  // baru fallback basename.
  if (byName.has(importPath)) return importPath;
  const base = importPath.split("/").pop().split("\\").pop();
  const cands = byBase.get(base);
  if (cands && cands.length === 1) return cands[0];
  return null;
}

// Pindai pernyataan import pada source TANPA memperhitungkan kata
// `import` di dalam string literal (R6 wasit W11d: string berisi teks
// import bukan import nyata — TAPI path import itu sendiri ADALAH
// string, jadi mem-mask semua string justru membunuh import asli).
// Kembalikan daftar {path, names} — names = entri dalam kurung
// kurawal (kosong untuk import polos / namespace). Bekerja atas
// clean (komentar sudah di-strip); scanner melacak keadaan string
// (kutip ganda/tunggal + escape) dan hanya mengenali `import` di
// luar string.
function scanImports(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const isId = (c) => /[A-Za-z0-9_$]/.test(c || "");
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) i += 2;
        else i++;
      }
      if (i < n) i++;
      continue;
    }
    if (src.startsWith("import", i) && (i === 0 || !isId(src[i - 1])) && !isId(src[i + 6])) {
      const m = /^import\b[^;]*?["']([^"']+)["']/.exec(src.slice(i));
      if (m) {
        const brace = /\{([^}]*)\}/.exec(m[0]);
        const names = brace ? brace[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
        // R10.1 wasit (x3): bedakan jenis import — hanya impor GLOBAL
        // (`import "./X.sol";`) yang mengekspor ulang simbol target;
        // namespace (`import * as NS`) dan default tidak.
        const kind = /\*\s*as\s/.test(m[0]) ? "namespace"
          : /\{/.test(m[0]) ? "named"
          : /^\s*import\s*["']/.test(m[0]) ? "global" : "other";
        out.push({ path: m[1], names, kind, index: i });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

function buildImportClosure(index) {
  const { byName, byBase } = buildFileMaps(index);
  const direct = new Map();
  for (const pf of index.perFile) {
    const s = new Set();
    for (const im of scanImports(pf.clean)) {
      const target = resolveImportTarget(pf.name, im.path, byName, byBase);
      if (target && target !== pf.name) s.add(target);
    }
    direct.set(pf.name, s);
  }
  const closure = new Map();
  for (const pf of index.perFile) {
    const out = new Set();
    const queue = [...(direct.get(pf.name) || [])];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === pf.name || out.has(cur)) continue;
      out.add(cur);
      for (const dep of direct.get(cur) || []) {
        if (!out.has(dep)) queue.push(dep);
      }
    }
    closure.set(pf.name, out);
  }
  return closure;
}

// Peta nama yang diekspor tiap file → nama tipe KANONIK (residual (10)).
// - Kontrak/interface/library yang didefinisikan di file itu → dirinya sendiri.
// - Import bernama `{Orig as Alias}` / `{Orig}` dari target T → kanonik
//   dari Orig DI T (rekursif: Orig bisa jadi alias yang diekspor T —
//   `Mid` mengekspor `K` = Vault, jadi Reader yang mengimpor `{K as C}`
//   dari Mid mendapat C = Vault; rantai N hop ikut terurai).
// - Entri yang kanoniknya bukan tipe yang dikenal di korpus dibuang.
// - Definisi lokal menang atas import senama (shadowing); siklus import
//   diputus konservatif (memo + set visiting → null).
// Dipakai validasi alias berantai di findCrossFileReads. Dihitung sekali
// per pemanggilan; biaya O(file × import).
function buildExportedTypeMap(index) {
  const { byName, byBase } = buildFileMaps(index);
  const defined = new Map();
  for (const pf of index.perFile) {
    defined.set(pf.name, new Set(pf.contracts.map((c) => c.name)));
  }
  const memo = new Map();
  const visiting = new Set();
  const resolveIn = (fileName, name) => {
    if (defined.get(fileName)?.has(name)) return name;
    let m = memo.get(fileName);
    if (m && m.has(name)) return m.get(name);
    const key = fileName + "::" + name;
    if (visiting.has(key)) return null;
    visiting.add(key);
    let result = null;
    const pf = byName.get(fileName);
    if (pf) {
      for (const im of scanImports(pf.clean)) {
        const target = resolveImportTarget(pf.name, im.path, byName, byBase);
        if (!target) continue;
        for (const ent of im.names) {
          const mm = ent.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (!mm) continue;
          const local = mm[2] || mm[1];
          if (local !== name) continue;
          result = resolveIn(target, mm[1]);
          break;
        }
        if (result) break;
      }
      // R10.1 wasit (x3): impor GLOBAL (`import "./X.sol";`, tanpa
      // nama) mengekspor ulang SEMUA simbol file target ke file ini —
      // rantai alias boleh lewat sana. Impor namespace (`import * as NS`)
      // TIDAK dihitung (nama hanya tersedia sebagai NS.<nama>).
      if (!result) {
        for (const im of scanImports(pf.clean)) {
          if (im.kind !== "global") continue;
          const target = resolveImportTarget(pf.name, im.path, byName, byBase);
          if (!target) continue;
          result = resolveIn(target, name);
          if (result) break;
        }
      }
    }
    visiting.delete(key);
    if (!memo.has(fileName)) memo.set(fileName, new Map());
    memo.get(fileName).set(name, result);
    return result;
  };
  const out = new Map();
  for (const pf of index.perFile) {
    const m = new Map();
    for (const n of defined.get(pf.name) || []) m.set(n, n);
    for (const im of scanImports(pf.clean)) {
      const target = resolveImportTarget(pf.name, im.path, byName, byBase);
      if (!target) continue;
      for (const ent of im.names) {
        const mm = ent.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!mm) continue;
        const local = mm[2] || mm[1];
        if (m.has(local)) continue;
        const canon = resolveIn(target, mm[1]);
        if (canon) m.set(local, canon);
      }
    }
    out.set(pf.name, m);
  }
  return out;
}

// Rentang deklarasi non-ekspresi di dalam span kontrak: event/error
// + signature modifier — nama var di sana bukan baca (P4-10/P4-13).
// R5: blok struct DIMASUKKAN — sejak scanStateVarDecls sadar-struct,
// field struct tidak lagi men-shadow rantai (alasan lama gugur), jadi
// deklarasi field (`uint256 fee;`) harus dilewati di sini, kalau tidak
// classifyVarOccurrence mengembalikannya sebagai "read" dan kandidat
// dead-config ter-drop palsu.
function nonExpressionSpans(span) {
  const spans = [];
  const pushRe = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(span)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
    }
  };
  pushRe(/\b(?:event|error)\s+[A-Za-z_$][\w$]*\s*\([^;{]*\)\s*;/g);
  pushRe(/\bmodifier\s+[A-Za-z_$][\w$]*\s*\([^;{]*\)/g);
  for (const sp of findBlockSpans(span, "struct")) {
    spans.push([sp.start, sp.end + 1]);
  }
  return spans;
}

// Tipe kembalian pertama sebuah fungsi (dari signature yang sudah
// dinormalisasi spasi), dengan alias import file pendefinisi
// di-resolve + prefix namespace dipangkas; null bila tak ada returns.
// Dipakai residual (8): wrapper transitif.
function wrapperReturnType(signature, aliasMap) {
  const m = /\breturns\s*\(([^)]*)\)/.exec(signature || "");
  if (!m) return null;
  const first = m[1].split(",")[0].trim()
    .replace(/\b(memory|storage|calldata)\b/g, "").trim();
  const tok = first.split(/\s+/)[0] || "";
  if (!tok) return null;
  const base = tok.includes(".") ? tok.split(".").pop() : tok;
  return (aliasMap && aliasMap.get(base)) || base;
}

// Nama-nama identifier yang dideklarasi dengan tipe pemilik di sebuah
// fragmen teks (state var / parameter / lokal): `Vault v`, `Vault
// private vault;`, `returns (Vault vault)`. Dipakai bukti badan wrapper.
function typedNamesOfType(text, baseTypeAlt) {
  const out = new Set();
  const re = new RegExp("\\b" + baseTypeAlt
    + "\\s+(?:(?:public|private|internal|immutable|constant|override|memory|storage|calldata)\\s+)*"
    + "([A-Za-z_$][\\w$]*)", "g");
  let m;
  while ((m = re.exec(text || "")) !== null) out.add(m[1]);
  return out;
}

// State var bertipe pemilik di kontrak pendefinisi + leluhurnya
// (transitif). Hanya deklarasi level-kontrak: badan fungsi
// dikeluarkan (lokal fungsi lain bukan state var — W-J) dan blok struct
// dikeluarkan; tipe di-resolve lewat alias file pendefinisi (W-H).
// Dipakai bukti badan wrapper: state var WARISAN ikut dihitung (W-N).
function ownerTypedStateVars(index, ct, baseTypeNames) {
  const out = new Set();
  if (!ct) return out;
  const lineage = [ct];
  const seen = new Set([ct.name + "@" + ct.file]);
  const queue = [ct];
  while (queue.length) {
    const cur = queue.shift();
    for (const p of cur.parents || []) {
      for (const nx of index.contractsByName[p] || []) {
        const key = nx.name + "@" + nx.file;
        if (seen.has(key)) continue;
        seen.add(key);
        lineage.push(nx);
        queue.push(nx);
      }
    }
  }
  for (const lc of lineage) {
    const pf = index.perFile.find((x) => x.name === lc.file);
    if (!pf) continue;
    const span = pf.clean.slice(lc.start, lc.end);
    const lcStartLine = lineOfSrc(pf.clean, lc.start);
    const excluded = pf.fns
      .filter((fn) => fn.startLine >= lcStartLine
        && fn.startLine <= lineOfSrc(pf.clean, lc.end))
      .map((fn) => ({ startLine: fn.startLine - lcStartLine, endLine: fn.endLine - lcStartLine }));
    for (const sp of findBlockSpans(span, "struct")) {
      excluded.push({ startLine: lineOfSrc(span, sp.start), endLine: lineOfSrc(span, sp.end) });
    }
    const inExcluded = (line) => excluded.some((s) => line >= s.startLine && line <= s.endLine);
    const aliasMap = pf.aliasMap || new Map();
    for (const d of scanStateVarDecls(span)) {
      if (inExcluded(d.line)) continue;
      // Tipe = token terakhir sebelum nama pada (maks.) 2 baris deklarasi.
      const before = span.slice(0, d.nameIndex);
      const lineStart = before.lastIndexOf("\n") + 1;
      const prevStart = before.lastIndexOf("\n", lineStart - 2) + 1;
      const tm = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:\[[^\]]*\])*\s*(?:(?:public|private|internal|immutable|constant|override|transient|payable)\s+)*$/.exec(before.slice(prevStart));
      if (!tm) continue;
      const raw = tm[1].includes(".") ? tm[1].split(".").pop() : tm[1];
      const t = aliasMap.get(raw) || raw;
      if (baseTypeNames.includes(t)) out.add(d.name);
    }
  }
  return out;
}

// Apakah sebuah fungsi kandidat wrapper BENAR mengembalikan instance
// tipe pemilik? Bukti dari badan: `return this;` (kontrak pendefinisi
// bertipe pemilik), cast tipe pemilik (`Vault(...)` / `IVault(...)`),
// identifier bertipe pemilik (`return vault;`, `return this.vault;`),
// atau pemanggilan wrapper lain yang sudah terkonfirmasi (rantai).
// Tuple: elemen pertama dipakai (sesuai tipe pertama returns).
// Assembly `return(...)`: jalur keluar lewat assembly pada fungsi yang
// mendeklarasi returns tipe pemilik ikut dihitung (W-A).
// Bentuk lain (ternary, `return helper.vault;`) TIDAK dihitung —
// batas yang didokumentasikan.
function wrapperReturnsOwnerInstance(c, baseTypeNames, confirmed) {
  const { fn, ct, pf } = c;
  const aliasMap = pf.aliasMap || new Map();
  // Alias yang mengarah ke tipe pemilik ikut dihitung sebagai tipe
  // pemilik saat mencocokkan deklarasi (W-H: `V private vault;`).
  const aliasTypes = [...aliasMap.entries()]
    .filter(([, v]) => baseTypeNames.includes(v)).map(([k]) => k);
  const typeAlt = "(?:" + [...baseTypeNames, ...aliasTypes].map(escapeRegExp).join("|") + ")";
  // typed: state var kontrak pendefinisi + leluhurnya (W-N; dihitung
  // sekali per kandidat di collectWrappers) + param / named-return /
  // lokal di badan wrapper itu sendiri (bukan lokal fungsi lain — W-J).
  const typed = new Set(c.typedState || []);
  for (const n of typedNamesOfType(fn.body, typeAlt)) typed.add(n);
  const retRe = /\breturn\b\s*([^;]*);/g;
  let rm;
  while ((rm = retRe.exec(fn.body)) !== null) {
    let expr = rm[1].trim();
    if (!expr) continue;
    // Tuple/kurung: ambil elemen pertama (sesuai tipe pertama returns);
    // `(vault)` and `(vault, 1)` sama-sama terurai; rantai bersarang
    // diurai bertahap (maks. 3 lapis). W-L.
    let guard = 0;
    while (expr.startsWith("(") && guard++ < 3) {
      let depth = 0, comma = -1, end = -1;
      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) { end = i; break; } }
        else if (ch === "," && depth === 1 && comma === -1) comma = i;
      }
      if (end === -1) break;
      expr = (comma !== -1 ? expr.slice(1, comma) : expr.slice(1, end)).trim();
    }
    if (expr === "this") {
      if (ct && baseTypeNames.includes(ct.name)) return true;
      continue;
    }
    // Cast tipe pemilik ATAU pemanggilan (fungsi / member) — token
    // pertama sesudah prefix opsional adalah nama tipe / callee.
    const call = /^(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (call) {
      const t = aliasMap.get(call[1]) || call[1];
      if (baseTypeNames.includes(t)) return true;
      if (confirmed.has(call[1])) return true;
      continue;
    }
    // Identifier telanjang / this.<id> bertipe pemilik.
    const id = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(expr);
    if (id && typed.has(id[1])) return true;
  }
  // Assembly `return(...)`: satu-satunya jalur keluar lewat assembly.
  if (/\breturn\s*\(/.test(maskStringLiterals(fn.body))) return true;
  return false;
}

// Indeks wrapper transitif (residual (8)) atas seluruh korpus.
// confirmed: nama fungsi -> file-file tempat definisinya terkonfirmasi
// mengembalikan instance tipe pemilik (fixpoint atas rantai wrapper).
// defined: nama fungsi -> file-file tempat NAMA itu didefinisikan
// (apa pun tipe kembaliannya — dipakai uji ambiguitas per file pembaca).
function collectWrappers(index, baseTypeNames) {
  const confirmed = new Map();
  const defined = new Map();
  const cands = [];
  for (const pf of index.perFile) {
    const aliasMap = pf.aliasMap || new Map();
    for (const fn of pf.fns) {
      if (!fn.name || fn.name === "constructor") continue;
      if (!defined.has(fn.name)) defined.set(fn.name, new Set());
      defined.get(fn.name).add(pf.name);
      const rt = wrapperReturnType(fn.signature, aliasMap);
      if (!rt || !baseTypeNames.includes(rt)) continue;
      let ct = null;
      for (const c of pf.contracts) {
        const sLine = lineOfSrc(pf.clean, c.start);
        const eLine = lineOfSrc(pf.clean, c.end);
        if (fn.startLine >= sLine && fn.startLine <= eLine) { ct = c; break; }
      }
      cands.push({ name: fn.name, file: pf.name, fn, ct, pf,
        typedState: ownerTypedStateVars(index, ct, baseTypeNames) });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cands) {
      const set = confirmed.get(c.name);
      if (set && set.has(c.file)) continue;
      if (!wrapperReturnsOwnerInstance(c, baseTypeNames, confirmed)) continue;
      if (!confirmed.has(c.name)) confirmed.set(c.name, new Set());
      confirmed.get(c.name).add(c.file);
      changed = true;
    }
  }
  return { confirmed, defined };
}

// Cari pembaca lintas-file untuk satu state var.
// owner: {name (kontrak), file, varName}. Kembalikan daftar
// {file, line, kind} ("getter" | "inheritance" | "wrapper").
function findCrossFileReads(index, owner) {
  const reads = [];
  const varName = owner.varName;
  const ownerBase = owner.file.split("/").pop().split("\\").pop();
  // R6: closure import transitif — dipakai gerbang cakupan (P9b-3)
  // + validasi alias (P7-6) di bawah.
  const importClosure = buildImportClosure(index);
  // Residual (10): peta ekspor per file — dipakai validasi alias berantai.
  const exportedMap = buildExportedTypeMap(index);
  const { byName, byBase } = buildFileMaps(index);
  const getterDeclRe = new RegExp("\\bfunction\\s+" + escapeRegExp(varName) + "\\s*\\(");
  // Peta nama tipe → file-file pendefinisi YANG MEMENUHI SYARAT
  // (validasi alias P7-6 + cakupan file turunan/interface P9b-3).
  // Per-entri, bukan per-nama: dua kontrak senama di file berbeda
  // dibedakan lewat file pendefinisinya. Nama pemilik dipin ke
  // owner.file saja (kandidat dipin via declLine di applyProjectPass);
  // "I"+nama dilonggarkan ke semua file pendefinisi (aturan lama).
  const typeFiles = new Map();
  const addTypeFile = (n, f) => {
    if (!typeFiles.has(n)) typeFiles.set(n, new Set());
    typeFiles.get(n).add(f);
  };
  // R6 wasit (W5b): kunci "file::nama" untuk definisi tipe yang
  // TERVERIFIKASI sebagai anggota lineage pemilik (pemilik, turunan,
  // interface getter, leluhur getter). Definisi lokal senama yang
  // bukan anggota men-shadow nama impor di file itu.
  const legitKeys = new Set([owner.file + "::" + owner.name]);
  for (const pf of index.perFile) {
    for (const ct of pf.contracts) {
      if (ct.name === owner.name) {
        if (pf.name === owner.file) addTypeFile(ct.name, pf.name);
      } else if (ct.name === "I" + owner.name) {
        addTypeFile(ct.name, pf.name);
      }
    }
  }
  // P9b: nama kontrak turunan pemilik (transitif) — receiver bertipe
  // turunan membaca var warisan (`Vault public v; v.fee()`).
  const descendantNames = new Set();
  for (const pf of index.perFile) {
    for (const ct of pf.contracts) {
      if (ct.kind === "contract" && ancestorChain(index, ct, owner.name)) {
        descendantNames.add(ct.name);
        addTypeFile(ct.name, pf.name);
        legitKeys.add(pf.name + "::" + ct.name);
      }
    }
  }
  // P9a: interface yang mendeklarasi getter varName DAN diimplementasi
  // oleh pemilik (atau turunannya) — receiver bertipe interface itu
  // (`IFee public f; f.fee()`) membaca var pemilik. Syarat implementasi
  // mencegah false read dari interface tak terkait yang kebetulan
  // mendeklarasi fungsi senama.
  const ownerCt = index.perFile
    .find((pf) => pf.name === owner.file)?.contracts
    ?.find((ct) => ct.name === owner.name);
  const lineageNames = new Set([owner.name]);
  if (ownerCt) for (const a of collectAncestorNames(index, ownerCt)) lineageNames.add(a);
  const implemented = new Set();
  for (const pf of index.perFile) {
    for (const ct of pf.contracts) {
      if (lineageNames.has(ct.name) || descendantNames.has(ct.name)) {
        for (const p of ct.parents || []) implemented.add(p);
      }
    }
  }
  // P9a-4: getter dihitung bila dideklarasi interface itu ATAU interface
  // leluhurnya — `interface IFeed is IPrice` mewarisi deklarasi `fee()`
  // dari IPrice. Dicek per-entri (bukan per-nama) supaya interface
  // senama di file lain yang tak mendeklarasi getter tidak ikut.
  const ifaceDeclaresGetter = (ct) => {
    const pf = index.perFile.find((x) => x.name === ct.file);
    if (pf && getterDeclRe.test(pf.clean.slice(ct.start, ct.end))) return true;
    for (const a of collectAncestorNames(index, ct)) {
      for (const anc of index.contractsByName[a] || []) {
        if (anc.kind !== "interface") continue;
        const apf = index.perFile.find((x) => x.name === anc.file);
        if (apf && getterDeclRe.test(apf.clean.slice(anc.start, anc.end))) return true;
      }
    }
    return false;
  };
  const ifaceNames = new Set();
  const ifaceFiles = new Set();
  for (const pf of index.perFile) {
    for (const ct of pf.contracts) {
      if (ct.kind !== "interface" || !implemented.has(ct.name)) continue;
      if (!ifaceDeclaresGetter(ct)) continue;
      ifaceNames.add(ct.name);
      ifaceFiles.add(pf.name);
      addTypeFile(ct.name, pf.name);
      legitKeys.add(pf.name + "::" + ct.name);
    }
  }
  // R10.1 wasit (x2-ivault): "I"+nama hanya sah dari file interface
  // yang diimplementasi pemilik DAN mendeklarasi getter — interface
  // senama yang tak diimplementasi (Fake IVault) bukan tipe pemilik.
  // Dulu semua file pendefinisi I+nama masuk typeFiles ("aturan lama"
  // yang dilonggarkan); kini dipangkas ke ifaceFiles.
  if (typeFiles.has("I" + owner.name)) {
    typeFiles.set("I" + owner.name,
      new Set([...typeFiles.get("I" + owner.name)].filter((f) => ifaceFiles.has(f))));
  }
  // P9a-6: kontrak leluhur pemilik yang mendeklarasi `function fee(`
  // (mis. abstract FeeBase) — receiver bertipe leluhur itu membaca var
  // pemilik yang meng-override fungsinya.
  const ancestorFnNames = new Set();
  for (const pf of index.perFile) {
    for (const ct of pf.contracts) {
      if (ct.kind !== "contract" || ct.name === owner.name) continue;
      if (!lineageNames.has(ct.name)) continue;
      if (!getterDeclRe.test(pf.clean.slice(ct.start, ct.end))) continue;
      ancestorFnNames.add(ct.name);
      addTypeFile(ct.name, pf.name);
      legitKeys.add(pf.name + "::" + ct.name);
    }
  }
  const baseTypeNames = [...new Set([
    owner.name, "I" + owner.name, ...descendantNames, ...ifaceNames, ...ancestorFnNames,
  ])];
  // Residual (8): indeks wrapper transitif — dihitung sekali per owner.
  const wrapperIndex = collectWrappers(index, baseTypeNames);
  const baseTypeAlt = "(?:" + baseTypeNames.map(escapeRegExp).join("|") + ")";
  const mentionsOwnerRe = new RegExp("\\b" + baseTypeAlt + "\\b");
  const importOwnerRe = new RegExp("\\bimport\\b[^;]*" + escapeRegExp(ownerBase));
  const bareRe = new RegExp("(?<![\\w$])" + escapeRegExp(varName) + "(?![\\w$])", "g");
  // R9.1: pola kepala dari LOCAL_DECL_HEAD_SRC (ukuran penuh, mapping,
  // lowercase+location) + batas `(?![\w$])` agar `fee$` tak cocok (F5).
  const localDeclRe = new RegExp(
    "(?<![\\w$])" + LOCAL_DECL_HEAD_SRC + escapeRegExp(varName) + "(?![\\w$])");

  for (const pf of index.perFile) {
    if (pf.name === owner.file) continue;
    // P3: file test/mock tidak di-deploy — baca di sana bukan bukti.
    if (isTestOrMockFile(pf.name)) continue;
    const clean = pf.clean;
    // Gerbang relevansi: file harus menyebut kontrak/interface pemilik
    // atau mengimpor file pemilik — kalau tidak, `.varName(` di sini
    // hampir pasti milik kontrak lain yang kebetulan senama.
    // Residual (8): file pemilik terlihat TRANSITIF lewat closure import
    // juga lolos — pembaca yang mewarisi base (yang mengimpor pemilik)
    // tak menyebut nama pemilik sama sekali, tapi wrapper-nya terlihat.
    if (!mentionsOwnerRe.test(clean) && !importOwnerRe.test(clean)
      && !importClosure.get(pf.name)?.has(owner.file)) continue;

    // P9b-3: nama turunan/interface/leluhur hanya berlaku bila file
    // pembaca mengimpor file pendefinisinya (atau mendefinisikannya
    // sendiri) — nama saja tak cukup. Pemilik + I+nama dikecualikan
    // (dipin via declLine; tabrakan basename tetap batas lama).
    // R6 wasit (W11d): scanImports mengabaikan `import` di dalam
    // string literal (bukan import nyata).
    const importedBasenames = new Set([pf.name.split("/").pop().split("\\").pop()]);
    for (const im of scanImports(clean)) {
      importedBasenames.add(im.path.split("/").pop().split("\\").pop());
    }
    let scopedTypeNames = baseTypeNames.filter((n) => {
      if (n === owner.name || n === "I" + owner.name) return true;
      const defs = typeFiles.get(n);
      if (!defs) return false;
      for (const f of defs) {
        if (f === pf.name) return true;
        if (importedBasenames.has(f.split("/").pop().split("\\").pop())) return true;
        // R6: file pendefinisi terlihat lewat rantai import transitif.
        if (importClosure.get(pf.name)?.has(f)) return true;
      }
      return false;
    });
    // R6 wasit (W5b): definisi lokal senama yang BUKAN anggota lineage
    // men-shadow nama impor — `Child` di file ini merujuk ke definisi
    // lokal, bukan turunan pemilik, jadi baca `c.fee()` bukan bukti.
    // (I+nama: legitimate bila mendeklarasi getter, ikut aturan lama.)
    for (const ct of pf.contracts) {
      if (!scopedTypeNames.includes(ct.name)) continue;
      if (legitKeys.has(pf.name + "::" + ct.name)) continue;
      if (ct.name === "I" + owner.name && ct.kind === "interface" && ifaceDeclaresGetter(ct)) continue;
      scopedTypeNames = scopedTypeNames.filter((n) => n !== ct.name);
    }
    // R10.1 wasit (x1b): nama pemilik yang di-REBIND file ini ke tipe
    // lain (`import {Other as Vault}` di file perantara, lalu `{Vault}`
    // dari sana) BUKAN merujuk ke pemilik — `Vault v; v.fee()` di file
    // ini membaca Other, bukan var pemilik. Keluarkan nama itu dari
    // scopedTypeNames bila peta ekspor file ini mengikatnya ke kanonik
    // yang berbeda. Nama yang tak diikat file ini (impor global /
    // transitif) tetap berlaku seperti sebelumnya.
    const ownExports = exportedMap.get(pf.name);
    if (ownExports) {
      scopedTypeNames = scopedTypeNames.filter((n) => {
        if (!ownExports.has(n)) return true;
        return ownExports.get(n) === n;
      });
    }
    // P7: alias import file ini — berlaku untuk SEMUA nama di
    // baseTypeNames (P7-3/P7-4) dan divalidasi dengan path import yang
    // di-resolve terhadap file pendefinisi tipe (P7-6). Path yang tak
    // bisa di-resolve (remapping "@/" dsb.) ditolak — konservatif.
    // Residual (10): nama yang diimpor boleh jadi ALIAS BERANTAI —
    // `import {K as C} from "./Mid.sol"` dengan Mid mengekspor K =
    // Vault (11a), atau `import {K}` lalu pakai K langsung (11b).
    // Nama kanonik di-resolve lewat peta ekspor file target; import
    // tanpa rename ikut dihitung (nama impornya sendiri adalah alias
    // yang berlaku di file ini).
    const aliases = new Set();
    for (const im of scanImports(clean)) {
      if (!im.names.length) continue;
      // R6 wasit (W11c/3b): resolve lewat resolveImportTarget agar
      // konsisten dengan closure (path non-relatif dari root korpus).
      const target = resolveImportTarget(pf.name, im.path, byName, byBase);
      if (target === null) continue;
      for (const ent of im.names) {
        const mm = ent.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!mm) continue;
        const local = mm[2] || mm[1];
        // R10.1 wasit (x1/x1b): cek peta ekspor target DULU — nama impor
        // bisa jadi alias lokal target untuk tipe lain (`{Other as
        // Vault}` di Mid); shortcut nama hanya bila target tak punya
        // entri untuk nama itu (nama tersedia lewat impor global — x4).
        const viaMap = exportedMap.get(target)?.get(mm[1]);
        const canon = viaMap !== undefined
          ? viaMap
          : (baseTypeNames.includes(mm[1]) ? mm[1] : null);
        if (!canon || !baseTypeNames.includes(canon)) continue;
        // W5b: definisi lokal senama yang bukan anggota lineage
        // men-shadow nama impor di file ini.
        if (pf.contracts.some((ct) => ct.name === local)
          && !legitKeys.has(pf.name + "::" + local)) continue;
        const defs = typeFiles.get(canon);
        // R6: alias sah bila path menunjuk file pendefinisi ATAU file
        // yang mengimpornya secara transitif (`import {Child as C}
        // from "./Mid.sol"` — Mid.sol mengimpor Child.sol).
        const aliasOk = defs && (defs.has(target)
          || [...defs].some((d) => importClosure.get(target)?.has(d)));
        if (!aliasOk) continue;
        aliases.add(local);
      }
    }
    const typeAlt = "(?:"
      + [...scopedTypeNames, ...aliases].map(escapeRegExp).join("|") + ")";
    // (a) Getter/member read via instance bertipe pemilik/interface.
    // Prefix namespace satu segmen (`NS.Base`) diizinkan — tabrakan
    // basename antar file tetap batas yang didokumentasikan (P2).
    const typedIdRe = new RegExp("(?:[A-Za-z_$][\\w$]*\\.)?\\b" + typeAlt
      + "\\s+(?:(?:public|private|internal|immutable|constant|override)\\s+)*"
      + "([A-Za-z_$][\\w$]*)", "g");
    const memberRe = (id) => new RegExp("\\b" + escapeRegExp(id) + "\\s*\\.\\s*" + escapeRegExp(varName) + "\\b", "g");
    const typedIds = new Set();
    let tm;
    while ((tm = typedIdRe.exec(clean)) !== null) typedIds.add(tm[1]);
    for (const id of typedIds) {
      const re = memberRe(id);
      let m;
      while ((m = re.exec(clean)) !== null) {
        reads.push({ file: pf.name, line: lineOfSrc(clean, m.index), kind: "getter" });
      }
    }
    // P9b-4: receiver berupa cast (`VaultV2(a).fee()`).
    const castRe = new RegExp("(?:[A-Za-z_$][\\w$]*\\.)?\\b" + typeAlt
      + "\\s*\\([^;{}]*?\\)\\s*\\.\\s*" + escapeRegExp(varName) + "\\b", "g");
    let cm;
    while ((cm = castRe.exec(clean)) !== null) {
      reads.push({ file: pf.name, line: lineOfSrc(clean, cm.index), kind: "getter" });
    }
    // (a2) Wrapper transitif (residual (8)): baca via hasil pemanggilan
    // fungsi yang mengembalikan instance tipe pemilik —
    // `getVault().fee()`, `helper.getVault().fee()`. Nama wrapper hanya
    // dipakai bila SEMUA definisinya dalam jangkauan file ini (file
    // sendiri / closure import) terkonfirmasi mengembalikan tipe
    // pemilik — definisi senama bertipe lain dalam jangkauan = ambigu,
    // nama ditolak (konservatif).
    const usableWrappers = [...wrapperIndex.confirmed.keys()].filter((w) => {
      const defFiles = [...(wrapperIndex.defined.get(w) || [])]
        .filter((f) => f === pf.name || importClosure.get(pf.name)?.has(f));
      if (!defFiles.length) return false;
      return defFiles.every((f) => wrapperIndex.confirmed.get(w)?.has(f));
    });
    if (usableWrappers.length) {
      const wAlt = "(?:" + usableWrappers.map(escapeRegExp).join("|") + ")";
      const wrapRe = new RegExp("(?:\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*)?\\b" + wAlt
        + "\\s*\\([^;{}]*?\\)\\s*\\.\\s*" + escapeRegExp(varName) + "\\b", "g");
      let wm;
      while ((wm = wrapRe.exec(clean)) !== null) {
        reads.push({ file: pf.name, line: lineOfSrc(clean, wm.index), kind: "wrapper" });
      }
    }
    if (reads.some((r) => r.file === pf.name)) continue;

    // (b) Inheritance read: kontrak turunan membaca var langsung.
    // Rantai TRANSITIF (P8): cucu/cicit yang mewarisi via perantara
    // ikut dihitung. Bila kontrak mana pun di rantai (termasuk ct
    // sendiri) mendeklarasi ulang var senama, baca di ct merujuk ke
    // var itu — bukan var pemilik — jadi bukan bukti (shadowing).
    for (const ct of pf.contracts) {
      if (ct.kind !== "contract") continue;
      const chain = ancestorChain(index, ct, owner.name);
      if (!chain) continue;
      if (chain.some((c) => c.vars.some((v) => v.name === varName))) continue; // shadowed
      // P4-11: string literal di-mask (panjang/offset dipertahankan) —
      // nama var di dalam string bukan baca.
      const mclean = maskStringLiterals(clean);
      const span = mclean.slice(ct.start, ct.end);
      const skipSpans = nonExpressionSpans(span);
      const inSkip = (idx) => skipSpans.some((s) => idx >= s[0] && idx < s[1]);
      // R9.1/F10: blok assembly — kemunculan telanjang = variabel Yul.
      const asmSpans = assemblySpans(mclean);
      const inAssembly = (idx) => asmSpans.some((s) => idx >= s.start && idx <= s.end);
      const lineOffs = lineStartOffsets(mclean);
      bareRe.lastIndex = 0;
      let bm;
      while ((bm = bareRe.exec(span)) !== null) {
        // P4-10/P4-13: param event/error + signature modifier.
        if (inSkip(bm.index)) continue;
        const absIdx = ct.start + bm.index;
        const line = lineOfSrc(mclean, absIdx);
        // R9.1: nama deklarasi lokal itu sendiri bukan baca
        // (`uint256 fee;`, named return, catch-param).
        if (isLocalDeclName(mclean, absIdx)) continue;
        // R9.1/F10: baca nyata di assembly hanya lewat `.slot`/`.offset`.
        if (inAssembly(absIdx)) {
          const after = mclean.slice(absIdx + varName.length, absIdx + varName.length + 12);
          if (!/^\s*\.\s*(?:slot|offset)\b/.test(after)) continue;
        }
        // Shadowing oleh parameter / lokal senama di fungsi pembungkus.
        // R9.1 (F9): pencarian berbasis indeks CHAR, bukan baris.
        const fn = enclosingFunctionAtIdx(pf.fns, absIdx);
        const mod = !fn ? enclosingModifierAtIdx(pf.mods, absIdx) : null;
        if (fn) {
          if (hasParamNamed(fn, varName)) continue;
          // Residual (9a): shadow lokal SADAR-BLOK — deklarasi lokal
          // hanya menutupi kemunculan di dalam bloknya (P4-14 tetap:
          // deklarasi setelah pemakaian tidak men-shadow; deklarasi di
          // blok bersarang yang sudah menutup tidak men-shadow).
          // R9.1 (F9): lantai = indeks char kata kunci `function`,
          // bukan awal baris — dua fungsi sebaris tak lagi saling
          // menutupi lewat signature.
          const fnStartIdx = typeof fn.startIndex === "number"
            ? fn.startIndex : lineOffs[fn.startLine];
          const fnEndIdx = typeof fn.endIndex === "number"
            ? fn.endIndex + 1
            : (lineOffs[fn.endLine + 1] !== undefined ? lineOffs[fn.endLine + 1] : mclean.length);
          if (typeof fnStartIdx === "number"
            && isShadowedByLocalDecl(mclean, fnStartIdx, fnEndIdx, absIdx, varName, localDeclRe)) continue;
        } else if (mod) {
          // R9.1 (F11): di dalam modifier, param + lokal badan modifier
          // menutupi seperti di fungsi.
          if (mod.paramNames.includes(varName)) continue;
          const modStartIdx = typeof mod.start === "number" ? mod.start : lineOffs[mod.startLine];
          const modEndIdx = typeof mod.end === "number" ? mod.end + 1
            : (lineOffs[mod.endLine + 1] !== undefined ? lineOffs[mod.endLine + 1] : mclean.length);
          if (typeof modStartIdx === "number"
            && isShadowedByLocalDecl(mclean, modStartIdx, modEndIdx, absIdx, varName, localDeclRe)) continue;
        }
        // P4-12: key named-arg (`{fee: 5}`) bukan baca.
        let p = bm.index - 1;
        while (p >= 0 && /\s/.test(span[p])) p--;
        let n = bm.index + varName.length;
        while (n < span.length && /\s/.test(span[n])) n++;
        if ((span[p] === "{" || span[p] === ",") && span[n] === ":") continue;
        // P4: hanya kemunculan yang DIKLASIFIKASI sebagai baca yang
        // dihitung — tulis-murni (`fee = f`), `delete fee`, dan akses
        // member objek lain (`o.fee()`) bukan bukti baca. `this.fee` /
        // `super.fee` tetap baca (ditangani classifyVarOccurrence,
        // semantik yang sama dengan detektor dead-config).
        if (classifyVarOccurrence(mclean, absIdx, varName) !== "read") continue;
        reads.push({ file: pf.name, line, kind: "inheritance" });
      }
    }
  }
  return reads;
}

// Terapkan project-pass pada daftar kandidat gabungan: hapus kandidat
// dead-config-storage yang terbukti dibaca lintas-file. Kembalikan
// {candidates, dropped} — dropped membawa bukti pembacanya.
function applyProjectPass(candidates, files) {
  const index = buildProjectIndex(files);
  const dropped = [];
  const kept = [];
  for (const c of candidates) {
    if (c.detector !== "dead-config-storage" || !c.varName) { kept.push(c); continue; }
    const ownerEntry = index.perFile.find((pf) => pf.name === c.location.file);
    // Pemilik dipin via declLine kandidat bila ada (kalibrasi P1-owner):
    // dua kontrak satu file bisa mendeklarasi var SENAMA — find
    // berdasarkan nama saja salah memilih kontrak pertama. Fallback
    // ke nama-saja hanya bila declLine tak cocok (kandidat dari luar
    // jalur detektor dead-config).
    const owner = ownerEntry
      ? ownerEntry.contracts.find((ct) => ct.vars.some((v) => v.name === c.varName
          && (typeof c.declLine !== "number" || v.line === c.declLine)))
        || ownerEntry.contracts.find((ct) => ct.vars.some((v) => v.name === c.varName))
      : null;
    if (!owner) { kept.push(c); continue; }
    const reads = findCrossFileReads(index, {
      name: owner.name, file: c.location.file, varName: c.varName,
    });
    if (!reads.length) {
      // Residual (3), sesi 16:38 WIB 2026-11-17 — heuristik F6
      // (abstract+internal → Info) HANYA menebak adanya pembaca di
      // kontrak turunan file lain; project-pass baru saja menguji
      // hipotesis itu di SELURUH korpus dan tidak menemukan pembaca.
      // Bila F6 satu-satunya alasan Info, cabut → kembali Low, dengan
      // bukti bahwa pemeriksaan dilakukan di korpus ini. Alasan lain
      // (member-call, override, raw-slot) TIDAK dicabut — project-pass
      // tidak menguji hipotesis itu. Batas: pembaca di file DI LUAR
      // korpus tetap tak terlihat (asumsi korpus = proyek, sama seperti
      // keputusan drop di atas); toVerify kandidat tetap mengingatkan.
      const reasons = Array.isArray(c.infoReasons) ? c.infoReasons : [];
      const f6 = reasons.filter((r) => r.indexOf("abstract-internal") === 0);
      if (f6.length > 0) {
        const rest = reasons.filter((r) => r.indexOf("abstract-internal") !== 0);
        const oldTag = " [Info: " + reasons.join("; ") + "]";
        c.infoReasons = rest;
        if (rest.length === 0) {
          c.severityGuess = "Low";
          const note = " [project-pass: abstract-internal hypothesis checked in this corpus — no derived contract reads the var]";
          c.evidence = c.evidence.indexOf(oldTag) >= 0
            ? c.evidence.replace(oldTag, note)
            : c.evidence + note;
        } else {
          const newTag = " [Info: " + rest.join("; ") + "]";
          c.evidence = c.evidence.indexOf(oldTag) >= 0
            ? c.evidence.replace(oldTag, newTag)
            : c.evidence;
        }
      }
      kept.push(c); continue;
    }
    const first = reads[0];
    dropped.push({
      id: c.id, detector: c.detector, varName: c.varName,
      file: c.location.file, contract: owner.name,
      severityGuess: c.severityGuess,
      readBy: reads.map((r) => r.file + ":" + (r.line + 1) + " (" + r.kind + ")"),
      reason: "read cross-file in " + first.file + " line " + (first.line + 1)
        + " (" + first.kind + ") — not dead config",
    });
  }
  return { candidates: kept, dropped };
}

// Jalankan pipeline atas SELURUH file proyek sekaligus (bukan per-file):
// kandidat digabung + didedupe (detector+file+fungsi+varName), lalu
// project-pass menghapus dead-config yang terbukti dibaca lintas-file.
// ID dinomori ulang gabungan (ID per-file bertabrakan antar file).
// opts sama seperti runPipeline (mis. {baseline}).
function runProjectPipeline(files, opts) {
  const list = (files || []).filter((f) => f && typeof f.text === "string");
  // KALIBRASI R18.4: sinyal dust dikumpulkan sekali atas seluruh korpus
  // (+ docs bila opts.docsText ada) lalu diteruskan ke tiap runPipeline.
  const dustSignals = collectDustSignals(list,
    opts && opts.docsText, opts && opts.docsLabel);
  // R19.4 (residual A17/A19): gabungan nama tipe proyek — kontrak/
  // interface + struct dari SEMUA file korpus, supaya tipe import
  // (mis. `IVault`/`IERC20` yang didefinisikan di file lain) dikenali
  // D19 sebagai address-typed. Struct tetap menang atas kontrak senama
  // (isAddressTypeName memeriksa structNames dulu) — arah fail-safe.
  const projectContractTypeNames = new Set();
  const projectStructNames = new Set();
  for (const f of list) {
    const clean = stripComments(f.text);
    for (const s of contractSpans(clean)) {
      if (s.kind === "contract" || s.kind === "interface") projectContractTypeNames.add(s.name);
    }
    for (const n of structNamesOf(clean)) projectStructNames.add(n);
  }
  // D22 (sesi #36, 19 Nov 2026): gabungan initializer state var proyek —
  // fee yang dideklarasikan di file storage lain (mis. `unbondingFee` di
  // YbEthStorage.sol) tetap terlihat D22 saat menganalisis YbEth.sol.
  const projectStateVarInits = new Map();
  for (const f of list) {
    const clean = stripComments(f.text);
    for (const [name, info] of d22StateVarInitMap(clean)) {
      if (!projectStateVarInits.has(name)) projectStateVarInits.set(name, info);
    }
  }
  const opts2 = Object.assign({}, opts, { dustSignals, projectContractTypeNames, projectStructNames, projectStateVarInits });
  const perFile = [];
  let merged = [];
  for (const f of list) {
    const res = runPipeline(f.text, f.name, opts2);
    perFile.push({ file: f.name, candidates: res.candidates.length });
    for (const c of res.candidates) merged.push(c);
  }
  const seen = new Set();
  merged = merged.filter((c) => {
    const k = c.detector + "@" + c.location.file + "#" + c.location.function
      + (c.varName ? ":" + c.varName : "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const { candidates, dropped } = applyProjectPass(merged, list);
  const rank = { High: 0, Medium: 1, Low: 2, Info: 3 };
  candidates.sort((a, b) => rank[a.severityGuess] - rank[b.severityGuess]);
  candidates.forEach((c, i) => { c.id = "FA-" + String(i + 1).padStart(3, "0"); });
  return { candidates, dropped, files: perFile };
}

// ---------------------------------------------------------------------------
// Titik masuk pipeline
// ---------------------------------------------------------------------------
const DETECTORS = [
  detectReentrancy,
  detectMissingAccessControl,
  detectDivisionNoGuard,
  detectEcrecoverNoZeroCheck,
  detectTxOrigin,
  detectUncheckedCall,
  detectPermissionlessDispatcher,
  detectFullBalanceSweep,
  detectPermissionlessValueSend,
  detectReplaySignature,
  detectShareAccounting,
  detectCommentedOutCheck,
  detectOraclePassthrough,
  detectFreeMemPointer,
  detectVacuousIdentityCheck,
];

function runPipeline(source, fileName, opts) {
  // Detektor bekerja atas source tanpa komentar (nomor baris tetap sama).
  const cleanSource = stripComments(source);
  const fns = extractFunctions(cleanSource);
  const found = [];
  let n = 1;
  // Konteks level-kontrak untuk detektor yang butuh state di luar fungsi.
  // R19.2 (sesi 04:38 WIB 18 Nov 2026): nama tipe kontrak/interface +
  // struct + state var address-typed — penunjang `ident.balance` polos
  // di detektor full-balance-sweep (D19).
  const localContractTypeNames = new Set(contractSpans(cleanSource)
    .filter((s) => s.kind === "contract" || s.kind === "interface")
    .map((s) => s.name));
  // R19.4: gabungan nama tipe proyek (opts.projectContractTypeNames /
  // opts.projectStructNames, dihitung runProjectPipeline) digabung ke
  // set lokal — tipe import dikenali D19. Mode single-file (tanpa opts)
  // tetap memakai set lokal saja (konservatif).
  const contractTypeNames = new Set(localContractTypeNames);
  if (opts && opts.projectContractTypeNames) {
    for (const n of opts.projectContractTypeNames) contractTypeNames.add(n);
  }
  const structNames = structNamesOf(cleanSource);
  if (opts && opts.projectStructNames) {
    for (const n of opts.projectStructNames) structNames.add(n);
  }
  const ctx = {
    hasShareState: /\btotalShares\b/.test(cleanSource)
      || /\bmapping\s*\([^)]*\)\s*(public\s+)?shares\b/.test(cleanSource),
    comments: extractComments(source),
    commentBlocks: extractCommentBlocks(source),
    // R-COF-1 (sesi #33, 19 Nov 2026): file interface-only — penunjang
    // kalibrasi commented-out-function (lihat detectCommentedOutFunction).
    // R-COF-1b (temuan Kiro F7/C9): file dengan fungsi bebas (free
    // function) BUKAN interface-only — fungsi bebas adalah kode hidup di
    // luar interface, jadi deklarasi yang dikomentari di file itu bukan
    // trimming interface murni.
    interfaceOnly: (() => {
      const spans = contractSpans(cleanSource);
      return spans.length > 0 && spans.every((s) => s.kind === "interface")
        && fns.length === 0;
    })(),
    contractTypeNames,
    structNames,
    addressStateVars: new Set(scanStateVarDecls(cleanSource)
      .filter((d) => isAddressTypeName(d.type, contractTypeNames, structNames))
      .map((d) => d.name)),
    // R19.3 (sesi 08:38 WIB 18 Nov 2026): base state var yang elemen
    // terindeksnya address-typed — penunjang `BASE[i].balance` di D19.
    indexedAddressStateBases: scanIndexedAddressStateBases(
      cleanSource, contractTypeNames, structNames),
  };
  for (const fn of fns) {
    for (const det of DETECTORS) {
      const hits = det(fn, fileName, "FA-" + String(n).padStart(3, "0"), ctx);
      for (const h of hits) { found.push(h); n++; }
    }
  }
  // Detektor level-file: forwarder satu hop ke dispatcher internal (F10).
  const flaggedD18 = new Set(found
    .filter((c) => c.detector === "permissionless-dispatcher")
    .map((c) => c.location.function));
  const hopHits = detectOneHopDispatcher(fns, fileName, n, flaggedD18);
  for (const h of hopHits) { found.push(h); n++; }
  // Detektor level-file: fungsi utuh yang dikomentari.
  const fileHits = detectCommentedOutFunction(
    fileName, n, ctx);
  for (const h of fileHits) { found.push(h); n++; }
  // Detektor level-file: pergeseran semantik enum vs baseline.
  const enumHits = detectEnumSemanticShift(source, fileName, n, opts);
  for (const h of enumHits) { found.push(h); n++; }
  // Detektor level-file: receive()/fallback() payable tanpa jalur keluar ETH.
  const ethHits = detectEthLockedReceive(source, fileName, n);
  for (const h of ethHits) { found.push(h); n++; }
  // Detektor level-file: state config ditulis tapi tak pernah dibaca.
  const dcHits = detectDeadConfigStorage(source, fileName, n);
  for (const h of dcHits) { found.push(h); n++; }
  // Detektor level-file: bukti konsensus sub-daftar kosong memajukan
  // height + stale-rejection menyensor bukti jujur (kelas K-1).
  const esHits = detectEmptySublistProofAdvancesHeight(source, fileName, n);
  for (const h of esHits) { found.push(h); n++; }
  // Detektor level-file: sandwich JIT reward-accrual (kelas VENO-C2 YbEth).
  const jitHits = detectJitRewardAccrualSandwich(source, fileName, n, opts);
  for (const h of jitHits) { found.push(h); n++; }
  // Detektor level-file: refund gagal-deposit terkunci di middleware tanpa
  // jalur keluar (kelas VENO-C1 BridgeMiddleware zkCRO).
  const refundHits = detectRefundLockedMiddleware(source, fileName, n, opts);
  for (const h of refundHits) { found.push(h); n++; }
  // Detektor level-file: cabang varian tidak mengonsumsi payload (kelas
  // L-1 Hyperbridge Codec.DecodeHeader — cabang Other hanya set flag).
  const variantHits = detectVariantBranchNoPayloadConsume(source, fileName, n);
  for (const h of variantHits) { found.push(h); n++; }
  // Detektor level-file: asimetri guard reentrancy antar-fungsi pembaca NAV
  // (kelas H-SOMM-12 Somm Cellar — preview*/convert* tanpa cek locked vs
  // totalAssets/maxWithdraw/maxRedeem yang ber-guard).
  const navGuardHits = detectGuardAsymmetryNavReaders(source, fileName, n);
  for (const h of navGuardHits) { found.push(h); n++; }
  // Detektor level-file: loop tak-berbatas atas set yang bisa digelembungkan
  // permissionless, di jalur akuntansi (kelas H-SOMM-19 Somm VestingSimple
  // — deposit() tanpa guard menambah allUserDepositIds[receiver];
  // vestedBalanceOf() me-loop seluruh set; totalAssets brick ±3.121 entri).
  const inflatableHits = detectUnboundedLoopInflatableSet(source, fileName, n);
  for (const h of inflatableHits) { found.push(h); n++; }
  // KALIBRASI R18.4 (sesi 12:38 WIB 18 Nov 2026 — backlog dust-by-design):
  // sinyal dust lintas-file dilewatkan runProjectPipeline via
  // opts.dustSignals; mode single-file hanya memakai sinyal file ini +
  // opts.docsText.
  const dustSignals = (opts && opts.dustSignals)
    || collectDustSignals([{ name: fileName, text: source }],
        opts && opts.docsText, opts && opts.docsLabel);
  // R18.4b: nama kontrak dispatcher di file ini (ternormalisasi, prefix
  // I- dibuang) untuk ikatan sinyal eksak-nama (F13). SENGAJA memakai
  // set LOKAL (bukan gabungan proyek R19.4) — nama kontrak file lain
  // tidak boleh mengikat sinyal dust ke kandidat file ini.
  const dispatcherNames = new Set([...localContractTypeNames]
    .map((nm) => nm.replace(/^I(?=[A-Z])/, "")));
  applyDustByDesign(found, dustSignals, fileName, dispatcherNames);
  // Urutkan: High dulu, lalu urutan deteksi.
  const rank = { High: 0, Medium: 1, Low: 2, Info: 3 };
  const sorted = [...found].sort((a, b) =>
    (rank[a.severityGuess] - rank[b.severityGuess]));
  // Lapisan klasifikasi upstream-diff: menganotasi kandidat
  // commented-out-* dengan konteks baseline (bila opts.baseline tersedia).
  classifyUpstreamDiff(source, fileName, sorted, opts);
  // KALIBRASI R-COF-1 (sesi #33, 19 Nov 2026 — residual hunting Veno:
  // ISavingsDai.sol, 32 FP): kandidat commented-out-function dari file
  // interface-only DIBUANG bila baseline tidak membuktikan fungsi itu
  // memang ada di upstream (klasifikasi live-identical / live-divergent
  // / live-modified). Deklarasi interface tidak pernah masuk bytecode —
  // mengomentari deklarasi di salinan interface lokal tanpa bukti
  // baseline hanya memangkas tampilan atas kontrak eksternal (sDAI:
  // 32 deklarasi dikomentari, 5 live), bukan mematikan fungsionalitas.
  // Bila baseline membuktikan fungsi itu ada di upstream (kasus Amply
  // IPool.sol resetIsolationModeTotalDebt, live-identical vs Aave
  // v1.19.4), kandidat DIPERTAHANKAN sebagai anggota klaster.
  // Klasifikasi `absent` (fungsi tak pernah ada di upstream) dan
  // tanpa-baseline ikut dibuang.
  // KALIBRASI R-COF-1b (temuan Kiro F7): kandidat yang dikomentari
  // DENGAN badan (`commentedHasBody`) DIPERTAHANKAN tanpa baseline —
  // interface tidak bisa punya badan, jadi ini kode implementasi yang
  // dimatikan, bukan trimming interface.
  const kept = sorted.filter((c) => {
    if (c.detector !== "commented-out-function" || !ctx.interfaceOnly) return true;
    if (c.commentedHasBody) return true;
    const cls = c.upstream && c.upstream.classification;
    return cls === "live-identical" || cls === "live-divergent"
      || cls === "live-modified";
  });
  // Info baseline untuk laporan (bila ada): jumlah file baseline yang
  // dipakai pass ini — UI menampilkannya di penutup laporan.
  const baselineInfo = (opts && opts.baseline)
    ? { files: typeof opts.baseline.get === "function"
        ? opts.baseline.size : Object.keys(opts.baseline).length }
    : null;
  return {
    candidates: kept,
    baseline: baselineInfo,
    mappedAreas: [
      "reentrancy call-before-update",
      "critical function without access control",
      "division without a zero guard",
      "ecrecover without an address(0) check",
      "tx.origin for authorization",
      "unchecked external call",
      "arbitrary-call executor without access control / permissionless-dispatcher (new 17 Nov; Medium — H3 class, Hyperbridge CallDispatcher.dispatch; calibration R18.1: indexed receiver, assembly sink, onlyGateway/if-revert; calibration F10 18 Nov: one-hop forwarder external -> internal dispatcher, target/data argument positions; F10.1: selector-pinned data is not caller flow; R18.3: empty data `new bytes(0)`/`abi.encode()` excluded; R18.4: dust-by-design documented in code/docs → Medium downgraded to Low; R18.4b: prose only from per-sentence comments, negation rejected, exact-name signal binding, two-source rule)",
      "escrow sweep uses the intermediary contract's full balance / full-balance-sweep (new 17 Nov; Low — H3b class, Hyperbridge IntentGatewayV2.placeOrder; calibration R19.1: paren-balanced argument position, last assignment; R19.2: plain `ident.balance` when ident is address-typed)",
      "send ETH without access control to a caller-chosen target / permissionless-value-send (new 17 Nov; Medium — F8 recommendation, Kiro review of detectors 18/19; calibration R20.2 19 Nov: payable unwrap + payout entitlement; R20.2c: F1 bound amount, F2 non-param name, F3 widened check forms, F4 position before send, F5 one-level nested form)",
      "signature replay without nonce/domain separator (new 14 Nov)",
      "share accounting does not decrease on withdraw (new 14 Nov)",
      "commented-out security check / commented-out-check (new 14 Nov)",
      "whole function commented out / commented-out-function (new 14 Nov; calibration R-COF-1 19 Nov: interface-only files discarded without baseline proof; R-COF-1b: commented-out bodies kept, files with free functions are not interface-only)",
      "upstream-diff: commented-out classification vs the fork baseline (new 14 Nov; active when a baseline is available)",
      "enum semantic shift vs baseline / enum-semantic-shift (new 14 Nov; active when a baseline is available)",
      "oracle price without a staleness check / oracle-passthrough (new 14 Nov; by-design vs candidate classification via baseline; Kiro review calibration 15 Nov: getPriceUnsafe/getUnderlyingPrice/getRoundData, paren/variable-age guards, no answeredInRound/isBorrowAllowed)",
      "free-memory pointer without 32-byte rounding / free-memory-pointer (new 14 Nov; Info only — calibrated PoC falsified; Kiro review calibration 15 Nov: size/count word bounds, mload as size, mstore(64), 1-step let-variable tracing)",
      "payable receive()/fallback() without an ETH exit path / eth-locked-receive (new 15 Nov; Info, rises to Low if IWETH.withdraw/refund=address(this); Kiro Opus 5.5 review calibration 15 Nov: common {value:}, nested casts, immutable/array, safeTransferETH, proxy delegatecall suppressed, body-less declarations not flagged, test/mock paths skipped)",
      "vacuous msg.sender identity check in a handler-only function / vacuous-identity-check (new 15 Nov; Medium — FUL-REF-01 class, Fulcrom ReferralManager: onlyRole(HANDLER_ROLE) + `affiliate == msg.sender`)",
      "config state written but never read / dead-config-storage (new 15 Nov; Low — R-02 class, Fulcrom VaultPriceFeedV2: favorPrimaryPrice + spreadThresholdBasisPoints; upstream-diff classification: live-divergent if upstream reads this var)",
      "empty sub-list consensus proof advances the height + stale-rejection censors honest proofs / empty-sublist-proof-advances-height (new 18 Nov; Low — K-1 class, Hyperbridge EcdsaBeefy: `if (len > 0)` skips verification when parachains are empty, `latestHeight` still advances, an honest proof of the same block is rejected as stale)",
      "JIT reward-accrual sandwich / jit-reward-accrual-sandwich (new 19 Nov; Medium if the exit fee is default-0/absent, Low if the fee is nonzero/unknown — VENO-C2 class, YbEth: `accrueReward` adds `totalPooledEth` without minting shares, `stake` mints at the pre-accrual rate, `requestUnbond` locks the post-accrual rate then burns shares; accrual schedule + live fee = toVerify)",
      "failed-deposit refund locked in the middleware / refund-locked-middleware (new 19 Nov; Medium — VENO-C1 class, BridgeMiddleware zkCRO: deposits are forwarded to the bridge via `requestL2TransactionTwoBridges` so the contract is recorded as the deposit sender; no arbitrary ERC20 rescue + no receive()/fallback() — ERC20 refunds locked in the middleware, ETH refunds revert at the bridge; live bridge refund semantics + live balance + rescue in a parent contract = toVerify)",
      "parser variant branch does not consume the payload / variant-branch-no-payload-consume (new 20 Nov, calibration R24 session #42; Info — L-1 class, Hyperbridge Codec.DecodeHeader: the Other branch only sets a flag without reading the Vec<u8> payload, offset desync for the next item; unit variants without payload are intentionally not flagged; the variant wire format = toVerify)",
      "guard asymmetry between NAV-reader functions / guard-asymmetry-nav-readers (new 22 Nov; Low — H-SOMM-12 class, Somm Cellar: preview*/convert* read NAV without a locked check while totalAssets/maxWithdraw/maxRedeem are guarded; calibration R25 session #56: guard propagation through closures, guard via helper/modifier, uint/getter/member guard forms)",
      "unbounded loop over a set that can be inflated permissionlessly / unbounded-loop-inflatable-set-accounting (new 23 Nov; Medium — H-SOMM-19 class, Somm VestingSimple: deposit() without a guard adds allUserDepositIds[receiver] with a free receiver, vestedBalanceOf() loops the whole set; fork PoC: totalAssets bricks at ±3,121 entries, ±9,846 gas/entry; calibration R26 session #59 over a Kiro review: widened cap, while/backward/reversed loops, conditional break, D26-specific guard, single-file inheritance; F10 sybil intentional)",
    ],
    unmappedAreas: [
      "deep accounting beyond share-withdraw",
      "oracle price manipulation / TWAP beyond staleness",
      "Kiro agent crew review (separate path, not the pipeline)",
      "Slither (run separately, results normalized via normalizeSlither)",
    ],
    topHypotheses: kept.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Normalisasi output Slither (JSON) -> kandidat baku.
// Dipakai begitu slither-analyzer terpasang (M2); fungsi murni, bisa diuji
// dengan fixture tanpa menjalankan Slither.
// ---------------------------------------------------------------------------
function normalizeSlither(slitherJson, fileName) {
  const out = [];
  const detectors = (slitherJson && slitherJson.results
    && slitherJson.results.detectors) || [];
  detectors.forEach((d, i) => {
    const el = (d.elements && d.elements[0]) || {};
    const fnName = (el.name) || "contract";
    const file = (el.source_mapping
      && el.source_mapping.filename_relative) || fileName;
    out.push(normalizeCandidate({
      id: "SL-" + String(i + 1).padStart(3, "0"),
      detector: "slither:" + (d.check || "unknown"),
      title: d.description
        ? d.description.split("\n")[0].slice(0, 120)
        : ("Slither: " + (d.check || "unknown")),
      location: { file, function: fnName },
      hypothesis: d.description || "",
      preconditions: "See the full Slither report for context.",
      impact: "Impact Slither: " + (d.impact || "?")
        + " · confidence: " + (d.confidence || "?"),
      severityGuess: d.impact === "High" ? "High"
        : d.impact === "Medium" ? "Medium" : "Low",
      evidence: (d.check || "") + " — "
        + ((el.source_mapping && el.source_mapping.lines) || []).join(","),
      toVerify: ["Read the full Slither finding",
        "konfirmasi manual di source", "Fork PoC if relevant"],
      source: "slither",
    }));
  });
  return out;
}

// Lookup on-chain read-only: eth_getCode via RPC publik.
async function fetchBytecodeReadOnly(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_getCode",
      params: [address, "latest"],
    }),
  });
  const json = await res.json();
  return json.result; // "0x" = bukan kontrak / belum deploy
}

// Export Node (untuk test runner); di browser, fungsi tetap global.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runPipeline, normalizeCandidate, normalizeSlither,
    extractFunctions, fetchBytecodeReadOnly, stripComments, extractComments,
    extractCommentBlocks, listCommentedOutFunctions, classifyUpstreamDiff,
    extractEnums, detectEnumSemanticShift, hasStalenessGuard,
    detectEthLockedReceive, detectDeadConfigStorage, findDeadConfigVars,
    detectEmptySublistProofAdvancesHeight,
    detectJitRewardAccrualSandwich,
    detectRefundLockedMiddleware,
    detectVariantBranchNoPayloadConsume,
    detectGuardAsymmetryNavReaders,
    detectUnboundedLoopInflatableSet,
    buildBaselineMap, runProjectPipeline, applyProjectPass, findCrossFileReads,
    findDispatcherSink, detectOneHopDispatcher, paramNamesOf,
    collectDustSignals, findDustSignalsInText, applyDustByDesign, dustSignalTied,
  };
}

