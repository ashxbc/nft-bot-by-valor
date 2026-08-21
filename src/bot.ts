// SeaDrop NFT Sniper Telegram Bot
// Mobile-friendly interface built with grammY
// Default network: Robinhood Chain Mainnet (Chain ID: 4663)

import "dotenv/config";
import { Bot, Context, session, SessionFlavor, NextFunction } from "grammy";
import {
  Wallet,
  parseUnits,
  formatEther,
  JsonRpcProvider,
  isAddress,
} from "ethers";
import {
  UserSession,
  createDefaultSession,
  encryptWallet,
  decryptWallet,
  ActiveSnipe,
} from "./session";
import { buildMintPlan, fetchPublicDrop } from "./seadrop";
import { executeSnipe, resolveRpcUrls } from "./mint";
import { DEFAULT_CHAIN, resolveChain } from "./chains";
import {
  BOT_COMMANDS,
  esc,
  code,
  link,
  maskRpcUrl,
  isAlchemyUrl,
  formatDuration,
  getMainMenuKeyboard,
  getWalletsKeyboard,
  getSettingsKeyboard,
  getStatusKeyboard,
  getHelpKeyboard,
  getSnipeTimingKeyboard,
  getSnipeConfirmKeyboard,
  getChainSelectionKeyboard,
  getClearWalletsConfirmKeyboard,
  renderStartText,
  renderWalletsText,
  renderSettingsText,
  renderStatusText,
  renderHelpText,
} from "./menu";

type BotContext = Context & SessionFlavor<UserSession>;

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error(
    "❌ BOT_TOKEN is required. Set it in .env or environment variables.",
  );
  process.exit(1);
}

const bot = new Bot<BotContext>(BOT_TOKEN);

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM COMMAND MENU REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────
export async function registerBotCommands(): Promise<boolean> {
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
    console.log("✅ Telegram bot command menu registered successfully.");
    return true;
  } catch (err: any) {
    console.error("⚠️ Failed to register bot commands:", err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING MESSAGE HANDLER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const pendingHandlers = new Map<
  number,
  (ctx: BotContext, next: NextFunction) => Promise<void>
>();

function registerPendingHandler(
  chatId: number,
  handler: (ctx: BotContext, next: NextFunction) => Promise<void>,
) {
  pendingHandlers.set(chatId, handler);
}

// 12-Character Access Gate Key
export const ACCESS_KEY = (process.env.ACCESS_KEY || "v9x2m4k7p8q3").trim();

// ─────────────────────────────────────────────────────────────────────────────
// 1. SESSION MIDDLEWARE — MUST BE FIRST
// ─────────────────────────────────────────────────────────────────────────────
bot.use(
  session({
    initial: createDefaultSession,
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.5 AUTHENTICATION GATE MIDDLEWARE
// Requires users to enter the 12-character access key before unlocking bot
// ─────────────────────────────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  const sess = ctx.session;
  if (!sess) return next();

  // If already authenticated, allow through
  if (sess.isAuthorized) {
    return next();
  }

  const text = ctx.message?.text?.trim() || "";

  // Check /start with key parameter (e.g. /start v9x2m4k7p8q3) or exact key text
  const isStartWithKey =
    text.startsWith("/start ") &&
    text.slice(7).trim().toLowerCase() === ACCESS_KEY.toLowerCase();
  const isExactKey = text.toLowerCase() === ACCESS_KEY.toLowerCase();

  if (isStartWithKey || isExactKey) {
    sess.isAuthorized = true;
    const hasRpc = Boolean(sess.settings.customRpc);
    await ctx.reply(
      `🎉 <b>Access Granted!</b>\n\nWelcome to <b>SeaDrop NFT Sniper Bot</b>. Your access has been unlocked.`,
      { parse_mode: "HTML" },
    );
    const startText = renderStartText(sess);
    await ctx.reply(startText, {
      parse_mode: "HTML",
      reply_markup: getMainMenuKeyboard(hasRpc),
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  // If callback query on inline button, alert user to authenticate
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: "🔒 Access Restricted. Enter the 12-character key first.",
      show_alert: true,
    });
    return;
  }

  // Prompt the user to enter the access key
  await ctx.reply(
    `🔒 <b>Private Bot — Access Restricted</b>\n\n` +
      `This bot requires authorization to access.\n` +
      `Please enter your 12-character access key below to unlock:`,
    { parse_mode: "HTML" },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PENDING HANDLER DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("message", async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const handler = pendingHandlers.get(chatId);
  if (handler) {
    pendingHandlers.delete(chatId);
    await handler(ctx, next);
    return;
  }

  await next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// /start — Main dashboard with Alchemy RPC onboarding
bot.command("start", async (ctx) => {
  const sess = ctx.session;
  const hasRpc = Boolean(sess.settings.customRpc);
  const text = renderStartText(sess);
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getMainMenuKeyboard(hasRpc),
    link_preview_options: { is_disabled: true },
  });
});

// /help — Help & documentation
bot.command("help", async (ctx) => {
  const text = renderHelpText();
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getHelpKeyboard(),
    link_preview_options: { is_disabled: true },
  });
});

// /wallets — Wallet manager menu
bot.command("wallets", async (ctx) => {
  const sess = ctx.session;
  const text = renderWalletsText(sess);
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getWalletsKeyboard(sess.walletAddresses.length > 0),
  });
});

// /wallets_add — Add a private key
bot.command("wallets_add", async (ctx) => {
  await promptAddWallet(ctx);
});

// /wallets_view — View balances
bot.command("wallets_view", async (ctx) => {
  await displayWalletBalances(ctx);
});

// /wallets_clear — Clear all wallets
bot.command("wallets_clear", async (ctx) => {
  ctx.session.wallets = [];
  ctx.session.walletAddresses = [];
  await ctx.reply("🗑️ All wallets cleared from memory.", {
    reply_markup: getWalletsKeyboard(false),
  });
});

// /snipe — Start the wizard
bot.command("snipe", async (ctx) => {
  await startSnipeWizard(ctx);
});

// /confirm_snipe — Execute the snipe
bot.command("confirm_snipe", async (ctx) => {
  await executeConfirmedSnipe(ctx);
});

// /settings — Settings menu
bot.command("settings", async (ctx) => {
  const sess = ctx.session;
  const text = renderSettingsText(sess);
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getSettingsKeyboard(sess),
  });
});

