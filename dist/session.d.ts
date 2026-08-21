export interface EncryptedWallet {
    iv: string;
    authTag: string;
    data: string;
}
export declare function encryptWallet(privateKey: string): EncryptedWallet;
export declare function decryptWallet(encrypted: EncryptedWallet): string;
export interface UserSession {
    wallets: EncryptedWallet[];
    walletAddresses: string[];
    settings: {
        customRpc: string;
        maxFeePerGas: string;
        maxPriorityFee: string;
        gasSafetyCap: boolean;
        activeChain: string;
    };
    snipeWizard?: {
        step: number;
        contractAddress?: string;
        quantity?: number;
        maxFeePerGas?: string;
        maxPriorityFee?: string;
        timingMode?: "now" | "scheduled";
        scheduledTime?: string;
        rpcUrl?: string;
    };
    activeSnipes: ActiveSnipe[];
    logs: LogEntry[];
}
export interface ActiveSnipe {
    id: string;
    contractAddress: string;
    quantity: number;
    maxFeePerGas: string;
    maxPriorityFee: string;
    timingMode: "now" | "scheduled";
    scheduledTime?: Date;
    status: "pending" | "waiting" | "firing" | "completed" | "failed" | "cancelled";
    txHashes: string[];
    startedAt: Date;
    abortController?: AbortController;
}
export interface LogEntry {
    timestamp: Date;
    message: string;
    type: "info" | "success" | "error" | "warning";
}
export declare function createDefaultSession(): UserSession;
//# sourceMappingURL=session.d.ts.map