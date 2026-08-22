// Ultra-low-latency pre-signing execution engine, multi-RPC concurrent blasting, and high-frequency receipt polling.
// Pre-signs all attempts ahead of time so T-0 execution has 0ms preparation latency.
// Persistent keep-alive RPC connection pool, dynamic fee escalation, and instant stop-on-success.

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
  dispatchLatencyMs?: number;
}

export interface SnipeExecutionReport {
  confirmed: boolean;
  successfulAttempt?: number;
  attemptsRun: number;
  results: MintResult[];
  confirmedResult?: MintResult;
  error?: string;
  totalExecutionMs?: number;
}

export interface SnipeProgressCallbackData {
  phase:
    | "preparing"
    | "armed"
    | "dispatched"
    | "confirming"
    | "succeeded"
    | "retrying"
    | "failed";
  attempt: number;
  maxAttempts: number;
  txHashes?: string[];
  explorerUrls?: string[];
  blockNumber?: number;
  gasUsed?: string;
  walletAddress?: string;
  error?: string;
  dispatchLatencyMs?: number;
  elapsedMs?: number;
}

export type SnipeProgressCallback = (
  update: SnipeProgressCallbackData,
) => Promise<void> | void;

export interface PreparedTransaction {
  address: string;
  rawTx: string;
  txHash: string;
  nonce: number;
}

export interface ArmedAttempt {
  attemptNumber: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  transactions: PreparedTransaction[];
}

export interface ArmedSnipe {
  id: string;
  contractAddress: string;
  quantity: number;
  plan: MintPlan;
  chainId: bigint;
  walletAddresses: string[];
  attempts: [ArmedAttempt, ArmedAttempt, ArmedAttempt]; // Pre-signed attempts 1, 2, and 3
  armedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENT RPC PROVIDER & CONNECTION POOL
// ─────────────────────────────────────────────────────────────────────────────
const providerCache = new Map<string, JsonRpcProvider>();

export function getCachedProvider(rpcUrl: string): JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
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

/**
 * Pre-warms TCP/TLS connections to all RPC endpoints.
 * Keeps keep-alive sockets open and ready so T-0 execution has 0ms connection setup overhead.
 */
export async function warmRpcConnections(rpcUrls: string[]): Promise<void> {
  const pings = rpcUrls.map(async (url) => {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "keep-alive",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "net_version",
          params: [],
          id: 99,
        }),
      });
    } catch {}
  });
  await Promise.allSettled(pings);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SIGNING PIPELINE (WELL BEFORE T-0)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-fetches nonces and chain network info for all minter wallets.
 */
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

/**
 * Pre-signs ALL 3 execution attempts ahead of time in memory.
 * - Attempt 1: Base gas + Base tip
 * - Attempt 2: Base gas + 25% Boosted tip (same nonce, instant replacement)
 * - Attempt 3: Base gas + 50% Boosted tip (same nonce, instant replacement)
 * 
 * At T-0, 0 signing or network queries occur — already-signed raw bytes are broadcast instantly.
 */