// /set_chain — Switch network
bot.command("set_chain", async (ctx) => {
  await promptSetChain(ctx);
});

// /set_rpc — Set or update Alchemy RPC URL
bot.command("set_rpc", async (ctx) => {
  await promptSetRpc(ctx);
});

// /set_maxfee — Set max fee per gas
bot.command("set_maxfee", async (ctx) => {
  await promptSetMaxFee(ctx);
});

// /set_priority — Set priority fee
bot.command("set_priority", async (ctx) => {
  await promptSetPriority(ctx);
});

// /toggle_safety — Toggle gas safety cap
bot.command("toggle_safety", async (ctx) => {
  ctx.session.settings.gasSafetyCap = !ctx.session.settings.gasSafetyCap;
  const state = ctx.session.settings.gasSafetyCap ? "ON ✅" : "OFF ❌";
  await ctx.reply(`Gas safety cap: <b>${state}</b>`, {
    parse_mode: "HTML",
    reply_markup: getSettingsKeyboard(ctx.session),
  });
});

// /status — View active snipes and logs
bot.command("status", async (ctx) => {
  const sess = ctx.session;
  const text = renderStatusText(sess);
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getStatusKeyboard(),
  });
});

// /cancel — Abort pending/scheduled tasks
bot.command("cancel", async (ctx) => {
  await handleCancelTasks(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. INTERACTIVE INLINE CALLBACK QUERY HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// Navigation: Back to / Refresh Start Dashboard
bot.callbackQuery(["menu_start", "menu_refresh_start"], async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Dashboard refreshed" });
  const sess = ctx.session;
  const hasRpc = Boolean(sess.settings.customRpc);
  const text = renderStartText(sess);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getMainMenuKeyboard(hasRpc),
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getMainMenuKeyboard(hasRpc),
      link_preview_options: { is_disabled: true },
    });
  }
});

// Navigation: Help
bot.callbackQuery("menu_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  const text = renderHelpText();
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getHelpKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getHelpKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  }
});

// Navigation: Wallets Menu
bot.callbackQuery("menu_wallets", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = ctx.session;
  const text = renderWalletsText(sess);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getWalletsKeyboard(sess.walletAddresses.length > 0),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getWalletsKeyboard(sess.walletAddresses.length > 0),
    });
  }
});

// Wallet: Add
bot.callbackQuery("wallet_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptAddWallet(ctx);
});

// Wallet: View Balances
bot.callbackQuery("wallet_view", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Fetching balances..." });
  await displayWalletBalances(ctx);
});

// Wallet: Clear Prompt
bot.callbackQuery("wallet_clear_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "⚠️ <b>Are you sure you want to clear all wallets from memory?</b>",
    {
      parse_mode: "HTML",
      reply_markup: getClearWalletsConfirmKeyboard(),
    },
  );
});

// Wallet: Clear Confirmed
bot.callbackQuery("wallet_clear_confirmed", async (ctx) => {
  ctx.session.wallets = [];
  ctx.session.walletAddresses = [];
  await ctx.answerCallbackQuery({ text: "All wallets cleared" });
  await ctx.reply("🗑️ All wallets have been cleared from memory.", {
    reply_markup: getWalletsKeyboard(false),
  });
});

// Navigation: Settings Menu
bot.callbackQuery("menu_settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = ctx.session;
  const text = renderSettingsText(sess);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(sess),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(sess),
    });
  }
});

// Settings: Reset RPC to Default
bot.callbackQuery("reset_rpc_action", async (ctx) => {
  ctx.session.settings.customRpc = "";
  await ctx.answerCallbackQuery({ text: "Custom RPC removed" });
  const text = renderSettingsText(ctx.session);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  }
});

// Settings: Toggle Safety Cap
bot.callbackQuery("toggle_safety_action", async (ctx) => {
  ctx.session.settings.gasSafetyCap = !ctx.session.settings.gasSafetyCap;
  const state = ctx.session.settings.gasSafetyCap ? "enabled" : "disabled";
  await ctx.answerCallbackQuery({ text: `Gas safety cap ${state}` });

  const text = renderSettingsText(ctx.session);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  }
});

// Settings: Set Max Fee Prompt
bot.callbackQuery("set_maxfee_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptSetMaxFee(ctx);
});

// Settings: Set Priority Fee Prompt
bot.callbackQuery("set_priority_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptSetPriority(ctx);
});

// Settings: Set Custom / Alchemy RPC Prompt
bot.callbackQuery("set_rpc_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptSetRpc(ctx);
});

