// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TrapVault — kontrak SAMPEL TERKURASI untuk FrankenAudit (M2)
/// @notice Sengaja berisi bug nyata + pola aman (negative control).
///         Dipakai untuk demo juri & pengujian pipeline. JANGAN deploy
///         ke mainnet, JANGAN dipakai sebagai referensi kode aman.
/// @dev Ground truth: trap-vault.analysis.json (30 kandidat diharapkan,
///      23 negative control yang TIDAK boleh memicu kandidat).
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

    // BUG 23 — JIT REWARD-ACCRUAL SANDWICH: reward diakru ke pool tanpa
    // mint share (harga share naik), stake masuk sebelum accrual,
    // requestUnbond mengunci rate pasca-accrual, fee keluar 0
    // (unbondingFee default 0) dan tanpa jeda minimum stake ke unbond.
    // Kelas VENO-C2 YbEth (sesi BB pagi 19 Nov 2026 — Medium wasit,
    // PoC-verified Foundry 4/4, fix-flip fee 1% membalik profit).
    uint256 public totalPooledEth;
    uint256 public totalSupply;
    uint256 public unbondingFee;
    uint256 public constant UNBONDING_FEE_DENOMINATOR = 100_000;
    uint256 public constant EXCHANGE_RATE_PRECISION = 1e18;
    mapping(string => uint256) public txnHash2Amount;
    mapping(uint256 => UnbondRequest) public token2UnbondRequest;

    struct UnbondRequest {
        uint256 shareAmount;
        uint256 exchangeRate;
    }

    function convertToShare(uint256 tokenAmount) public view returns (uint256) {
        require(totalPooledEth > 0, "empty pool");
        return (tokenAmount * totalSupply) / totalPooledEth;
    }

    function _mint(address to, uint256 amount) internal {
        shares[to] += amount;
        totalSupply += amount;
    }

    function _burn(address from, uint256 amount) internal {
        shares[from] -= amount;
        totalSupply -= amount;
    }

    function stake(address _receiver) external payable {
        uint256 shareAmount = convertToShare(msg.value);
        _mint(_receiver, shareAmount);
        totalPooledEth += msg.value;
    }

    function accrueReward(uint256 amount, string calldata txnHash) external onlyHandler {
        require(txnHash2Amount[txnHash] == 0, "dup");
        totalPooledEth += amount;
        txnHash2Amount[txnHash] = amount;
    }

    function requestUnbond(uint256 _shareAmount) external returns (uint256) {
        require(totalSupply > 0, "no shares");
        require(_shareAmount <= shares[msg.sender], "insufficient");
        uint256 exchangeRate = (totalPooledEth * EXCHANGE_RATE_PRECISION) / totalSupply;
        token2UnbondRequest[1] = UnbondRequest({shareAmount: _shareAmount, exchangeRate: exchangeRate});
        totalPooledEth -= (_shareAmount * exchangeRate) / EXCHANGE_RATE_PRECISION;
        _burn(msg.sender, _shareAmount);
        return 1;
    }

    function unbond(uint256 _tokenId) external returns (uint256) {
        UnbondRequest storage req = token2UnbondRequest[_tokenId];
        uint256 totalTokenAmount = (req.shareAmount * req.exchangeRate) / EXCHANGE_RATE_PRECISION;
        uint256 tokenFeeAmount = (totalTokenAmount * unbondingFee) / UNBONDING_FEE_DENOMINATOR;
        uint256 tokenAmount = totalTokenAmount - tokenFeeAmount;
        (bool ok, ) = payable(msg.sender).call{value: tokenAmount}("");
        require(ok, "failed");
        return tokenAmount;
    }
}

// BUG 22 — EMPTY-SUBLIST PROOF ADVANCES HEIGHT (kelas K-1 Hyperbridge):
// verifikasi sub-daftar bukti dilewati bila kosong, height tetap maju,
// proof jujur blok yang sama ditolak stale — sensor satu interval
// komitmen. Bentuk ringkas EcdsaBeefy.verifyParachainHeaderProof +
// verifyMmrUpdateProof + verify() (sesi BB sore 18 Nov 2026).
contract ConsensusTrap {
    struct ConsensusState {
        uint256 latestHeight;
        uint256 nextAuthoritySetId;
    }
    struct Proof {
        uint256 blockNumber;
        bytes32[] parachains;
        bytes proof;
    }
    ConsensusState public consensus;

    function verifyProof(bytes32 root, bytes memory p, bytes32[] memory leaves)
        internal pure returns (bool)
    {
        root; p; leaves;
        return true;
    }

    function verifyParachainHeaders(bytes32 headsRoot, Proof memory proof)
        internal returns (uint256)
    {
        uint256 len = proof.parachains.length;
        bytes32[] memory leaves = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            leaves[i] = proof.parachains[i];
        }
        if (len > 0) {
            require(verifyProof(headsRoot, proof.proof, leaves), "bad proof");
        }
        return len;
    }

    function verify(bytes memory previousState, Proof memory proof)
        external returns (bytes memory)
    {
        ConsensusState memory state = abi.decode(previousState, (ConsensusState));
        if (state.latestHeight >= proof.blockNumber) {
            return previousState;
        }
        verifyParachainHeaders(bytes32(0), proof);
        state.latestHeight = proof.blockNumber;
        return abi.encode(state);
    }
}

