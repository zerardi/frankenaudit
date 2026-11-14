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
    if (ch === '"') {
      // String literal: salin utuh (termasuk escape).
      out += ch; i++;
      while (i < n && source[i] !== '"') {
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

function hasAccessGuard(fn) {
  if (/\b(onlyOwner|onlyAdmin|onlyRole|requiresAuth|\bauth\b)\b/.test(fn.signature)) return true;
  if (/require\s*\(\s*msg\.sender\s*==/.test(fn.body)) return true;
  if (/require\s*\(\s*hasRole\s*\(/.test(fn.body)) return true;
  if (/msg\.sender\s*==\s*owner/.test(fn.body)) return true;
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
  const writeRe = new RegExp(
    "\\b(" + SENSITIVE_STATE.join("|") + ")\\s*=(?!=)"
    + "|\\bselfdestruct\\s*\\(|\\bsuicide\\s*\\(");
  if (!writeRe.test(fn.body)) return [];
  if (hasAccessGuard(fn)) return [];
  const m = fn.body.match(writeRe);
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
  const checkRe = /\brequire\s*\(|\bassert\s*\(|\bif\s*\([^)]*\)\s*\{?\s*revert\b|\brevert\s*\(/;
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
// Satu kandidat per nama fungsi per file (dedupe internal).
function detectCommentedOutFunction(fileName, idStart, ctx) {
  if (!ctx || !ctx.commentBlocks) return [];
  const out = [];
  const seen = new Set();
  let n = 0;
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
      out.push(normalizeCandidate({
        id: "FA-" + String(idStart + n).padStart(3, "0"),
        detector: "commented-out-function",
        title: "Fungsi utuh dikomentari (commented-out function)",
        location: { file: fileName, function: name },
        hypothesis: "Fungsi " + name + " dikomentari UTUH (blok komentar "
          + "baris " + (b.startLine + 1) + "–" + (b.endLine + 1) + ") — "
          + "fungsionalitas yang seharusnya ada justru tidak ada di "
          + "bytecode: tidak ada jalur yang bisa menjalankan logika ini.",
        preconditions: "Fungsi yang dikomentari memang load-bearing "
          + "(bukan fungsi mati / sudah diganti jalur lain yang aktif).",
        impact: "Kemampuan yang dimatikan tidak bisa dipakai: batas/izin/"
          + "pengaturan yang diatur fungsi ini tidak lagi bisa diubah.",
        severityGuess: "Medium",
        evidence: "Definisi fungsi " + name + " di dalam blok komentar "
          + "(baris " + (b.startLine + 1) + "–" + (b.endLine + 1) + "): "
          + b.text.replace(/\s+/g, " ").trim().slice(0, 140),
        toVerify: ["Baca blok komentar lengkap: fungsi apa yang dimatikan",
          "bandingkan dengan upstream / versi sebelumnya (git history / diff)",
          "cek apakah jalur pengganti masih aktif di tempat lain",
          "PoC fork: panggil jalur yang bergantung pada fungsi ini"],
        source: "pattern-scan",
      }));
      n++;
    }
  }
  return out;
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
  detectReplaySignature,
  detectShareAccounting,
  detectCommentedOutCheck,
];

function runPipeline(source, fileName) {
  // Detektor bekerja atas source tanpa komentar (nomor baris tetap sama).
  const cleanSource = stripComments(source);
  const fns = extractFunctions(cleanSource);
  const found = [];
  let n = 1;
  // Konteks level-kontrak untuk detektor yang butuh state di luar fungsi.
  const ctx = {
    hasShareState: /\btotalShares\b/.test(cleanSource)
      || /\bmapping\s*\([^)]*\)\s*(public\s+)?shares\b/.test(cleanSource),
    comments: extractComments(source),
    commentBlocks: extractCommentBlocks(source),
  };
  for (const fn of fns) {
    for (const det of DETECTORS) {
      const hits = det(fn, fileName, "FA-" + String(n).padStart(3, "0"), ctx);
      for (const h of hits) { found.push(h); n++; }
    }
  }
  // Detektor level-file: fungsi utuh yang dikomentari.
  const fileHits = detectCommentedOutFunction(
    fileName, n, ctx);
  for (const h of fileHits) { found.push(h); n++; }
  // Urutkan: High dulu, lalu urutan deteksi.
  const rank = { High: 0, Medium: 1, Low: 2 };
  const sorted = [...found].sort((a, b) =>
    (rank[a.severityGuess] - rank[b.severityGuess]));
  return {
    candidates: sorted,
    mappedAreas: [
      "reentrancy call-sebelum-update",
      "fungsi kritikal tanpa kontrol akses",
      "pembagian tanpa guard nol",
      "ecrecover tanpa cek address(0)",
      "tx.origin untuk otorisasi",
      "unchecked external call",
      "replay signature tanpa nonce/domain separator (baru 14 Nov)",
      "akuntansi share tak berkurang saat withdraw (baru 14 Nov)",
      "cek keamanan dikomentari / commented-out-check (baru 14 Nov)",
      "fungsi utuh dikomentari / commented-out-function (baru 14 Nov)",
    ],
    unmappedAreas: [
      "accounting mendalam di luar share-withdraw",
      "oracle / harga eksternal",
      "upstream-diff (perbandingan vs baseline fork)",
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
    extractCommentBlocks,
  };
}