// Settings: Set Chain Prompt
bot.callbackQuery("set_chain_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("📡 <b>Select a network:</b>", {
    parse_mode: "HTML",
    reply_markup: getChainSelectionKeyboard(),
  });
});

// Settings: Select Chain Action
bot.callbackQuery(/^select_chain_(.+)$/, async (ctx) => {
  const chainKey = ctx.match[1];
  const chain = resolveChain(chainKey);
  if (chain) {
    ctx.session.settings.activeChain = chain.key;
    await ctx.answerCallbackQuery({
      text: `Network switched to ${chain.name}`,
    });
  } else {
    await ctx.answerCallbackQuery({ text: "Chain not recognized" });
  }

  const text = renderSettingsText(ctx.session);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  }
});

// Navigation: Status Dashboard & Refresh
bot.callbackQuery(["menu_status", "status_refresh"], async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Status refreshed" });
  const text = renderStatusText(ctx.session);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getStatusKeyboard(),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: getStatusKeyboard(),
    });
  }
});

// Snipe: Start Wizard from button
bot.callbackQuery("menu_snipe", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startSnipeWizard(ctx);
});

// Snipe: Timing Option A — Exactly When Mint Starts (T-0)
bot.callbackQuery("snipe_timing_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = ctx.session;
  if (!sess.snipeWizard) return;

  const startSec = sess.snipeWizard.detectedStartTime;
  if (startSec && startSec > Math.floor(Date.now() / 1000)) {
    sess.snipeWizard.scheduledTime = new Date(startSec * 1000).toISOString();
    sess.snipeWizard.timingMode = "mint_start";
  } else {
    sess.snipeWizard.timingMode = "now";
  }

  sess.snipeWizard.step = 6;
  await showSnipeSummary(ctx, sess);
});

// Snipe: Timing Option B — Fire Immediately (Now)
bot.callbackQuery("snipe_timing_now", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = ctx.session;
  if (!sess.snipeWizard) return;

  sess.snipeWizard.timingMode = "now";
  sess.snipeWizard.step = 6;
  await showSnipeSummary(ctx, sess);
});

// Snipe: Timing Option C — Specific Time During Mint
bot.callbackQuery("snipe_timing_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = ctx.session;
  if (!sess.snipeWizard) return;

  sess.snipeWizard.step = 51;
  const startSec =
    sess.snipeWizard.detectedStartTime || Math.floor(Date.now() / 1000);
  const endSec = sess.snipeWizard.detectedEndTime;

  let windowInfo = "";
  if (endSec) {
    windowInfo = `\n<i>Mint Window: ${new Date(startSec * 1000).toISOString()} ➔ ${new Date(endSec * 1000).toISOString()}</i>\n`;
  }

  await ctx.reply(
    `⏰ <b>Set Specific Snipe Time</b>\n` +
      windowInfo +
      `\nSend your target execution time in ISO format or Unix timestamp.\n` +
      `Example: ${code(new Date(Date.now() + 1800_000).toISOString())}`,
    { parse_mode: "HTML" },
  );
});

// Snipe: Confirm Action
bot.callbackQuery("snipe_confirm_action", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Processing snipe..." });
  await executeConfirmedSnipe(ctx);
});

