import { InlineKeyboard } from "grammy";
import { UserSession } from "./session";
import { resolveChain, CHAINS } from "./chains";

export const BOT_COMMANDS = [
  { command: "start", description: "🏠 Main dashboard & overview" },
  { command: "snipe", description: "🎯 Start interactive snipe wizard" },
  { command: "wallets", description: "👤 Manage in-memory wallets" },
  { command: "settings", description: "⚙️ Gas, RPC & network settings" },
  { command: "status", description: "📊 View active tasks & recent logs" },
  { command: "cancel", description: "🛑 Cancel pending tasks" },
  { command: "help", description: "❓ Bot guide & documentation" },
];

/** Escape text for Telegram HTML parse mode */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

export function link(label: string, url: string): string {
  return `<a href="${url}">${esc(label)}</a>`;
}

export function getMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Snipe NFT", "menu_snipe")
    .text("👤 Wallets", "menu_wallets")
    .row()
    .text("⚙️ Settings", "menu_settings")
    .text("📊 Status", "menu_status")
    .row()
    .text("🛑 Cancel Tasks", "menu_cancel")
    .text("❓ Help", "menu_help")
    .row()
    .text("🔄 Refresh Dashboard", "menu_refresh_start");
}

export function getWalletsKeyboard(hasWallets: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("➕ Add Wallet", "wallet_add")
    .text("💰 View Balances", "wallet_view");

  if (hasWallets) {
    kb.row().text("🗑️ Clear All Wallets", "wallet_clear_prompt");
  }

  kb.row().text("🔙 Main Menu", "menu_start");
  return kb;
}

export function getSettingsKeyboard(sess: UserSession): InlineKeyboard {
  const chain = resolveChain(sess.settings.activeChain);
  const capLabel = sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌";

  return new InlineKeyboard()
    .text(`📡 Chain: ${chain?.name || "Robinhood"}`, "set_chain_prompt")
    .text("🔗 Set Custom RPC", "set_rpc_prompt")
    .row()
    .text(`⛽ Max Fee: ${sess.settings.maxFeePerGas} Gwei`, "set_maxfee_prompt")
    .text(`⚡ Priority: ${sess.settings.maxPriorityFee} Gwei`, "set_priority_prompt")
    .row()
    .text(`🛡️ Safety Cap: ${capLabel}`, "toggle_safety_action")
    .row()
    .text("🔙 Main Menu", "menu_start");
}

export function getStatusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh Status", "status_refresh")
    .text("🛑 Cancel Pending", "menu_cancel")
    .row()
    .text("🔙 Main Menu", "menu_start");
}

export function getHelpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Snipe NFT", "menu_snipe")
    .text("👤 Wallets", "menu_wallets")
    .row()
    .text("🔙 Main Menu", "menu_start");
}

export function getSnipeTimingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Fire Immediately (Now)", "snipe_timing_now")
    .row()
    .text("⏰ Schedule Specific Mint Time", "snipe_timing_scheduled")
    .row()
    .text("❌ Cancel Wizard", "snipe_cancel_action");
}

export function getSnipeConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Confirm & Fire Snipe", "snipe_confirm_action")
    .row()
    .text("❌ Cancel Wizard", "snipe_cancel_action");
}

export function getChainSelectionKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of CHAINS) {
    kb.text(`🔹 ${c.name} (${c.key})`, `select_chain_${c.key}`).row();
  }
  kb.text("🔙 Back to Settings", "menu_settings");
  return kb;
}

export function getClearWalletsConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗑️ Yes, Clear All", "wallet_clear_confirmed")
    .text("❌ No, Keep", "menu_wallets");
}

export function renderStartText(sess: UserSession): string {
  const chain = resolveChain(sess.settings.activeChain);
  const walletCount = sess.walletAddresses.length;
  const activeSnipes = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting",
  ).length;

  const walletLines =
    walletCount === 0
      ? "⚠️ No wallets loaded. Click <b>Wallets</b> below to add one."
      : `✅ ${walletCount} wallet(s) ready:\n` +
        sess.walletAddresses
          .map(
            (addr, i) =>
              `  ${i + 1}. ${code(addr.slice(0, 10) + "..." + addr.slice(-8))}`,
          )
          .join("\n");

  const rpcDisplay = sess.settings.customRpc
    ? "🔗 <b>Custom RPC:</b> " + code(sess.settings.customRpc.slice(0, 40) + "...")
    : "🔗 <b>Default RPC:</b> " + code(chain?.rpc.public[0] || "N/A");

  return (
    `🔫 <b>SeaDrop NFT Sniper Bot</b>\n\n` +
    `📡 <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (Chain ID: ${chain?.chainId || 4663})\n` +
    `${rpcDisplay}\n\n` +
    `💰 <b>Gas Settings:</b>\n` +
    `  • Max Fee: <code>${esc(sess.settings.maxFeePerGas)} Gwei</code>\n` +
    `  • Priority Fee: <code>${esc(sess.settings.maxPriorityFee)} Gwei</code>\n` +
    `  • Safety Cap: <b>${sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌"}</b>\n\n` +
    `👤 <b>Wallets:</b>\n  ${walletLines.replace(/\n/g, "\n  ")}\n\n` +
    `🎯 <b>Active Snipes:</b> <code>${activeSnipes}</code>\n\n` +
    `👇 <i>Use the interactive buttons below or Telegram command menu [/] to navigate:</i>`
  );
}

