import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SUSHISWAP_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const UNISWAPV2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

// ⚠️ Mainnet contract address
const CONTRACT_ADDRESS = "0x1C33Db5FC563ac9732C5352c37B73d95b7015E6f";
const FLASH_LOAN_AMOUNT = ethers.parseUnits("1", 18); // 1 WETH
const MIN_PROFIT_THRESHOLD = 0.02; // raise from 0.005 to 0.02 WETH // minimum 0.005 WETH profit to execute (~$10)
const MIN_LIQUIDITY_USD = 100000; // $100k minimum liquidity

const CONTRACT_ABI = [
  "function requestFlashLoan(address token, uint256 amount, bool buyOnA) external",
  "function withdraw(address token) external",
];

const FACTORY_ABI = [
  "function getPair(address,address) external view returns (address)",
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112,uint112,uint32)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const sushiFactory = new ethers.Contract(
  "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
  FACTORY_ABI,
  provider,
);
const uniFactory = new ethers.Contract(
  "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  FACTORY_ABI,
  provider,
);
const sushiRouter = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);
const uniRouter = new ethers.Contract(UNISWAPV2_ROUTER, ROUTER_ABI, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

let isExecuting = false;

async function getPrice(router, amountIn) {
  try {
    const amounts = await router.getAmountsOut(amountIn, [WETH, USDC]);
    return Number(ethers.formatUnits(amounts[1], 6));
  } catch {
    return null;
  }
}

async function getLiquidity(factory, label) {
  try {
    const pairAddress = await factory.getPair(WETH, USDC);
    if (pairAddress === "0x0000000000000000000000000000000000000000") return 0;
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
    const reserves = await pair.getReserves();
    const usdcReserve = Number(ethers.formatUnits(reserves[0], 6));
    return usdcReserve;
  } catch {
    return 0;
  }
}

async function estimateProfit(buyPrice, sellPrice) {
  // Sell 1 WETH on high price DEX → get USDC
  const usdcReceived = sellPrice * 0.997;
  // Buy WETH back on low price DEX
  const wethReceived = (usdcReceived / buyPrice) * 0.997;
  const profit = wethReceived - 1;
  return profit;
}

async function executeArbitrage(buyOnSushi) {
  if (isExecuting) return;
  isExecuting = true;

  console.log("\n🚀 EXECUTING FLASH LOAN...");
  try {
    const tx = await contract.requestFlashLoan(WETH, FLASH_LOAN_AMOUNT, {
      gasLimit: 500000,
    });
    console.log("Transaction sent:", tx.hash);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log(
        "✅ ARBITRAGE SUCCESS! Gas used:",
        receipt.gasUsed.toString(),
      );

      // Auto-withdraw profits
      const withdrawTx = await contract.withdraw(WETH);
      await withdrawTx.wait();
      console.log("💰 Profits withdrawn to wallet");
    } else {
      console.log("❌ Transaction failed");
    }
  } catch (err) {
    console.error("Execution failed:", err.message);
  } finally {
    isExecuting = false;
  }
}

async function scan() {
  try {
    const amountIn = FLASH_LOAN_AMOUNT;

    const [sushiPrice, uniPrice] = await Promise.all([
      getPrice(sushiRouter, amountIn),
      getPrice(uniRouter, amountIn),
    ]);

    if (!sushiPrice || !uniPrice) {
      console.log("Price fetch failed, retrying...");
      return;
    }

    const spread = Math.abs(sushiPrice - uniPrice);
    const spreadPct = (spread / Math.min(sushiPrice, uniPrice)) * 100;

    const buyOnSushi = sushiPrice < uniPrice;
    const buyPrice = buyOnSushi ? sushiPrice : uniPrice;
    const sellPrice = buyOnSushi ? uniPrice : sushiPrice;
    const buyDex = buyOnSushi ? "SushiSwap" : "UniswapV2";
    const sellDex = buyOnSushi ? "UniswapV2" : "SushiSwap";

    const estimatedProfit = await estimateProfit(buyPrice, sellPrice);

    console.log("─────────────────────────────────");
    console.log(`SushiSwap:  1 WETH = $${sushiPrice.toFixed(2)}`);
    console.log(`UniswapV2:  1 WETH = $${uniPrice.toFixed(2)}`);
    console.log(`Spread: $${spread.toFixed(2)} (${spreadPct.toFixed(4)}%)`);
    console.log(`Est. Profit: ${estimatedProfit.toFixed(6)} WETH`);

    // Check liquidity
    const [sushiLiq, uniLiq] = await Promise.all([
      getLiquidity(sushiFactory, "SushiSwap"),
      getLiquidity(uniFactory, "UniswapV2"),
    ]);

    if (sushiLiq < MIN_LIQUIDITY_USD || uniLiq < MIN_LIQUIDITY_USD) {
      console.log("⚠️  Low liquidity, skipping");
      return;
    }

    if (estimatedProfit > MIN_PROFIT_THRESHOLD) {
      console.log(`\n🚨 OPPORTUNITY! Buy on ${buyDex} → Sell on ${sellDex}`);
      console.log(`Est. Profit: ${estimatedProfit.toFixed(6)} WETH`);
      await executeArbitrage(buyOnSushi);
    } else {
      console.log("No opportunity yet...");
    }
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

console.log("🤖 Arbitrage bot started...");
console.log(`Wallet: ${wallet.address}`);
console.log(`Contract: ${CONTRACT_ADDRESS}`);
console.log("Scanning every 10 seconds...\n");

scan();
setInterval(scan, 10000);
