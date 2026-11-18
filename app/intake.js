// FrankenAudit — intake.js (M2.5: Intake & Gate)
// Tahap Intake & Gate di depan pipeline hunting: dari daftar program kandidat
// (publik, pasif, read-only) → skoring → vonis gerbang → routing ke antrean.
// Metodologi diadopsi dari SUPERAGENT v10 (references/v10/security/autonomy/):
// program-discovery.md (skema record + aturan pasif), program-qualifier.md
// (drop filter + skoring 0-100), authorization-gate.md (5 tes gerbang + matriks
// vonis + mode strict/auto/paused), memory-dedupe.md (dedupe per id + re-open
// bila policy berubah). HANYA metodologi yang diadopsi — modul ini NATIVE,
// tidak ada kode Python engine v10 yang ditempel/dipakai.
// Batas: discovery PASIF atas halaman publik program; tidak ada kontak ke
// target, tidak ada submit apa pun. Vonis KONFIRMASI = berhenti, JANGAN
// hunting target itu; sesi TIDAK PERNAH meng-override vonis ini.
// Vonis TOLAK = blacklist (tidak di-antre ulang kecuali policy berubah).

// ---------------------------------------------------------------------------
// Skema record program (program-discovery.md) + input qualifier/gate
// ---------------------------------------------------------------------------
// {
//   id: "hackenproof:cronos-zkevm",      // platform:slug — kunci dedupe
//   name, platform, source,              // source: directory|security.txt|vdp-index|web-search
//   policy_url, invites_testing,         // true | false | "unknown"
//   pays_bounty,                         // true | false | "unknown"
//   scope_assets: [...],                 // aset in-scope (boleh grup, mis. "Amply (26)")
//   scopeAssetCount,                     // opsional: jumlah aset bila scope_assets grup
//   out_of_scope: [...], excluded_tests: [...],
//   freshness: "2026-11-16",             // tanggal terakhir terverifikasi (ISO)
//   deadline: "2026-12-09",              // opsional: batas kontes/program
//   status: "candidate",                 // candidate|qualified|authorized|exhausted|blacklisted
//   rewardMaxUsd, responseHealth,        // 0..1 — kesehatan respons/triase
//   competition: "low"|"medium"|"high"|"unknown",
//   surfaceFit,                          // 0..1 — cocok dgn detektor kita
//   assetNovelty,                        // 0..1
//   reputationGate, submitFeeUsd, kycRequired,
//   automatedTestingAllowed,             // true | false | "unknown"
//   loginToSeePolicy, privateOrInviteOnly, doNotTest,
//   securityTxt, securityTxtOnly,        // security.txt ada tapi tanpa undangan eksplisit
//   policyHash,                          // hash teks policy — re-open bila berubah
//   surfaces: ["evm-solidity", ...],     // tag routing
//   queue, baseline,                     // routing: nama antrean + baseline upstream
// }

// Teknik yang dipakai agen ini (untuk drop filter excluded-tests).
const AGENT_TECHNIQUES = [
  "automated scanning",
  "static analysis",
  "fork testing",
  "fuzzing",
];
// Frasa yang berarti "semua pengujian dilarang".
const BLANKET_EXCLUSIONS = [
  "all testing",
  "any testing",
  "all automated testing",
  "no testing",
];

// Bobot skoring (program-qualifier.md).
const SCORE_WEIGHTS = {
  scope: 25, payout: 20, freshness: 15, fit: 15,
  competition: 10, response: 10, novelty: 5,
};

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normProgram(raw) {
  const p = Object.assign({}, raw || {});
  p.scope_assets = Array.isArray(p.scope_assets) ? p.scope_assets : [];
  p.out_of_scope = Array.isArray(p.out_of_scope) ? p.out_of_scope : [];
  p.excluded_tests = Array.isArray(p.excluded_tests) ? p.excluded_tests : [];
  p.surfaces = Array.isArray(p.surfaces) ? p.surfaces : [];
  if (p.invites_testing !== true && p.invites_testing !== false) p.invites_testing = "unknown";
  if (p.pays_bounty !== true && p.pays_bounty !== false) p.pays_bounty = "unknown";
  if (p.automatedTestingAllowed !== true && p.automatedTestingAllowed !== false) {
    p.automatedTestingAllowed = "unknown";
  }
  if (!p.status) p.status = "candidate";
  return p;
}

