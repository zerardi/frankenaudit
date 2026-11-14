# PoC fork-lokal TrapVault (FrankenAudit)

Satu file test Foundry untuk 4 kandidat yang dikonfirmasi Kiro crew
(Opus 5.5, sesi 20:38 WIB 2026-11-13) — demo bahwa pipeline FrankenAudit
tidak berhenti di kandidat, tapi bisa membuktikan exploit di fork lokal.

## Menjalankan

```sh
cd poc
forge test -vv
```

Hasil yang diharapkan: **4/4 PASS**

| Test | Kandidat | Hasil |
|---|---|---|
| `test_PoC2_SetOwnerDrain` | #2 setOwner tanpa akses → `emergencyDrain` kuras vault | vault 15 ETH → 0 |
| `test_PoC7_PayFeeDrain` | #7 `payFee` tanpa akses → kirim saldo ke alamat mana pun | vault 15 ETH → 0 |
| `test_PoCA_PermitSelfMint` | A `permitRegexControl` self-signed mint arbitrer | cetak 1000 ETH saldo, tarik isi vault |
| `test_PoCB_ReplaySignature` | B satu signature dipakai 2× | saldo +2 ETH dari 1 signature |

## Catatan

- Semua di fork lokal (forge in-process). TANPA mainnet, TANPA wallet nyata.
- `foundry.toml` memakai `src = ../app/samples` (kontrak sampel terkurasi)
  + remapping `trapvault/` — jangan duplikasi `trap-vault.sol` ke sini.
- `lib/forge-std` adalah salinan lokal (1,4 MB) supaya proyek mandiri.
- `vm.prank(attacker, attacker)` (2-arg) wajib untuk #2: `emergencyDrain`
  memeriksa `tx.origin`, dan `prank` satu-arg hanya menyetel `msg.sender`.
