// Local development entry point — long-polling mode
// For production (Vercel), use api/index.ts instead.

import "dotenv/config";
import { run } from "@grammyjs/runner";
import { bot } from "./bot";

console.log("🔫 SeaDrop Sniper Bot starting (long-polling mode)...");
console.log(`📡 Network: Robinhood Chain Mainnet (Chain ID: 4663)`);
console.log(
  `🔗 RPC: ${process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"}`,
);

run(bot);