// ---------------------------------------------------------------------------
// Drop filter (program-qualifier.md): satu gagal = drop, BUKAN blacklist.
// ---------------------------------------------------------------------------
// Jumlah scope kanonik (kalibrasi R1, review Kiro P1): SATU sumber yang
// dipakai skoring, drop filter, DAN gate. Sebelumnya scopeSubScore memakai
// scopeAssetCount sementara gateTests.scopeExplicit hanya menghitung
// scope_assets.length — program valid yang discovery-nya hanya mengisi
// scopeAssetCount tertolak (TOLAK + dropped) padahal skor scope-nya 1,0.
function scopeCount(p) {
  if (typeof p.scopeAssetCount === "number" && p.scopeAssetCount > 0) {
    return p.scopeAssetCount;
  }
  return p.scope_assets.length;
}

// Frasa larangan menyeluruh (kalibrasi R1, review Kiro P3): pencocokan
// substring lama terlalu luas — "casino testing" mengandung "no testing",
// "install testing" mengandung "all testing", "no testing on prod"
// mengandung "no testing". Frasa blanket hanya dihitung bila entrinya
// memang larangan menyeluruh (persis, atau diawali frasa + tanpa qualifier
// scope seperti "on prod" / "in staging").
function isBlanketBan(s) {
  for (const b of BLANKET_EXCLUSIONS) {
    if (s === b) return true;
    if (s.startsWith(b + " ") || s.startsWith(b + ":") || s.startsWith(b + " —")) {
      const rest = s.slice(b.length).trim();
      if (/^(on|in|against|of|for|during|within)\b/.test(rest)) return false;
      return true; // "all testing is prohibited" = blanket
    }
  }
  return false;
}

function blanketExcluded(p) {
  const ex = p.excluded_tests.map((s) => String(s).toLowerCase().trim());
  if (ex.some((s) => isBlanketBan(s))) return true;
  // Semua teknik agen dilarang = praktis melarang semua yang kita lakukan.
  return AGENT_TECHNIQUES.every((t) =>
    ex.some((s) => s.includes(t)));
}

