// SeaDrop NFT Sniper Telegram Bot
// Mobile-friendly interface built with grammY
// Default network: Robinhood Chain Mainnet (Chain ID: 4663)

import "dotenv/config";
import { Bot, Context, session, SessionFlavor, NextFunction } from "grammy";
import { Wallet, parseUnits, formatEther, JsonRpcProvider, isAddress } from "ethers";
import {
  UserSession,
  createDefaultSession,
  encryptWallet,
  decryptWallet,
  ActiveSnipe,
} from "./session";
import { buildMintPlan, fetchPublicDrop } from "./seadrop";
import { executeSnipe, resolveRpcUrls } from "./mint";
import { CHAINS, DEFAULT_CHAIN, resolveChain } from "./chains";

type BotContext = Context & SessionFlavor<UserSession>;

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is required. Set it in .env or environment variables.");
  process.exit(1);
}

const bot = new Bot<BotContext>(BOT_TOKEN);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Escape text for Telegram HTML parse mode */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

function link(label: string, url: string): string {
  return `<a href="${url}">${esc(label)}</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING MESSAGE HANDLER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const pendingHandlers = new Map<number, (ctx: BotContext, next: NextFunction) => Promise<void>>();

function registerPendingHandler(
  chatId: number,
  handler: (ctx: BotContext, next: NextFunction) => Promise<void>
) {
  pendingHandlers.set(chatId, handler);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SESSION MIDDLEWARE — MUST BE FIRST
// ─────────────────────────────────────────────────────────────────────────────
bot.use(
  session({
    initial: createDefaultSession,
  })
);

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

// /start — Main dashboard
bot.command("start", async (ctx) => {
  const sess = ctx.session;
  const chain = resolveChain(sess.settings.activeChain);
  const walletCount = sess.walletAddresses.length;
  const activeSnipes = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting"
  ).length;

  const walletLines =
    walletCount === 0
      ? "⚠️ No wallets loaded. Use /wallets to add one."
      : `✅ ${walletCount} wallet(s) ready:\n` +
        sess.walletAddresses
          .map((addr, i) => `  ${i + 1}. ${code(addr.slice(0, 10) + "..." + addr.slice(-8))}`)
          .join("\n");

  const rpcDisplay = sess.settings.customRpc
    ? "🔗 Custom: " + code(sess.settings.customRpc.slice(0, 40) + "...")
    : "🔗 Default: " + code(chain?.rpc.public[0] || "N/A");

  const text =
    `🔫 <b>SeaDrop NFT Sniper Bot</b>\n\n` +
    `📡 <b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (Chain ID: ${chain?.chainId || 4663})\n` +
    `${rpcDisplay}\n\n` +
    `💰 <b>Gas Settings:</b>\n` +
    `  Max Fee: ${esc(sess.settings.maxFeePerGas)} Gwei\n` +
    `  Priority Fee: ${esc(sess.settings.maxPriorityFee)} Gwei\n` +
    `  Safety Cap: ${sess.settings.gasSafetyCap ? "ON" : "OFF"}\n\n` +
    `👤 <b>Wallets:</b>\n  ${walletLines.replace(/\n/g, "\n  ")}\n\n` +
    `🎯 <b>Active Snipes:</b> ${activeSnipes}\n\n` +
    `<b>Commands:</b>\n` +
    `/snipe — Start a new mint snipe\n` +
    `/wallets — Manage wallets\n` +
    `/settings — Adjust settings\n` +
    `/status — View logs and active tasks\n` +
    `/cancel — Abort pending tasks`;

  await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});

// /wallets — Wallet manager menu
bot.command("wallets", async (ctx) => {
  const sess = ctx.session;

  const text =
    `👤 <b>Wallet Manager</b>\n\n` +
    `Currently loaded: ${sess.walletAddresses.length} wallet(s)\n\n` +
    `<b>Actions:</b>\n` +
    `/wallets_add — Add a private key\n` +
    `/wallets_view — View wallet addresses\n` +
    `/wallets_clear — Clear all wallets`;

  await ctx.reply(text, { parse_mode: "HTML" });
});

// /wallets_add — Add a private key
bot.command("wallets_add", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply(
    `🔑 <b>Send me a private key to add.</b>\n\n` +
    `The key is encrypted in memory and never saved to disk.\n` +
    `Send /cancel_w to abort.`,
    { parse_mode: "HTML" }
  );

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;

    if (msgCtx.message.text === "/cancel_w") {
      await msgCtx.reply("❌ Cancelled.");
      return;
    }

    const key = msgCtx.message.text.trim();

    try {
      const wallet = new Wallet(key);
      const encrypted = encryptWallet(key);

      ctx.session.wallets.push(encrypted);
      ctx.session.walletAddresses.push(wallet.address);

      await msgCtx.reply(
        `✅ <b>Wallet added!</b>\n\nAddress: ${code(wallet.address)}`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await msgCtx.reply(
        `❌ <b>Invalid private key:</b> ${esc(err.message || "Could not parse key")}`
      );
    }
  });
});

// /wallets_view — View balances
bot.command("wallets_view", async (ctx) => {
  const sess = ctx.session;

  if (sess.walletAddresses.length === 0) {
    await ctx.reply("⚠️ No wallets loaded. Use /wallets_add to add one.");
    return;
  }

  const chain = resolveChain(sess.settings.activeChain);
  const rpc = sess.settings.customRpc || chain?.rpc.public[0];
  if (!rpc) {
    await ctx.reply("⚠️ No RPC configured to fetch balances.");
    return;
  }

  const provider = new JsonRpcProvider(rpc);

  const lines = await Promise.all(
    sess.walletAddresses.map(async (addr, i) => {
      try {
        const balance = await provider.getBalance(addr);
        return `${i + 1}. ${code(addr)}\n   💰 ${formatEther(balance)} ETH`;
      } catch {
        return `${i + 1}. ${code(addr)}\n   💰 Balance: unknown`;
      }
    })
  );

  await ctx.reply(
    `👤 <b>Your Wallets (${sess.walletAddresses.length}):</b>\n\n` + lines.join("\n\n"),
    { parse_mode: "HTML" }
  );
});

// /wallets_clear — Clear all wallets
bot.command("wallets_clear", async (ctx) => {
  ctx.session.wallets = [];
  ctx.session.walletAddresses = [];
  await ctx.reply("🗑️ All wallets cleared from memory.");
});

// /snipe — Start the wizard
bot.command("snipe", async (ctx) => {
  const sess = ctx.session;

  if (sess.walletAddresses.length === 0) {
    await ctx.reply("⚠️ Add wallets first with /wallets_add before sniping.");
    return;
  }

  sess.snipeWizard = { step: 1 };
  await ctx.reply(
    `🎯 <b>SeaDrop Snipe Wizard</b>\n\n` +
    `Step 1/6: <b>Contract Address</b>\n` +
    `Send the NFT contract address (0x...).`,
    { parse_mode: "HTML" }
  );
});

// /confirm_snipe — Execute the snipe
bot.command("confirm_snipe", async (ctx) => {
  const sess = ctx.session;
  const wizard = sess.snipeWizard;

  if (!wizard || wizard.step !== 6 || !wizard.contractAddress) {
    await ctx.reply("⚠️ No snipe to confirm. Use /snipe to start.");
    return;
  }

  const chain = resolveChain(sess.settings.activeChain);
  const rpcUrls = resolveRpcUrls(
    sess.settings.customRpc,
    process.env.ADDITIONAL_RPC_URLS || ""
  );

  await ctx.reply("🔍 Building mint plan from on-chain data...");

  const plan = await buildMintPlan(rpcUrls[0], wizard.contractAddress, wizard.quantity!);
  if (!plan) {
    await ctx.reply(
      "❌ Could not build mint plan. Contract may not be a SeaDrop collection."
    );
    sess.snipeWizard = undefined;
    return;
  }

  const maxFee = parseUnits(wizard.maxFeePerGas!, "gwei");
  const maxTip = parseUnits(wizard.maxPriorityFee!, "gwei");

  const snipeId = `snipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const activeSnipe: ActiveSnipe = {
    id: snipeId,
    contractAddress: wizard.contractAddress,
    quantity: wizard.quantity!,
    maxFeePerGas: wizard.maxFeePerGas!,
    maxPriorityFee: wizard.maxPriorityFee!,
    timingMode: wizard.timingMode!,
    scheduledTime: wizard.scheduledTime ? new Date(wizard.scheduledTime) : undefined,
    status: wizard.timingMode === "now" ? "firing" : "waiting",
    txHashes: [],
    startedAt: new Date(),
  };

  sess.activeSnipes.push(activeSnipe);
  sess.snipeWizard = undefined;

  if (wizard.timingMode === "now") {
    await ctx.reply("🚀 <b>Firing immediately...</b>", { parse_mode: "HTML" });

    try {
      const results = await executeSnipe(
        sess.wallets.map((w) => decryptWallet(w)),
        plan,
        rpcUrls,
        maxFee,
        maxTip,
        250_000,
        BigInt(chain?.chainId || DEFAULT_CHAIN.chainId),
        (log) => sess.logs.push(log)
      );

      activeSnipe.txHashes = results.map((r) => r.txHash);
      activeSnipe.status = "completed";

      const resultLines = results.map((r) => {
        const icon = r.status === "confirmed" ? "✅" : r.status === "failed" ? "❌" : "⏳";
        const addr = r.address.slice(0, 10) + "..." + r.address.slice(-6);
        const txLabel = r.txHash.slice(0, 16) + "...";
        let line = `${icon} ${code(addr)}\n  TX: ${link(txLabel, r.explorerUrl)}`;
        if (r.blockNumber) {
          line += `\n  Block: ${r.blockNumber} | Gas: ${r.gasUsed}`;
        }
        return line;
      });

      await ctx.reply(
        `📊 <b>Snipe Results</b>\n\n` + resultLines.join("\n\n"),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } catch (err: any) {
      activeSnipe.status = "failed";
      await ctx.reply(`❌ <b>Snipe failed:</b> ${esc(err.message)}`, { parse_mode: "HTML" });
    }
  } else {
    // Scheduled
    const scheduledTime = new Date(wizard.scheduledTime!);
    const waitMs = scheduledTime.getTime() - Date.now();

    await ctx.reply(
      `⏰ <b>Scheduled!</b>\n\n` +
      `Will fire at: ${esc(scheduledTime.toISOString())}\n` +
      `Waiting: ${Math.ceil(waitMs / 1000)}s\n` +
      `Use /cancel to abort before it fires.`,
      { parse_mode: "HTML" }
    );

    const timeoutId = setTimeout(async () => {
      activeSnipe.status = "firing";
      try {
        const results = await executeSnipe(
          sess.wallets.map((w) => decryptWallet(w)),
          plan,
          rpcUrls,
          maxFee,
          maxTip,
          250_000,
          BigInt(chain?.chainId || DEFAULT_CHAIN.chainId),
          (log) => sess.logs.push(log)
        );

        activeSnipe.txHashes = results.map((r) => r.txHash);
        activeSnipe.status = "completed";

        if (ctx.chat) {
          const resultLines = results.map((r) => {
            const icon = r.status === "confirmed" ? "✅" : r.status === "failed" ? "❌" : "⏳";
            const addr = r.address.slice(0, 10) + "...";
            return `${icon} ${code(addr)} — ${link("TX", r.explorerUrl)}`;
          });

          await ctx.api.sendMessage(
            ctx.chat.id,
            `🚀 <b>Scheduled Snipe Fired!</b>\n\n` + resultLines.join("\n"),
            { parse_mode: "HTML" }
          );
        }
      } catch (err: any) {
        activeSnipe.status = "failed";
        if (ctx.chat) {
          await ctx.api.sendMessage(
            ctx.chat.id,
            `❌ <b>Scheduled snipe failed:</b> ${esc(err.message)}`,
            { parse_mode: "HTML" }
          );
        }
      }
    }, waitMs);

    (activeSnipe as any)._timeoutId = timeoutId;
  }
});

