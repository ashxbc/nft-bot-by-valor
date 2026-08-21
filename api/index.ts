// SeaDrop Sniper Bot — Vercel Serverless Entry Point
// Express + grammY webhookCallback for Telegram webhook mode.
//
// Architecture:
//   Telegram → Vercel Edge → POST /api → webhookCallback → bot handlers
//
// Vercel free tier: 10s function timeout per invocation.
// Session state is per-invocation (in-memory). For persistent multi-step
// wizards across requests, plug in a Redis/Upstash session store.

import "dotenv/config";
import express from "express";
import { webhookCallback } from "grammy";
import { bot } from "../bot";

const app = express();

// Parse JSON bodies (Telegram sends JSON POST payloads)
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK — GET /api
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
// TELEGRAM WEBHOOK — POST /api
// ─────────────────────────────────────────────────────────────────────────────
// webhookCallback returns Express middleware that:
//   1. Validates the Telegram request (secret token)
//   2. Parses the update
//   3. Runs it through the bot's middleware chain
//   4. Responds 200 OK immediately (Telegram requires <5s response)
//
// The bot processes the update asynchronously after the response is sent.
// Only pass secretToken if actually set — undefined causes Telegram API errors
const webhookOpts: Record<string, unknown> = {};
if (process.env.WEBHOOK_SECRET) {
  webhookOpts.secretToken = process.env.WEBHOOK_SECRET;
}
app.use("/api", webhookCallback(bot, "express", webhookOpts));

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER WEBHOOK — GET /api/register?token=YOUR_BOT_TOKEN&url=YOUR_VERCEL_URL
// ─────────────────────────────────────────────────────────────────────────────
// Hit this endpoint once after deployment to tell Telegram where to send updates.
// Example: https://your-project.vercel.app/api/register?url=https://your-project.vercel.app
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
    // Validate the URL looks correct
    const parsedUrl = new URL(url);
    const webhookUrl = `${parsedUrl.origin}/api`;

    // Register the webhook with Telegram
    const setWebhookOpts: Record<string, unknown> = {
      max_connections: 40,
      allowed_updates: [
        "message",
        "callback_query",
        "inline_query",
      ],
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
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE WEBHOOK — GET /api/deregister
// ─────────────────────────────────────────────────────────────────────────────
// Useful for switching back to long-polling during local development.
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
// EXPORT — Vercel serves this as a serverless function
// ─────────────────────────────────────────────────────────────────────────────
export default app;