function qualifierDropReasons(p, now) {
  const reasons = [];
  if (p.invites_testing === false) {
    reasons.push("tidak ada undangan pengujian publik");
  }
  if (scopeCount(p) === 0 && !p.securityTxt) {
    reasons.push("scope kosong/tak terurai & tanpa security.txt");
  }
  if (p.automatedTestingAllowed === false) {
    reasons.push("RoE melarang pengujian otomatis/agentic");
  }
  if (p.status === "exhausted" || p.status === "blacklisted") {
    reasons.push("sudah " + p.status + " di memori");
  }
  if (blanketExcluded(p)) {
    reasons.push("excluded-tests melarang semua teknik agen");
  }
  if (p.deadline) {
    const d = new Date(p.deadline + "T00:00:00Z");
    const ref = now instanceof Date ? now : new Date(now || Date.now());
    if (!Number.isNaN(d.getTime()) && d.getTime() < ref.getTime()) {
      reasons.push("deadline " + p.deadline + " sudah lewat");
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Skoring 0-100 (program-qualifier.md). Tiap sub-skor 0..1 x bobot.
// `now` bisa di-inject (string ISO / Date) supaya tes deterministik.
// ---------------------------------------------------------------------------
function scopeSubScore(p) {
  const n = scopeCount(p);
  if (n <= 0) return 0;
  if (n <= 2) return 0.4;
  if (n <= 9) return 0.7;
  return 1.0;
}

function payoutSubScore(p) {
  if (p.pays_bounty === false) return 0;
  const m = p.rewardMaxUsd;
  if (typeof m !== "number" || !Number.isFinite(m)) return 0.3; // reward ada, nilai tak diketahui
  if (m <= 0) return 0;
  if (m < 100) return 0.2;
  if (m < 1000) return 0.4;
  if (m < 10000) return 0.6;
  if (m < 100000) return 0.8;
  return 1.0;
}

function freshnessSubScore(p, now) {
  if (!p.freshness) return 0.2;
  const d = new Date(p.freshness + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return 0.2;
  const ref = now instanceof Date ? now : new Date(now || Date.now());
  const days = (ref.getTime() - d.getTime()) / 86400000;
  // Kalibrasi R1 (review Kiro P7): tanggal di masa depan (clock skew / data
  // salah) TIDAK boleh dapat kredit penuh — perlakukan seperti tak terverifikasi.
  if (days < 0) return 0.2;
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.5;
  if (days <= 180) return 0.3;
  return 0.1;
}

function competitionSubScore(p) {
  if (p.competition === "low") return 1.0;
  if (p.competition === "medium") return 0.6;
  if (p.competition === "high") return 0.2;
  return 0.5; // unknown
}

function scoreProgram(raw, now) {
  const p = normProgram(raw);
  const dropped = qualifierDropReasons(p, now);
  const breakdown = {
    scope: scopeSubScore(p),
    payout: payoutSubScore(p),
    freshness: freshnessSubScore(p, now),
    fit: clamp01(p.surfaceFit),
    competition: competitionSubScore(p),
    response: clamp01(p.responseHealth),
    novelty: clamp01(p.assetNovelty),
  };
  let total = 0;
  for (const k of Object.keys(SCORE_WEIGHTS)) total += SCORE_WEIGHTS[k] * breakdown[k];
  // Pembulatan half-up (review Kiro P10, didokumentasikan — bukan bug):
  // 86,25 → Math.round(862,5) = 863 → 86,3. Ranking/threshold di x,x5
  // membulat ke atas; disepakati apa adanya.
  const score = Math.round(total * 10) / 10;
  // Kalibrasi R1 (review Kiro P5): field yang tidak terverifikasi memakai
  // default NETRAL (fit/kompetisi/respons/novelty 0,5; payout 0,3;
  // freshness 0,2) — skor program miskin-data adalah BATAS ATAS, bukan
  // bukti kualitas. Daftar field-nya diekspos supaya UI/laporan jujur.
  const unknownFields = [];
  if (p.surfaceFit === undefined) unknownFields.push("fit");
  if (p.competition === "unknown" || p.competition === undefined) unknownFields.push("kompetisi");
  if (p.responseHealth === undefined) unknownFields.push("respons");
  if (p.assetNovelty === undefined) unknownFields.push("novelty");
  if (!p.freshness) unknownFields.push("freshness");
  if (typeof p.rewardMaxUsd !== "number" || !Number.isFinite(p.rewardMaxUsd)) {
    unknownFields.push("payout");
  }
  const reasons = [];
  if (scopeCount(p) >= 10) {
    reasons.push("scope jelas & luas (" + scopeCount(p) + " aset)");
  }
  if (typeof p.rewardMaxUsd === "number" && p.rewardMaxUsd >= 100000) {
    reasons.push("reward maks ≥ $100 rb");
  }
  if (breakdown.freshness >= 0.8) reasons.push("baru terverifikasi (≤30 hari)");
  if (breakdown.competition <= 0.2) reasons.push("kompetisi tinggi — skor ditekan");
  if (p.deadline) reasons.push("deadline " + p.deadline);
  return { program: p, score, breakdown, dropped, reasons, unknownFields };
}

// ---------------------------------------------------------------------------
// Authorization Gate (authorization-gate.md): 5 tes, vonis LAYAK /
// KONFIRMASI / TOLAK. Mode: "strict" (default v10 — semua field butuh
// konfirmasi manusia), "auto" (publik-jelas lolos otomatis), "paused"
// (discovery/qualify jalan, tanpa pengujian sama sekali).
// ---------------------------------------------------------------------------
function gateTests(p) {
  // Kalibrasi R1 (review Kiro P2): scope kosong + security.txt ada =
  // "unknown", BUKAN false — scope belum terurai, bukan pelanggaran.
  // Sebelumnya false → gate langsung TOLAK → program masuk blacklist,
  // bertentangan dengan metodologi (scope belum terverifikasi ≠ blacklist).
  const scopeExplicit = scopeCount(p) > 0
    ? true : (p.securityTxt ? "unknown" : false);
  return {
    // 1. Undangan publik ada (halaman program / VDP / security.txt).
    publicInvitation: p.invites_testing === true
      ? true : (p.invites_testing === "unknown" ? "unknown" : false),
    // 2. Scope eksplisit & aset yang dituju tercakup.
    scopeExplicit,
    // 3. Tidak dikecualikan (aset/teknik tidak di out-of-scope / excluded).
    notExcluded: !blanketExcluded(p),
    // 4. Pengujian agentic/otomatis diizinkan RoE.
    agenticAllowed: p.automatedTestingAllowed === true
      ? true : (p.automatedTestingAllowed === "unknown" ? "unknown" : false),
    // 5. Tidak ada sinyal bertentangan (do-not-test, privat, login wall).
    noConflictingSignal: !(p.privateOrInviteOnly || p.loginToSeePolicy || p.doNotTest),
  };
}

function gateProgram(raw, mode) {
  const p = normProgram(raw);
  const m = mode || "strict";
  const tests = gateTests(p);
  const reasons = [];
  const fails = Object.keys(tests).filter((k) => tests[k] === false);
  const unknowns = Object.keys(tests).filter((k) => tests[k] === "unknown");
  const ambiguous = unknowns.length > 0 || p.securityTxtOnly === true
    || scopeCount(p) === 0;

  if (tests.publicInvitation === false) reasons.push("tidak ada undangan pengujian publik");
  if (tests.scopeExplicit === false) reasons.push("scope tidak eksplisit / kosong");
  if (tests.notExcluded === false) reasons.push("aset/teknik dikecualikan RoE");
  if (tests.agenticAllowed === false) reasons.push("RoE melarang pengujian otomatis/agentic");
  if (tests.noConflictingSignal === false) {
    reasons.push("sinyal bertentangan (privat/invite-only/login wall/do-not-test)");
  }
  if (fails.length > 0) {
    return { program: p, verdict: "TOLAK", mode: m, tests, reasons };
  }
  // Kalibrasi R1 (review Kiro P8): mode paused menelan vonis keras —
  // sebelumnya KONFIRMASI bahkan untuk doNotTest/invites=false, jadi program
  // terlarang tak pernah masuk blacklist selama paused. Kini: fail keras
  // tetap TOLAK (ditangani di atas); paused hanya mengonfirmasi sisanya.
  if (m === "paused") {
    return { program: p, verdict: "KONFIRMASI", mode: m, tests,
      reasons: ["gate mode paused — discovery/qualify jalan, tanpa pengujian"] };
  }
  // security.txt ada tapi tanpa undangan eksplisit → human-confirm (matriks v10).
  if (p.securityTxtOnly === true && p.invites_testing !== true) {
    reasons.push("security.txt ada tapi tanpa undangan pengujian eksplisit");
    return { program: p, verdict: "KONFIRMASI", mode: m, tests, reasons };
  }
  if (ambiguous) {
    if (unknowns.includes("publicInvitation")) reasons.push("undangan pengujian belum terbukti");
    if (unknowns.includes("agenticAllowed")) reasons.push("izin pengujian agentic belum terbukti");
    // Kalibrasi R1 (review Kiro P9): alasan ini dulu kode mati — scope kosong
    // selalu TOLAK lebih dulu. Sesudah P2 (scope kosong + securityTxt =
    // "unknown") jalur ini tercapai.
    if (scopeCount(p) === 0) reasons.push("scope belum terurai");
    if (p.securityTxtOnly === true) reasons.push("hanya security.txt, tanpa undangan eksplisit");
    return { program: p, verdict: "KONFIRMASI", mode: m, tests, reasons };
  }
  if (m === "strict") {
    reasons.push("mode strict — setiap field butuh konfirmasi manusia");
    return { program: p, verdict: "KONFIRMASI", mode: m, tests, reasons };
  }
  reasons.push("publik-jelas: undangan + scope + RoE terverifikasi");
  return { program: p, verdict: "LAYAK", mode: m, tests, reasons };
}

// ---------------------------------------------------------------------------
// Routing: permukaan → detektor + antrean hunting yang sudah ada.
// ---------------------------------------------------------------------------
const SURFACE_ROUTES = {
  "evm-solidity": {
    detectors: "all-17",
    note: "pattern-scan 17 detektor + Slither cross-check",
  },
  "defi-lending": {
    detectors: ["oracle-passthrough-no-staleness", "commented-out-check",
      "commented-out-function", "enum-semantic-shift", "missing-access-control",
      "dead-config-storage"],
    note: "fokus oracle / access-control / config mati",
  },
  "defi-perps": {
    detectors: ["vacuous-identity-check", "dead-config-storage", "share-accounting",
      "missing-access-control", "division-no-guard"],
    note: "fokus likuidasi / accounting / referral",
  },
  "bridge": {
    detectors: ["eth-locked-receive", "tx-origin", "missing-access-control",
      "free-mem-pointer-no-rounding"],
    note: "fokus ETH terkunci / identitas pemanggil",
  },
  "contest": {
    detectors: "all-17",
    note: "kontes timed — prioritas Critical, dedupe vs audit terlampir",
  },
};

function routeProgram(raw) {
  const p = normProgram(raw);
  const detectors = [];
  const notes = [];
  let sawAll = false;
  for (const s of p.surfaces) {
    const r = SURFACE_ROUTES[s];
    if (!r) continue;
    if (r.detectors === "all-17") sawAll = true;
    else for (const d of r.detectors) if (!detectors.includes(d)) detectors.push(d);
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
  }
  return {
    queue: p.queue || ("intake:" + (p.id || "unknown")),
    detectors: sawAll ? "all-17" : detectors,
    baseline: p.baseline || null,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Dedupe (memory-dedupe.md): per id; re-open bila policyHash berubah;
// blacklist tidak pernah di-antre ulang. Memori HANYA memengaruhi
// prioritas, TIDAK PERNAH otorisasi — field yang diingat "bagus" tetap
// melewati gate tiap siklus.
// ---------------------------------------------------------------------------
function dedupePrograms(existing, candidates) {
  const known = {};
  for (const e of existing || []) {
    if (e && e.id) known[e.id] = e;
  }
  const added = [], reopened = [], skipped = [];
  for (const raw of candidates || []) {
    const p = normProgram(raw);
    const prev = known[p.id];
    if (!prev) { added.push(p); continue; }
    // Kalibrasi R1 (review Kiro P4): bandingkan policyHash DULU — sebelumnya
    // cek blacklist didahulukan, jadi program blacklisted yang policy-nya
    // berubah ter-skip selamanya, bertentangan dengan komentar modul
    // ("tidak di-antre ulang kecuali policy berubah").
    if (p.policyHash && prev.policyHash && p.policyHash !== prev.policyHash) {
      reopened.push({ program: p, prev,
        wasBlacklisted: prev.status === "blacklisted" });
      continue;
    }
    if (prev.status === "blacklisted") { skipped.push({ program: p, why: "blacklisted" }); continue; }
    skipped.push({ program: p, why: "sudah ada (policy tak berubah)" });
  }
  return { added, reopened, skipped };
}

// ---------------------------------------------------------------------------
// Intake run: dedupe → skor → gate → routing. Urut skor menurun;
// seri → scope lebih jelas dulu (lebih aman, bukan payout lebih besar).
// ---------------------------------------------------------------------------
function intakeRun(programs, existing, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const mode = o.mode || "strict";
  const dedup = dedupePrograms(existing, programs);
  const todo = dedup.added.concat(dedup.reopened.map((r) => r.program));
  const results = [];
  for (const raw of todo) {
    const scored = scoreProgram(raw, now);
    const gated = gateProgram(raw, mode);
    const routed = routeProgram(raw);
    const notes = [];
    if (typeof scored.program.reputationGate === "number" && scored.program.reputationGate > 0) {
      notes.push("gerbang reputasi ≥" + scored.program.reputationGate
        + " (bukan tes gerbang legal — antrean PARKED sampai reputasi lolos)");
    }
    if (typeof scored.program.submitFeeUsd === "number" && scored.program.submitFeeUsd > 0) {
      notes.push("fee submit $" + scored.program.submitFeeUsd);
    }
    if (scored.program.kycRequired) notes.push("KYC wajib");
    results.push({
      id: scored.program.id,
      name: scored.program.name,
      // Kalibrasi R1 (review Kiro P11): skor entri dropped = null — angka
      // penuh untuk program yang tidak akan diuji menyesatkan bila dibaca
      // sebagai kandidat. Aritmetika mentahnya tetap terkunci di tes
      // scoreProgram (Kiln 60,8 / Tokenize.it 34,0 / VeChain 34,0).
      score: scored.dropped.length > 0 ? null : scored.score,
      breakdown: scored.breakdown,
      scoreReasons: scored.reasons,
      unknownFields: scored.unknownFields,
      dropped: scored.dropped,
      gate: { verdict: gated.verdict, mode: gated.mode, reasons: gated.reasons },
      route: routed,
      notes,
    });
  }
  // Tie-break: skor sama → scope sub-skor lebih tinggi dulu.
  // Skor null (dropped) diperlakukan sebagai -1 — selalu di bawah.
  results.sort((a, b) => ((b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score))
    || (b.breakdown.scope - a.breakdown.scope));
  // Drop di qualifier ≠ FAIL gerbang: kandidat yang scope-nya belum
  // terverifikasi (Kiln, Tokenize.it, VeChain) TIDAK masuk blacklist —
  // mereka tetap kandidat untuk verifikasi ulang, bukan target terlarang.
  const droppedList = results.filter((r) => r.dropped.length > 0);
  const ranked = results.filter((r) => r.dropped.length === 0
    && r.gate.verdict !== "TOLAK");
  const blacklisted = results.filter((r) => r.dropped.length === 0
    && r.gate.verdict === "TOLAK");
  return { results, ranked, dropped: droppedList, blacklisted,
    dedupe: { added: dedup.added.map((p) => p.id),
      reopened: dedup.reopened.map((r) => r.program.id),
      skipped: dedup.skipped.map((s) => s.program.id) } };
}

// ---------------------------------------------------------------------------
// Daftar target yang sudah dikenal (TARGETS.md + bb-log.md, per 17 Nov 2026).
// Versi minimal M2.5: skoring + vonis atas daftar ini, TANPA discovery
// internet terbuka. `freshness` = tanggal terakhir terverifikasi.
// ---------------------------------------------------------------------------
function knownPrograms() {
  return [
    {
      id: "hackenproof:cronos-zkevm",
      name: "Cronos zkEVM Smart Contracts",
      platform: "HackenProof",
      source: "directory",
      policy_url: "https://hackenproof.com/programs/cronos-zkevm",
      invites_testing: true, pays_bounty: true,
      scope_assets: ["Amply (26)", "Fulcrom (±40)", "H2 (±22)", "Veno (±15)"],
      scopeAssetCount: 103,
      out_of_scope: ["rounding errors", "DoS", "zero-share pools",
        "issue yang sudah ada di audit", "vuln yang sudah dikenal di Ethereum/fork lain",
        "testing mainnet/testnet publik"],
      excluded_tests: ["mainnet testing", "public testnet testing"],
      freshness: "2026-11-16",
      status: "candidate",
      rewardMaxUsd: 50000, responseHealth: 0.6, competition: "medium",
      surfaceFit: 0.9, assetNovelty: 0.5,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: true,
      automatedTestingAllowed: true, // fork lokal / private testnet saja — metode kita
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "cronos-scope-2026-11-16",
      surfaces: ["evm-solidity", "defi-lending", "defi-perps"],
      queue: "cronos-zkevm",
      baseline: "GMX v1 @ fe55c4ba / Aave v3 v1.19.4",
    },
    {
      id: "hackenproof:nado",
      name: "Nado Smart Contracts",
      platform: "HackenProof",
      source: "directory",
      policy_url: "https://hackenproof.com/programs/nado",
      invites_testing: true, pays_bounty: true,
      scope_assets: ["Clearinghouse", "PerpEngine", "SpotEngine",
        "RiskHelper", "Verifier/Endpoint", "MatchOrdersV2Helper"],
      out_of_scope: [],
      excluded_tests: [],
      freshness: "2026-11-12",
      status: "candidate",
      rewardMaxUsd: 500000, responseHealth: 0.7, competition: "high",
      surfaceFit: 0.9, assetNovelty: 0.6,
      reputationGate: 100, submitFeeUsd: 0, kycRequired: true,
      automatedTestingAllowed: "unknown", // belum terverifikasi di halaman program
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "nado-scope-2026-11-12",
      surfaces: ["evm-solidity", "defi-perps"],
      queue: "nado-parked",
      baseline: null,
    },
    {
      id: "guardian:raac",
      name: "RAAC Core Contracts Bounty Contest",
      platform: "Guardian Defender",
      source: "directory",
      policy_url: "https://defender.guardianaudits.com/contests/01a1a379-b7c1-72d9-8075-5318b386f2e4",
      invites_testing: true, pays_bounty: true,
      scope_assets: ["LendingPool", "StabilityPool", "LendingPoolStorage",
        "StabilityPoolStorage", "LiquidationProxy", "LiquidationStrategyProxy",
        "oracle/*", "token/*", "math/*", "StringUtils"],
      scopeAssetCount: 20,
      out_of_scope: ["temuan yang tercakup audit Guardian 3 Nov 2026"],
      excluded_tests: [],
      freshness: "2026-11-13",
      deadline: "2026-12-09",
      status: "candidate",
      rewardMaxUsd: 100000, // pool musiman dibagi rata antar Critical valid
      responseHealth: 0.5, competition: "medium",
      surfaceFit: 0.85, assetNovelty: 0.5,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
      automatedTestingAllowed: true, // kontes audit — PoC fork lokal
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "raac-contest-2026-11-13",
      surfaces: ["evm-solidity", "defi-lending", "contest"],
      queue: "raac-contest",
      baseline: null,
    },
    {
      id: "cantina:kiln-v2",
      name: "Kiln V2",
      platform: "Cantina",
      source: "directory",
      policy_url: "https://kiln.fi/bug-bounties",
      invites_testing: "unknown", pays_bounty: true,
      scope_assets: [], // scope/repo/commit BELUM terverifikasi (halaman JS-rendered)
      out_of_scope: [], excluded_tests: [],
      freshness: "2026-11-16",
      status: "candidate",
      rewardMaxUsd: 500000, responseHealth: 0.5, competition: "unknown",
      surfaceFit: 0.85, assetNovelty: 0.6,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
      automatedTestingAllowed: "unknown",
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "kiln-v2-2026-11-16",
      surfaces: ["evm-solidity"],
      queue: "kiln-v2",
      baseline: null,
    },
    {
      id: "hackenproof:tokenize-it",
      name: "Tokenize.it Token SC DualDefense Audit",
      platform: "HackenProof",
      source: "directory",
      policy_url: "https://hackenproof.com/programs/tokenize-it",
      invites_testing: "unknown", pays_bounty: "unknown",
      scope_assets: [], // status/deadline/pool BELUM terverifikasi
      out_of_scope: [], excluded_tests: [],
      freshness: null,
      status: "candidate",
      rewardMaxUsd: null, responseHealth: 0.5, competition: "unknown",
      surfaceFit: 0.8, assetNovelty: 0.6,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
      automatedTestingAllowed: "unknown",
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "tokenize-it-2026-11-16",
      surfaces: ["evm-solidity"],
      queue: "tokenize-it",
      baseline: null,
    },
    {
      id: "hackenproof:vechain-stargate",
      name: "VeChain Stargate SC DualDefense Audit RND 2",
      platform: "HackenProof",
      source: "directory",
      policy_url: "https://hackenproof.com/programs/vechain-stargate",
      invites_testing: "unknown", pays_bounty: "unknown",
      scope_assets: [], // status/deadline/pool BELUM terverifikasi
      out_of_scope: [], excluded_tests: [],
      freshness: null,
      status: "candidate",
      rewardMaxUsd: null, responseHealth: 0.5, competition: "unknown",
      surfaceFit: 0.8, assetNovelty: 0.6,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
      automatedTestingAllowed: "unknown",
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: false, securityTxtOnly: false,
      policyHash: "vechain-stargate-2026-11-16",
      surfaces: ["evm-solidity"],
      queue: "vechain-stargate",
      baseline: null,
    },
    {
      id: "selfhosted:aktionariat",
      name: "Aktionariat (SECURITY.md)",
      platform: "Self-hosted",
      source: "security.txt",
      policy_url: "https://github.com/aktionariat/contracts/blob/master/SECURITY.md",
      invites_testing: true, pays_bounty: true,
      scope_assets: ["Shares v6", "SecondaryMarket v3", "DirectInvestment v11",
        "PaymentHub v14", "MultiSigWallet v11", "AktionariatFactory v1"],
      out_of_scope: ["not-a-bug list (review 2026)"],
      excluded_tests: [],
      freshness: null, // tanggal pencatatan tidak ada di TARGETS.md
      status: "candidate",
      rewardMaxUsd: null, // High 3 ETH / Medium 1 ETH — nilai USD belum dihitung
      responseHealth: 0.5, competition: "low",
      surfaceFit: 0.8, assetNovelty: 0.7,
      reputationGate: 0, submitFeeUsd: 0, kycRequired: false,
      automatedTestingAllowed: "unknown", // SECURITY.md tidak menyebut eksplisit
      loginToSeePolicy: false, privateOrInviteOnly: false, doNotTest: false,
      securityTxt: true, securityTxtOnly: false,
      policyHash: "aktionariat-security-md",
      surfaces: ["evm-solidity"],
      queue: "aktionariat-noted",
      baseline: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Render kartu intake (dipakai UI app + tes Node).
// ---------------------------------------------------------------------------
function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function verdictClass(v) {
  if (v === "LAYAK") return "verdict-layak";
  if (v === "KONFIRMASI") return "verdict-konfirmasi";
  return "verdict-tolak";
}

function renderIntakeCard(r) {
  const b = r.breakdown;
  const rows = [
    ["Scope", SCORE_WEIGHTS.scope, b.scope],
    ["Payout", SCORE_WEIGHTS.payout, b.payout],
    ["Freshness", SCORE_WEIGHTS.freshness, b.freshness],
    ["Attack-surface fit", SCORE_WEIGHTS.fit, b.fit],
    ["Kompetisi rendah", SCORE_WEIGHTS.competition, b.competition],
    ["Respons", SCORE_WEIGHTS.response, b.response],
    ["Novelty", SCORE_WEIGHTS.novelty, b.novelty],
  ].map(([label, w, sub]) =>
    `<tr><td>${escHtml(label)}</td><td>${w}</td><td>${sub.toFixed(2)}</td>`
    + `<td>${(w * sub).toFixed(1)}</td></tr>`).join("");
  const dropped = r.dropped.length
    ? `<p><strong>Drop (qualifier):</strong> ${r.dropped.map(escHtml).join("; ")}</p>` : "";
  const unknown = (r.unknownFields && r.unknownFields.length)
    ? `<p><strong>Field belum terverifikasi:</strong> ${r.unknownFields.map(escHtml).join(", ")} — skor memakai default netral, angka ini batas atas.</p>` : "";
  const scoreLine = r.score === null || r.score === undefined
    ? `<strong>Skor:</strong> — (drop — bukan kandidat)`
    : `<strong>Skor:</strong> ${r.score} / 100`;
  const gateReasons = r.gate.reasons.length
    ? `<ul>${r.gate.reasons.map((x) => `<li>${escHtml(x)}</li>`).join("")}</ul>` : "";
  const detectors = Array.isArray(r.route.detectors)
    ? r.route.detectors.join(", ") : r.route.detectors;
  const notes = r.notes.length
    ? `<p><strong>Catatan:</strong> ${r.notes.map(escHtml).join("; ")}</p>` : "";
  return `<article class="intake-card">\n`
    + `  <h3>${escHtml(r.name)}</h3>\n`
    + `  <p>${scoreLine}`
    + ` · <span class="${verdictClass(r.gate.verdict)}"><strong>${escHtml(r.gate.verdict)}</strong></span>`
    + ` (mode ${escHtml(r.gate.mode)})</p>\n`
    + `  <table class="intake-score"><tr><th>Sinyal</th><th>Bobot</th><th>Sub</th><th>Poin</th></tr>${rows}</table>\n`
    + `  ${dropped}\n`
    + `  ${unknown}\n`
    + `  <p><strong>Alasan gate:</strong></p>${gateReasons}\n`
    + `  <p><strong>Routing:</strong> antrean ${escHtml(r.route.queue)}`
    + ` · detektor ${escHtml(detectors)}`
    + (r.route.baseline ? ` · baseline ${escHtml(r.route.baseline)}` : "") + `</p>\n`
    + `  ${notes}\n`
    + `</article>`;
}

function renderIntakeReport(run) {
  const cards = run.results.map(renderIntakeCard).join("\n");
  const summary = `<p><strong>Intake:</strong> ${run.ranked.length} lolos ke antrean, `
    + `${run.dropped.length} drop di qualifier (scope belum terverifikasi — bukan blacklist), `
    + `${run.blacklisted.length} blacklist, dedupe: ${run.dedupe.added.length} baru, `
    + `${run.dedupe.reopened.length} re-open, ${run.dedupe.skipped.length} lewati.</p>`
    + `<p class="disclaimer">Vonis KONFIRMASI = berhenti, JANGAN hunting target itu `
    + `sampai manusia mengonfirmasi. TOLAK = blacklist.</p>`;
  return summary + "\n" + cards;
}

// Export Node (untuk test runner); di browser, fungsi tetap global.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normProgram, qualifierDropReasons, blanketExcluded, isBlanketBan, scopeCount,
    scoreProgram, gateProgram, gateTests, routeProgram,
    dedupePrograms, intakeRun, knownPrograms,
    renderIntakeCard, renderIntakeReport, SCORE_WEIGHTS,
  };
}
