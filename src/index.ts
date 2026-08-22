// SeaDrop Sniper Bot — Unified Persistent Daemon Entry Point
// Runs Telegram Bot + Persistent BullMQ Worker + Supabase PostgreSQL Connection

import "dotenv/config";
import { bot, registerBotCommands } from "./bot";
import { startWorker } from "./worker";

async function main() {
  console.log("===============================================================================");
  console.log("🔫 SEADROP SNIPER BOT DAEMON & BULLMQ WORKER STARTING");
  console.log("===============================================================================");
  console.log(`📡 Network: Robinhood Chain Mainnet (Chain ID: 4663)`);
  console.log(`🔗 RPC: ${process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"}`);

  // 1. Start Persistent BullMQ Worker for T-0 Execution
  const worker = startWorker();
  if (worker) {
    console.log("⚡ BullMQ Worker initialized and active.");
  }

  // 2. Clear any existing webhook so long-polling receives updates without 409 conflict
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log("🧹 Webhook cleared for persistent long-polling.");
  } catch (err: any) {
    console.warn("⚠️ deleteWebhook notice:", err.message);
  }

  // 3. Register Telegram command menu [/]
  await registerBotCommands().catch(console.error);

  // 4. Start Telegram Bot Polling
  console.log("🚀 Starting bot event loop...");
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ SeaDrop Sniper Bot is LIVE and listening as @${botInfo.username}`);
      console.log("===============================================================================\n");
    },
  });
}

main().catch(console.error);
