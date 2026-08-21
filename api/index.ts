// SeaDrop Sniper Bot — Vercel Serverless Entry Point
// Express + grammY webhookCallback for Telegram webhook mode.
//
// Architecture:
//   Telegram -> Vercel Edge -> POST /api -> webhookCallback -> bot handlers
//
// Vercel free tier: 10s function timeout per invocation.

import "dotenv/config";
import express from "express";
import { webhookCallback } from "grammy";
import { bot } from "../bot";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    bot: "SeaDrop Sniper Bot",
    network: "Robinhood Chain (4663)",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER WEBHOOK — GET /api/register?url=https://your-app.vercel.app
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/register", async (req, res) => {
  const url = req.query.url as string;

  if (!url) {
    res.status(400).json({
      error: "Missing ?url parameter",
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
      drop_pending_updates: true,
    };
    if (process.env.WEBHOOK_SECRET) {
      setWebhookOpts.secret_token = process.env.WEBHOOK_SECRET;
    }

    const result = await bot.api.setWebhook(webhookUrl, setWebhookOpts);

    res.json({
      ok: result,
      webhook_url: webhookUrl,
      message: "Webhook registered successfully! Bot is now live.",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE WEBHOOK — GET /api/deregister
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/deregister", async (_req, res) => {
  try {
    const result = await bot.api.deleteWebhook({ drop_pending_updates: true });
    res.json({
      ok: result,
      message: "Webhook removed. Bot can now use long-polling.",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM WEBHOOK — POST /api (MUST be last — catches all POST /api/*)
// ─────────────────────────────────────────────────────────────────────────────
const webhookOpts: Record<string, unknown> = {};
if (process.env.WEBHOOK_SECRET) {
  webhookOpts.secretToken = process.env.WEBHOOK_SECRET;
}
app.use("/api", webhookCallback(bot, "express", webhookOpts));

// ─────────────────────────────────────────────────────────────────────────────
export default app;
