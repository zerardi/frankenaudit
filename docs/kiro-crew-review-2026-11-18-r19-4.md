# Review R19.4 — contract/interface types from imports in D19 (residuals A17/A19) — session 16:38 WIB 18 Nov 2026

## Kiro crew pass: DID NOT RUN (login collision — precedent sessions #21/#25/#29)

- The afternoon BB session on 18 Nov was running in parallel (checkpoint 3 ±17:00 WIB — Kiro pass #10 on the Hyperbridge consensus was in progress, browser task
  88bc7304, Sonnet 5.5). This session did NOT use Kiro Web at all;
  the dashboard was NOT re-checked (last 268.03/4,000, remaining 3,731.97,
  45 days → pace ≈82.9/day — on target). Kiro credits for this session: 0.
- **Replacement: local referee review** — probes of 8 cases against the local
  pipeline (`/tmp/probe-wasit-r194.js`, deleted after use, locked in
  as section 47 tests in `tests/run-m2-tests.js`).

## Gap proven by the probes (pre-fix)

| Case | Shape | Expected | Got | Verdict |
|---|---|---|---|---|
| P1 | project: `IERC20` in another file, parameter `IERC20 token` + `token.balance` | 1 | 0 | **FN TERBUKTI (A19 literal)** |
| P2 | control: parameter `address token` + `token.balance` | 1 | 1 | Correct (probe shape valid) |
| P3 | project: `IVault` in another file, parameter `IVault vault` + `vault.balance` | 1 | 0 | **FN TERBUKTI (A17)** |
| P4 | project: parameter `IERC20[] tokens` + `tokens[0].balance` | 1 | 0 | **FN TERBUKTI (indexed shape, same class)** |
| P5 | project: local struct `IERC20` shadows the interface from another file | 0 | 0 | Correct (struct guard) |
| P6 | single-file: `IVault vault` with no definition in the file | 0 | 0 | Correct (conservative) |
| P7 | single-file: `IERC20 token`, interface not in the corpus | 1 | 0 | **FN TERBUKTI (real case: IERC20 from OZ, dependencies excluded from the hunting corpus)** |
| P8 | single-file: local struct `IERC20` + `info.balance` | 0 | 0 | Correct (struct guard) |

Probe note: the shape `payable(to).transfer(x)` (1-arg ETH) does NOT
trigger D19 — the detector reads `.transfer(` as a 2-arg ERC20 call
(`args[1]` = amount). Not an R19.4 probe defect; that shape is outside
D19's current scope (known limit, not worked on this session).

## R19.4 calibration (referee jack)

1. **Union of project type names** — `runProjectPipeline` computes
   the union of contract/interface + struct names from ALL corpus files
   (`contractSpans` + `structNamesOf` per file) then passes it
   via `opts.projectContractTypeNames` / `opts.projectStructNames`;
   `runPipeline` merges it into ctx. Single-file mode (without
   opts) still uses only the local set — conservative.
2. **Standard ERC interface allowlist** — `WELL_KNOWN_INTERFACE_TYPES`
   (21 names: `IERC20`, `IERC20Metadata`, `IERC721`,
   `IERC721Metadata`, `IERC721Enumerable`, `IERC721Receiver`,
   `IERC1155`, `IERC1155MetadataURI`, `IERC1155Receiver`, `IERC4626`,
   `IERC165`, `IERC777`, `IERC2981`, `IERC3156FlashBorrower`,
   `IERC3156FlashLender`, `IWETH`, `IWETH9`, `ERC20`, `ERC721`,
   `ERC1155`) in `isAddressTypeName`, checked AFTER the struct guard —
   a struct/enum of the same name in this file still wins. This is what fixes
   P7: in a real hunting corpus, `IERC20` comes from OZ which is
   excluded from the corpus, so the project union alone is NOT enough.
3. **One element-type evaluation path** — both `elemIsAddress` helpers
   (R19.3, `collectIndexedAddressBases` + `scanIndexedAddressStateBases`)
   now delegate to `isAddressTypeName` (previously they duplicated
   address/struct/contract logic). Behaviour identical except the allowlist.
4. **`dispatcherNames` R18.4b still from the LOCAL set** — deliberately does NOT
   use the project union: a contract name from another file must not
   bind a dust signal to a D18 candidate in this file. Locked in by test 47i
   (two dust signals in file B mention `DustVault` → the D18 candidate
   in file A stays Medium; if the union set were used, both would
   bind → false Low).

## Result after calibration

- **Probes 8/8 PASS**; suite **597/597 PASS** (588 old + 9 new
  in section 47: 47a–47i).
- **Hunting re-run on 5 surfaces IDENTICAL, 0 new candidates** —
  Fulcrom **15**, Amply **18**, RAAC **14**, Hyperbridge **6**,
  Flow **0**; recall vs Kiro AMP still 4/7. FA-005
  `CallDispatcher.dispatch` remains **Low dust-by-design**.
  Meaning: in the current real corpus there is no new `ident.balance` /
  `BASE[i].balance` revealed by R19.4 — the calibration
  closes the FN class without adding noise.

## Known limits (after R19.4)

- `x = T(addr)` (cast-assignment without a declaration) does not yet track the type.
- 1-arg `.transfer(x)` (ETH) is not yet read by D19 as a sweep amount.
- Contract types from files OUTSIDE the corpus (not on the allowlist) remain 0
  in project mode — e.g. interfaces from another project that were not
  cloned in; single-file remains conservative except for the allowlist.
- F5/F6 taint, F11 per-target labels, `encodeWithSelector`
  4-arg transferFrom, F8 swap-output rename — other open residuals,
  not worked on this session.
