import { InlineKeyboard } from "grammy";
import { UserSession } from "./session";
import { resolveChain, CHAINS } from "./chains";

export const BOT_COMMANDS = [
  { command: "start", description: "🏠 Main dashboard & overview" },
  { command: "snipe", description: "🎯 Start interactive snipe wizard" },
  { command: "wallets", description: "👤 Manage in-memory wallets" },
  { command: "settings", description: "⚙️ Gas, RPC & network settings" },
  { command: "set_rpc", description: "🔗 Set or update your Alchemy RPC URL" },
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

/** Safely mask an Alchemy/RPC URL to protect API keys in chat */
export function maskRpcUrl(url: string): string {
  if (!url) return "⚠️ Not configured";
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.length > 8) {
      return `${parsed.origin}${pathname.slice(0, 4)}••••${pathname.slice(-4)}`;
    }
    return `${parsed.origin}/••••`;
  } catch {
    if (url.length > 20) {
      return url.slice(0, 15) + "••••" + url.slice(-4);
    }
    return "••••••••";
  }
}

/** Check if URL appears to be an Alchemy endpoint */
export function isAlchemyUrl(url: string): boolean {
  return url.toLowerCase().includes("alchemy.com");
}

/** Format seconds into human readable countdown (e.g. "2h 15m 30s") */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(" ");
}

export function getMainMenuKeyboard(hasRpc: boolean = true): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (!hasRpc) {
    kb.text("🔗 ⚡ Set Alchemy RPC (Required)", "set_rpc_prompt").row();
  }

  kb.text("🎯 Snipe NFT", "menu_snipe")
    .text("👤 Wallets", "menu_wallets")
    .row()
    .text("⚙️ Settings", "menu_settings")
    .text("📊 Status", "menu_status")
    .row()
    .text("🛑 Cancel Tasks", "menu_cancel")
    .text("❓ Help", "menu_help");

  return kb;
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
  const capLabel = sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌";
  const hasCustomRpc = Boolean(sess.settings.customRpc);

  const kb = new InlineKeyboard().text(
    "🔗 Set / Update Alchemy RPC",
    "set_rpc_prompt",
  );

  if (hasCustomRpc) {
    kb.text("🗑️ Reset RPC", "reset_rpc_action");
  }

  kb.row()
    .text(`⛽ Max Fee: ${sess.settings.maxFeePerGas} Gwei`, "set_maxfee_prompt")
    .text(
      `⚡ Priority: ${sess.settings.maxPriorityFee} Gwei`,
      "set_priority_prompt",
    )
    .row()
    .text("📡 Switch Network", "set_chain_prompt")
    .text(`🛡️ Safety Cap: ${capLabel}`, "toggle_safety_action")
    .row()
    .text("🔙 Main Menu", "menu_start");

  return kb;
}

export function getArmedSnipeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛑 Cancel Armed Snipe", "menu_cancel")
    .text("🏠 Main Menu", "menu_start");
}

export function getLiveExecutionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🛑 Abort Snipe", "menu_cancel");
}

export function getStatusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛑 Cancel Pending", "menu_cancel")
    .text("🏠 Main Menu", "menu_start");
}

export function getHelpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔗 Set Alchemy RPC", "set_rpc_prompt")
    .text("🎯 Snipe NFT", "menu_snipe")
    .row()
    .text("👤 Wallets", "menu_wallets")
    .text("🔙 Main Menu", "menu_start");
}

export function getSnipeTimingKeyboard(isUpcoming: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (isUpcoming) {
    kb.text("⚡ Exactly When Mint Starts (T-0)", "snipe_timing_start").row();
  } else {
    kb.text("🚀 Fire Immediately (Live Now)", "snipe_timing_now").row();
  }

  kb.text("⏰ Specific Time During Mint", "snipe_timing_custom").row();
  kb.text("❌ Cancel Wizard", "snipe_cancel_action");
  return kb;
}

export function getSnipeConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Confirm & Arm Snipe (3x Sequential)", "snipe_confirm_action")
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
  const uniqueAddresses = Array.from(
    new Map(
      sess.walletAddresses.map((a) => {
        try {
          return [a.toLowerCase(), a];
        } catch {
          return [a.toLowerCase(), a];
        }
      }),
    ).values(),
  );
  const walletCount = uniqueAddresses.length;
  const activeSnipes = sess.activeSnipes.filter(
    (s) =>
      s.status === "pending" || s.status === "waiting" || s.status === "firing",
  ).length;

  const hasRpc = Boolean(sess.settings.customRpc);

  let rpcBanner = "";
  if (!hasRpc) {
    rpcBanner =
      `⚠️ <b>Alchemy RPC Required!</b>\n` +
      `To ensure fast transaction blasting and avoid public rate limits, please configure your own Alchemy RPC:\n` +
      `1️⃣ Get your free RPC endpoint at <a href="https://alchemy.com">alchemy.com</a>\n` +
      `2️⃣ Click <b>🔗 Set Alchemy RPC</b> below or send /set_rpc to save it.\n\n`;
  }

  const rpcDisplay = hasRpc
    ? `🔗 <b>Alchemy RPC:</b> ${code(maskRpcUrl(sess.settings.customRpc))}`
    : `🔗 <b>Alchemy RPC:</b> ⚠️ <i>Not configured (Required)</i>`;

  const walletLines =
    walletCount === 0
      ? "⚠️ No wallets loaded. Click <b>Wallets</b> below to add one."
      : `✅ ${walletCount} wallet(s) ready:\n` +
        uniqueAddresses
          .map(
            (addr, i) =>
              `  ${i + 1}. ${code(addr.slice(0, 10) + "..." + addr.slice(-8))}`,
          )
          .join("\n");

  return (
    `🔫 <b>SeaDrop NFT Sniper Bot</b>\n\n` +
    rpcBanner +
    `📡 <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (Chain ID: ${chain?.chainId || 4663})\n` +
    `${rpcDisplay}\n\n` +
    `💰 <b>Gas Settings:</b>\n` +
    `  • Max Fee: <code>${esc(sess.settings.maxFeePerGas)} Gwei</code>\n` +
    `  • Priority Fee: <code>${esc(sess.settings.maxPriorityFee)} Gwei</code>\n` +
    `  • Safety Cap: <b>${sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌"}</b>\n\n` +
    `👤 <b>Wallets:</b>\n  ${walletLines.replace(/\n/g, "\n  ")}\n\n` +
    `🎯 <b>Active Tasks:</b> <code>${activeSnipes}</code>\n\n` +
    `👇 <i>Use the interactive buttons below or Telegram command menu [/] to navigate:</i>\n\n` +
    `⚡ Built by <a href="https://x.com/valor0x">Valor</a>`
  );
}

