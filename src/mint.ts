// Transaction signing, multi-RPC blasting, and receipt polling.
// Autonomous execution engine with instant verification and stop-on-success.

import { JsonRpcProvider, Wallet, keccak256, formatEther } from "ethers";
import { MintPlan } from "./seadrop";
import { LogEntry } from "./session";
import { explorerTx } from "./chains";

export interface MintResult {
  walletIndex: number;
  address: string;
  txHash: string;
  attempt: number;
  status:
    | "dispatched"
    | "accepted"
    | "rejected"
    | "confirmed"
    | "failed"
    | "timeout";
  blockNumber?: number;
  gasUsed?: string;
  error?: string;
  explorerUrl: string;
}

export interface SnipeExecutionReport {
  confirmed: boolean;
  successfulAttempt?: number;
  attemptsRun: number;
  results: MintResult[];
  confirmedResult?: MintResult;
  error?: string;
}

// Resolve RPC URLs: user custom Alchemy RPC > additional backup RPCs > default fallback
export function resolveRpcUrls(
  customRpc: string,
  additionalRpcEnv: string,
): string[] {
  const urls: string[] = [];
  if (customRpc) urls.push(customRpc);
  if (additionalRpcEnv) {
    urls.push(...additionalRpcEnv.split(",").filter(Boolean));
  }
  const defaultRpc =
    process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  if (!urls.includes(defaultRpc)) {
    urls.push(defaultRpc);
  }
  return [...new Set(urls)];
}

// Pre-fetch nonces and warm connections
async function prepareWallets(
  walletKeys: string[],
  rpcUrl: string,
): Promise<{ wallets: Wallet[]; nonces: number[]; chainId: bigint }> {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  const [nonces, network] = await Promise.all([
    Promise.all(
      wallets.map((w) => provider.getTransactionCount(w.address, "pending")),
    ),
    provider.getNetwork(),
  ]);

  return { wallets, nonces, chainId: network.chainId };
}

// Sign all transactions before the fire moment
export async function signTransactions(
  walletKeys: string[],
  plan: MintPlan,
  rpcUrl: string,
  maxFeePerGas: bigint,
  maxPriorityFee: bigint,
  gasLimit: number,
): Promise<{
  prepared: { address: string; rawTx: string; txHash: string }[];
  chainId: bigint;
  baseFee: bigint;
}> {
  const { wallets, nonces, chainId } = await prepareWallets(walletKeys, rpcUrl);
  const provider = new JsonRpcProvider(rpcUrl);
  const feeData = await provider.getFeeData();
  const baseFee = feeData.gasPrice || 0n;

  const prepared: { address: string; rawTx: string; txHash: string }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: gasLimit || 250_000,
      type: 2,
      chainId: Number(chainId),
    });

    prepared.push({
      address: wallets[i].address,
      rawTx,
      txHash: keccak256(rawTx),
    });
  }

  return { prepared, chainId, baseFee };
}

// Blast raw transactions to all RPC endpoints simultaneously
export async function blastTransactions(
  prepared: { address: string; rawTx: string; txHash: string }[],
  rpcUrls: string[],
  chainId: bigint,
  attempt: number = 1,
): Promise<MintResult[]> {
  const results: MintResult[] = [];

  for (const p of prepared) {
    const firePromises = rpcUrls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: [p.rawTx],
          id: 1,
        }),
      })
        .then(async (res) => {
          const json = (await res.json()) as any;
          return { url, result: json.result, error: json.error };
        })
        .catch((err) => ({
          url,
          result: null,
          error: { message: err.message },
        })),
    );

    const responses = await Promise.allSettled(firePromises);
    const accepted = responses.some(
      (r) =>
        r.status === "fulfilled" &&
        (r.value.result ||
          (r.value.error?.message || "").includes("already known")),
    );

    results.push({
      walletIndex: prepared.indexOf(p),
      address: p.address,
      txHash: p.txHash,
      attempt,
      status: accepted ? "dispatched" : "rejected",
      explorerUrl: explorerTx(chainId, p.txHash),
      error: accepted
        ? undefined
        : "Rejected by RPCs: " +
          responses
            .filter(
              (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
            )
            .map((r) => r.value.error?.message || "unknown")
            .filter(Boolean)
            .join("; "),
    });
  }

  return results;
}

