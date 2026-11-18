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
    preconditions: raw.preconditions || "Belum terverifikasi.",
    impact: raw.impact || "",
    severityGuess: raw.severityGuess || "Low",
    evidence: raw.evidence || "",
    toVerify: raw.toVerify || [],
    source: raw.source || "pattern-scan",
    detector: raw.detector || "pattern-scan",
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
        title: "Kemungkinan reentrancy: state update sesudah external call",
        location: { file: fileName, function: fn.name },
        hypothesis: "Fungsi " + fn.name + " mengirim ETH/token sebelum "
          + "memperbarui state, sehingga kontrak penerima bisa re-enter "
          + "dan mengulang penarikan sebelum saldo tercatat berkurang.",
        preconditions: "Penerima adalah kontrak dengan fallback/receive "
          + "yang memanggil kembali fungsi ini; saldo korban mencukupi.",
        impact: "Pengurasan saldo kontrak bila pola terkonfirmasi.",
        severityGuess: "High",
        evidence: "external call di baris " + (fn.startLine + callIdx + 1)
          + ", state update di baris " + (fn.startLine + k + 1) + ".",
        toVerify: ["Baca urutan lengkap fungsi " + fn.name,
          "cek apakah ada reentrancy guard (nonReentrant)",
          "PoC fork: kontrak penyerang re-enter"],
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
    title: "Fungsi kritikal tanpa kontrol akses",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " menulis state sensitif ("
      + (m ? m[0].trim() : "?") + ") tanpa modifier akses dan tanpa "
      + "require(msg.sender == ...) — siapa pun bisa memanggilnya.",
    preconditions: "Fungsi bersifat external/public dan dapat dipanggil "
      + "oleh alamat mana pun.",
    impact: "Pengambilalihan peran / pengiriman aset tanpa izin bila terkonfirmasi.",
    severityGuess: "High",
    evidence: "Tulis state sensitif di fungsi " + fn.name
      + " tanpa onlyOwner/onlyRole/require pengirim.",
    toVerify: ["Periksa modifier & require di " + fn.name,
      "cek apakah fungsi ini memang sengaja terbuka (mis. permissionless by design)",
      "PoC fork: panggil dari alamat acak"],
    source: "pattern-scan",
  })];
}