export function renderWalletsText(sess: UserSession): string {
  const uniqueAddresses = Array.from(
    new Map(
      sess.walletAddresses.map((a) => [a.toLowerCase(), a]),
    ).values(),
  );
  const walletCount = uniqueAddresses.length;
  const walletList =
    walletCount === 0
      ? "No wallets loaded. Private keys are encrypted in-memory (AES-256-GCM) and never written to disk."
      : uniqueAddresses
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
  const rpcStatus = sess.settings.customRpc
    ? `✅ ${code(maskRpcUrl(sess.settings.customRpc))}`
    : `⚠️ <i>Not configured — click below to set your Alchemy RPC</i>`;

  return (
    `⚙️ <b>Bot Settings</b>\n\n` +
    `🔗 <b>Alchemy RPC URL:</b>\n${rpcStatus}\n\n` +
    `📡 <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (Chain ID: ${chain?.chainId || 4663})\n` +
    `⛽ <b>Max Fee Per Gas:</b> ${code(sess.settings.maxFeePerGas + " Gwei")}\n` +
    `⚡ <b>Priority Fee (Tip):</b> ${code(sess.settings.maxPriorityFee + " Gwei")}\n` +
    `🛡️ <b>Gas Safety Cap:</b> <b>${sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌"}</b>\n\n` +
    `<i>💡 You can update or replace your personal Alchemy RPC anytime below:</i>`
  );
}

export function renderStatusText(sess: UserSession): string {
  const activeSnipes = sess.activeSnipes.filter(
    (s) =>
      s.status === "pending" || s.status === "waiting" || s.status === "firing",
  );

  const snipeLines =
    activeSnipes.length === 0
      ? "  • No active tasks running."
      : activeSnipes
          .map((s) => {
            const countdown =
              s.scheduledTime && s.status === "waiting"
                ? ` ⏳ ${formatDuration(Math.max(0, Math.ceil((new Date(s.scheduledTime).getTime() - Date.now()) / 1000)))} left`
                : "";
            const modeLabel =
              s.timingMode === "mint_start"
                ? "T-0 Mint Start"
                : s.timingMode === "specific_time"
                  ? "Scheduled Time"
                  : "Immediate";
            return `  • ${esc(s.contractAddress.slice(0, 10) + "...")} | Qty: ${s.quantity} | <b>${esc(s.status)}</b> (${modeLabel})${countdown}`;
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
            const time = new Date(l.timestamp).toLocaleTimeString();
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
    `This bot automatically detects SeaDrop NFT mint schedules and snipes with ultra-fast sequential retry logic.\n\n` +
    `<b>How Mint Scheduling & Sniping Works:</b>\n` +
    `• <b>Automatic Detection:</b> Entering a contract address automatically inspects the on-chain start & end times.\n` +
    `• <b>Timing Options:</b> Choose to snipe <b>Exactly when the mint starts (T-0)</b> or at a <b>Specific time during the mint</b>.\n` +
    `• <b>Sequential 3x Firing:</b> When the target window arrives, fires up to 3 sequential transactions, stopping immediately upon first confirmation.\n` +
    `• <b>Encrypted Wallets:</b> Private keys are encrypted in memory with AES-256-GCM.\n\n` +
    `<b>Available Commands:</b>\n` +
    `/start — Open the main dashboard\n` +
    `/set_rpc — Set or update your personal Alchemy RPC URL\n` +
    `/snipe — Launch the 6-step guided snipe wizard\n` +
    `/wallets — Add, inspect, and manage loaded wallets\n` +
    `/settings — Adjust gas fees, custom Alchemy RPC, and safety caps\n` +
    `/status — Monitor running tasks, countdowns, and execution logs\n` +
    `/cancel — Stop active wizard or cancel scheduled tasks\n` +
    `/help — Show this help guide\n\n` +
    `⚡ Built by <a href="https://x.com/valor0x">Valor</a>`
  );
}