export async function preSignAllAttempts(
  walletKeys: string[],
  plan: MintPlan,
  rpcUrl: string,
  baseMaxFee: bigint,
  basePriorityFee: bigint,
  gasLimit: number = 250_000,
  snipeId: string = `snipe_${Date.now()}`,
): Promise<ArmedSnipe> {
  const { wallets, nonces, chainId } = await prepareWallets(walletKeys, rpcUrl);

  const attemptConfigs = [
    { num: 1, multiplier: 100n }, // Base fee
    { num: 2, multiplier: 125n }, // +25% tip boost
    { num: 3, multiplier: 150n }, // +50% tip boost
  ];

  const attempts = await Promise.all(
    attemptConfigs.map(async ({ num, multiplier }) => {
      const currentMaxFee = (baseMaxFee * multiplier) / 100n;
      const currentPriorityFee = (basePriorityFee * multiplier) / 100n;

      const transactions: PreparedTransaction[] = [];

      for (let i = 0; i < wallets.length; i++) {
        const rawTx = await wallets[i].signTransaction({
          to: plan.to,
          data: plan.data,
          value: plan.value,
          nonce: nonces[i],
          maxFeePerGas: currentMaxFee,
          maxPriorityFeePerGas: currentPriorityFee,
          gasLimit: gasLimit || 250_000,
          type: 2,
          chainId: Number(chainId),
        });

        transactions.push({
          address: wallets[i].address,
          rawTx,
          txHash: keccak256(rawTx),
          nonce: nonces[i],
        });
      }

      return {
        attemptNumber: num,
        maxFeePerGas: currentMaxFee,
        maxPriorityFeePerGas: currentPriorityFee,
        transactions,
      } as ArmedAttempt;
    }),
  );

  return {
    id: snipeId,
    contractAddress: plan.drop ? plan.to : "",
    quantity: 1,
    plan,
    chainId,
    walletAddresses: wallets.map((w) => w.address),
    attempts: attempts as [ArmedAttempt, ArmedAttempt, ArmedAttempt],
    armedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTANT RAW TRANSACTION BROADCASTER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Concurrently blasts pre-signed raw transaction bytes across ALL configured RPC endpoints.
 * Preparation overhead at T-0: 0ms.
 */
export async function blastPreparedTransactions(
  prepared: PreparedTransaction[],
  rpcUrls: string[],
  chainId: bigint,
  attempt: number = 1,
): Promise<{ results: MintResult[]; dispatchLatencyMs: number }> {
  const startDispatch = Date.now();

  const results = await Promise.all(
    prepared.map(async (p, idx) => {
      let accepted = false;
      let firstAcceptedTime = 0;
      const responses: Array<{ url: string; result?: any; error?: any }> = [];

      const sendToRpc = async (url: string) => {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              connection: "keep-alive",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_sendRawTransaction",
              params: [p.rawTx],
              id: idx + 1,
            }),
          });
          const json = (await res.json()) as any;
          responses.push({ url, result: json.result, error: json.error });
          if (
            json.result ||
            (json.error?.message || "").includes("already known") ||
            (json.error?.message || "").includes("nonce too low")
          ) {
            accepted = true;
            if (!firstAcceptedTime) firstAcceptedTime = Date.now() - startDispatch;
            return true;
          }
          return false;
        } catch (err: any) {
          responses.push({ url, error: { message: err.message } });
          return false;
        }
      };

      // Launch across all RPCs concurrently in parallel
      const promises = rpcUrls.map(sendToRpc);

      // Fast-path: returns the moment the first RPC accepts, or when all finish
      await Promise.race([
        Promise.any(
          promises.map((pr) =>
            pr.then((ok) => {
              if (ok) return true;
              throw new Error("RPC rejected");
            }),
          ),
        ),
        Promise.allSettled(promises),
      ]).catch(() => {});

      const dispatchLatencyMs = firstAcceptedTime || Date.now() - startDispatch;

      return {
        walletIndex: idx,
        address: p.address,
        txHash: p.txHash,
        attempt,
        status: accepted ? ("dispatched" as const) : ("rejected" as const),
        explorerUrl: explorerTx(chainId, p.txHash),
        dispatchLatencyMs,
        error: accepted
          ? undefined
          : "Rejected by RPCs: " +
            responses
              .map((r) => r.error?.message || "unknown")
              .filter(Boolean)
              .join("; "),
      };
    }),
  );

  const totalDispatchMs = Date.now() - startDispatch;
  return { results, dispatchLatencyMs: totalDispatchMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-FREQUENCY SUB-SECOND RECEIPT POLLING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ultra-fast receipt polling across all RPC endpoints concurrently (polls every 200ms).
 */
export async function waitForReceipt(
  txHash: string,
  rpcUrls: string[],
  timeoutMs: number = 12_000,
): Promise<{ block: number; gasUsed: string; status: string } | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const checkPromises = rpcUrls.map((url) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            connection: "keep-alive",
          },
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
    await new Promise((r) => setTimeout(r, 200));
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ULTRA-FAST ARMED SNIPE EXECUTOR (T-0 CALLABLE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a pre-signed ArmedSnipe payload with sub-millisecond dispatch at T-0.
 * Zero signing or network query delays at T-0.
 */
export async function executeArmedSnipe(
  armedSnipe: ArmedSnipe,
  rpcUrls: string[],
  onLog: (log: LogEntry) => void,
  onProgress?: SnipeProgressCallback,
  perAttemptTimeoutMs: number = 4_000,
): Promise<SnipeExecutionReport> {
  const startTime = Date.now();
  const allResults: MintResult[] = [];
  const maxAttempts = armedSnipe.attempts.length;

  for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
    const attemptData = armedSnipe.attempts[attemptIdx];
    const attemptNum = attemptData.attemptNumber;

    onLog({
      timestamp: new Date().toISOString(),
      message: `[Attempt ${attemptNum}/${maxAttempts}] 🚀 Blasting pre-signed raw bytes across ${rpcUrls.length} RPCs...`,
      type: "info",
    });

    // Sub-millisecond raw byte blast
    const { results, dispatchLatencyMs } = await blastPreparedTransactions(
      attemptData.transactions,
      rpcUrls,
      armedSnipe.chainId,
      attemptNum,
    );
    allResults.push(...results);

    const dispatched = results.filter((r) => r.status === "dispatched");
    const txHashes = results.map((r) => r.txHash);
    const explorerUrls = results.map((r) => r.explorerUrl);

    for (const r of results) {
      if (r.status === "dispatched") {
        onLog({
          timestamp: new Date().toISOString(),
          message: `[Attempt ${attemptNum}/${maxAttempts}] [${r.address.slice(0, 10)}...] Dispatched in ${dispatchLatencyMs}ms: ${r.txHash}`,
          type: "success",
        });
      } else {
        onLog({
          timestamp: new Date().toISOString(),
          message: `[Attempt ${attemptNum}/${maxAttempts}] [${r.address.slice(0, 10)}...] ⚠️ RPC Rejected: ${r.error}`,
          type: "error",
        });
      }
    }

    if (onProgress) {
      await onProgress({
        phase: "dispatched",
        attempt: attemptNum,
        maxAttempts,
        txHashes,
        explorerUrls,
        dispatchLatencyMs,
        elapsedMs: Date.now() - startTime,
      });
    }

    // Check confirmation for dispatched transactions
    if (dispatched.length > 0) {
      onLog({
        timestamp: new Date().toISOString(),
        message: `[Attempt ${attemptNum}/${maxAttempts}] ⏳ Monitoring on-chain inclusion (200ms polling)...`,
        type: "info",
      });

      if (onProgress) {
        await onProgress({
          phase: "confirming",
          attempt: attemptNum,
          maxAttempts,
          txHashes,
          explorerUrls,
          elapsedMs: Date.now() - startTime,
        });
      }

      let confirmedResult: MintResult | undefined;

      await Promise.all(
        dispatched.map(async (r) => {
          const receipt = await waitForReceipt(
            r.txHash,
            rpcUrls,
            perAttemptTimeoutMs,
          );
          if (receipt) {
            if (receipt.status === "SUCCESS") {
              r.status = "confirmed";
              r.blockNumber = receipt.block;
              r.gasUsed = receipt.gasUsed;
              confirmedResult = r;
              onLog({
                timestamp: new Date().toISOString(),
                message: `[Attempt ${attemptNum}/${maxAttempts}] ✅ MINT CONFIRMED in Block ${receipt.block} (Gas: ${receipt.gasUsed})!`,
                type: "success",
              });
            } else {
              r.status = "failed";
              r.blockNumber = receipt.block;
              r.gasUsed = receipt.gasUsed;
              onLog({
                timestamp: new Date().toISOString(),
                message: `[Attempt ${attemptNum}/${maxAttempts}] ❌ Transaction reverted on-chain in Block ${receipt.block}.`,
                type: "error",
              });
            }
          } else {
            r.status = "timeout";
            onLog({
              timestamp: new Date().toISOString(),
              message: `[Attempt ${attemptNum}/${maxAttempts}] ⏳ Block inclusion timeout (${perAttemptTimeoutMs}ms).`,
              type: "warning",
            });
          }
        }),
      );

      // SUCCESS: Stop all remaining attempts immediately!
      if (confirmedResult) {
        onLog({
          timestamp: new Date().toISOString(),
          message: `🎯 Mint confirmed on Attempt ${attemptNum} of ${maxAttempts}! Stopped remaining attempts. Total time: ${Date.now() - startTime}ms.`,
          type: "success",
        });

        if (onProgress) {
          await onProgress({
            phase: "succeeded",
            attempt: attemptNum,
            maxAttempts,
            txHashes: [confirmedResult.txHash],
            explorerUrls: [confirmedResult.explorerUrl],
            blockNumber: confirmedResult.blockNumber,
            gasUsed: confirmedResult.gasUsed,
            walletAddress: confirmedResult.address,
            elapsedMs: Date.now() - startTime,
          });
        }

        return {
          confirmed: true,
          successfulAttempt: attemptNum,
          attemptsRun: attemptNum,
          results: allResults,
          confirmedResult,
          totalExecutionMs: Date.now() - startTime,
        };
      }
    }

    // If previous attempt did not confirm and retries remain, trigger next pre-signed attempt immediately
    if (attemptIdx + 1 < maxAttempts) {
      const nextAttemptNum = armedSnipe.attempts[attemptIdx + 1].attemptNumber;
      onLog({
        timestamp: new Date().toISOString(),
        message: `⚠️ Attempt ${attemptNum}/${maxAttempts} did not confirm. Instantly triggering pre-signed Attempt ${nextAttemptNum}/${maxAttempts} (+25% fee boost)...`,
        type: "warning",
      });

      if (onProgress) {
        await onProgress({
          phase: "retrying",
          attempt: nextAttemptNum,
          maxAttempts,
          elapsedMs: Date.now() - startTime,
        });
      }
    }
  }

  // All attempts finished without confirmation
  onLog({
    timestamp: new Date().toISOString(),
    message: `❌ All ${maxAttempts} sequential attempts finished without confirmation. Total time: ${Date.now() - startTime}ms.`,
    type: "error",
  });

  if (onProgress) {
    await onProgress({
      phase: "failed",
      attempt: maxAttempts,
      maxAttempts,
      error: `All ${maxAttempts} attempts completed without confirmation.`,
      elapsedMs: Date.now() - startTime,
    });
  }

  return {
    confirmed: false,
    attemptsRun: maxAttempts,
    results: allResults,
    error: `All ${maxAttempts} sequential attempts failed or timed out.`,
    totalExecutionMs: Date.now() - startTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKWARD-COMPATIBLE ON-DEMAND EXECUTE SNIPE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * On-demand sniper executor (for immediate execution or when pre-signing occurs on the fly).
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
  // Pre-sign all 3 attempts in parallel
  if (onProgress) {
    await onProgress({
      phase: "preparing",
      attempt: 1,
      maxAttempts,
    });
  }

  const armedSnipe = await preSignAllAttempts(
    walletKeys,
    plan,
    rpcUrls[0],
    baseMaxFee,
    basePriorityFee,
    gasLimit,
  );

  return executeArmedSnipe(armedSnipe, rpcUrls, onLog, onProgress);
}
