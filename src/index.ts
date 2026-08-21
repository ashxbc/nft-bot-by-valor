// Local development entry point — long-polling mode
// For production (Vercel), use api/index.ts instead.

import "dotenv/config";
import { bot, registerBotCommands } from "./bot";

async function main() {
  console.log("🔫 SeaDrop Sniper Bot starting (long-polling mode)...");
  console.log(`📡 Network: Robinhood Chain Mainnet (Chain ID: 4663)`);
  console.log(
    `🔗 RPC: ${process.env.DEFAULT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"}`,
  );

  // Clear any existing webhook so long-polling receives updates without 409 conflict
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log("🧹 Webhook cleared for local long-polling.");
  } catch (err: any) {
    console.warn("⚠️ deleteWebhook notice:", err.message);
  }

  // Register Telegram command menu [/]
  await registerBotCommands().catch(console.error);

  console.log("🚀 Starting polling...");
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ SeaDrop Sniper Bot is LIVE and listening as @${botInfo.username}`);
    },
  });
}

main().catch(console.error);
