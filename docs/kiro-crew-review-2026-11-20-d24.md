# Kiro crew review of detector 24 + referee calibration R24

Date: 2026-11-20 (Frankenstein session #42, 12:38 WIB).
Detector: `variant-branch-no-payload-consume` (class L-1 Hyperbridge
Codec.DecodeHeader — Info/design, NOT a submission candidate).
Kiro pass: NEW session 40d58610-080d-44ca-86cf-44abc0f0df6f,
model Claude Opus 5.5 explicitly set — with NO refusal, with NO
MODEL_TIDAK_SESUAI flag. Session footer 3.52 credits (est., not yet posted at
check time); dashboard 348.11/4,000 before the pass. Google SSO login with no
obstacles (browser task 8f507e02, 12:57–13:05 WIB, 3m 36s).

## Kiro's verdict: NEEDS WORK (F1–F23)

Kiro's method: the detector was run in Node with helpers that were
re-implemented from descriptions (stripComments, extractFunctions,
d24ParseIfChain, d24ParenEnd, blockEndIndex) — NOT the project's original code,
so some verdicts may be re-implementation artifacts. Results per
case: 36 cases, 9 correct / 15 FP / 11 FN / 1 ambiguous.

## Referee verification (probes against the REAL code, /tmp/probe-d24-r24.js)

Pre-calibration: 16 of 20 probes DIFFERED from the referee's expectation — Kiro's claims
were mostly reproduced in the original code. Post-calibration R24:
**20/20 PASS**; suite **796 → 823/823** (Section 58b, 27 new tests —
F1–F23 locked in as regressions, including the constant-name forms F13/F14 which
in the probes were only numeric literals).

### ACCEPTED + FIXED (R24)

- **F1 (cast in tag-read)** — TERBUKTI. `uint8(readByte(slice))`
  made the cursor read as `readByte`, not `slice` (FN). Fix:
  innermost-call rule — skip a call whose first argument is
  itself a call; take the last plain identifier argument.
- **F1b (nested member call)** — TERBUKTI (same form, already OK in
  v1, locked in by test 58b-2). `uint8(slice.data[slice.offset])` → cursor
  `slice` via the index rule.
- **F2 (index cursor)** — TERBUKTI. `uint8(enc[offset])` made
  the cursor `enc`, not `offset` (FN). Fix: index rule —
  `X[plainIdent]` → the identifier inside the brackets is the cursor.
- **F11 (sibling of F2, index cursor in a consumption branch)** — TERBUKTI.
  Fixed by the same index rule (F2/F11).
- **F3 (cast in condition)** — TERBUKTI. `uint8(kind) == 0` was not
  recognized as tag `kind` (FN). Fix: the tag var now comes from
  the intersection of identifiers across ALL chain conditions (minus type names), not
  a `TAG ==` regex in the first condition.
- **F4 (Yoda)** — TERBUKTI. `OTHER == kind` was not recognized (FN).
  Fixed by the same identifier intersection.
- **F5 (state-based, no-arg)** — TERBUKTI. `readByte()` /
  `decodeItem()` with no arguments made the cursor null → v1 rejected
  the whole chain (FN). Fix: null cursor = state-based mode —
  consumption is judged from the verb alone (any decode*/read*
  call except `abi.*`).
- **F6 (assembly)** — TERBUKTI. An `assembly` block that advances
  the offset was counted as non-consumption (FP). Fix: an `assembly` block
  that mentions the cursor is counted as consumption (conservative).
- **F7 (`abi.decode`)** — TERBUKTI. `abi.decode(...)` was counted as
  consumption (FN — `abi.decode` does not advance the offset). Fix:
  `abi.*` calls are excluded from consumption on all paths.
- **F8 (unknown helper)** — TERBUKTI. `handleOther(slice)`
  was counted as non-consumption (FP — a helper that receives the cursor can
  advance it, memory structs are by-reference). Fix: ANY call
  (except `abi.*` + pure/view + `emit` + keywords)
  whose argument mentions the cursor/alias OR whose receiver is the cursor
  is counted as consumption.
- **F9 (verbs outside the list)** — TERBUKTI. `takeBytes` etc. were not
  in the verb list (FP). Fixed by the same rule (c)
  as F8 — the verb list is now only used in state-based mode.
- **F10a (offset comparison)** — TERBUKTI. `slice.offset == ...`
  was counted as advance (FN). Fix: offset advance is now ONLY
  `+=` / `++` / `= ...offset...` (the RHS mentions the same offset);
  `==` and a reset `= 0` are not counted; a guard `(?<!\.)` prevents
  `slice.offset` from matching for an index cursor named `offset`.
- **F10b (offset reset)** — TERBUKTI. `slice.offset = 0` was counted as
  advance (FN). Fixed by the same rule (a).
- **F13 (substring hint)** — TERBUKTI. `DATA_CLEARED`,
  `WITHDRAW_ALL`, `EXTRACTED`, `ANOTHER`, `MOTHER`,
  `METADATA_HASH`, `BYTES32_ROOT` all matched the substring
  `data`/`bytes`/`extra` (FP). Fix: the hint moved to the constant
  operand ONLY (the `==` side with no tag var, first identifier
  incl. dots) + whole-token matching — strong {other, unknown,
  custom, generic, raw, opaque, extra, extension, arbitrary,
  payload}; `data`/`bytes` only if it is the LAST token of the name.
  The numeric literal form F13a was already 0 in v1 (locked in by a test).
- **F14 (allowOther predicate)** — TERBUKTI. `kind == PING &&
  !cfg.allowOther` matched because the condition text contained
  `allowOther` (FP). Fixed by the same constant-operand rule
  (PING → no hint). The numeric form was already 0 in v1.
- **F15 (tag var named payload)** — TERBUKTI. A tag var named
  `payloadType` triggered the `payload` hint (FP). Fixed: only
  the constant operand is tested, the tag var name is never tested.
- **F16 (bare `else`)** — TERBUKTI. A plain `else` branch was
  never flagged (FN). Fix: a flag-only and
  non-terminating `else` is flagged as Info (condLabel catch-all).
- **F17 (cursor alias)** — TERBUKTI. `s = slice` then
  `readBytes(s)` was not recognized (FP). Fix: collect aliases
  `ALIAS = cursor;` before the chain (2 rounds for alias chains);
  consumption is counted over cursor + aliases.
- **F18a/b (terminator)** — TERBUKTI. A `revert` / `break` branch
  was flagged even though it cannot desync (FP). Fix: top-level
  terminator check — strip nested `{...}` blocks
  (string-aware), split per `;`, skip a branch if there is a statement
  starting with `revert`/`break`/`return`. A conditional `revert`
  (`if (x) revert ...;`) is NOT counted as a terminator. The `return`
  form is locked in by test 58b-20.
- **F19 (do-while + braceless)** — TERBUKTI. `do { ... } while`
  and braceless loops were skipped (FN). Fix: `d24FindLoopBodies`
  covers braced do-while + braceless for/while whose body is
  a single if-chain (the tag gate is limited to an inline assignment in the first
  condition — the limit is documented).
- **F20 (nested chain)** — TERBUKTI. An if-chain inside a branch
  body was not scanned (FN). Fix: `d24ParseIfChain`
  returns the position of the continuing `else if`; the scanner uses a skip-set
  (not `ifRe.lastIndex = chain.end`), so inner chains are
  scanned; locked in by test 58b-23 (exactly 1).
- **F21 (nested loop dedupe)** — TERBUKTI. The same chain
  was reported 2× (outer loop + inner loop). Fix: the dedupe key is
  the absolute position of the chain in the function body
  (`fn.name:loopBodyStart + im.index`); locked in by test 58b-24.
- **F22 (tag = parameter / read once)** — TERBUKTI. A tag that
  is a function parameter / read once before the loop was flagged
  (FP — not per-item dispatch). Fix: assignment gate —
  the tag must have an assignment in the loop body before the chain, OR
  inline in the first condition; locked in by tests 58b-25/26.
- **F23 (severity)** — TERBUKTI. The Low default was too high for
  a name-only heuristic (the reference case itself is Info/design).
  Fix: default severity **Low → Info** for all D24 candidates
  (pipeline.js, mappedAreas, trap-vault.analysis.json, tests
  58-1/58-2/58b-27).

### REJECTED by the referee / accepted as a limit

- **F12 (`Kind.A` / `Kind.B`, with no hint word)** — ACCEPTED AS A
  LIMIT of name-only coverage, with no code change (locked in by test 58b-13
  = 0). If upstream uses an enum with no opaque word, the detector
  needs another signal (payload type in the wire format) — outside this
  pattern.
- **F13a / F14 numeric literal forms** — already 0 in v1 (not
  calibration findings); the constant-name forms are locked in at 58b-14/15.

## Post-R24 hunting results

8 surfaces, IDENTICAL to pre-calibration except for the FA-005 severity:
Fulcrom 15, Amply 18, RAAC 14, Hyperbridge **8** (FA-007 D24 **Info**
@ DecodeHeader line 84 — pipeline confirmation of L-1), Flow 0,
Veno 8 (FA-004 D23 = confirmation of VENO-C1, FA-005 D22 = confirmation of
VENO-C2), Veno zkEVM 0, LCROBridge 0. D24 exactly 1 hit across 8
surfaces, 0 real-corpus FPs. **0 new submission candidates.**

## Known limits (new)

- Switch statements are not handled yet.
- A tag that is a numeric literal with no constant name is not flagged.
- A braceless loop only if its body is a single if-chain with
  an inline tag assignment in the first condition.
- The variant wire format must be confirmed from the upstream spec
  (toVerify item 1); severity rises to Low only if the input stream
  is proven to be attacker-controllable.
- `Kind.A`/`Kind.B` with no hint word = FN by design (F12).

## Tool note — correction of the backslash rule (session #42)

The transport rule noted in the previous session ("type `\\` → the file gets
`\`") TURNED OUT TO BE A MISCOUNT — this session's verification via `od -c`:
what is typed lands VERBATIM in the file (type 2 backslashes → file gets 2).
As a result, the R24 calibration edit briefly doubled all regex
backslashes (39 lines) + found 2 latent v1 bugs (`/\w/` written as
`/\\w/` in `d24ParseIfChain` — the `if`/`else` boundary check lines,
never caught by the suite because input with no backslashes passed
anyway). Fix: a Python halving script per line (replace pairs
`\\` → `\`, verified to have an even count before writing) +
`node --check` + probes + a green suite. Lesson: do NOT trust
output rendering for backslash counts — ALWAYS verify via
`od -c` / a Python `chr(92)` count, and do NOT rely on a
"verified" summary with no raw bytes.