// /settings — Settings menu
bot.command("settings", async (ctx) => {
  const sess = ctx.session;
  const chain = resolveChain(sess.settings.activeChain);

  const text =
    `⚙️ <b>Settings</b>\n\n` +
    `<b>Network:</b> ${esc(chain?.name || "Robinhood Chain")} (${chain?.chainId || 4663})\n` +
    `/set_chain — Switch network\n\n` +
    `<b>RPC:</b>\n` +
    `Current: ${code(sess.settings.customRpc || chain?.rpc.public[0] || "N/A")}\n` +
    `/set_rpc — Set custom RPC URL\n\n` +
    `<b>Gas:</b>\n` +
    `Max Fee: ${esc(sess.settings.maxFeePerGas)} Gwei — /set_maxfee\n` +
    `Priority Fee: ${esc(sess.settings.maxPriorityFee)} Gwei — /set_priority\n` +
    `Safety Cap: ${sess.settings.gasSafetyCap ? "ON ✅" : "OFF ❌"} — /toggle_safety`;

  await ctx.reply(text, { parse_mode: "HTML" });
});

// /set_chain — Switch network
bot.command("set_chain", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const chainList = CHAINS.map(
    (c) => `🔹 ${esc(c.key)} — ${esc(c.name)} (ID: ${c.chainId})`
  ).join("\n");

  await ctx.reply(
    `📡 <b>Available Networks:</b>\n\n` +
    chainList + "\n\n" +
    `Send the chain key (e.g., ${code("robinhood")})`,
    { parse_mode: "HTML" }
  );

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const chain = resolveChain(msgCtx.message.text.trim());
    if (!chain) {
      await msgCtx.reply("❌ Unknown chain. Use /set_chain to see available options.");
      return;
    }
    ctx.session.settings.activeChain = chain.key;
    await msgCtx.reply(`✅ Network set to <b>${esc(chain.name)}</b>`, { parse_mode: "HTML" });
  });
});