function detectDivisionNoGuard(fn, fileName, id) {
  const out = [];
  for (const denom of DIVISION_DENOMS) {
    const divRe = new RegExp("/\\s*" + denom + "\\b");
    if (!divRe.test(fn.body)) continue;
    const guardRe = new RegExp(
      "require\\s*\\(\\s*" + denom + "\\s*(>|!=)\\s*0");
    if (guardRe.test(fn.body)) continue;
    out.push(normalizeCandidate({
      id, detector: "division-no-guard",
      title: "Pembagian tanpa guard nol pada " + denom,
      location: { file: fileName, function: fn.name },
      hypothesis: "Fungsi " + fn.name + " membagi dengan " + denom
        + " tanpa require(" + denom + " > 0) — bila penyebut 0, transaksi revert.",
      preconditions: denom + " bisa mencapai 0 (mis. vault kosong / sebelum deposit pertama).",
      impact: "DoS pada fungsi terkait; harga/nilai tidak terdefinisi saat penyebut 0.",
      severityGuess: "Medium",
      evidence: "Pembagian / " + denom + " di fungsi " + fn.name
        + " tanpa guard nol di badan fungsi.",
      toVerify: ["Cek apakah " + denom + " memang bisa 0 dari jalur mana pun",
        "PoC fork: panggil saat " + denom + " == 0"],
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
    title: "Hasil ecrecover dipakai tanpa cek address(0)",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " memakai hasil ecrecover tanpa "
      + "require(signer != address(0)) — signature invalid menghasilkan "
      + "address(0) yang bisa lolos bila logika membandingkannya.",
    preconditions: "Signature (v/r/s) tidak valid / dibuat-buat.",
    impact: "Klaim/otorisasi palsu bila address(0) lolos perbandingan.",
    severityGuess: "Medium",
    evidence: "ecrecover( di fungsi " + fn.name
      + " tanpa kemunculan address(0) di badan fungsi.",
    toVerify: ["Baca perbandingan signer di " + fn.name,
      "PoC fork: kirim signature sampah (v/r/s acak)"],
    source: "pattern-scan",
  })];
}

function detectTxOrigin(fn, fileName, id) {
  if (!/tx\.origin/.test(fn.body)) return [];
  return [normalizeCandidate({
    id, detector: "tx-origin-auth",
    title: "Otorisasi memakai tx.origin",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " memakai tx.origin untuk otorisasi — "
      + "kontrak perantara/phishing bisa memanggilnya atas nama pemilik.",
    preconditions: "Pemilik pernah berinteraksi dengan kontrak penyerang.",
    impact: "Aksi atas nama pemilik tanpa persetujuan pemilik bila terkonfirmasi.",
    severityGuess: "High",
    evidence: "tx.origin di fungsi " + fn.name + ".",
    toVerify: ["Cek konteks pemakaian tx.origin di " + fn.name,
      "PoC fork: kontrak perantara memanggil fungsi ini"],
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
      title: "Hasil external call diabaikan (unchecked call)",
      location: { file: fileName, function: fn.name },
      hypothesis: "Fungsi " + fn.name + " memanggil .call tanpa memeriksa "
        + "return value, lalu melanjutkan seolah transfer berhasil.",
      preconditions: "Call gagal (mis. penerima revert / gas habis).",
      impact: "State berubah seolah transfer sukses padahal gagal — akuntansi salah.",
      severityGuess: "Medium",
      evidence: ".call mandiri di baris " + (fn.startLine + k + 1)
        + " tanpa penangkapan return / require.",
      toVerify: ["Baca baris sekitar call di " + fn.name,
        "PoC fork: buat call gagal lalu cek state sesudahnya"],
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
    title: "Eksekutor arbitrary-call tanpa kontrol akses (permissionless dispatcher)",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " mengeksekusi panggilan low-level "
      + "ke target arbitrer (" + recv + ") dengan data arbitrer ("
      + args.slice(0, 40) + ") tanpa modifier akses dan tanpa "
      + "require(msg.sender == ...) — siapa pun bisa memanggilnya dan "
      + "menjalankan call apa pun dengan saldo kontrak ini.",
    preconditions: "Kontrak menampung dana (ETH/token) — mis. dari "
      + "predispatch / deposit user — saat fungsi ini dipanggil penyerang.",
    impact: "Pengurasan dana yang tersangkut di kontrak bila terkonfirmasi "
      + "(kelas H3 Hyperbridge: residu predispatch 200 USDC dikuras via dispatch langsung).",
    severityGuess: "Medium",
    evidence: "Low-level call " + method + " di fungsi " + fn.name
      + " — target `" + recv + "`, data `" + args.slice(0, 60)
      + "`, tanpa guard akses di signature/badan"
      + (viaAssembly ? " (via assembly)" : "") + ".",
    toVerify: ["Cek modifier & require di " + fn.name,
      "cek apakah kontrak ini memang menampung dana user sementara",
      "PoC fork: panggil dari alamat acak dengan transfer token ke diri sendiri"],
    source: "pattern-scan",
  });
  return [mkCandidate(sink.method, sink.recv, sink.args, sink.viaAssembly)];
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
            title: "Eksekutor arbitrary-call tanpa kontrol akses (permissionless dispatcher, one-hop forwarder)",
            location: { file: fileName, function: fn.name },
            hypothesis: "Fungsi " + fn.name + " meneruskan argumen kendali caller "
              + "ke dispatcher internal " + dName + " (sink: " + d.sink.method
              + " ke `" + d.sink.recv + "` dengan data `" + d.sink.args.slice(0, 40)
              + "`) — siapa pun bisa memanggil " + fn.name + " dan menjalankan "
              + "call apa pun dengan saldo kontrak ini lewat satu hop.",
            preconditions: "Kontrak menampung dana (ETH/token) saat fungsi ini dipanggil penyerang; "
              + dName + " tidak punya guard sendiri.",
            impact: "Pengurasan dana yang tersangkut di kontrak bila terkonfirmasi "
              + "(kelas H3 Hyperbridge, varian forwarder).",
            severityGuess: "Medium",
            evidence: "One-hop: `" + fn.name + "` -> `" + dName + "` — argumen posisi ke-"
              + (i + 1) + " (`" + args[i].trim().slice(0, 40) + "`) memakai parameter caller dan "
              + "mengalir ke parameter `" + pname + "` dispatcher (dipakai sebagai "
              + (d.targetParams.has(pname) ? "target" : "") + (d.targetParams.has(pname) && d.dataParams.has(pname) ? "/" : "")
              + (d.dataParams.has(pname) ? "data" : "") + " sink), tanpa guard akses di "
              + fn.name + ".",
            toVerify: ["Cek modifier & require di " + fn.name + " dan " + dName,
              "cek apakah kontrak ini memang menampung dana user sementara",
              "PoC fork: panggil " + fn.name + " dari alamat acak dengan transfer token ke diri sendiri"],
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
// masuk set ini (bukan identifier deklarasi). BATAS: tipe kontrak dari
// file lain (import) tidak dikenali — konservatif, tetap 0 (FN diketahui).
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
    const e = String(elem).replace(/\s+/g, " ").trim();
    if (e === "address" || e === "address payable") return true;
    if (sts && sts.has(e)) return false;
    return !!cts && cts.has(e);
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
    const e = String(elem).replace(/\s+/g, " ").trim();
    if (e === "address" || e === "address payable") return true;
    if (sts && sts.has(e)) return false;
    return !!cts && cts.has(e);
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
// BATAS DIKETAHUI: tipe kontrak dari file lain (import) tidak dikenali
// (konservatif — FN); `x = T(addr)` (cast-assignment tanpa deklarasi)
// belum melacak tipe. R19.3: akses terindeks `BASE[i].balance` SUDAH
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
    title: "Sweep escrow memakai saldo penuh kontrak perantara, bukan jumlah deklarasi",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " mentransfer sejumlah `" + amountExpr
      + "` — saldo penuh sebuah kontrak perantara (balanceOf/balance) — "
      + "bukan jumlah yang dideklarasikan di order. Kelebihan di atas "
      + "jumlah deklarasi (mis. residu predispatch) ikut tersapu ke escrow.",
    preconditions: "Ada residu dana di kontrak perantara saat sweep berjalan "
      + "(mis. predispatch exact-output swap yang memakai kurang dari amountInMax).",
    impact: "Residu user tersapu ke escrow / tidak kembali ke user; bila "
      + "digabung eksekutor tanpa guard, residu bisa dikuras siapa saja.",
    severityGuess: "Low",
    evidence: "Jumlah `" + amountExpr + "` berasal dari balanceOf/balance "
      + "kontrak perantara dan dipakai sebagai jumlah transfer/call di "
      + "fungsi " + fn.name + ".",
    toVerify: ["Baca assignment & pemakaian jumlah di " + fn.name,
      "cek apakah kelebihan di atas jumlah deklarasi dikembalikan / dicatat",
      "PoC fork: sisakan residu di perantara, lalu cek ke mana ia tersapu"],
    source: "pattern-scan",
  });
  // 2. Pemakaian sebagai jumlah — posisi argumen EKSPLISIT via paren
  //    seimbang: transfer/safeTransfer -> argumen ke-2; transferFrom ->
  //    argumen ke-3; encodeWithSelector(...transfer.selector...) ->
  //    argumen ke-3; _sendValue -> argumen ke-2.
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
      if (args[0] && /\.transfer\.selector/.test(args[0])) amount = args[2];
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
function detectPermissionlessValueSend(fn, fileName, id) {
  if (fn.isConstructor) return [];
  if (/\b(internal|private)\b/.test(fn.signature)) return [];
  if (/\b(view|pure)\b/.test(fn.signature)) return [];
  if (hasAccessGuard(fn)) return [];
  const body = fn.body;
  const recvSrc = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\]|\\([^)]*\\))*";
  const recvOk = new RegExp("^(" + recvSrc + ")$");
  const recvExcluded = (recv) => {
    if (/^msg\.sender$/.test(recv)) return true;
    if (/^address\s*\(\s*this\s*\)$/.test(recv) || recv === "this") return true;
    if (/^0x[0-9a-fA-F]+$/.test(recv)) return true;
    // KALIBRASI hunting re-run 17 Nov 2026 (R20.1 — wasit: FP wrapper
    // Uniswap `WETH().call{value: msg.value}`): receiver berupa panggilan
    // tanpa argumen (`WETH()`) mengembalikan alamat TETAP, bukan pilihan
    // caller — dikecualikan.
    if (/^[A-Za-z_$][\w$]*\(\s*\)$/.test(recv)) return true;
    // Penerima yang dideklarasikan sebagai pemilik/beneficiary: jalur
    // payout yang sah (owner withdraw, beneficiary payout).
    if (/^(owner|beneficiary|treasury)$/.test(recv)) return true;
    return !recvOk.test(recv);
  };
  // KALIBRASI R20.1 (wasit): nilai yang dikirim BUKAN dana kontrak bila
  // (a) persis `msg.value` (ETH caller sendiri yang diteruskan — wrap),
  // (b) identifier yang sebelumnya DITARIK dari msg.sender di fungsi yang
  // sama (`safeTransferFrom(msg.sender, ..., V)` — unwrap-forward 1:1,
  // mis. swapExactTokensForETH).
  const isCallerFunded = (value) => {
    const t = (value || "").trim();
    if (t === "msg.value") return true;
    if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      const pullRe = new RegExp("\\.(?:safeTransferFrom|transferFrom)\\s*\\(\\s*msg\\.sender\\s*,[^,]+,\\s*" + t.replace(/\$/g, "\\$") + "\\b");
      if (pullRe.test(body)) return true;
    }
    return false;
  };
  const mkCandidate = (method, recv, value) => normalizeCandidate({
    id, detector: "permissionless-value-send",
    title: "Kirim ETH tanpa kontrol akses ke target pilihan caller (permissionless value-send)",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " mengirim ETH (" + method + ") ke "
      + "target pilihan caller (" + recv + ") sejumlah `" + value
      + "` tanpa modifier akses dan tanpa require(msg.sender == ...) — "
      + "siapa pun bisa memanggilnya dan menguras saldo ETH kontrak.",
    preconditions: "Kontrak memegang ETH saat fungsi ini dipanggil penyerang.",
    impact: "Pengurasan saldo ETH kontrak bila terkonfirmasi.",
    severityGuess: "Medium",
    evidence: method + " ke `" + recv + "` sejumlah `" + value
      + "` di fungsi " + fn.name + ", tanpa guard akses di signature/badan.",
    toVerify: ["Cek modifier & require di " + fn.name,
      "cek apakah " + recv + " memang dipilih caller atau sudah ditentukan",
      "PoC fork: panggil dari alamat acak ke alamat penyerang"],
    source: "pattern-scan",
  });
  // .call{value: V}("") — data kosong.
  const callRe = new RegExp("(" + recvSrc + ")\\s*\\.\\s*call\\s*\\{[^}]*value\\s*:\\s*([^,}]+)\\}\\s*\\(\\s*(\"\"|'')\\s*\\)", "g");
  let m;
  while ((m = callRe.exec(body)) !== null) {
    const recv = m[1].trim(), value = (m[2] || "").trim();
    if (value === "0") continue;
    if (isCallerFunded(value)) continue;
    if (recvExcluded(recv)) continue;
    return [mkCandidate(".call{value:}", recv, value)];
  }
  // .transfer(V) / .send(V) — termasuk payable(to).transfer(V).
  // Pembedanya dari ERC20 transfer(to, amount): ETH transfer/send hanya
  // punya SATU argumen (jumlah) — dihitung via paren seimbang.
  const tsRe = /((?:payable\s*\(\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\([^)]*\))*(?:\s*\))?)\s*\.\s*(transfer|send)\s*\(/g;
  while ((m = tsRe.exec(body)) !== null) {
    let recv = m[1].trim();
    const openIdx = body.indexOf("(", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const parsed = splitTopLevelArgs(body, openIdx);
    if (!parsed || parsed.args.length !== 1) continue; // ERC20: 2 argumen
    const value = (parsed.args[0] || "").trim();
    if (value === "0") continue;
    if (isCallerFunded(value)) continue;
    // payable(to) -> to (untuk cek pengecualian).
    const inner = recv.match(/^payable\s*\(\s*([\w$.]+)\s*\)$/);
    if (inner) recv = inner[1];
    if (recvExcluded(recv)) continue;
    return [mkCandidate("." + m[2], recv, value)];
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
    title: "Signature bisa di-replay: ecrecover tanpa nonce/domain separator",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " memverifikasi signature via "
      + "ecrecover, tapi digest-nya tidak mengikat nonce, chainId, "
      + "domain separator, atau address(this) — satu signature sah bisa "
      + "dipakai ulang berkali-kali (dan di chain/deployment lain).",
    preconditions: "Penyerang memperoleh satu signature valid "
      + "(mis. dari klaim sah sebelumnya / signature yang bocor).",
    impact: "Pencetakan saldo / klaim berulang tanpa batas bila terkonfirmasi.",
    severityGuess: "High",
    evidence: "ecrecover( di fungsi " + fn.name
      + " tanpa nonce/chainId/domain separator/address(this) di badan fungsi.",
    toVerify: ["Baca konstruksi digest di " + fn.name,
      "cek apakah nonce disimpan & ditandai terpakai",
      "PoC fork: panggil 2x dengan signature yang sama"],
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
    title: "Akuntansi share tidak berkurang saat penarikan",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " mengurangi balances tapi tidak "
      + "mengurangi shares/totalShares — akuntansi share tidak sinkron "
      + "dengan saldo, sehingga sharePrice / nilai per share salah.",
    preconditions: "Kontrak melacak shares/totalShares dan dipakai "
      + "untuk menghitung harga atau nilai.",
    impact: "Harga share salah; nilai klaim/penarikan tidak akurat.",
    severityGuess: "Low",
    evidence: "balances[...] -= di fungsi " + fn.name
      + " tanpa shares[...] -= / totalShares -= di badan fungsi.",
    toVerify: ["Cek pemakaian shares/totalShares di " + fn.name
      + " dan fungsi lain", "PoC fork: deposit → withdraw → baca sharePrice"],
    source: "pattern-scan",
  })];
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
    if (!checkRe.test(text)) continue;
    return [normalizeCandidate({
      id, detector: "commented-out-check",
      title: "Cek keamanan dikomentari (commented-out check)",
      location: { file: fileName, function: fn.name },
      hypothesis: "Fungsi " + fn.name + " mengandung cek keamanan yang "
        + "dikomentari (baris " + (c.line + 1) + ": \"" + text.slice(0, 90)
        + "\") — pertahanan yang seharusnya aktif justru dimatikan, "
        + "sehingga jalur yang tadinya ditolak kini lolos.",
      preconditions: "Cek yang dikomentari memang load-bearing (bukan "
        + "duplikat cek lain yang masih aktif di jalur yang sama).",
      impact: "Validasi hilang: batas/izin yang seharusnya ditegakkan "
        + "tidak lagi ditegakkan bila terkonfirmasi.",
      severityGuess: "Medium",
      evidence: "Komentar cek di baris " + (c.line + 1)
        + " dalam fungsi " + fn.name + ": " + text.slice(0, 120),
      toVerify: ["Baca fungsi " + fn.name + " lengkap: cek apa yang dimatikan",
        "bandingkan dengan upstream / versi sebelumnya (git history / diff)",
        "cek apakah cek pengganti masih aktif di jalur yang sama",
        "PoC fork: panggil jalur yang tadinya ditolak cek tersebut"],
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
      items.push({ name, startLine: b.startLine, endLine: b.endLine, text: b.text });
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
  const items = listCommentedOutFunctions(ctx);
  return items.map((it, n) => normalizeCandidate({
    id: "FA-" + String(idStart + n).padStart(3, "0"),
    detector: "commented-out-function",
    title: "Fungsi utuh dikomentari (commented-out function)",
    location: { file: fileName, function: it.name },
    hypothesis: "Fungsi " + it.name + " dikomentari UTUH (blok komentar "
      + "baris " + (it.startLine + 1) + "–" + (it.endLine + 1) + ") — "
      + "fungsionalitas yang seharusnya ada justru tidak ada di "
      + "bytecode: tidak ada jalur yang bisa menjalankan logika ini.",
    preconditions: "Fungsi yang dikomentari memang load-bearing "
      + "(bukan fungsi mati / sudah diganti jalur lain yang aktif).",
    impact: "Kemampuan yang dimatikan tidak bisa dipakai: batas/izin/"
      + "pengaturan yang diatur fungsi ini tidak lagi bisa diubah.",
    severityGuess: "Medium",
    evidence: "Definisi fungsi " + it.name + " di dalam blok komentar "
      + "(baris " + (it.startLine + 1) + "–" + (it.endLine + 1) + "): "
      + it.text.replace(/\s+/g, " ").trim().slice(0, 140),
    toVerify: ["Baca blok komentar lengkap: fungsi apa yang dimatikan",
      "bandingkan dengan upstream / versi sebelumnya (git history / diff)",
      "cek apakah jalur pengganti masih aktif di tempat lain",
      "PoC fork: panggil jalur yang bergantung pada fungsi ini"],
    source: "pattern-scan",
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
      hypothesis: "Enum " + te.name + " di fork ini berbeda dari "
        + "baseline " + baseName + ": member yang bertahan bergeser "
        + "nilai numeriknya (" + shifts.join(", ") + ")"
        + (removed.length ? "; dihapus: " + removed.join(", ") : "")
        + (added.length ? "; ditambah: " + added.join(", ") : "")
        + ". Kode/integrator yang mengirim nilai mentah konvensi "
        + "upstream bisa kena revert — atau diam-diam mendapat arti "
        + "yang berbeda.",
      preconditions: "Enum ini dipakai lintas kontrak / lewat ABI "
        + "(parameter fungsi, event, atau nilai mentah dari integrator).",
      impact: "Compat break: nilai enum mentah konvensi upstream "
        + "berarti lain / revert di fork — integrator bisa diam-diam "
        + "mendapat mode yang salah (mis. utang variable, bukan stable).",
      severityGuess: "Low",
      evidence: "Baseline " + baseName + ": enum " + te.name + " {"
        + be.members.join(", ") + "}; fork: {" + te.members.join(", ")
        + "}; geser nilai: " + shifts.join(", "),
      toVerify: ["Baca pemakaian enum ini di seluruh codebase (parameter fungsi / ABI)",
        "cek apakah integrator / UI mengirim nilai mentah",
        "bandingkan dengan versi upstream yang dipakai fork ini",
        "PoC fork: panggil dengan nilai mentah konvensi upstream"],
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
    title: "Harga oracle dipakai tanpa cek staleness",
    location: { file: fileName, function: fn.name },
    hypothesis: "Fungsi " + fn.name + " membaca harga ("
      + (m ? m[0].trim() : "?")
      + ") tanpa memeriksa umur data (updatedAt vs block.timestamp / "
      + "answeredInRound) — bila feed macet atau updater berhenti, "
      + "harga basi tetap dipakai untuk valuasi/likuidasi.",
    preconditions: "Feed/oracle di belakang panggilan ini bisa basi "
      + "(updater berhenti, sequencer down, feed tidak diperbarui).",
    impact: "Valuasi agunan/utang memakai harga basi — likuidasi salah "
      + "atau utang dinilai terlalu rendah/tinggi bila terkonfirmasi.",
    severityGuess: "Low",
    evidence: "Panggilan baca harga di fungsi " + fn.name
      + " tanpa cek staleness di badan fungsi.",
    toVerify: ["Baca implementasi oracle di belakang panggilan ini: "
      + "apakah ia sendiri memvalidasi staleness (updatedAt/heartbeat)?",
      "cek apakah ada PriceOracleSentinel / grace period di jalur pemakaian",
      "bandingkan dengan upstream (baseline): bila pola sama persis "
      + "dengan upstream, ini by-design / known-issue, bukan deviasi fork",
      "cek live: updatedAt feed vs block.timestamp saat ini",
      "NAIKKAN ke Medium hanya bila ketiganya terpenuhi: (1) harga dipakai "
      + "untuk valuasi agunan/utang, likuidasi, mint, atau redeem; (2) "
      + "staleness realistis untuk feed itu (heartbeat panjang, "
      + "latestAnswer deprecated, L2 tanpa sentinel); (3) tidak ada guard "
      + "di jalur lain (fallback oracle / sentinel / circuit breaker). "
      + "High hanya bila PoC menunjukkan selisih harga basi bisa diubah "
      + "menjadi borrow berlebih"],
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
          title: "Free-memory pointer di-update tanpa pembulatan 32 byte (Info)",
          location: { file: fileName, function: fn.name },
          hypothesis: "Fungsi " + fn.name + " meng-update free-memory pointer "
            + "di assembly dengan nilai dari variabel `" + trimmed + "` yang "
            + "berisi penjumlahan ukuran data-dependent tanpa pembulatan "
            + "ke kelipatan 32 byte.",
          preconditions: "Jumlah byte yang ditambahkan bukan kelipatan 32 "
            + "(mis. panjang payload arbitrer).",
          impact: "Info saja (terkalibrasi PoC Foundry 8/8 PASS, sesi BB "
            + "14 Nov): misalignment NYATA tapi TIDAK ada korupsi data — "
            + "memori EVM byte-addressable dan alokasi relatif; jangan "
            + "naikkan ke Medium tanpa bukti korupsi baru.",
          severityGuess: "Info",
          evidence: "mstore ke free-memory pointer di fungsi " + fn.name
            + " dengan nilai variabel `" + trimmed + "` (add() berukuran "
            + "data-dependent tanpa idiom pembulatan 32 byte).",
          toVerify: ["Baca blok assembly lengkap di " + fn.name,
            "cek apakah nilai yang ditambahkan selalu kelipatan 32",
            "PoC fork: alokasi berurutan dengan panjang non-kelipatan-32, "
            + "cek integritas data"],
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
      title: "Free-memory pointer di-update tanpa pembulatan 32 byte (Info)",
      location: { file: fileName, function: fn.name },
      hypothesis: "Fungsi " + fn.name + " meng-update free-memory pointer "
        + "di assembly dengan penjumlahan ukuran data-dependent tanpa "
        + "pembulatan ke kelipatan 32 byte — pointer bebas berikutnya "
        + "bisa tidak sejajar 32 byte.",
      preconditions: "Jumlah byte yang ditambahkan bukan kelipatan 32 "
        + "(mis. panjang payload arbitrer).",
      impact: "Info saja (terkalibrasi PoC Foundry 8/8 PASS, sesi BB "
        + "14 Nov): misalignment NYATA tapi TIDAK ada korupsi data — "
        + "memori EVM byte-addressable dan alokasi relatif; jangan "
        + "naikkan ke Medium tanpa bukti korupsi baru.",
      severityGuess: "Info",
      evidence: "mstore ke free-memory pointer di fungsi " + fn.name
        + " dengan nilai add(...) berukuran data-dependent tanpa idiom "
        + "pembulatan 32 byte.",
      toVerify: ["Baca blok assembly lengkap di " + fn.name,
        "cek apakah nilai yang ditambahkan selalu kelipatan 32",
        "PoC fork: alokasi berurutan dengan panjang non-kelipatan-32, "
        + "cek integritas data"],
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
    ? "Fungsi " + fn.name + " hanya bisa dipanggil kontrak perantara ("
      + gateText + ") tapi memeriksa `" + best.other + " " + best.op
      + " msg.sender` (" + best.text + ") di " + best.ctx
      + " — msg.sender di sini selalu perantara, jadi guard ini SELALU "
      + "gagal dan fungsi tidak pernah jalan (DoS fungsional), bukan "
      + "bypass — periksa apakah fungsi ini satu-satunya jalur untuk "
      + "aksi itu."
    : best.cls === "info"
      ? "Fungsi " + fn.name + " hanya bisa dipanggil kontrak perantara ("
        + gateText + ") dan membandingkan msg.sender dengan `" + best.other
        + "` (" + best.text + ") — `" + best.other + "` adalah identitas "
        + "perantara itu sendiri, jadi cek ini redundan (selalu benar) — "
        + "Info saja, bukan bypass."
      : "Fungsi " + fn.name + " hanya bisa dipanggil kontrak perantara ("
        + gateText + ") tapi membandingkan msg.sender dengan `" + best.other
        + "` (" + best.text + ") — msg.sender di sini selalu perantara, "
        + "tidak pernah end-user, jadi cek identitas itu tidak pernah "
        + "menangkap kasus yang dimaksud (mis. self-referral lolos).";
  return [normalizeCandidate({
    id, detector: "vacuous-identity-check",
    title: best.cls === "dos"
      ? "Guard identitas yang selalu revert di fungsi handler-only"
      : best.cls === "info"
        ? "Cek identitas redundan terhadap perantara di fungsi handler-only"
        : "Cek identitas msg.sender yang vacuous di fungsi handler-only",
    location: { file: fileName, function: fn.name },
    hypothesis,
    preconditions: "Fungsi dipanggil lewat kontrak perantara (handler / "
      + "router / relayer), bukan langsung oleh end-user.",
    impact: best.cls === "dos"
      ? "Fungsi tidak pernah bisa jalan lewat jalur ini — aksi yang "
        + "seharusnya tersedia (mis. set referral, withdraw, likuidasi) "
        + "terblokir selama guard ini ada."
      : best.cls === "info"
        ? "Tidak ada dampak keamanan — cek redundan, hanya noise."
        : "Guard identitas yang dimaksudkan (mis. larangan self-referral) "
          + "tidak berlaku di jalur ini — aturan bisa dilewati dari panggilan "
          + "perantara bila terkonfirmasi.",
    severityGuess: best.severityGuess,
    evidence: "Perbandingan msg.sender vs `" + best.other + "` di fungsi "
      + fn.name + " yang ber-modifier perantara (" + best.text
      + "; konteks " + best.ctx + ", kelas " + best.cls + ").",
    toVerify: ["Baca siapa pemegang peran perantara itu (kontrak vs EOA) "
      + "dan siapa yang memanggil fungsi ini",
      "bandingkan dengan jalur pemanggilan langsung (bila ada) — apakah "
      + "cek yang sama di sana bermakna?",
      "PoC fork: panggil lewat perantara dengan identitas sendiri sebagai "
      + "parameter dan lihat apakah guard menangkapnya"],
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

// Apakah sebuah NAMA TIPE address-typed: `address` / `address payable`,
// atau nama kontrak/interface yang dideklarasikan di file ini. Struct
// (namanya ada di structNames) dan primitif lain BUKAN address-typed;
// tipe array (`address[]`) juga bukan — `arr.balance` bukan Solidity valid.
function isAddressTypeName(typeName, contractTypeNames, structNames) {
  if (!typeName) return false;
  const t = String(typeName).replace(/\s+/g, " ").trim();
  if (t.indexOf("[") !== -1) return false;
  if (t === "address" || t === "address payable") return true;
  if (structNames && structNames.has(t)) return false;
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
    // `this.name` dan `super.name` membaca var file ini (F16: getter
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
      if (a.memberCalls > 0) infoReasons.push("member-call: getter `.name(` dibaca di instance/kontrak lain (P1)");
      if (d.override) infoReasons.push("override-getter: getter interface, dibaca off-chain/lewat interface (F14)");
      if (rawSlot) infoReasons.push("raw-slot: assembly sload/sstore slot angka di file ini (P10)");
      // F6 (heuristik): kontrak abstract + var non-public → pembaca bisa
      // ada di kontrak turunan file lain. Single-file (runPipeline) ini
      // tetap Info; bila dijalankan lewat runProjectPipeline,
      // applyProjectPass mencabut alasan ini bila korpus penuh tidak
      // menemukan pembaca (residual (3), sesi 16:38 WIB 2026-11-17).
      const ownerC = contracts.find((c) => d.nameIndex >= c.start && d.nameIndex <= c.end);
      const isAbstract = ownerC && ownerC.kind === "contract"
        && /\babstract\b/.test(clean.slice(Math.max(0, ownerC.start - 16), ownerC.start));
      if (isAbstract && !d.isPublic) {
        infoReasons.push("abstract-internal: mungkin dibaca kontrak turunan file lain (F6)");
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

function detectDeadConfigStorage(source, fileName, idStart) {
  if (/(^|\/)(mocks?|test|tests?)\//i.test(fileName)
    || /\.t\.sol$/i.test(fileName)
    || /(^|\/)(Mock|Harness)[A-Za-z0-9_]*\.sol$/i.test(fileName)) return [];
  const dead = findDeadConfigVars(source);
  const contractName = (source.match(/\bcontract\s+([A-Za-z_][A-Za-z0-9_$]*)/) || [])[1]
    || fileName.split("/").pop();
  return dead.map((d, k) => {
    const writerList = d.writes.map((w) => (w.fn || "?") + " (baris " + (w.line + 1) + ")").join(", ");
    const isInfo = d.infoReasons.length > 0;
    const cand = normalizeCandidate({
      id: "FA-" + String(idStart + k).padStart(3, "0"),
      detector: "dead-config-storage",
      title: "Dead config: `" + d.name + "` ditulis tapi tak pernah dibaca",
      location: { file: fileName, function: d.firstWriter.fn || contractName },
      hypothesis: "State var `" + d.name + "` (deklarasi baris " + (d.declLine + 1) + ") ditulis "
        + d.writes.length + "× di " + writerList + " tapi TIDAK PERNAH dibaca di file ini"
        + (d.noops > 0 ? " (plus " + d.noops + "× statement no-op `" + d.name + ";` — disebut tapi tidak dipakai)" : "")
        + " — config yang disetel governance tidak mengubah perilaku kontrak apa pun.",
      preconditions: "Setter/initialize masih bisa dipanggil (governance aktif) dan tidak ada pembaca di file lain yang terlewat.",
      impact: "Operator/governance mengira config ini berlaku padahal tidak — keputusan (mis. pilih oracle primer vs sekunder, ambang spread) diam-diam tidak berpengaruh; bila upstream MEMBACA var ini, fork kehilangan wiring-nya (lihat anotasi upstream-diff).",
      severityGuess: isInfo ? "Info" : "Low",
      evidence: "Tulis di " + writerList + "; 0 baca di file ini"
        + (d.noops > 0 ? "; " + d.noops + "× statement no-op `" + d.name + ";`" : "")
        + "; deklarasi baris " + (d.declLine + 1) + "."
        + (isInfo ? " [Info: " + d.infoReasons.join("; ") + "]" : ""),
      toVerify: ["Cek apakah var ini dibaca lewat getter publik oleh kontrak lain / off-chain (auto-getter `public` tetap bisa dibaca lintas kontrak)",
        "bandingkan dengan upstream: bila upstream MEMBACA var ini, fork menghapus wiring-nya",
        "cek apakah setter-nya masih bisa dipanggil governance — bila ya, config ini menyesatkan operator",
        "PoC fork: set var lalu panggil jalur yang seharusnya terpengaruh, bandingkan perilaku"],
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
      title: "receive()/fallback() payable tanpa jalur keluar ETH",
      location: { file: fileName, function: kind },
      hypothesis: "Kontrak ini punya " + kind + "() external payable "
        + "(baris " + line + ") tapi TIDAK ADA satu pun idiom keluar-ETH "
        + "di file ini (call{value:}, payable(...).transfer/send, "
        + "selfdestruct, safeTransferETH, {value:}) — ETH yang masuk via "
        + kind + "() tidak punya jalan keluar di file ini.",
      preconditions: "Tidak ada jalur rescue ETH di kontrak/proxy lain "
        + "(mis. gateway WETH / admin rescue terpisah).",
      impact: severity + " — ETH yang terkirim "
        + (severity === "Low"
          ? "(masuk lewat alur normal protokol: IWETH.withdraw / refund ke address(this)) "
          : "(biasanya kesalahan transfer user) ")
        + "terkunci di kontrak; bukan fund-loss attacker.",
      severityGuess: severity,
      evidence: kind + "() external payable di baris " + line
        + " tanpa idiom keluar-ETH di file."
        + (severity === "Low" ? " Sinyal Low: IWETH.withdraw / refund=address(this)." : ""),
      toVerify: ["Cek apakah ada jalur keluar ETH di kontrak/proxy lain",
        "cek rescueTokens/rescue: apakah hanya ERC20",
        "bandingkan dengan upstream: apakah receive() ini tambahan fork",
        "PoC fork: kirim ETH lalu coba tarik keluar"],
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
        + "; penanda niat: " + (r.intentMarker ? "ya" : "tidak")
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
        + "; penanda niat: " + (r.intentMarker ? "ya" : "tidak")
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
    // `(vault)` dan `(vault, 1)` sama-sama terurai; rantai bersarang
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
          const note = " [project-pass: hipotesis abstract-internal diperiksa di korpus ini — tidak ada kontrak turunan yang membaca var]";
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
      reason: "dibaca lintas-file di " + first.file + " baris " + (first.line + 1)
        + " (" + first.kind + ") — bukan dead config",
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
  const perFile = [];
  let merged = [];
  for (const f of list) {
    const res = runPipeline(f.text, f.name, opts);
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
  const contractTypeNames = new Set(contractSpans(cleanSource)
    .filter((s) => s.kind === "contract" || s.kind === "interface")
    .map((s) => s.name));
  const structNames = structNamesOf(cleanSource);
  const ctx = {
    hasShareState: /\btotalShares\b/.test(cleanSource)
      || /\bmapping\s*\([^)]*\)\s*(public\s+)?shares\b/.test(cleanSource),
    comments: extractComments(source),
    commentBlocks: extractCommentBlocks(source),
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
  // Urutkan: High dulu, lalu urutan deteksi.
  const rank = { High: 0, Medium: 1, Low: 2, Info: 3 };
  const sorted = [...found].sort((a, b) =>
    (rank[a.severityGuess] - rank[b.severityGuess]));
  // Lapisan klasifikasi upstream-diff: menganotasi kandidat
  // commented-out-* dengan konteks baseline (bila opts.baseline tersedia).
  classifyUpstreamDiff(source, fileName, sorted, opts);
  // Info baseline untuk laporan (bila ada): jumlah file baseline yang
  // dipakai pass ini — UI menampilkannya di penutup laporan.
  const baselineInfo = (opts && opts.baseline)
    ? { files: typeof opts.baseline.get === "function"
        ? opts.baseline.size : Object.keys(opts.baseline).length }
    : null;
  return {
    candidates: sorted,
    baseline: baselineInfo,
    mappedAreas: [
      "reentrancy call-sebelum-update",
      "fungsi kritikal tanpa kontrol akses",
      "pembagian tanpa guard nol",
      "ecrecover tanpa cek address(0)",
      "tx.origin untuk otorisasi",
      "unchecked external call",
      "eksekutor arbitrary-call tanpa kontrol akses / permissionless-dispatcher (baru 17 Nov; Medium — kelas H3 Hyperbridge CallDispatcher.dispatch; kalibrasi R18.1: receiver terindeks, sink assembly, onlyGateway/if-revert; kalibrasi F10 18 Nov: one-hop forwarder external -> dispatcher internal, posisi argumen target/data; F10.1: data selector-pinned bukan aliran caller; R18.3: data kosong `new bytes(0)`/`abi.encode()` dikecualikan)",
      "sweep escrow memakai saldo penuh kontrak perantara / full-balance-sweep (baru 17 Nov; Low — kelas H3b Hyperbridge IntentGatewayV2.placeOrder; kalibrasi R19.1: posisi argumen paren-seimbang, assignment terakhir; R19.2: `ident.balance` polos bila ident address-typed)",
      "kirim ETH tanpa kontrol akses ke target pilihan caller / permissionless-value-send (baru 17 Nov; Medium — rekomendasi F8 review Kiro detektor 18/19)",
      "replay signature tanpa nonce/domain separator (baru 14 Nov)",
      "akuntansi share tak berkurang saat withdraw (baru 14 Nov)",
      "cek keamanan dikomentari / commented-out-check (baru 14 Nov)",
      "fungsi utuh dikomentari / commented-out-function (baru 14 Nov)",
      "upstream-diff: klasifikasi commented-out vs baseline fork (baru 14 Nov; aktif bila baseline tersedia)",
      "pergeseran semantik enum vs baseline / enum-semantic-shift (baru 14 Nov; aktif bila baseline tersedia)",
      "harga oracle tanpa cek staleness / oracle-passthrough (baru 14 Nov; klasifikasi by-design vs kandidat via baseline; kalibrasi review Kiro 15 Nov: getPriceUnsafe/getUnderlyingPrice/getRoundData, guard kurung/variabel-age, tanpa answeredInRound/isBorrowAllowed)",
      "free-memory pointer tanpa pembulatan 32 byte / free-mem-pointer (baru 14 Nov; Info saja — terkalibrasi PoC falsified; kalibrasi review Kiro 15 Nov: batas kata size/count, mload sebagai ukuran, mstore(64), lacak variabel let 1 langkah)",
      "receive()/fallback() payable tanpa jalur keluar ETH / eth-locked-receive (baru 15 Nov; Info, naik Low bila IWETH.withdraw/refund=address(this); kalibrasi review Kiro Opus 5.5 15 Nov: {value:} umum, cast bersarang, immutable/array, safeTransferETH, proxy delegatecall ditekan, deklarasi tanpa badan tidak ter-flag, path test/mock dilewati)",
      "cek identitas msg.sender yang vacuous di fungsi handler-only / vacuous-identity-check (baru 15 Nov; Medium — kelas FUL-REF-01 Fulcrom ReferralManager: onlyRole(HANDLER_ROLE) + `affiliate == msg.sender`)",
      "state config ditulis tapi tak pernah dibaca / dead-config-storage (baru 15 Nov; Low — kelas R-02 Fulcrom VaultPriceFeedV2: favorPrimaryPrice + spreadThresholdBasisPoints; klasifikasi upstream-diff: live-divergent bila upstream membaca var ini)",
    ],
    unmappedAreas: [
      "accounting mendalam di luar share-withdraw",
      "manipulasi harga oracle / TWAP di luar staleness",
      "review Kiro agent crew (jalur terpisah, bukan pipeline)",
      "Slither (dijalankan terpisah, hasil dinormalisasi via normalizeSlither)",
    ],
    topHypotheses: sorted.slice(0, 3),
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
    const fnName = (el.name) || "kontrak";
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
      preconditions: "Lihat laporan Slither lengkap untuk konteks.",
      impact: "Impact Slither: " + (d.impact || "?")
        + " · confidence: " + (d.confidence || "?"),
      severityGuess: d.impact === "High" ? "High"
        : d.impact === "Medium" ? "Medium" : "Low",
      evidence: (d.check || "") + " — "
        + ((el.source_mapping && el.source_mapping.lines) || []).join(","),
      toVerify: ["Baca finding Slither lengkap",
        "konfirmasi manual di source", "PoC fork bila relevan"],
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
    buildBaselineMap, runProjectPipeline, applyProjectPass, findCrossFileReads,
    findDispatcherSink, detectOneHopDispatcher, paramNamesOf,
  };
}