// Snipe: Cancel Action
bot.callbackQuery(["snipe_cancel_action", "menu_cancel"], async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cancelled" });
  await handleCancelTasks(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WIZARD MESSAGE HANDLER — processes free-text input during snipe wizard
// ─────────────────────────────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const sess = ctx.session;
  if (!sess.snipeWizard) return;

  const text = ctx.message.text.trim();
  const wizard = sess.snipeWizard;

  if (text === "/cancel") {
    sess.snipeWizard = undefined;
    await ctx.reply("❌ Snipe wizard cancelled.", {
      reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
    });
    return;
  }

  switch (wizard.step) {
    case 1: {
      if (!isAddress(text)) {
        await ctx.reply(
          "❌ Invalid address. Send a valid 0x contract address.",
        );
        return;
      }
      wizard.contractAddress = text;
      wizard.step = 2;

      const chain = resolveChain(sess.settings.activeChain);
      const rpc = sess.settings.customRpc || chain?.rpc.public[0];
      if (!rpc) {
        await ctx.reply(
          "❌ No RPC configured. Please set your Alchemy RPC first with /set_rpc.",
          {
            reply_markup: getSettingsKeyboard(sess),
          },
        );
        sess.snipeWizard = undefined;
        return;
      }

      await ctx.reply(
        "🔍 <i>Inspecting contract and detecting on-chain drop schedule...</i>",
        {
          parse_mode: "HTML",
        },
      );

      const drop = await fetchPublicDrop(rpc, text);
      if (drop) {
        const nowSec = Math.floor(Date.now() / 1000);
        wizard.detectedStartTime = drop.startTime;
        wizard.detectedEndTime = drop.endTime;
        wizard.mintPrice = drop.mintPrice.toString();
        wizard.maxTotalMintableByWallet = drop.maxTotalMintableByWallet;

        const isUpcoming = drop.startTime > nowSec;
        const statusText = isUpcoming
          ? `⏰ <b>Starts in:</b> <b>${formatDuration(drop.startTime - nowSec)}</b> (${code(new Date(drop.startTime * 1000).toISOString())})`
          : `🟢 <b>Status:</b> <b>LIVE NOW</b> (Ends in ${formatDuration(Math.max(0, drop.endTime - nowSec))})`;

        await ctx.reply(
          `✅ <b>SeaDrop Public Drop Detected!</b>\n\n` +
            `• <b>Price:</b> ${code(formatEther(drop.mintPrice) + " ETH")}\n` +
            `• <b>Wallet Limit:</b> <code>${drop.maxTotalMintableByWallet}</code> NFTs\n` +
            `• ${statusText}\n` +
            `• <b>Window:</b> ${code(new Date(drop.startTime * 1000).toISOString())} ➔ ${code(new Date(drop.endTime * 1000).toISOString())}\n\n` +
            `Step 2/6: <b>Mint Quantity</b>\n` +
            `How many NFTs per wallet? (1–${drop.maxTotalMintableByWallet})`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(
          `⚠️ <i>Could not automatically read SeaDrop drop info (custom or uninitialized stage).</i>\n\n` +
            `Step 2/6: <b>Mint Quantity</b>\n` +
            `How many NFTs per wallet? (1–10)`,
          { parse_mode: "HTML" },
        );
      }
      break;
    }

    case 2: {
      const qty = parseInt(text, 10);
      const maxAllowed = wizard.maxTotalMintableByWallet || 100;
      if (isNaN(qty) || qty < 1 || qty > maxAllowed) {
        await ctx.reply(`❌ Enter a valid quantity (1-${maxAllowed}).`);
        return;
      }
      wizard.quantity = qty;
      wizard.step = 3;

      await ctx.reply(
        `Step 3/6: <b>Max Fee Per Gas (ceiling)</b>\n\n` +
          `Max gas price you'll tolerate.\n` +
          `Recommended: ${esc(sess.settings.maxFeePerGas)} Gwei\n\n` +
          `Send a value in Gwei, or send ${code("default")} to use current setting.`,
        { parse_mode: "HTML" },
      );
      break;
    }

    case 3: {
      const fee =
        text.toLowerCase() === "default" ? sess.settings.maxFeePerGas : text;
      const parsed = parseFloat(fee);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply(
          "❌ Enter a valid gas price in Gwei, or send 'default'.",
        );
        return;
      }
      wizard.maxFeePerGas = fee;
      wizard.step = 4;

      await ctx.reply(
        `Step 4/6: <b>Priority Fee (tip)</b>\n\n` +
          `Paid to block producers for faster inclusion.\n` +
          `Recommended: ${esc(sess.settings.maxPriorityFee)} Gwei\n\n` +
          `Send a value in Gwei, or send ${code("default")} to use current setting.`,
        { parse_mode: "HTML" },
      );
      break;
    }

    case 4: {
      const tip =
        text.toLowerCase() === "default" ? sess.settings.maxPriorityFee : text;
      const parsed = parseFloat(tip);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("❌ Enter a valid tip in Gwei, or send 'default'.");
        return;
      }
      wizard.maxPriorityFee = tip;
      wizard.step = 5;

      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = wizard.detectedStartTime || 0;
      const endSec = wizard.detectedEndTime || 0;
      const isUpcoming = startSec > nowSec;

      let scheduleBanner = "";
      if (isUpcoming) {
        scheduleBanner =
          `⏰ <b>Scheduled Mint Start:</b> ${code(new Date(startSec * 1000).toISOString())}\n` +
          `⏳ <b>Countdown:</b> <b>${formatDuration(startSec - nowSec)}</b> from now\n` +
          `🏁 <b>Mint Window Ends:</b> ${code(new Date(endSec * 1000).toISOString())}\n\n`;
      } else if (endSec > nowSec) {
        scheduleBanner =
          `🟢 <b>Mint is LIVE NOW!</b>\n` +
          `🏁 <b>Mint Window Ends:</b> ${code(new Date(endSec * 1000).toISOString())} (${formatDuration(endSec - nowSec)} left)\n\n`;
      }

      await ctx.reply(
        `Step 5/6: <b>Timing & Execution Window</b>\n\n` +
          scheduleBanner +
          `<b>When would you like to snipe?</b>\n` +
          `• <i>Exactly when mint starts (T-0)</i>: Arms the bot to fire right at opening.\n` +
          `• <i>Specific time during mint</i>: Choose your own execution timestamp.\n\n` +
          `👇 <i>Select an option below:</i>`,
        {
          parse_mode: "HTML",
          reply_markup: getSnipeTimingKeyboard(isUpcoming),
        },
      );
      break;
    }

    case 5: {
      const lower = text.toLowerCase();
      if (lower === "start" || lower === "t0" || lower === "t-0") {
        const startSec = wizard.detectedStartTime;
        if (startSec && startSec > Math.floor(Date.now() / 1000)) {
          wizard.scheduledTime = new Date(startSec * 1000).toISOString();
          wizard.timingMode = "mint_start";
        } else {
          wizard.timingMode = "now";
        }
        wizard.step = 6;
        await showSnipeSummary(ctx, sess);
      } else if (lower === "now") {
        wizard.timingMode = "now";
        wizard.step = 6;
        await showSnipeSummary(ctx, sess);
      } else if (
        lower === "custom" ||
        lower === "scheduled" ||
        lower === "specific"
      ) {
        wizard.step = 51;
        await ctx.reply(
          `⏰ <b>Set Specific Snipe Time</b>\n\n` +
            `Send the target mint time in ISO format or Unix timestamp.\n` +
            `Example: ${code(new Date(Date.now() + 1800_000).toISOString())}`,
          { parse_mode: "HTML" },
        );
      } else {
        const isUpcoming =
          (wizard.detectedStartTime || 0) > Math.floor(Date.now() / 1000);
        await ctx.reply(
          "Please select your timing preference using the buttons below:",
          {
            parse_mode: "HTML",
            reply_markup: getSnipeTimingKeyboard(isUpcoming),
          },
        );
      }
      break;
    }

    case 51: {
      let scheduledDate: Date;
      const num = parseInt(text, 10);

      if (!isNaN(num) && num > 1e9) {
        scheduledDate = new Date(num * 1000);
      } else {
        scheduledDate = new Date(text);
      }

      if (isNaN(scheduledDate.getTime())) {
        await ctx.reply(
          "❌ Invalid time format. Try ISO format like '2026-09-01T18:00:00Z'",
        );
        return;
      }

      if (scheduledDate.getTime() <= Date.now()) {
        await ctx.reply("❌ Scheduled time must be in the future.");
        return;
      }

      if (
        wizard.detectedEndTime &&
        scheduledDate.getTime() > wizard.detectedEndTime * 1000
      ) {
        await ctx.reply(
          `⚠️ Note: The target time is after the detected mint end (${new Date(wizard.detectedEndTime * 1000).toISOString()}).\n` +
            `Please provide a time during the active drop window.`,
        );
        return;
      }

      wizard.scheduledTime = scheduledDate.toISOString();
      wizard.timingMode = "specific_time";
      wizard.step = 6;
      await showSnipeSummary(ctx, sess);
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ACTION HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function promptAddWallet(ctx: Context & SessionFlavor<UserSession>) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply(
    `🔑 <b>Send me a private key to add.</b>\n\n` +
      `The key is encrypted in memory (AES-256-GCM) and never saved to disk.\n` +
      `Send /cancel_w to abort.`,
    { parse_mode: "HTML" },
  );

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;

    if (msgCtx.message.text === "/cancel_w") {
      await msgCtx.reply("❌ Cancelled adding wallet.", {
        reply_markup: getWalletsKeyboard(
          ctx.session.walletAddresses.length > 0,
        ),
      });
      return;
    }

    const key = msgCtx.message.text.trim();

    try {
      const wallet = new Wallet(key);
      const encrypted = encryptWallet(key);

      ctx.session.wallets.push(encrypted);
      ctx.session.walletAddresses.push(wallet.address);

      await msgCtx.reply(
        `✅ <b>Wallet added successfully!</b>\n\nAddress: ${code(wallet.address)}`,
        {
          parse_mode: "HTML",
          reply_markup: getWalletsKeyboard(true),
        },
      );
    } catch (err: any) {
      await msgCtx.reply(
        `❌ <b>Invalid private key:</b> ${esc(err.message || "Could not parse key")}`,
        {
          reply_markup: getWalletsKeyboard(
            ctx.session.walletAddresses.length > 0,
          ),
        },
      );
    }
  });
}