// /set_rpc — Set custom RPC URL
bot.command("set_rpc", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply(
    `🔗 <b>Set Custom RPC URL</b>\n\n` +
    `Send a full RPC URL, or ${code("default")} to use the chain default.`,
    { parse_mode: "HTML" }
  );

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const rpc = msgCtx.message.text.trim();
    if (rpc.toLowerCase() === "default") {
      ctx.session.settings.customRpc = "";
      await msgCtx.reply("✅ RPC reset to chain default.");
    } else {
      try {
        new URL(rpc);
        ctx.session.settings.customRpc = rpc;
        await msgCtx.reply(`✅ Custom RPC set: ${code(rpc.slice(0, 50) + "...")}`, {
          parse_mode: "HTML",
        });
      } catch {
        await msgCtx.reply("❌ Invalid URL. Please send a valid RPC endpoint.");
      }
    }
  });
});

// /set_maxfee — Set max fee per gas
bot.command("set_maxfee", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.reply("Send the new max fee per gas in Gwei:");

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const val = parseFloat(msgCtx.message.text.trim());
    if (isNaN(val) || val <= 0) {
      await msgCtx.reply("❌ Invalid value. Send a positive number in Gwei.");
      return;
    }
    ctx.session.settings.maxFeePerGas = val.toString();
    await msgCtx.reply(`✅ Max fee set to ${val} Gwei`);
  });
});