// BUG 24 — REFUND-LOCKED MIDDLEWARE (kelas VENO-C1 BridgeMiddleware zkCRO):
// deposit ERC20 user diteruskan ke bridgehub (kontrak ini tercatat deposit
// sender); bila deposit L2 gagal, refund kembali ke kontrak ini — tapi
// withdraw yang ada hanya base token (via lookup) + ETH ke treasury, tanpa
// rescue ERC20 arbitrer, tanpa receive()/fallback() (refund ETH revert).
// Bentuk ringkas BridgeMiddleware.sol (sesi BB pagi 19 Nov 2026, KANDIDAT
// laten, mock PoC 5/5 PASS).
interface IBridgeHubMini {
    function baseToken(uint256 chainId) external view returns (address);
    function sharedBridge() external view returns (address);
    function requestL2TransactionTwoBridges(
        uint256 chainId,
        uint256 mintValue,
        uint256 l2Value,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit,
        address refundRecipient,
        address secondBridgeAddress,
        uint256 secondBridgeValue,
        bytes calldata secondBridgeCalldata
    ) external payable returns (bytes32);
}

contract RefundTrap {
    IBridgeHubMini public bridgehub;
    uint256 public chainId;
    address public treasury;

    constructor(uint256 _chainId, address _bridgeHub, address _treasury) {
        chainId = _chainId;
        bridgehub = IBridgeHubMini(_bridgeHub);
        treasury = _treasury;
    }

    function withdrawEth(uint256 _amount) external {
        require(_amount <= address(this).balance, "insufficient");
        (bool success,) = payable(treasury).call{value: _amount}("");
        require(success, "failed");
    }

    function withdrawBaseToken(uint256 _amount) external {
        address baseToken = bridgehub.baseToken(chainId);
        require(_amount <= IERC20(baseToken).balanceOf(address(this)), "insufficient");
        IERC20(baseToken).safeTransfer(treasury, _amount);
    }

    function bridge(address _l2Receiver, address _token, uint256 _amount, address _refundRecipient)
        external payable returns (bytes32)
    {
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        address sharedBridge = bridgehub.sharedBridge();
        IERC20(_token).approve(sharedBridge, _amount);
        return bridgehub.requestL2TransactionTwoBridges(
            chainId, msg.value, 0, 100000, 800, _refundRecipient,
            sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver)
        );
    }
}

// NEGATIVE CONTROL P — middleware yang sama + rescue ERC20 arbitrer:
// withdrawToken(token, to, amount) adalah jalur keluar umum -> D23 diam.
contract RefundTrapRescued {
    IBridgeHubMini public bridgehub;
    uint256 public chainId;
    address public treasury;

    constructor(uint256 _chainId, address _bridgeHub, address _treasury) {
        chainId = _chainId;
        bridgehub = IBridgeHubMini(_bridgeHub);
        treasury = _treasury;
    }

    function rescueToken(address token, address to, uint256 amount) external {
        IERC20(token).safeTransfer(to, amount);
    }

    function bridge(address _l2Receiver, address _token, uint256 _amount, address _refundRecipient)
        external payable returns (bytes32)
    {
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        address sharedBridge = bridgehub.sharedBridge();
        IERC20(_token).approve(sharedBridge, _amount);
        return bridgehub.requestL2TransactionTwoBridges(
            chainId, msg.value, 0, 100000, 800, _refundRecipient,
            sharedBridge, 0, abi.encode(_token, _amount, _l2Receiver)
        );
    }
}


