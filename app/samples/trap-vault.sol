// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TrapVault — kontrak SAMPEL TERKURASI untuk FrankenAudit (M2)
/// @notice Sengaja berisi bug nyata + pola aman (negative control).
///         Dipakai untuk demo juri & pengujian pipeline. JANGAN deploy
///         ke mainnet, JANGAN dipakai sebagai referensi kode aman.
/// @dev Ground truth: trap-vault.analysis.json (14 kandidat diharapkan,
///      10 negative control yang TIDAK boleh memicu kandidat).
contract TrapVault {
    mapping(address => uint256) public balances;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public nonces;
    uint256 public totalShares;
    address public owner;
    uint256 public feeBps;
    address public oracle;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "zero");
        balances[msg.sender] += msg.value;
        shares[msg.sender] += msg.value;
        totalShares += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    // BUG 1 — REENTRANCY: external call SEBELUM state update.
    // Korban: withdraw() — balances dikurangi SETELAH ETH terkirim.
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "call failed");
        balances[msg.sender] -= amount;
        emit Withdraw(msg.sender, amount);
    }

    // NEGATIVE CONTROL A — pola aman: checks-effects-interactions benar.
    // State dikurangi SEBELUM external call -> detektor reentrancy
    // TIDAK boleh memicu kandidat di sini.
    function withdrawSafe(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "call failed");
        emit Withdraw(msg.sender, amount);
    }

    // NEGATIVE CONTROL D — withdraw yang mengurangi SEMUA akuntansi
    // (balances + shares + totalShares) sebelum external call.
    // Detektor share-accounting & reentrancy TIDAK boleh memicu di sini.
    function withdrawFull(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        require(shares[msg.sender] >= amount, "insufficient shares");
        balances[msg.sender] -= amount;
        shares[msg.sender] -= amount;
        totalShares -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "call failed");
        emit Withdraw(msg.sender, amount);
    }

    // NEGATIVE CONTROL E — klaim signature yang AMAN dari replay:
    // digest mengikat nonce (sekali pakai) + chainId + address(this),
    // signer dicek nol. Detektor replay-signature & ecrecover
    // TIDAK boleh memicu di sini.
    function claimWithNonceSafe(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 h = keccak256(
            abi.encodePacked(address(this), block.chainid, msg.sender, amount, nonces[msg.sender])
        );
        address signer = ecrecover(h, v, r, s);
        require(signer != address(0), "zero signer");
        require(signer == owner, "bad sig");
        nonces[msg.sender]++;
        balances[msg.sender] += amount;
    }

    // BUG 2 — MISSING ACCESS CONTROL: siapa pun bisa merebut owner.
    // Tidak ada modifier onlyOwner, tidak ada require(msg.sender == owner).
    function setOwner(address newOwner) external {
        owner = newOwner;
    }

    // BUG 3 — DIVISION WITHOUT ZERO GUARD: totalShares bisa 0
    // (vault kosong / sebelum deposit pertama) -> revert / DoS harga.
    function sharePrice() external view returns (uint256) {
        return address(this).balance / totalShares;
    }

    // NEGATIVE CONTROL B — divisi yang sama, tapi diguard.
    // Detektor divisi TIDAK boleh memicu kandidat di sini.
    function sharePriceSafe() external view returns (uint256) {
        require(totalShares > 0, "no shares");
        return address(this).balance / totalShares;
    }

    // BUG 4 — ECRECOVER TANPA CEK address(0): signature invalid
    // (v/r/s sampah) menghasilkan signer == address(0); bila owner
    // pernah 0 / logika berubah, klaim palsu bisa lolos.
    function claimWithSignature(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 h = keccak256(abi.encodePacked(msg.sender, amount));
        address signer = ecrecover(h, v, r, s);
        require(signer == owner, "bad sig");
        balances[msg.sender] += amount;
    }

    // NEGATIVE CONTROL C — ecrecover yang sama, tapi signer dicek nol.
    // Detektor ecrecover TIDAK boleh memicu kandidat di sini.
    function claimWithSignatureSafe(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 h = keccak256(abi.encodePacked(msg.sender, amount));
        address signer = ecrecover(h, v, r, s);
        require(signer != address(0), "zero signer");
        require(signer == owner, "bad sig");
        balances[msg.sender] += amount;
    }

    // BUG 5 — TX.ORIGIN UNTUK OTORISASI: kontrak perantara / phishing
    // bisa memanggil ini atas nama owner tanpa persetujuan owner.
    function emergencyDrain() external {
        require(tx.origin == owner, "not owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "drain failed");
    }

    // BUG 6 — UNCHECKED EXTERNAL CALL: hasil call diabaikan, lalu
    // state diubah seolah transfer berhasil (fee di-nol-kan).
    // BUG 7 — MISSING ACCESS CONTROL (fungsi yang sama): siapa pun
    // bisa memanggil payFee ke alamat mana pun.
    function payFee(address to, uint256 amount) external {
        to.call{value: amount}("");
        feeBps = 0;
    }

    // BUG 8 — COMMENTED-OUT CHECK: require saldo dikomentari, jadi
    // penarikan tanpa saldo mencukupi lolos dari cek (temuan kelas
    // AMP-01 Amply, sesi 04:38 WIB 2026-11-14).
    function drainCommentedCheck(uint256 amount) external {
        // require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "call failed");
    }

    // NEGATIVE CONTROL F — komentar prosa yang menyebut "require" TANPA
    // tanda kurung, plus baris kode non-check yang dikomentari.
    // Detektor commented-out-check TIDAK boleh memicu di sini.
    function setFeeCommentProse(uint256 bps) external {
        // we require the caller to be the owner before changing the fee
        // feeBps = 999; (nilai lama, sudah tidak dipakai)
        require(msg.sender == owner, "not owner");
        feeBps = bps;
    }

    // KONTROL REGRESI SAJA — fungsi ini SENGAJA TIDAK AMAN dan BUKAN
    // contoh pola aman: tanpa nonce, caller memilih sendiri parameter
    // "owner" lalu menandatangani digest dengan key-nya sendiri, sehingga
    // balances[caller] += value sebesar apa pun (temuan Kiro Opus 5.5,
    // sesi 20:38 WIB 2026-11-13 — Critical, jalur pengurasan ketiga).
    // Fungsinya di sini HANYA menguji detektor missing-access-control
    // tidak salah-flag "owner ==" (perbandingan) sebagai penulisan state.
    function permitRegexControl(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "zero owner");
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = keccak256(
            abi.encodePacked(owner, spender, value, deadline)
        );
        require(owner == ecrecover(digest, v, r, s), "bad sig");
        balances[owner] += value;
    }

    // BUG 9 — COMMENTED-OUT FUNCTION: fungsi pengatur fee dikomentari
    // utuh, jadi tidak ada jalur yang bisa mengubah feeBps (temuan kelas
    // AMP-02 Amply — setDebtCeiling dikomentari utuh di PoolConfigurator,
    // sesi 08:38 WIB 2026-11-14).
    // function setFeePaused(uint256 bps) external {
    //     require(msg.sender == owner, "not owner");
    //     feeBps = bps;
    // }

    // NEGATIVE CONTROL G — komentar prosa yang menyebut signature fungsi
    // (lihat function setFeeActive(uint256) untuk versi yang dimatikan) —
    // BUKAN definisi fungsi yang dikomentari, jadi detektor
    // commented-out-function TIDAK boleh memicu di sini.
}
