// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TrapVault — kontrak SAMPEL TERKURASI untuk FrankenAudit (M2)
/// @notice Sengaja berisi bug nyata + pola aman (negative control).
///         Dipakai untuk demo juri & pengujian pipeline. JANGAN deploy
///         ke mainnet, JANGAN dipakai sebagai referensi kode aman.
/// @dev Ground truth: trap-vault.analysis.json (24 kandidat diharapkan,
///      21 negative control yang TIDAK boleh memicu kandidat).
/// @notice Interface minimal feed harga (Chainlink-style) + oracle getter
///         (Aave-style) — dipakai fixture detektor oracle-passthrough.
interface IPriceFeed {
    function latestAnswer() external view returns (int256);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
interface IPriceOracleGetter {
    function getAssetPrice(address asset) external view returns (uint256);
}
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
// Panggilan arbitrer ala Hyperbridge ICallDispatcher — dipakai fixture
// detektor permissionless-dispatcher (BUG 19) + kontrol K.
struct Call {
    address to;
    uint256 value;
    bytes data;
}

contract TrapVault {
    mapping(address => uint256) public balances;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => address) public codeOwners;
    mapping(address => bytes32) public traderReferralCodes;
    address public handler;

    modifier onlyHandler() {
        require(msg.sender == handler, "not handler");
        _;
    }
    uint256 public totalShares;
    address public owner;
    uint256 public feeBps;
    address public oracle;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);

    constructor() {
        owner = msg.sender;
        handler = msg.sender;
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

    // BUG 10 — ORACLE PASSTHROUGH TANPA STALENESS CHECK: harga dari
    // feed dipakai apa adanya; hanya cek price > 0 (BUKAN cek staleness)
    // — bila feed macet / updater berhenti, harga basi tetap dipakai
    // untuk valuasi (kelas AMP-06 Amply — AmplyOracle meneruskan harga
    // tanpa validasi umur data, sama seperti AaveOracle upstream
    // v1.19.4 yang juga hanya cek price > 0).
    function getVaultPrice() external view returns (uint256) {
        int256 price = IPriceFeed(oracle).latestAnswer();
        require(price > 0, "bad price");
        return uint256(price);
    }

    // BUG 11 — KONSUMEN ORACLE TANPA STALENESS CHECK: getAssetPrice
    // dipakai langsung untuk valuasi agunan tanpa cek umur harga
    // (bentuk AMP-06 di sisi konsumen — ValidationLogic.validateBorrow
    // Amply memanggil IPriceOracleGetter.getAssetPrice tanpa guard).
    function collateralValue(address asset, uint256 amount) external view returns (uint256) {
        uint256 price = IPriceOracleGetter(oracle).getAssetPrice(asset);
        return amount * price;
    }

    // NEGATIVE CONTROL H — harga dari feed yang sama, tapi umur data
    // dicek (block.timestamp - updatedAt < 1 jam) sebelum dipakai.
    // Detektor oracle-passthrough TIDAK boleh memicu di sini.
    function getVaultPriceSafe() external view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = IPriceFeed(oracle).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "old price");
        require(price > 0, "bad price");
        return uint256(price);
    }

    // BUG 17 — VACUOUS IDENTITY CHECK: fungsi ini HANYA dipanggil
    // kontrak perantara (onlyHandler — pemanggil = router, bukan trader)
    // tapi memeriksa `affiliate == msg.sender` seolah msg.sender adalah
    // trader — cek itu tidak pernah benar, jadi trader bisa menyetel
    // kode referral MILIKNYA SENDIRI (self-referral lolos). Kelas
    // FUL-REF-01 Fulcrom ReferralManager.setTraderReferralCode, sesi BB
    // sore 15 Nov 2026 (wasit: Medium, fee-avoidance).
    function setTraderReferralCode(address _trader, bytes32 _code) external onlyHandler {
        address affiliate = codeOwners[_code];
        if (affiliate == address(0) || affiliate == msg.sender) return;
        traderReferralCodes[_trader] = _code;
    }

    // NEGATIVE CONTROL I — jalur pemanggilan LANGSUNG oleh trader:
    // cek `affiliate != msg.sender` di sini BERMAKNA (msg.sender memang
    // trader) — detektor vacuous-identity-check TIDAK boleh memicu.
    // (Bentuk persis Fulcrom ReferralManager.setTraderReferralCodeByUser.)
    function setTraderReferralCodeByUser(bytes32 _code) external {
        address affiliate = codeOwners[_code];
        require(affiliate != address(0), "code not registered");
        require(affiliate != msg.sender, "self referral not allowed");
        traderReferralCodes[msg.sender] = _code;
    }

    // BUG 18 — DEAD CONFIG: dua variabel config ditulis di setter tapi
    // tidak pernah dibaca di kontrak ini — governance mengira config
    // berlaku padahal tidak ada logika yang memakainya. Kelas R-02
    // Fulcrom VaultPriceFeedV2 (favorPrimaryPrice +
    // spreadThresholdBasisPoints), sesi BB sore 15 Nov 2026 (wasit:
    // Low/Info). Setter memakai onlyHandler supaya tidak memicu
    // missing-access-control (bukan bagian dari pola ini).
    bool public configDead;
    uint256 public thresholdDead;

    function setDeadSwitch(bool _v) external onlyHandler {
        configDead = _v;
    }

    function setDeadThreshold(uint256 _v) external onlyHandler {
        thresholdDead = _v;
    }

    // NEGATIVE CONTROL J — config HIDUP: ditulis di setter DAN dibaca
    // di fungsi view — detektor dead-config-storage TIDAK boleh memicu.
    uint256 public liveCounter;

    function setLiveCounter(uint256 _v) external onlyHandler {
        liveCounter = _v;
    }

    function getLiveCounter() external view returns (uint256) {
        return liveCounter + 1;
    }

    // Pembaca registry referral (bentuk nyata Fulcrom): kode referral
    // trader dibaca di sini — traderReferralCodes BUKAN dead config
    // (ditulis di dua setter, dibaca di getter ini).
    function getTraderReferralCode(address _trader) external view returns (bytes32) {
        return traderReferralCodes[_trader];
    }

    error NotContract(address target);
    error CallFailed(address target, bytes result);
    error InsufficientBalance();

    // BUG 19 — PERMISSIONLESS DISPATCHER: siapa pun boleh memanggil
    // eksekutor ini dengan call arbitrer; kontrak menampung ETH/token
    // user sementara (predispatch). Kelas H3 Hyperbridge
    // (CallDispatcher.dispatch, sesi BB sore 17 Nov 2026 — wasit Medium,
    // PoC-verified Foundry 4/4: residu 200 USDC dikuras via dispatch
    // langsung). Target + data berasal dari calldata yang di-decode.
    function dispatch(bytes calldata encoded) external {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        uint256 callsLen = calls.length;
        for (uint256 i = 0; i < callsLen; ++i) {
            Call memory call = calls[i];
            uint32 size;
            address to = call.to;
            assembly {
                size := extcodesize(to);
            }
            if (size == 0) {
                revert NotContract(to);
            }
            (bool success, bytes memory result) = to.call{value: call.value}(call.data);
            if (!success) revert CallFailed(to, result);
        }
    }

    // NEGATIVE CONTROL K — dispatcher yang SAMA, tapi hanya gateway
    // yang boleh memanggil (modifier onlyHandler) — detektor
    // permissionless-dispatcher TIDAK boleh memicu di sini.
    function dispatchGuarded(bytes calldata encoded) external onlyHandler {
        Call[] memory calls = abi.decode(encoded, (Call[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory call = calls[i];
            (bool success, ) = call.to.call{value: call.value}(call.data);
            if (!success) revert CallFailed(call.to, "");
        }
    }

    // BUG 20 — FULL-BALANCE SWEEP: escrow disapu sebesar saldo penuh
    // kontrak perantara, bukan jumlah yang dideklarasikan di order —
    // residu (mis. sisa predispatch) ikut tersapu. Kelas H3b Hyperbridge
    // (IntentGatewayV2.placeOrder, sesi BB sore 17 Nov 2026 — wasit Low).
    address public dispatcher;

    function sweepEscrow(address token, uint256 required) external {
        uint256 balance = IERC20(token).balanceOf(dispatcher);
        if (balance < required) revert InsufficientBalance();
        IERC20(token).transfer(address(this), balance);
    }

    // NEGATIVE CONTROL L — sweep dengan jumlah yang DIDeklarasikan
    // (parameter amount), bukan saldo penuh — detektor full-balance-sweep
    // TIDAK boleh memicu di sini.
    function sweepDeclared(address token, uint256 amount) external {
        IERC20(token).transfer(address(this), amount);
    }

    // NEGATIVE CONTROL M — rescue saldo SENDIRI (by-design): saldo
    // kontrak sendiri disapu ke owner — detektor full-balance-sweep
    // TIDAK boleh memicu di sini (hanya saldo kontrak perantara yang dihitung).
    function rescueOwnBalance(address token) external onlyHandler {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }

    // BUG 21 — PERMISSIONLESS VALUE-SEND: siapa pun bisa mengirim ETH
    // kontrak ke alamat pilihannya; return dicek (lolos unchecked-call)
    // dan data kosong (lolos permissionless-dispatcher). Rekomendasi F8
    // review Kiro detektor 18/19, sesi 20:38 WIB 17 Nov 2026.
    function drainValue(address to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "failed");
    }

    // NEGATIVE CONTROL N — kirim ETH ke PEMILIK (payout sah) dan ke
    // pemanggil sendiri (withdraw) — detektor permissionless-value-send
    // TIDAK boleh memicu di sini.
    function withdrawToOwner(uint256 amount) external {
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "failed");
    }

    function withdrawSelf(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "failed");
    }

    // NEGATIVE CONTROL O — transfer TOKEN (dua argumen) bukan kirim ETH —
    // detektor permissionless-value-send TIDAK boleh memicu di sini.
    function payToken(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }
}