// BUG 25 — VARIANT BRANCH DOES NOT CONSUME PAYLOAD (kelas L-1 Hyperbridge
// Codec.DecodeHeader): loop decode header SCALE — cabang ITEM_OTHER hanya
// menandai flag, payload Vec<u8> sesudah tag tidak dibaca; offset tidak
// maju, item berikutnya ter-parse dari posisi salah; field `other` tak
// pernah terisi. Bentuk ringkas Codec.DecodeHeader (sesi BB pagi 20 Nov
// 2026, Info/design, BUKAN kandidat submit — header harus genuinely
// finalized). Cabang ITEM_UNIT (varian unit, tanpa payload di wire format)
// sengaja TIDAK di-flag.
library ScaleSlice {
    struct Slice { bytes data; uint256 offset; }

    function readByte(Slice memory s) internal pure returns (uint8) {
        uint8 b = uint8(s.data[s.offset]);
        s.offset += 1;
        return b;
    }

    function readBytes(Slice memory s, uint256 len) internal pure returns (bytes memory) {
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = s.data[s.offset + i];
        }
        s.offset += len;
        return out;
    }
}

contract ScaleHeaderTrap {
    uint8 constant ITEM_OTHER = 0;
    uint8 constant ITEM_CONSENSUS = 4;
    uint8 constant ITEM_SEAL = 5;
    uint8 constant ITEM_UNIT = 8;

    struct DigestItem { bytes4 id; bytes data; }
    struct Digest {
        bool isOther;
        bytes other;
        bool isConsensus;
        DigestItem consensus;
        bool isSeal;
        DigestItem seal;
        bool isUnit;
    }

    function decodeItem(ScaleSlice.Slice memory slice) internal pure returns (DigestItem memory) {
        bytes4 id = bytes4(ScaleSlice.readBytes(slice, 4));
        uint256 len = uint256(uint8(ScaleSlice.readByte(slice)));
        bytes memory data = ScaleSlice.readBytes(slice, len);
        return DigestItem(id, data);
    }

    function decodeHeader(bytes memory encoded) internal pure returns (Digest[] memory) {
        ScaleSlice.Slice memory slice = ScaleSlice.Slice(encoded, 0);
        uint256 length = uint256(uint8(ScaleSlice.readByte(slice)));
        Digest[] memory digests = new Digest[](length);
        for (uint256 i = 0; i < length; i++) {
            uint8 kind = ScaleSlice.readByte(slice);
            Digest memory digest;
            if (kind == ITEM_OTHER) {
                digest.isOther = true;
            } else if (kind == ITEM_CONSENSUS) {
                digest.isConsensus = true;
                digest.consensus = decodeItem(slice);
            } else if (kind == ITEM_SEAL) {
                digest.isSeal = true;
                digest.seal = decodeItem(slice);
            } else if (kind == ITEM_UNIT) {
                digest.isUnit = true;
            }
            digests[i] = digest;
        }
        return digests;
    }
}

// NEGATIVE CONTROL Q — semua cabang mengonsumsi payload: cabang Other
// membaca payload-nya (readByte + readBytes) -> D24 diam.
contract ScaleHeaderSafe {
    uint8 constant ITEM_OTHER = 0;
    uint8 constant ITEM_CONSENSUS = 4;

    struct DigestItem { bytes4 id; bytes data; }
    struct Digest {
        bool isOther;
        bytes other;
        bool isConsensus;
        DigestItem consensus;
    }

    function decodeItem(ScaleSlice.Slice memory slice) internal pure returns (DigestItem memory) {
        bytes4 id = bytes4(ScaleSlice.readBytes(slice, 4));
        uint256 len = uint256(uint8(ScaleSlice.readByte(slice)));
        bytes memory data = ScaleSlice.readBytes(slice, len);
        return DigestItem(id, data);
    }

    function decodeHeaderSafe(bytes memory encoded) internal pure returns (Digest[] memory) {
        ScaleSlice.Slice memory slice = ScaleSlice.Slice(encoded, 0);
        uint256 length = uint256(uint8(ScaleSlice.readByte(slice)));
        Digest[] memory digests = new Digest[](length);
        for (uint256 i = 0; i < length; i++) {
            uint8 kind = ScaleSlice.readByte(slice);
            Digest memory digest;
            if (kind == ITEM_OTHER) {
                digest.isOther = true;
                uint256 len = uint256(uint8(ScaleSlice.readByte(slice)));
                digest.other = ScaleSlice.readBytes(slice, len);
            } else if (kind == ITEM_CONSENSUS) {
                digest.isConsensus = true;
                digest.consensus = decodeItem(slice);
            }
            digests[i] = digest;
        }
        return digests;
    }
}

