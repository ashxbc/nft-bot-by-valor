export interface ChainProfile {
    key: string;
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
    rpc: {
        public: string[];
    };
}
export declare const CHAINS: ChainProfile[];
export declare const DEFAULT_CHAIN: ChainProfile;
export declare function resolveChain(idOrKey: string | number | bigint | null | undefined): ChainProfile | undefined;
export declare function explorerTx(idOrKey: string | number | bigint | null | undefined, txHash: string): string;
export declare function explorerAddress(idOrKey: string | number | bigint | null | undefined, address: string): string;
//# sourceMappingURL=chains.d.ts.map