// /set_priority — Set priority fee
bot.command("set_priority", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.reply("Send the new priority fee (tip) in Gwei:");

  registerPendingHandler(chatId, async (msgCtx, _next) => {
    if (!msgCtx.message?.text) return;
    const val = parseFloat(msgCtx.message.text.trim());
    if (isNaN(val) || val <= 0) {
      await msgCtx.reply("❌ Invalid value. Send a positive number in Gwei.");
      return;
    }
    ctx.session.settings.maxPriorityFee = val.toString();
    await msgCtx.reply(`✅ Priority fee set to ${val} Gwei`);
  });
});

// /toggle_safety — Toggle gas safety cap
bot.command("toggle_safety", async (ctx) => {
  ctx.session.settings.gasSafetyCap = !ctx.session.settings.gasSafetyCap;
  const state = ctx.session.settings.gasSafetyCap ? "ON ✅" : "OFF ❌";
  await ctx.reply(`Gas safety cap: <b>${state}</b>`, { parse_mode: "HTML" });
});

// /status — View active snipes and logs
bot.command("status", async (ctx) => {
  const sess = ctx.session;

  const activeSnipes = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting" || s.status === "firing"
  );

  const snipeLines =
    activeSnipes.length === 0
      ? "  No active snipes."
      : activeSnipes.map((s) => {
          const countdown =
            s.scheduledTime && s.status === "waiting"
              ? ` ⏳ ${Math.max(0, Math.ceil((s.scheduledTime.getTime() - Date.now()) / 1000))}s left`
              : "";
          return `  • ${esc(s.contractAddress.slice(0, 10) + "...")} | Qty: ${s.quantity} | ${esc(s.status)}${countdown}`;
        }).join("\n");

  const recentLogs = sess.logs.slice(-10);
  const logLines =
    recentLogs.length === 0
      ? "  No recent activity."
      : recentLogs.map((l) => {
          const icon =
            l.type === "success" ? "✅" : l.type === "error" ? "❌" : l.type === "warning" ? "⚠️" : "ℹ️";
          const time = l.timestamp.toLocaleTimeString();
          return `  ${icon} [${esc(time)}] ${esc(l.message)}`;
        }).join("\n");

  const text =
    `📊 <b>Status Dashboard</b>\n\n` +
    `<b>Active Snipes (${activeSnipes.length}):</b>\n` +
    snipeLines + "\n\n" +
    `<b>Recent Activity:</b>\n` +
    logLines + "\n\n" +
    `Total snipes completed: ${sess.activeSnipes.filter((s) => s.status === "completed").length}`;

  await ctx.reply(text, { parse_mode: "HTML" });
});

