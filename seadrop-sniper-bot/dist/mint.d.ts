import { MintPlan } from "./seadrop";
import { LogEntry } from "./session";
export interface MintResult {
    walletIndex: number;
    address: string;
    txHash: string;
    status: "dispatched" | "accepted" | "rejected" | "confirmed" | "failed" | "timeout";
    blockNumber?: number;
    gasUsed?: string;
    error?: string;
    explorerUrl: string;
}
export declare function resolveRpcUrls(customRpc: string, additionalRpcEnv: string): string[];
export declare function signTransactions(walletKeys: string[], plan: MintPlan, rpcUrl: string, maxFeePerGas: bigint, maxPriorityFee: bigint, gasLimit: number): Promise<{
    prepared: {
        address: string;
        rawTx: string;
        txHash: string;
    }[];
    chainId: bigint;
    baseFee: bigint;
}>;
export declare function blastTransactions(prepared: {
    address: string;
    rawTx: string;
    txHash: string;
}[], rpcUrls: string[], chainId: bigint): Promise<MintResult[]>;
export declare function waitForReceipt(txHash: string, rpcUrl: string, timeoutMs?: number): Promise<{
    block: number;
    gasUsed: string;
    status: string;
} | null>;
export declare function executeSnipe(walletKeys: string[], plan: MintPlan, rpcUrls: string[], maxFeePerGas: bigint, maxPriorityFee: bigint, gasLimit: number, chainId: bigint, onLog: (log: LogEntry) => void): Promise<MintResult[]>;
//# sourceMappingURL=mint.d.ts.map