export function renderWalletsText(sess: UserSession): string {
  const walletCount = sess.walletAddresses.length;
  const walletList =
    walletCount === 0
      ? "No wallets loaded. Private keys are encrypted in-memory (AES-256-GCM) and never written to disk."
      : sess.walletAddresses
          .map((addr, i) => `${i + 1}. ${code(addr)}`)
          .join("\n");

  return (
    `👤 <b>Wallet Manager</b>\n\n` +
    `<b>Loaded Wallets (${walletCount}):</b>\n` +
    `${walletList}\n\n` +
    `Select an action below:`
  );
}

export function renderSettingsText(sess: UserSession): string {
  const chain = resolveChain(sess.settings.activeChain);

  return (
    `⚙️ <b>Bot Settings</b>\n\n` +
    `📡 <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (Chain ID: ${chain?.chainId || 4663})\n` +
    `🔗 <b>RPC URL:</b> ${code(sess.settings.customRpc || chain?.rpc.public[0] || "N/A")}\n\n` +
    `⛽ <b>Max Fee Per Gas:</b> ${code(sess.settings.maxFeePerGas + " Gwei")}\n` +
    `⚡ <b>Priority Fee (Tip):</b> ${code(sess.settings.maxPriorityFee + " Gwei")}\n` +
    `🛡️ <b>Gas Safety Cap:</b> <b>${sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌"}</b>\n\n` +
    `<i>Tap a button below to configure:</i>`
  );
}

export function renderStatusText(sess: UserSession): string {
  const activeSnipes = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting" || s.status === "firing",
  );

  const snipeLines =
    activeSnipes.length === 0
      ? "  • No active tasks running."
      : activeSnipes
          .map((s) => {
            const countdown =
              s.scheduledTime && s.status === "waiting"
                ? ` ⏳ ${Math.max(0, Math.ceil((s.scheduledTime.getTime() - Date.now()) / 1000))}s left`
                : "";
            return `  • ${esc(s.contractAddress.slice(0, 10) + "...")} | Qty: ${s.quantity} | <b>${esc(s.status)}</b>${countdown}`;
          })
          .join("\n");

  const recentLogs = sess.logs.slice(-8);
  const logLines =
    recentLogs.length === 0
      ? "  • No recent activity logged."
      : recentLogs
          .map((l) => {
            const icon =
              l.type === "success"
                ? "✅"
                : l.type === "error"
                  ? "❌"
                  : l.type === "warning"
                    ? "⚠️"
                    : "ℹ️";
            const time = l.timestamp.toLocaleTimeString();
            return `  ${icon} [${esc(time)}] ${esc(l.message)}`;
          })
          .join("\n");

  const completedCount = sess.activeSnipes.filter(
    (s) => s.status === "completed",
  ).length;

  return (
    `📊 <b>Status & Activity Dashboard</b>\n\n` +
    `🎯 <b>Active Tasks (${activeSnipes.length}):</b>\n` +
    `${snipeLines}\n\n` +
    `📋 <b>Recent Activity:</b>\n` +
    `${logLines}\n\n` +
    `🏆 <b>Completed Snipes:</b> <code>${completedCount}</code>`
  );
}

export function renderHelpText(): string {
  return (
    `❓ <b>SeaDrop Sniper Bot Guide</b>\n\n` +
    `This bot allows you to snipe SeaDrop NFT public mints with zero delay directly from Telegram.\n\n` +
    `<b>Key Features:</b>\n` +
    `• <b>Pre-Signing & Blasting:</b> Transactions are pre-signed and blasted to multiple RPCs simultaneously at T-0.\n` +
    `• <b>Encrypted Wallets:</b> Private keys are encrypted in-memory with AES-256-GCM.\n` +
    `• <b>Scheduler:</b> Set exact mint timestamps to execute drops automatically.\n\n` +
    `<b>Available Commands:</b>\n` +
    `/start — Open the main dashboard\n` +
    `/snipe — Launch the 6-step guided snipe wizard\n` +
    `/wallets — Add, inspect, and manage loaded wallets\n` +
    `/settings — Adjust gas fees, custom RPCs, and safety caps\n` +
    `/status — Monitor running tasks, countdowns, and execution logs\n` +
    `/cancel — Stop active wizard or cancel scheduled tasks\n` +
    `/help — Show this help guide\n\n` +
    `<i>Select an option below to get started:</i>`
  );
}