// NEGATIVE CONTROL R — cabang non-konsumsi satu-satunya adalah varian unit
// (ITEM_UNIT, tanpa payload di wire format) -> D24 diam.
contract ScaleHeaderUnit {
    uint8 constant ITEM_CONSENSUS = 4;
    uint8 constant ITEM_UNIT = 8;

    struct DigestItem { bytes4 id; bytes data; }
    struct Digest {
        bool isConsensus;
        DigestItem consensus;
        bool isUnit;
    }

    function decodeItem(ScaleSlice.Slice memory slice) internal pure returns (DigestItem memory) {
        bytes4 id = bytes4(ScaleSlice.readBytes(slice, 4));
        uint256 len = uint256(uint8(ScaleSlice.readByte(slice)));
        bytes memory data = ScaleSlice.readBytes(slice, len);
        return DigestItem(id, data);
    }

    function decodeHeaderUnit(bytes memory encoded) internal pure returns (Digest[] memory) {
        ScaleSlice.Slice memory slice = ScaleSlice.Slice(encoded, 0);
        uint256 length = uint256(uint8(ScaleSlice.readByte(slice)));
        Digest[] memory digests = new Digest[](length);
        for (uint256 i = 0; i < length; i++) {
            uint8 kind = ScaleSlice.readByte(slice);
            Digest memory digest;
            if (kind == ITEM_CONSENSUS) {
                digest.isConsensus = true;
                digest.consensus = decodeItem(slice);
            } else if (kind == ITEM_UNIT) {
                digest.isUnit = true;
            }
            digests[i] = digest;
        }
        return digests;
    }
}


// BUG 26 — GUARD ASYMMETRY: NAV READERS (kelas H-SOMM-12 Somm Cellar):
// totalAssets() ber-guard require(!locked), sementara previewRedeem()
// membaca NAV yang sama lewat _nav() TANPA cek locked — pembaca
// lintas-kontrak (adaptor balanceOf -> previewRedeem) bisa membaca NAV basi
// di tengah deposit/withdraw. Latent/hardening (Low): butuh jalur callback
// ber-hook untuk dieksploitasi. Kontrol S (semua ber-guard) dan kontrol T
// (semua tanpa guard) diam — keduanya hidup di tes, bukan di file ini.
contract NavGuardTrap {
    bool public locked;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function _nav() internal view returns (uint256 assets, uint256 supply) {
        assets = address(this).balance;
        supply = totalSupply;
    }

    function totalAssets() public view returns (uint256 assets) {
        require(!locked, "REENTRANCY");
        (assets, ) = _nav();
    }

    function previewRedeem(uint256 shares) public view returns (uint256 assets) {
        (uint256 _totalAssets, uint256 _totalSupply) = _nav();
        assets = shares * _totalAssets / (_totalSupply == 0 ? 1 : _totalSupply);
    }
}


// BUG 27 — UNBOUNDED LOOP ATAS SET YANG BISA DIGELEMBUNGKAN PERMISSIONLESS
// (kelas H-SOMM-19 Somm VestingSimple): deposit() public tanpa guard menambah
// allUserDepositIds[receiver] dengan receiver bebas (minimum 0,0001 token);
// vestedBalanceOf() me-loop seluruh set via .values() tanpa batas —
// totalAssets yang membacanya brick pada ±3.121 entri (PoC fork 23 Nov 2026).
// Kontrol U (grower ber-guard) dan kontrol V (kunci msg.sender saja) diam —
// keduanya hidup di tes, bukan di file ini.
contract VestingBloatTrap {
    mapping(address => EnumerableSet.UintSet) private allUserDepositIds;
    mapping(address => mapping(uint256 => uint256)) public vests;
    mapping(address => uint256) public currentId;
    uint256 public minimumDeposit = 1e14;

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        require(assets >= minimumDeposit, "too small");
        shares = assets;
        // Ejaan baca+tulis eksplisit (bukan ++x) supaya detektor dead-config
        // melihat pembacaan currentId — pola .add() di bawah tetap verbatim.
        uint256 newDepositId = currentId[receiver] + 1;
        currentId[receiver] = newDepositId;
        allUserDepositIds[receiver].add(newDepositId);
        vests[receiver][newDepositId] = assets;
    }

    function vestedBalanceOf(address user) public view returns (uint256 balance) {
        uint256[] memory depositIds = allUserDepositIds[user].values();
        uint256 numDeposits = depositIds.length;
        for (uint256 i = 0; i < numDeposits; i++) {
            balance += vests[user][depositIds[i]];
        }
    }
}