// /cancel — Abort pending/scheduled tasks
bot.command("cancel", async (ctx) => {
  const sess = ctx.session;

  if (sess.snipeWizard) {
    sess.snipeWizard = undefined;
  }

  const pending = sess.activeSnipes.filter(
    (s) => s.status === "pending" || s.status === "waiting"
  );

  if (pending.length === 0) {
    await ctx.reply("ℹ️ No active tasks to cancel.");
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

  await ctx.reply(`✅ Cancelled ${pending.length} pending task(s).`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WIZARD MESSAGE HANDLER — processes free-text input during snipe wizard
// ─────────────────────────────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const sess = ctx.session;
  if (!sess.snipeWizard) return;

  const text = ctx.message.text.trim();
  const wizard = sess.snipeWizard;

  if (text === "/cancel") {
    sess.snipeWizard = undefined;
    await ctx.reply("❌ Snipe wizard cancelled.");
    return;
  }

  switch (wizard.step) {
    case 1: {
      if (!isAddress(text)) {
        await ctx.reply("❌ Invalid address. Send a valid 0x contract address.");
        return;
      }
      wizard.contractAddress = text;
      wizard.step = 2;

      const chain = resolveChain(sess.settings.activeChain);
      const rpc = sess.settings.customRpc || chain?.rpc.public[0];
      if (!rpc) {
        await ctx.reply("❌ No RPC configured. Use /settings first.");
        sess.snipeWizard = undefined;
        return;
      }

      const drop = await fetchPublicDrop(rpc, text);
      if (drop) {
        await ctx.reply(
          `✅ <b>SeaDrop Public Drop Found!</b>\n\n` +
          `Price: ${code(formatEther(drop.mintPrice) + " ETH")}\n` +
          `Max per wallet: ${drop.maxTotalMintableByWallet}\n` +
          `Starts: ${code(new Date(drop.startTime * 1000).toISOString())}\n` +
          `Ends: ${code(new Date(drop.endTime * 1000).toISOString())}\n` +
          `Fee BPS: ${drop.feeBps}\n\n` +
          `Step 2/6: <b>Mint Quantity</b>\n` +
          `How many NFTs per wallet? (1–${drop.maxTotalMintableByWallet})`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `⚠️ Could not fetch drop info (may not be SeaDrop or network issue).\n\n` +
          `Step 2/6: <b>Mint Quantity</b>\n` +
          `How many NFTs per wallet?`,
          { parse_mode: "HTML" }
        );
      }
      break;
    }

    case 2: {
      const qty = parseInt(text, 10);
      if (isNaN(qty) || qty < 1 || qty > 100) {
        await ctx.reply("❌ Enter a valid quantity (1-100).");
        return;
      }
      wizard.quantity = qty;
      wizard.step = 3;

      await ctx.reply(
        `Step 3/6: <b>Max Fee Per Gas (ceiling)</b>\n\n` +
        `Max gas price you'll tolerate.\n` +
        `Recommended: ${esc(sess.settings.maxFeePerGas)} Gwei\n\n` +
        `Send a value in Gwei, or send ${code("default")} to use the current setting.`,
        { parse_mode: "HTML" }
      );
      break;
    }

    case 3: {
      const fee = text.toLowerCase() === "default" ? sess.settings.maxFeePerGas : text;
      const parsed = parseFloat(fee);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("❌ Enter a valid gas price in Gwei, or send 'default'.");
        return;
      }
      wizard.maxFeePerGas = fee;
      wizard.step = 4;

      await ctx.reply(
        `Step 4/6: <b>Priority Fee (tip)</b>\n\n` +
        `Paid to block producers for faster inclusion.\n` +
        `Recommended: ${esc(sess.settings.maxPriorityFee)} Gwei\n\n` +
        `Send a value in Gwei, or send ${code("default")} to use the current setting.`,
        { parse_mode: "HTML" }
      );
      break;
    }

    case 4: {
      const tip = text.toLowerCase() === "default" ? sess.settings.maxPriorityFee : text;
      const parsed = parseFloat(tip);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("❌ Enter a valid tip in Gwei, or send 'default'.");
        return;
      }
      wizard.maxPriorityFee = tip;
      wizard.step = 5;

      await ctx.reply(
        `Step 5/6: <b>Timing Mode</b>\n\n` +
        `Send ${code("now")} to fire immediately, or ${code("scheduled")} to wait for a specific time.`,
        { parse_mode: "HTML" }
      );
      break;
    }

    case 5: {
      if (text.toLowerCase() === "now") {
        wizard.timingMode = "now";
        wizard.step = 6;
        await showSnipeSummary(ctx, sess);
      } else if (text.toLowerCase() === "scheduled") {
        wizard.step = 51;
        await ctx.reply(
          `⏰ <b>Scheduled Mint Time</b>\n\n` +
          `Send the mint time in ISO format or Unix timestamp.\n` +
          `Example: ${code("2025-01-15T18:00:00Z")}`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply("Please send 'now' or 'scheduled'.", { parse_mode: "HTML" });
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
        await ctx.reply("❌ Invalid time. Try ISO format like '2025-01-15T18:00:00Z'");
        return;
      }

      if (scheduledDate.getTime() <= Date.now()) {
        await ctx.reply("❌ Scheduled time must be in the future.");
        return;
      }

      wizard.scheduledTime = scheduledDate.toISOString();
      wizard.timingMode = "scheduled";
      wizard.step = 6;
      await showSnipeSummary(ctx, sess);
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function showSnipeSummary(ctx: Context, sess: UserSession) {
  const wizard = sess.snipeWizard!;
  const chain = resolveChain(sess.settings.activeChain);

  const timingText = wizard.timingMode === "now"
    ? "🚀 Fire Now"
    : `⏰ Scheduled: ${wizard.scheduledTime}`;

  const text =
    `📋 <b>Snipe Summary</b>\n\n` +
    `Contract: ${code(wizard.contractAddress!)}\n` +
    `Quantity: ${wizard.quantity} per wallet\n` +
    `Max Fee: ${esc(wizard.maxFeePerGas!)} Gwei\n` +
    `Priority Fee: ${esc(wizard.maxPriorityFee!)} Gwei\n` +
    `Timing: ${esc(timingText)}\n` +
    `Wallets: ${sess.walletAddresses.length}\n` +
    `Network: ${esc(chain?.name || "Robinhood Chain")}\n\n` +
    `<b>Send /confirm_snipe to execute, or /cancel to abort.</b>`;

  await ctx.reply(text, { parse_mode: "HTML" });
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER + START
// ─────────────────────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error("Bot error:", err);
});

export { bot };
export type { BotContext };