async function displayWalletBalances(
  ctx: Context & SessionFlavor<UserSession>,
) {
  const sess = ctx.session;

  if (sess.walletAddresses.length === 0) {
    await ctx.reply("⚠️ No wallets loaded. Use the button below to add one.", {
      reply_markup: getWalletsKeyboard(false),
    });
    return;
  }

  const chain = resolveChain(sess.settings.activeChain);
  const rpc = sess.settings.customRpc || chain?.rpc.public[0];
  if (!rpc) {
    await ctx.reply("⚠️ No RPC configured to fetch balances.", {
      reply_markup: getSettingsKeyboard(sess),
    });
    return;
  }

  const provider = new JsonRpcProvider(rpc);

  const lines = await Promise.all(
    sess.walletAddresses.map(async (addr, i) => {
      try {
        const balance = await provider.getBalance(addr);
        return `${i + 1}. ${code(addr)}\n   💰 <b>${formatEther(balance)} ETH</b>`;
      } catch {
        return `${i + 1}. ${code(addr)}\n   💰 Balance: <i>unknown</i>`;
      }
    }),
  );

  const rpcNote = !sess.settings.customRpc
    ? "\n\n💡 <i>Tip: Set your Alchemy RPC via /set_rpc for fastest balance checks and sniping.</i>"
    : "";

  await ctx.reply(
    `👤 <b>Wallet Balances (${sess.walletAddresses.length}):</b>\n\n` +
      lines.join("\n\n") +
      rpcNote,
    {
      parse_mode: "HTML",
      reply_markup: getWalletsKeyboard(true),
    },
  );
}

async function startSnipeWizard(ctx: Context & SessionFlavor<UserSession>) {
  const sess = ctx.session;

  if (sess.walletAddresses.length === 0) {
    await ctx.reply(
      "⚠️ <b>Add wallets first before sniping.</b>\nClick below to add a wallet:",
      {
        parse_mode: "HTML",
        reply_markup: getWalletsKeyboard(false),
      },
    );
    return;
  }

  sess.snipeWizard = { step: 1 };
  await ctx.reply(
    `🎯 <b>SeaDrop Snipe Wizard</b>\n\n` +
      `Step 1/6: <b>Contract Address</b>\n` +
      `Send the NFT contract address (<code>0x...</code>) to detect the mint schedule:`,
    {
      parse_mode: "HTML",
    },
  );
}

