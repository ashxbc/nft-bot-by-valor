// Chain registry — Robinhood Chain Mainnet (Chain ID: 4663) is the sole network.

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

export const CHAINS: ChainProfile[] = [
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

export const DEFAULT_CHAIN = CHAINS[0];

export function resolveChain(
  idOrKey: string | number | bigint | null | undefined
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return DEFAULT_CHAIN;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    return CHAINS.find((c) => c.key === key) ?? DEFAULT_CHAIN;
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id) ?? DEFAULT_CHAIN;
}

export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_CHAIN.explorer;
  return `${base}/tx/${txHash}`;
}

export function explorerAddress(
  idOrKey: string | number | bigint | null | undefined,
  address: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_CHAIN.explorer;
  return `${base}/address/${address}`;
}
