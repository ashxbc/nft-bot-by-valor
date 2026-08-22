// Ultra-low-latency transaction signing, multi-RPC concurrent blasting, and high-frequency receipt polling.
// Autonomous execution engine with pre-signing, zero-friction automated progress updates, and stop-on-success.

import { JsonRpcProvider, Wallet, keccak256, formatEther } from "ethers";
import { MintPlan, fetchPublicDrop, buildMintPlan } from "./seadrop";
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

export type SnipeProgressCallback = (update: {
  phase: "preparing" | "dispatched" | "confirming" | "succeeded" | "retrying" | "failed";
  attempt: number;
  maxAttempts: number;
  txHashes?: string[];
  explorerUrls?: string[];
  blockNumber?: number;
  gasUsed?: string;
  walletAddress?: string;
  error?: string;
}) => Promise<void> | void;

// Provider cache to avoid re-instantiating providers and TLS handshakes
const providerCache = new Map<string, JsonRpcProvider>();

export function getCachedProvider(rpcUrl: string): JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    providerCache.set(rpcUrl, p);
  }
  return p;
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

// Pre-fetch nonces and warm provider connections
export async function prepareWallets(
  walletKeys: string[],
  rpcUrl: string,
): Promise<{ wallets: Wallet[]; nonces: number[]; chainId: bigint }> {
  const provider = getCachedProvider(rpcUrl);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  const [nonces, network] = await Promise.all([
    Promise.all(
      wallets.map((w) => provider.getTransactionCount(w.address, "pending")),
    ),
    provider.getNetwork(),
  ]);

  return { wallets, nonces, chainId: network.chainId };
}

export interface PreparedTransaction {
  address: string;
  rawTx: string;
  txHash: string;
}

// Pre-sign all transactions into serialized raw bytes in memory
export async function signTransactions(
  walletKeys: string[],
  plan: MintPlan,
  rpcUrl: string,
  maxFeePerGas: bigint,
  maxPriorityFee: bigint,
  gasLimit: number,
): Promise<{
  prepared: PreparedTransaction[];
  chainId: bigint;
  baseFee: bigint;
}> {
  const { wallets, nonces, chainId } = await prepareWallets(walletKeys, rpcUrl);
  const provider = getCachedProvider(rpcUrl);
  const feeData = await provider.getFeeData();
  const baseFee = feeData.gasPrice || 0n;

  const prepared: PreparedTransaction[] = [];

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

// Blast raw transactions to all RPC endpoints concurrently in parallel (millisecond latency)
export async function blastTransactions(
  prepared: PreparedTransaction[],
  rpcUrls: string[],
  chainId: bigint,
  attempt: number = 1,
): Promise<MintResult[]> {
  const results = await Promise.all(
    prepared.map(async (p, idx) => {
      // Fire to all RPC URLs simultaneously
      const firePromises = rpcUrls.map((url) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_sendRawTransaction",
            params: [p.rawTx],
            id: idx + 1,
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
            (r.value.error?.message || "").includes("already known") ||
            (r.value.error?.message || "").includes("nonce too low")),
      );

      return {
        walletIndex: idx,
        address: p.address,
        txHash: p.txHash,
        attempt,
        status: accepted ? ("dispatched" as const) : ("rejected" as const),
        explorerUrl: explorerTx(chainId, p.txHash),
        error: accepted
          ? undefined
          : "Rejected by RPCs: " +
            responses
              .filter(
                (r): r is PromiseFulfilledResult<any> =>
                  r.status === "fulfilled",
              )
              .map((r) => r.value.error?.message || "unknown")
              .filter(Boolean)
              .join("; "),
      };
    }),
  );

  return results;
}