async function showSnipeSummary(ctx: Context, sess: UserSession) {
  const wizard = sess.snipeWizard!;
  const chain = resolveChain(sess.settings.activeChain);

  let timingText = "";
  if (wizard.timingMode === "mint_start") {
    const waitSec = Math.max(
      0,
      Math.ceil(
        (new Date(wizard.scheduledTime!).getTime() - Date.now()) / 1000,
      ),
    );
    timingText = `⚡ Exactly When Mint Starts (T-0: ${wizard.scheduledTime} — in ${formatDuration(waitSec)})`;
  } else if (wizard.timingMode === "specific_time") {
    const waitSec = Math.max(
      0,
      Math.ceil(
        (new Date(wizard.scheduledTime!).getTime() - Date.now()) / 1000,
      ),
    );
    timingText = `⏰ Specific Mint Time (${wizard.scheduledTime} — in ${formatDuration(waitSec)})`;
  } else {
    timingText = "🚀 Immediate (Live Now)";
  }

  const rpcDisplay = sess.settings.customRpc
    ? `Alchemy Dedicated (${maskRpcUrl(sess.settings.customRpc)})`
    : `⚠️ Not configured (Set via /set_rpc)`;

  const text =
    `📋 <b>Snipe Configuration Summary</b>\n\n` +
    `• <b>Contract:</b> ${code(wizard.contractAddress!)}\n` +
    `• <b>Quantity:</b> <code>${wizard.quantity}</code> per wallet\n` +
    `• <b>Max Fee:</b> <code>${esc(wizard.maxFeePerGas!)} Gwei</code>\n` +
    `• <b>Priority Fee:</b> <code>${esc(wizard.maxPriorityFee!)} Gwei</code>\n` +
    `• <b>Timing Mode:</b> ${esc(timingText)}\n` +
    `• <b>Execution Strategy:</b> 🔄 <b>Up to 3 sequential attempts</b> (stops immediately on 1st success)\n` +
    `• <b>Wallets:</b> <code>${sess.walletAddresses.length}</code> loaded\n` +
    `• <b>RPC Endpoint:</b> ${code(rpcDisplay)}\n` +
    `• <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")}\n\n` +
    `<i>Click below to confirm and arm your snipe:</i>`;

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: getSnipeConfirmKeyboard(),
  });
}

