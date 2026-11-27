# FrankenAudit — Demo video script (DRAFT, target < 3 minutes)

> Draft script + shot list for the public YouTube demo video (M4).
> Status: FINAL — v3 public on YouTube 26 Nov 2026 23:37 WIB
> (https://www.youtube.com/watch?v=AtwaC5bD6XU, 177.03 s). Target duration: ±2:55.
> Language: English (the Devpost judges), with subtitles if needed.
> v3 is FINAL (owner decision 27 Nov 2026 — no v4 re-record); known
> narration errata are listed below and mirrored in the Devpost
> description's "Video errata (v3)" section.

## Structure (±175 seconds)

| # | Time | Visual | Narration (draft) |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | Title + FrankenAudit logo; contract code snippets | "Bug-bounty scanners give you noise. FrankenAudit gives you candidates you can falsify — a hypothesis, the on-chain preconditions, and a verification checklist." |
| 2 | 0:15–0:45 | App: paste a contract address / upload `trap-vault.sol`; click Run | "Paste a contract address, or upload a Solidity file. The pipeline runs twenty-six pattern detectors plus Slither — here on a curated trap contract with thirty planted bugs." |
| 3 | 0:45–1:20 | Report page: candidates FA-001…; open one candidate (setOwner, Critical) | "Every candidate is a hypothesis, not a verdict. Location, mechanism, preconditions, impact, and exactly how to verify it. No finding is called proven until a fork proof-of-concept runs." |
| 4 | 1:20–1:50 | On-chain lookup: pick the Cronos zkEVM chain, paste an Amply Pool address → 6,304 bytes | "Then the live check. The app reads deployment state — read-only, no wallet, no transaction — to kill candidates that exist in code but are dead on-chain." |
| 5 | 1:50–2:15 | Foundry terminal: `forge test` PoC 4/4 PASS | "The survivors get a fork-level proof-of-concept. Four out of four pass here — including a drain through missing access control." |
| 6 | 2:15–2:40 | Walkthrough of the repo's `.kiro/`: open `steering/bug-bounty.md` → `specs/frankenaudit/tasks.md` → `hooks/candidate-format-check.json`; cut to `docs/kiro-crew-review-2026-11-23-d26.md` (findings F1–F12) + a terminal showing the suite at 977/977 | "Under the hood, everything is driven by Kiro: a bug-bounty steering persona, specs, and a format hook that keeps every candidate falsifiable. And Kiro surprised us — reviewing our newest detector, its crew fired fifty-eight adversarial test cases at it and found twelve issues in our own code. Our referee verified every claim against the real source before one fix landed. Nine hundred seventy-seven tests, all passing." |
| 7 | 2:40–2:55 | The repo's `.kiro/` (steering/specs/hooks) + closing | "Built with Kiro: a bug-bounty steering persona, specs, and hooks — the same discipline our crew hunts with every day. FrankenAudit. Candidate, not verdict." |

## Production notes

- Shot 6 is NEW (24 Nov 2026, approved by the owner — from the Kiroween
  judges' email: the Technological Implementation criterion + "show me
  how you used specs, steering and hooks" + "Kiro surprised you"): the VO
  has ALREADY been recorded 24 Nov 2026 (Helio, `vo-shot6-kiro.mp3`,
  26.4s). The old closing shot's VO (`vo-shot6.mp3`) is still used for
  shot 7 — its narration did not change.
- Record the screen at 1080p, from the live URL (the repo is public and
  M3 is live — prefer the live URL over a local app).
- Trap-vault: do NOT call it "safe" — stress that it is a sample contract
  deliberately full of bugs; do not deploy it.
- Background music: license-free, quiet. English subtitles if the
  narration has an accent.
- Upload: public YouTube; unlisted is NOT enough (the requirement is
  public).
- Before recording: make sure the public repo URL is live (it is, since
  25 Nov 2026) and capture from the English UI.

## v3 narration errata (27 Nov 2026 hostile re-review — v3 kept as final)

The v3 audio still carries the lines below. They are corrected in
writing in the Devpost description's "Video errata (v3)" section
instead of a re-record:
- Shot 2: "Paste a contract address, or upload a Solidity file. The pipeline runs twenty-six pattern detectors plus Slither — here on a curated trap contract with thirty planted bugs." → "Upload a Solidity file — or paste a contract address for a read-only bytecode check. The pipeline runs twenty-six pattern detectors — here on a curated trap contract with thirty expected candidates." (An address only gets an eth_getCode check; Slither is an offline cross-check, not part of the pipeline run.)
- Shot 3: "(setOwner, Critical)" → "(setOwner, High)" (the app shows High, not Critical).
- Shot 5: "fork-level proof-of-concept" → "local Foundry proof-of-concept" (the PoCs run locally in Foundry, no chain fork).
- Shot 6: "everything is driven by Kiro" → "Kiro drives the review crew" (implementation was done locally; Kiro is the reviewer/crew — see kiro-usage-writeup.md).
