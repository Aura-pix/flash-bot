// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface IVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract FlashLoanReceiver {
    address public owner;
    address public dexA;
    address public dexB;
    bool public buyOnA;

    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    constructor(address _dexA, address _dexB) {
        owner = msg.sender;
        dexA = _dexA;
        dexB = _dexB;
    }

    function requestFlashLoan(address token, uint256 amount, bool _buyOnA) external {
        require(msg.sender == owner, "Not owner");
        buyOnA = _buyOnA;

        address[] memory tokens = new address[](1);
        tokens[0] = token;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        IVault(BALANCER_VAULT).flashLoan(
            address(this),
            tokens,
            amounts,
            ""
        );
    }

    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == BALANCER_VAULT, "Not Balancer");

        address asset = tokens[0];
        uint256 amount = amounts[0];
        uint256 totalRepayment = amount + feeAmounts[0];
        address tokenB = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

        // Direction: buyOnA = true means sell on dexA first (dexA price is higher)
        address sellDex = buyOnA ? dexA : dexB;
        address buyDex = buyOnA ? dexB : dexA;

        // Step 1: WETH → USDC on sell DEX (higher price)
        address[] memory pathA = new address[](2);
        pathA[0] = asset;
        pathA[1] = tokenB;

        IERC20(asset).approve(sellDex, amount);
        uint256[] memory amountsA = IUniswapV2Router(sellDex).swapExactTokensForTokens(
            amount, 0, pathA, address(this), block.timestamp + 300
        );
        uint256 usdcReceived = amountsA[amountsA.length - 1];

        // Step 2: USDC → WETH on buy DEX (lower price)
        address[] memory pathB = new address[](2);
        pathB[0] = tokenB;
        pathB[1] = asset;

        IERC20(tokenB).approve(buyDex, usdcReceived);
        IUniswapV2Router(buyDex).swapExactTokensForTokens(
            usdcReceived, 0, pathB, address(this), block.timestamp + 300
        );

        // Step 3: Check balance and repay Balancer
        uint256 wethBalance = IERC20(asset).balanceOf(address(this));
        require(wethBalance >= totalRepayment,
            string(abi.encodePacked("Need ", _toString(totalRepayment), " have ", _toString(wethBalance)))
        );

        IERC20(asset).transfer(BALANCER_VAULT, totalRepayment);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function withdraw(address token) external {
        require(msg.sender == owner, "Not owner");
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }
}