async function executeConfirmedSnipe(
  ctx: Context & SessionFlavor<UserSession>,
) {
  const sess = ctx.session;
  const wizard = sess.snipeWizard;

  if (!wizard || wizard.step !== 6 || !wizard.contractAddress || !wizard.quantity) {
    await ctx.reply(
      "⚠️ No snipe to confirm. Click below to start a new snipe:",
      {
        reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
      },
    );
    return;
  }

  const contractAddress = wizard.contractAddress;
  const quantity = wizard.quantity;
  const timingMode = wizard.timingMode || "now";
  const scheduledTimeStr = wizard.scheduledTime;

  const chain = resolveChain(sess.settings.activeChain);
  const rpcUrls = resolveRpcUrls(
    sess.settings.customRpc,
    process.env.ADDITIONAL_RPC_URLS || "",
  );

  await ctx.reply("🔍 Building mint plan from on-chain data...");

  const plan = await buildMintPlan(
    rpcUrls[0],
    contractAddress,
    quantity,
  );
  if (!plan) {
    await ctx.reply(
      "❌ Could not build mint plan. Contract may not be an active SeaDrop collection.",
      {
        reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
      },
    );
    sess.snipeWizard = undefined;
    return;
  }

  const maxFee = parseUnits(wizard.maxFeePerGas || sess.settings.maxFeePerGas, "gwei");
  const maxTip = parseUnits(wizard.maxPriorityFee || sess.settings.maxPriorityFee, "gwei");

  const snipeId = `snipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const isImmediate = timingMode === "now" || !scheduledTimeStr;

  const activeSnipe: ActiveSnipe = {
    id: snipeId,
    contractAddress,
    quantity,
    maxFeePerGas: wizard.maxFeePerGas || sess.settings.maxFeePerGas,
    maxPriorityFee: wizard.maxPriorityFee || sess.settings.maxPriorityFee,
    timingMode,
    scheduledTime: scheduledTimeStr ? new Date(scheduledTimeStr) : undefined,
    status: isImmediate ? "firing" : "waiting",
    txHashes: [],
    startedAt: new Date(),
  };

  sess.activeSnipes.push(activeSnipe);
  sess.snipeWizard = undefined;

  if (isImmediate) {
    await ctx.reply("🚀 <b>Firing autonomous snipe (Attempt 1)...</b>", {
      parse_mode: "HTML",
    });

    try {
      const report = await executeSnipe(
        sess.wallets.map((w) => decryptWallet(w)),
        plan,
        rpcUrls,
        maxFee,
        maxTip,
        250_000,
        BigInt(chain?.chainId || DEFAULT_CHAIN.chainId),
        (log) => sess.logs.push(log),
        3,
      );

      activeSnipe.txHashes = report.results.map((r) => r.txHash);
      activeSnipe.status = report.confirmed ? "completed" : "failed";

      if (report.confirmed && report.confirmedResult) {
        const r = report.confirmedResult;
        const msg =
          `🎉 <b>NFT Mint Snipe Confirmed!</b>\n\n` +
          `🎯 <b>Collection:</b> ${code(contractAddress)}\n` +
          `👤 <b>Minter Wallet:</b> ${code(r.address)}\n` +
          `🔢 <b>Quantity:</b> <code>${quantity}</code>\n` +
          `⚡ <b>Succeeded On:</b> <b>Attempt ${report.successfulAttempt} of 3</b> <i>(Stopped remaining attempts)</i>\n` +
          `📦 <b>Block:</b> <code>${r.blockNumber}</code>\n` +
          `⛽ <b>Gas Used:</b> <code>${r.gasUsed}</code>\n` +
          `🔗 <b>Transaction:</b> ${link(r.txHash.slice(0, 18) + "...", r.explorerUrl)}\n\n` +
          `✅ <i>Mint transaction verified on-chain. Task completed!</i>`;

        await ctx.reply(msg, {
          parse_mode: "HTML",
          reply_markup: getStatusKeyboard(),
          link_preview_options: { is_disabled: true },
        });
      } else {
        const attemptLines = report.results
          .map((r) => `  • Attempt ${r.attempt}: <b>${r.status.toUpperCase()}</b> (${esc(r.error || "No receipt")}) — ${link("TX", r.explorerUrl)}`)
          .join("\n");

        await ctx.reply(
          `❌ <b>Snipe Failed After ${report.attemptsRun} Sequential Attempt(s)</b>\n\n` +
            `🎯 <b>Collection:</b> ${code(contractAddress)}\n\n` +
            `<b>Attempt History:</b>\n${attemptLines}\n\n` +
            `<i>All sequential retries were exhausted without confirmation.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: getStatusKeyboard(),
            link_preview_options: { is_disabled: true },
          },
        );
      }
    } catch (err: any) {
      activeSnipe.status = "failed";
      await ctx.reply(`❌ <b>Snipe execution error:</b> ${esc(err.message)}`, {
        parse_mode: "HTML",
        reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
      });
    }
  } else {
    // Scheduled for start time or specific custom time
    const scheduledTime = new Date(scheduledTimeStr!);
    const waitMs = scheduledTime.getTime() - Date.now();

    const modeTitle =
      timingMode === "mint_start"
        ? "⚡ Mint Start (T-0)"
        : "⏰ Specific Time";

    await ctx.reply(
      `🎯 <b>Snipe Armed for Autonomous Execution!</b>\n\n` +
        `• <b>Mode:</b> ${esc(modeTitle)}\n` +
        `• <b>Target Time:</b> <code>${esc(scheduledTime.toISOString())}</code>\n` +
        `• <b>Waiting:</b> <b>${formatDuration(Math.max(0, Math.ceil(waitMs / 1000)))}</b>\n` +
        `• <b>Autonomous Logic:</b> Fires Attempt 1 instantly at T-0. Verifies success immediately; if successful, stops remaining attempts. Only retries attempts 2/3 on genuine failure.\n\n` +
        `<i>No action required from you at drop time. Use /cancel to abort anytime.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: getStatusKeyboard(),
      },
    );

    const timeoutId = setTimeout(
      async () => {
        activeSnipe.status = "firing";
        try {
          if (ctx.chat) {
            await ctx.api.sendMessage(
              ctx.chat.id,
              `⏰ <b>Target mint window arrived! Autonomously firing Attempt 1...</b>`,
              { parse_mode: "HTML" },
            );
          }

          const report = await executeSnipe(
            sess.wallets.map((w) => decryptWallet(w)),
            plan,
            rpcUrls,
            maxFee,
            maxTip,
            250_000,
            BigInt(chain?.chainId || DEFAULT_CHAIN.chainId),
            (log) => sess.logs.push(log),
            3,
          );

          activeSnipe.txHashes = report.results.map((r) => r.txHash);
          activeSnipe.status = report.confirmed ? "completed" : "failed";

          if (ctx.chat) {
            if (report.confirmed && report.confirmedResult) {
              const r = report.confirmedResult;
              const msg =
                `🎉 <b>Autonomous Snipe Confirmed!</b>\n\n` +
                `🎯 <b>Collection:</b> ${code(contractAddress)}\n` +
                `👤 <b>Minter Wallet:</b> ${code(r.address)}\n` +
                `🔢 <b>Quantity:</b> <code>${quantity}</code>\n` +
                `⚡ <b>Succeeded On:</b> <b>Attempt ${report.successfulAttempt} of 3</b> <i>(Remaining attempts stopped)</i>\n` +
                `📦 <b>Block:</b> <code>${r.blockNumber}</code>\n` +
                `⛽ <b>Gas Used:</b> <code>${r.gasUsed}</code>\n` +
                `🔗 <b>Transaction:</b> ${link(r.txHash.slice(0, 18) + "...", r.explorerUrl)}\n\n` +
                `✅ <i>Mint verified on-chain autonomously.</i>`;

              await ctx.api.sendMessage(ctx.chat.id, msg, {
                parse_mode: "HTML",
                reply_markup: getStatusKeyboard(),
                link_preview_options: { is_disabled: true },
              });
            } else {
              const attemptLines = report.results
                .map((r) => `  • Attempt ${r.attempt}: <b>${r.status.toUpperCase()}</b> (${esc(r.error || "No receipt")}) — ${link("TX", r.explorerUrl)}`)
                .join("\n");

              await ctx.api.sendMessage(
                ctx.chat.id,
                `❌ <b>Autonomous Snipe Completed Without Success</b>\n\n` +
                  `🎯 <b>Collection:</b> ${code(contractAddress)}\n\n` +
                  `<b>Attempt History:</b>\n${attemptLines}\n\n` +
                  `<i>All 3 sequential attempts were exhausted.</i>`,
                {
                  parse_mode: "HTML",
                  reply_markup: getStatusKeyboard(),
                  link_preview_options: { is_disabled: true },
                },
              );
            }
          }
        } catch (err: any) {
          activeSnipe.status = "failed";
          if (ctx.chat) {
            await ctx.api.sendMessage(
              ctx.chat.id,
              `❌ <b>Autonomous snipe execution failed:</b> ${esc(err.message)}`,
              {
                parse_mode: "HTML",
                reply_markup: getMainMenuKeyboard(
                  Boolean(sess.settings.customRpc),
                ),
              },
            );
          }
        }
      },
      Math.max(0, waitMs),
    );

    (activeSnipe as any)._timeoutId = timeoutId;
  }
}

async function promptSetChain(ctx: Context & SessionFlavor<UserSession>) {
  await ctx.reply("📡 <b>Select a network:</b>", {
    parse_mode: "HTML",
    reply_markup: getChainSelectionKeyboard(),
  });
}

async function promptSetRpc(ctx: Context & SessionFlavor<UserSession>) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply(
    `🔗 <b>Configure Your Alchemy RPC Endpoint</b>\n\n` +
      `Each user must provide their personal Alchemy RPC URL for dedicated speed and reliability.\n\n` +
      `<b>How to get your free RPC URL:</b>\n` +
      `1️⃣ Visit <a href="https://alchemy.com">alchemy.com</a> and create/log in to your account.\n` +
      `2️⃣ Create an App for your chain and copy your HTTPS URL.\n` +
      `   <i>Example:</i> <code>https://arb-sepolia.g.alchemy.com/v2/your-api-key</code>\n` +
      `   <i>Example:</i> <code>https://eth-mainnet.g.alchemy.com/v2/your-api-key</code>\n\n` +
      `👉 <b>Send your Alchemy HTTPS RPC URL now:</b>\n` +
      `(Send <code>clear</code> to remove custom RPC, or /cancel to abort)`,
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  );

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const input = msgCtx.message.text.trim();

    if (input === "/cancel") {
      await msgCtx.reply("❌ Action cancelled.", {
        reply_markup: getSettingsKeyboard(ctx.session),
      });
      return;
    }

    if (input.toLowerCase() === "default" || input.toLowerCase() === "clear") {
      ctx.session.settings.customRpc = "";
      await msgCtx.reply("✅ Custom RPC cleared.", {
        reply_markup: getSettingsKeyboard(ctx.session),
      });
      return;
    }

    try {
      const parsed = new URL(input);
      if (!parsed.protocol.startsWith("http")) {
        throw new Error("Protocol must be http or https");
      }

      ctx.session.settings.customRpc = input;
      const masked = maskRpcUrl(input);

      let notice = "";
      if (!isAlchemyUrl(input)) {
        notice =
          "\n\n💡 <i>Note: This does not look like an Alchemy URL, but it has been saved as your custom endpoint.</i>";
      }

      await msgCtx.reply(
        `✅ <b>Alchemy RPC Endpoint Saved!</b>\n\n` +
          `Endpoint: ${code(masked)}${notice}\n\n` +
          `Your snipe transactions will now be blasted via your dedicated RPC for maximum inclusion speed!`,
        {
          parse_mode: "HTML",
          reply_markup: getMainMenuKeyboard(true),
        },
      );
    } catch {
      await msgCtx.reply(
        "❌ Invalid URL. Please send a valid HTTPS RPC endpoint (e.g. <code>https://...alchemy.com/v2/...</code>).",
        {
          parse_mode: "HTML",
          reply_markup: getSettingsKeyboard(ctx.session),
        },
      );
    }
  });
}

