"use strict";
// Transaction signing, multi-RPC blasting, and receipt polling.
// Adapted from the original local-mint.ts for async Telegram bot execution.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRpcUrls = resolveRpcUrls;
exports.signTransactions = signTransactions;
exports.blastTransactions = blastTransactions;
exports.waitForReceipt = waitForReceipt;
exports.executeSnipe = executeSnipe;
const ethers_1 = require("ethers");
const chains_1 = require("./chains");
// Resolve RPC URLs: custom > env default > chain defaults
function resolveRpcUrls(customRpc, additionalRpcEnv) {
    const urls = [];
    if (customRpc)
        urls.push(customRpc);
    const defaultRpc = process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
    urls.push(defaultRpc);
    if (additionalRpcEnv) {
        urls.push(...additionalRpcEnv.split(",").filter(Boolean));
    }
    return [...new Set(urls)];
}
// Pre-fetch nonces and warm connections
async function prepareWallets(walletKeys, rpcUrl) {
    const provider = new ethers_1.JsonRpcProvider(rpcUrl);
    const wallets = walletKeys.map((k) => new ethers_1.Wallet(k, provider));
    const [nonces, network] = await Promise.all([
        Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
        provider.getNetwork(),
    ]);
    return { wallets, nonces, chainId: network.chainId };
}
// Sign all transactions before the fire moment
async function signTransactions(walletKeys, plan, rpcUrl, maxFeePerGas, maxPriorityFee, gasLimit) {
    const { wallets, nonces, chainId } = await prepareWallets(walletKeys, rpcUrl);
    const provider = new ethers_1.JsonRpcProvider(rpcUrl);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.gasPrice || 0n;
    const prepared = [];
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
            txHash: (0, ethers_1.keccak256)(rawTx),
        });
    }
    return { prepared, chainId, baseFee };
}
// Blast raw transactions to all RPC endpoints simultaneously
async function blastTransactions(prepared, rpcUrls, chainId) {
    const results = [];
    for (const p of prepared) {
        const firePromises = rpcUrls.map((url) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "eth_sendRawTransaction",
                params: [p.rawTx],
                id: 1,
            }),
        }).then(async (res) => {
            const json = (await res.json());
            return { url, result: json.result, error: json.error };
        }).catch((err) => ({
            url,
            result: null,
            error: { message: err.message },
        })));
        const responses = await Promise.allSettled(firePromises);
        const accepted = responses.some((r) => r.status === "fulfilled" &&
            (r.value.result || (r.value.error?.message || "").includes("already known")));
        results.push({
            walletIndex: prepared.indexOf(p),
            address: p.address,
            txHash: p.txHash,
            status: accepted ? "dispatched" : "rejected",
            explorerUrl: (0, chains_1.explorerTx)(chainId, p.txHash),
            error: accepted
                ? undefined
                : "Rejected by all RPCs: " +
                    responses
                        .filter((r) => r.status === "fulfilled")
                        .map((r) => r.value.error?.message || "unknown")
                        .filter(Boolean)
                        .join("; "),
        });
    }
    return results;
}
// Poll for transaction receipt
async function waitForReceipt(txHash, rpcUrl, timeoutMs = 60_000) {
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
            const json = (await res.json());
            const receipt = json.result;
            if (receipt) {
                return {
                    block: parseInt(receipt.blockNumber, 16),
                    gasUsed: BigInt(receipt.gasUsed).toString(),
                    status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
                };
            }
        }
        catch { }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
}
// Execute a full snipe: sign → blast → wait for receipts
async function executeSnipe(walletKeys, plan, rpcUrls, maxFeePerGas, maxPriorityFee, gasLimit, chainId, onLog) {
    onLog({
        timestamp: new Date(),
        message: `Signing transactions for ${walletKeys.length} wallet(s)...`,
        type: "info",
    });
    const { prepared, chainId: liveChainId } = await signTransactions(walletKeys, plan, rpcUrls[0], maxFeePerGas, maxPriorityFee, gasLimit);
    onLog({
        timestamp: new Date(),
        message: `✓ ${prepared.length} tx(s) signed — calldata: ${(plan.data.length - 2) / 2} bytes`,
        type: "success",
    });
    onLog({
        timestamp: new Date(),
        message: `🚀 Firing to ${rpcUrls.length} RPC endpoint(s)...`,
        type: "info",
    });
    const results = await blastTransactions(prepared, rpcUrls, liveChainId);
    for (const r of results) {
        if (r.status === "dispatched") {
            onLog({
                timestamp: new Date(),
                message: `[${r.address.slice(0, 10)}...] TX: ${r.txHash}`,
                type: "success",
            });
        }
        else {
            onLog({
                timestamp: new Date(),
                message: `[${r.address.slice(0, 10)}...] REJECTED: ${r.error}`,
                type: "error",
            });
        }
    }
    // Wait for receipts on accepted transactions
    const dispatched = results.filter((r) => r.status === "dispatched");
    if (dispatched.length > 0) {
        onLog({
            timestamp: new Date(),
            message: `Waiting for receipts...`,
            type: "info",
        });
        await Promise.all(dispatched.map(async (r) => {
            const receipt = await waitForReceipt(r.txHash, rpcUrls[0], 60_000);
            if (receipt) {
                r.status = receipt.status === "SUCCESS" ? "confirmed" : "failed";
                r.blockNumber = receipt.block;
                r.gasUsed = receipt.gasUsed;
                onLog({
                    timestamp: new Date(),
                    message: `[${r.address.slice(0, 10)}...] Block: ${receipt.block} | ${receipt.status} | Gas: ${receipt.gasUsed}`,
                    type: receipt.status === "SUCCESS" ? "success" : "error",
                });
            }
            else {
                r.status = "timeout";
                onLog({
                    timestamp: new Date(),
                    message: `[${r.address.slice(0, 10)}...] TIMEOUT — check explorer`,
                    type: "warning",
                });
            }
        }));
    }
    return results;
}
//# sourceMappingURL=mint.js.map