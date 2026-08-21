// SeaDrop Sniper Bot — Vercel Serverless Entry Point
// Express + grammY webhookCallback for Telegram webhook mode.
//
// Architecture:
//   Telegram -> Vercel Edge -> POST /api (or POST /) -> webhookCallback -> bot handlers

import "dotenv/config";
import express from "express";
import { webhookCallback } from "grammy";
import { bot, registerBotCommands } from "../src/bot";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK — GET / and GET /api
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/", "/api"], async (req, res) => {
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  let botInfo: any = null;
  try {
    botInfo = await bot.api.getMe();
  } catch (err: any) {
    botInfo = { error: err.message };
  }

  res.json({
    ok: true,
    bot: "SeaDrop Sniper Bot",
    username: botInfo?.username ? `@${botInfo.username}` : "unknown",
    status: "online",
    network: "Robinhood Chain (4663)",
    endpoints: {
      health: `${baseUrl}/api`,
      info: `${baseUrl}/api/info`,
      register: `${baseUrl}/api/register`,
      deregister: `${baseUrl}/api/deregister`,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK STATUS & DIAGNOSTICS — GET /api/info and GET /info
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/info", "/api/info"], async (_req, res) => {
  try {
    const [me, webhookInfo] = await Promise.all([
      bot.api.getMe(),
      bot.api.getWebhookInfo(),
    ]);

    res.json({
      ok: true,
      bot: {
        id: me.id,
        first_name: me.first_name,
        username: `@${me.username}`,
      },
      webhook: webhookInfo,
      status: webhookInfo.url ? "webhook_active" : "webhook_not_registered",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER WEBHOOK — GET /api/register and GET /register
// (Auto-detects host if ?url parameter is omitted)
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/register", "/api/register"], async (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const defaultUrl = host ? `${protocol}://${host}` : undefined;

  const url = (req.query.url as string) || defaultUrl;

  if (!url) {
    res.status(400).json({
      error: "Missing ?url parameter and could not detect host header",
      usage: "GET /api/register?url=https://your-project.vercel.app",
    });
    return;
  }

  try {
    const parsedUrl = new URL(url);
    const webhookUrl = `${parsedUrl.origin}/api`;

    const setWebhookOpts: Record<string, unknown> = {
      max_connections: 40,
      allowed_updates: ["message", "callback_query", "inline_query"],
      drop_pending_updates: false,
    };
    if (process.env.WEBHOOK_SECRET) {
      setWebhookOpts.secret_token = process.env.WEBHOOK_SECRET;
    }

    const result = await bot.api.setWebhook(webhookUrl, setWebhookOpts);
    await registerBotCommands().catch(console.error);

    const webhookInfo = await bot.api.getWebhookInfo();

    res.json({
      ok: result,
      webhook_url: webhookUrl,
      message: "Webhook registered successfully! Bot is now live and receiving updates.",
      webhookInfo,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE WEBHOOK — GET /api/deregister and GET /deregister
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/deregister", "/api/deregister"], async (_req, res) => {
  try {
    const result = await bot.api.deleteWebhook({ drop_pending_updates: true });
    res.json({
      ok: result,
      message: "Webhook removed. Bot can now use local long-polling (npm run dev).",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM WEBHOOK HANDLER (POST /api and POST /)
// ─────────────────────────────────────────────────────────────────────────────
const webhookOpts: Record<string, unknown> = {};
if (process.env.WEBHOOK_SECRET) {
  webhookOpts.secretToken = process.env.WEBHOOK_SECRET;
}

const cb = webhookCallback(bot, "express", webhookOpts);
app.post(["/", "/api"], cb);
app.use(cb);

// ─────────────────────────────────────────────────────────────────────────────
export default app;
