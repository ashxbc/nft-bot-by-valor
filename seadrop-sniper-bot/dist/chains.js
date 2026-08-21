"use strict";
// Chain registry — Robinhood Chain Mainnet (Chain ID: 4663) is the sole network.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CHAIN = exports.CHAINS = void 0;
exports.resolveChain = resolveChain;
exports.explorerTx = explorerTx;
exports.explorerAddress = explorerAddress;
exports.CHAINS = [
    {
        key: "robinhood",
        chainId: 4663,
        name: "Robinhood Chain",
        explorer: "https://explorer.mainnet.chain.robinhood.com",
        nativeSymbol: "ETH",
        rpc: {
            public: [
                "https://rpc.mainnet.chain.robinhood.com",
            ],
        },
    },
];
exports.DEFAULT_CHAIN = exports.CHAINS[0];
function resolveChain(idOrKey) {
    if (idOrKey === null || idOrKey === undefined)
        return exports.DEFAULT_CHAIN;
    if (typeof idOrKey === "string") {
        const key = idOrKey.trim().toLowerCase();
        return exports.CHAINS.find((c) => c.key === key) ?? exports.DEFAULT_CHAIN;
    }
    const id = Number(idOrKey);
    return exports.CHAINS.find((c) => c.chainId === id) ?? exports.DEFAULT_CHAIN;
}
function explorerTx(idOrKey, txHash) {
    const profile = resolveChain(idOrKey);
    const base = profile?.explorer ?? exports.DEFAULT_CHAIN.explorer;
    return `${base}/tx/${txHash}`;
}
function explorerAddress(idOrKey, address) {
    const profile = resolveChain(idOrKey);
    const base = profile?.explorer ?? exports.DEFAULT_CHAIN.explorer;
    return `${base}/address/${address}`;
}
//# sourceMappingURL=chains.js.map