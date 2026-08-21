"use strict";
// Local development entry point — long-polling mode
// For production (Vercel), use api/index.ts instead.
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const runner_1 = require("@grammyjs/runner");
const bot_1 = require("./bot");
console.log("🔫 SeaDrop Sniper Bot starting (long-polling mode)...");
console.log(`📡 Network: Robinhood Chain Mainnet (Chain ID: 4663)`);
console.log(`🔗 RPC: ${process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"}`);
(0, runner_1.run)(bot_1.bot);
//# sourceMappingURL=index.js.map