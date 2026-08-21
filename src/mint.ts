// Transaction signing, multi-RPC blasting, and receipt polling.
// Adapted from the original local-mint.ts for async Telegram bot execution.

import { JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { MintPlan } from "./seadrop";
import { LogEntry } from "./session";
import { explorerTx } from "./chains";

export interface MintResult {
  walletIndex: number;
  address: string;
  txHash: string;
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
      status: accepted ? "dispatched" : "rejected",
      explorerUrl: explorerTx(chainId, p.txHash),
      error: accepted
        ? undefined
        : "Rejected by all RPCs: " +
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

// Poll for transaction receipt
export async function waitForReceipt(
  txHash: string,
  rpcUrl: string,
  timeoutMs: number = 60_000,
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

      if (receipt) {
        return {
          block: parseInt(receipt.blockNumber, 16),
          gasUsed: BigInt(receipt.gasUsed).toString(),
          status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  return null;
}

// Execute sequential snipe with up to maxAttempts (default 3), stopping immediately on first confirmation
export async function executeSnipe(
  walletKeys: string[],
  plan: MintPlan,
  rpcUrls: string[],
  maxFeePerGas: bigint,
  maxPriorityFee: bigint,
  gasLimit: number,
  chainId: bigint,
  onLog: (log: LogEntry) => void,
  maxAttempts: number = 3,
): Promise<MintResult[]> {
  const allResults: MintResult[] = [];
  let confirmed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onLog({
      timestamp: new Date(),
      message: `[Attempt ${attempt}/${maxAttempts}] Signing & preparing ${walletKeys.length} wallet transaction(s)...`,
      type: "info",
    });

    let preparedData;
    try {
      preparedData = await signTransactions(
        walletKeys,
        plan,
        rpcUrls[0],
        maxFeePerGas,
        maxPriorityFee,
        gasLimit,
      );
    } catch (err: any) {
      onLog({
        timestamp: new Date(),
        message: `[Attempt ${attempt}/${maxAttempts}] ❌ Signing failed: ${err.message}`,
        type: "error",
      });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      break;
    }

    const { prepared, chainId: liveChainId } = preparedData;

    onLog({
      timestamp: new Date(),
      message: `[Attempt ${attempt}/${maxAttempts}] 🚀 Blasting to ${rpcUrls.length} RPC endpoint(s)...`,
      type: "info",
    });

    const results = await blastTransactions(prepared, rpcUrls, liveChainId);
    allResults.push(...results);

    for (const r of results) {
      if (r.status === "dispatched") {
        onLog({
          timestamp: new Date(),
          message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] TX: ${r.txHash}`,
          type: "success",
        });
      } else {
        onLog({
          timestamp: new Date(),
          message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] REJECTED: ${r.error}`,
          type: "error",
        });
      }
    }

    // Wait for receipts on accepted transactions (20s timeout per attempt)
    const dispatched = results.filter((r) => r.status === "dispatched");
    if (dispatched.length > 0) {
      onLog({
        timestamp: new Date(),
        message: `[Attempt ${attempt}/${maxAttempts}] Checking on-chain receipt...`,
        type: "info",
      });

      const receiptStatuses = await Promise.all(
        dispatched.map(async (r) => {
          const receipt = await waitForReceipt(r.txHash, rpcUrls[0], 20_000);
          if (receipt) {
            r.status = receipt.status === "SUCCESS" ? "confirmed" : "failed";
            r.blockNumber = receipt.block;
            r.gasUsed = receipt.gasUsed;
            onLog({
              timestamp: new Date(),
              message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] Block: ${receipt.block} | ${receipt.status} | Gas: ${receipt.gasUsed}`,
              type: receipt.status === "SUCCESS" ? "success" : "error",
            });
            return receipt.status === "SUCCESS";
          } else {
            r.status = "timeout";
            onLog({
              timestamp: new Date(),
              message: `[Attempt ${attempt}/${maxAttempts}] [${r.address.slice(0, 10)}...] Timeout waiting for confirmation.`,
              type: "warning",
            });
            return false;
          }
        }),
      );

      // If at least one transaction confirmed successfully, STOP IMMEDIATELY!
      if (receiptStatuses.some(Boolean)) {
        confirmed = true;
        onLog({
          timestamp: new Date(),
          message: `🎯 SUCCESS on attempt ${attempt}/${maxAttempts}! Stopping further retry attempts.`,
          type: "success",
        });
        return results;
      }
    }

    if (attempt < maxAttempts) {
      onLog({
        timestamp: new Date(),
        message: `⚠️ Attempt ${attempt}/${maxAttempts} did not confirm. Firing attempt ${attempt + 1}/${maxAttempts} sequentially...`,
        type: "warning",
      });
      // Short breather before next sequential attempt
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!confirmed) {
    onLog({
      timestamp: new Date(),
      message: `❌ Completed all ${maxAttempts} sequential attempts without confirmation.`,
      type: "error",
    });
  }

  return allResults.length > 0 ? allResults : [];
}