async function promptSetMaxFee(ctx: Context & SessionFlavor<UserSession>) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.reply("Send the new max fee per gas in Gwei:");

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const val = parseFloat(msgCtx.message.text.trim());
    if (isNaN(val) || val <= 0) {
      await msgCtx.reply("❌ Invalid value. Send a positive number in Gwei.", {
        reply_markup: getSettingsKeyboard(ctx.session),
      });
      return;
    }
    ctx.session.settings.maxFeePerGas = val.toString();
    await msgCtx.reply(`✅ Max fee set to ${val} Gwei`, {
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  });
}

async function promptSetPriority(ctx: Context & SessionFlavor<UserSession>) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.reply("Send the new priority fee (tip) in Gwei:");

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const val = parseFloat(msgCtx.message.text.trim());
    if (isNaN(val) || val <= 0) {
      await msgCtx.reply("❌ Invalid value. Send a positive number in Gwei.", {
        reply_markup: getSettingsKeyboard(ctx.session),
      });
      return;
    }
    ctx.session.settings.maxPriorityFee = val.toString();
    await msgCtx.reply(`✅ Priority fee set to ${val} Gwei`, {
      reply_markup: getSettingsKeyboard(ctx.session),
    });
  });
}

async function handleCancelTasks(ctx: Context & SessionFlavor<UserSession>) {
  const sess = ctx.session;

  if (sess.snipeWizard) {
    sess.snipeWizard = undefined;
  }

  const pending = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting",
  );

  if (pending.length === 0) {
    await ctx.reply("ℹ️ No active tasks to cancel.", {
      reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
    });
    return;
  }

  for (const snipe of pending) {
    snipe.status = "cancelled";
    const timeoutId = (snipe as any)._timeoutId;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    sess.logs.push({
      timestamp: new Date(),
      message: `Cancelled snipe for ${snipe.contractAddress.slice(0, 10)}...`,
      type: "warning",
    });
  }

  await ctx.reply(`✅ Cancelled ${pending.length} pending task(s).`, {
    reply_markup: getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error("Bot error:", err);
});

export { bot };
export type { BotContext };