// Ultra-fast receipt polling across all RPC endpoints (polls every 250ms for sub-second confirmation)
export async function waitForReceipt(
  txHash: string,
  rpcUrls: string[],
  timeoutMs: number = 15_000,
): Promise<{ block: number; gasUsed: string; status: string } | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const checkPromises = rpcUrls.map((url) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [txHash],
            id: 1,
          }),
        })
          .then(async (res) => (await res.json()) as any)
          .catch(() => null),
      );

      const responses = await Promise.allSettled(checkPromises);
      for (const resp of responses) {
        if (resp.status === "fulfilled" && resp.value?.result?.blockNumber) {
          const receipt = resp.value.result;
          return {
            block: parseInt(receipt.blockNumber, 16),
            gasUsed: BigInt(receipt.gasUsed).toString(),
            status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
          };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
}

/**
 * Fully Autonomous Snipe Execution Pipeline:
 * 1. Automatically pre-signs and pre-warms provider connections.
 * 2. Concurrently blasts transactions to all RPC endpoints with 0ms latency at execution moment.
 * 3. Monitors on-chain confirmation in tight 250ms sub-second intervals.
 * 4. Pushes live automated progress callbacks to Telegram without requiring any user click.
 * 5. On SUCCESS: terminates immediately, cancels remaining attempts, and returns confirmation report.
 * 6. Only fires Attempt 2/3 if previous attempt genuinely failed (reverted, rejected, or timed out).
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
  onProgress?: SnipeProgressCallback,
): Promise<SnipeExecutionReport> {
  const allResults: MintResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Dynamic fee bumping on retries (+25% priority fee per retry attempt for instant mempool replacement)
    const multiplier = BigInt(Math.floor(100 + (attempt - 1) * 25));
    const currentMaxFee = (baseMaxFee * multiplier) / 100n;
    const currentPriorityFee = (basePriorityFee * multiplier) / 100n;

    onLog({
      timestamp: new Date(),
      message: `[Attempt ${attempt}/${maxAttempts}] Pre-signing raw transaction(s) for ${walletKeys.length} wallet(s)...`,
      type: "info",
    });

    if (onProgress) {
      await onProgress({
        phase: "preparing",
        attempt,
        maxAttempts,
      });
    }

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
        message: `[Attempt ${attempt}/${maxAttempts}] ❌ Signing error: ${err.message}`,
        type: "error",
      });
      if (attempt < maxAttempts) {
        onLog({
          timestamp: new Date(),
          message: `🔄 Proceeding to Attempt ${attempt + 1}/${maxAttempts}...`,
          type: "warning",
        });
        if (onProgress) {
          await onProgress({
            phase: "retrying",
            attempt,
            maxAttempts,
            error: `Signing failed: ${err.message}`,
          });
        }
        await new Promise((r) => setTimeout(r, 400));
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
      message: `[Attempt ${attempt}/${maxAttempts}] 🚀 Blasting concurrently across ${rpcUrls.length} RPCs...`,
      type: "info",
    });

    // Zero-delay parallel blast
    const results = await blastTransactions(
      prepared,
      rpcUrls,
      liveChainId,
      attempt,
    );
    allResults.push(...results);

    const dispatched = results.filter((r) => r.status === "dispatched");
    const txHashes = results.map((r) => r.txHash);
    const explorerUrls = results.map((r) => r.explorerUrl);

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

    if (onProgress) {
      await onProgress({
        phase: "dispatched",
        attempt,
        maxAttempts,
        txHashes,
        explorerUrls,
      });
    }

    // Immediately verify on-chain receipt for dispatched transactions
    if (dispatched.length > 0) {
      onLog({
        timestamp: new Date(),
        message: `[Attempt ${attempt}/${maxAttempts}] Monitoring on-chain block inclusion (250ms polling)...`,
        type: "info",
      });

      if (onProgress) {
        await onProgress({
          phase: "confirming",
          attempt,
          maxAttempts,
          txHashes,
          explorerUrls,
        });
      }

      let confirmedResult: MintResult | undefined;

      await Promise.all(
        dispatched.map(async (r) => {
          // Poll up to 15 seconds per attempt
          const receipt = await waitForReceipt(r.txHash, rpcUrls, 15_000);
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
          message: `🎯 Mint confirmed on Attempt ${attempt} of ${maxAttempts}! Stopped remaining attempts.`,
          type: "success",
        });

        if (onProgress) {
          await onProgress({
            phase: "succeeded",
            attempt,
            maxAttempts,
            txHashes: [confirmedResult.txHash],
            explorerUrls: [confirmedResult.explorerUrl],
            blockNumber: confirmedResult.blockNumber,
            gasUsed: confirmedResult.gasUsed,
            walletAddress: confirmedResult.address,
          });
        }

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
        message: `⚠️ Attempt ${attempt}/${maxAttempts} did not confirm. Triggering Attempt ${attempt + 1}/${maxAttempts} autonomously with boosted priority fee...`,
        type: "warning",
      });
      if (onProgress) {
        await onProgress({
          phase: "retrying",
          attempt: attempt + 1,
          maxAttempts,
        });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // All sequential attempts exhausted
  onLog({
    timestamp: new Date(),
    message: `❌ All ${maxAttempts} sequential attempts finished without confirmation.`,
    type: "error",
  });

  if (onProgress) {
    await onProgress({
      phase: "failed",
      attempt: maxAttempts,
      maxAttempts,
      error: `All ${maxAttempts} attempts completed without confirmation.`,
    });
  }

  return {
    confirmed: false,
    attemptsRun: maxAttempts,
    results: allResults,
    error: `All ${maxAttempts} sequential attempts failed or timed out.`,
  };
}