// Fast poll for transaction receipt (polls every 500ms for instant confirmation)
export async function waitForReceipt(
  txHash: string,
  rpcUrl: string,
  timeoutMs: number = 20_000,
): Promise<{ block: number; gasUsed: string; status: string } | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [txHash],
          id: 1,
        }),
      });
      const json = (await res.json()) as any;
      const receipt = json.result;

      if (receipt && receipt.blockNumber) {
        return {
          block: parseInt(receipt.blockNumber, 16),
          gasUsed: BigInt(receipt.gasUsed).toString(),
          status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}

/**
 * Fully Autonomous Snipe Execution Pipeline:
 * 1. Fires Attempt 1 immediately when the mint window begins.
 * 2. Immediately verifies receipt status.
 * 3. If SUCCESS: terminates immediately, cancels remaining attempts, and returns confirmation report.
 * 4. Only fires Attempt 2/3 if previous attempt genuinely failed (reverted, rejected, or timed out).
 */
export async function executeSnipe(
  walletKeys: string[],
  plan: MintPlan,
  rpcUrls: string[],
  baseMaxFee: bigint,
  basePriorityFee: bigint,
  gasLimit: number,
  chainId: bigint,
  onLog: (log: LogEntry) => void,
  maxAttempts: number = 3,
): Promise<SnipeExecutionReport> {
  const allResults: MintResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Dynamic fee bumping on retries (+20% priority fee per retry attempt for fast replacement)
    const multiplier = BigInt(Math.floor(100 + (attempt - 1) * 20));
    const currentMaxFee = (baseMaxFee * multiplier) / 100n;
    const currentPriorityFee = (basePriorityFee * multiplier) / 100n;

    onLog({
      timestamp: new Date(),
      message: `[Attempt ${attempt}/${maxAttempts}] Signing transactions for ${walletKeys.length} wallet(s)...`,
      type: "info",
    });

    let preparedData;
    try {
      preparedData = await signTransactions(
        walletKeys,
        plan,
        rpcUrls[0],
        currentMaxFee,
        currentPriorityFee,
        gasLimit,
      );
    } catch (err: any) {
      onLog({
        timestamp: new Date(),
        message: `[Attempt ${attempt}/${maxAttempts}] ❌ Signing failed: ${err.message}`,
        type: "error",
      });
      if (attempt < maxAttempts) {
        onLog({
          timestamp: new Date(),
          message: `🔄 Retrying with Attempt ${attempt + 1}/${maxAttempts}...`,
          type: "warning",
        });
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return {
        confirmed: false,
        attemptsRun: attempt,
        results: allResults,
        error: `Signing failed on all attempts: ${err.message}`,
      };
    }

    const { prepared, chainId: liveChainId } = preparedData;

    onLog({
      timestamp: new Date(),
      message: `[Attempt ${attempt}/${maxAttempts}] 🚀 Blasting to ${rpcUrls.length} RPC endpoint(s)...`,
      type: "info",
    });

    const results = await blastTransactions(prepared, rpcUrls, liveChainId, attempt);
    allResults.push(...results);

    const dispatched = results.filter((r) => r.status === "dispatched");

    for (const r of results) {
      if (r.status === "dispatched") {
        onLog({
          timestamp: new Date(),
          message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] Dispatched TX: ${r.txHash}`,
          type: "success",
        });
      } else {
        onLog({
          timestamp: new Date(),
          message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] ⚠️ RPC Rejected: ${r.error}`,
          type: "error",
        });
      }
    }

    // Immediately verify on-chain receipt for dispatched transactions
    if (dispatched.length > 0) {
      onLog({
        timestamp: new Date(),
        message: `[Attempt ${attempt}/${maxAttempts}] Verifying on-chain receipt...`,
        type: "info",
      });

      let confirmedResult: MintResult | undefined;

      await Promise.all(
        dispatched.map(async (r) => {
          // Poll up to 18 seconds per attempt
          const receipt = await waitForReceipt(r.txHash, rpcUrls[0], 18_000);
          if (receipt) {
            if (receipt.status === "SUCCESS") {
              r.status = "confirmed";
              r.blockNumber = receipt.block;
              r.gasUsed = receipt.gasUsed;
              confirmedResult = r;
              onLog({
                timestamp: new Date(),
                message: `[Attempt ${attempt}/${maxAttempts}] ✅ MINT CONFIRMED in Block ${receipt.block} (Gas: ${receipt.gasUsed})!`,
                type: "success",
              });
            } else {
              r.status = "failed";
              r.blockNumber = receipt.block;
              r.gasUsed = receipt.gasUsed;
              onLog({
                timestamp: new Date(),
                message: `[Attempt ${attempt}/${maxAttempts}] ❌ Transaction reverted on-chain in Block ${receipt.block}.`,
                type: "error",
              });
            }
          } else {
            r.status = "timeout";
            onLog({
              timestamp: new Date(),
              message: `[Attempt ${attempt}/${maxAttempts}] ⏳ Transaction confirmation timed out.`,
              type: "warning",
            });
          }
        }),
      );

      // SUCCESS: Stop all remaining attempts immediately!
      if (confirmedResult) {
        onLog({
          timestamp: new Date(),
          message: `🎉 Mint successful on Attempt ${attempt} of ${maxAttempts}! Cancelling all remaining attempts.`,
          type: "success",
        });
        return {
          confirmed: true,
          successfulAttempt: attempt,
          attemptsRun: attempt,
          results: allResults,
          confirmedResult,
        };
      }
    }

    // Only proceed to Attempt 2/3 if the previous attempt genuinely failed or timed out
    if (attempt < maxAttempts) {
      onLog({
        timestamp: new Date(),
        message: `⚠️ Attempt ${attempt}/${maxAttempts} did not succeed. Triggering Attempt ${attempt + 1}/${maxAttempts} autonomously...`,
        type: "warning",
      });
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // All 3 attempts exhausted without success
  onLog({
    timestamp: new Date(),
    message: `❌ All ${maxAttempts} sequential attempts finished without confirmation.`,
    type: "error",
  });

  return {
    confirmed: false,
    attemptsRun: maxAttempts,
    results: allResults,
    error: `All ${maxAttempts} sequential attempts failed or timed out.`,
  };
}
