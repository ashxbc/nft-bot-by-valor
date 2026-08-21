"use strict";
// SeaDrop Sniper Bot — Vercel Serverless Entry Point
// Express + grammY webhookCallback for Telegram webhook mode.
//
// Architecture:
//   Telegram → Vercel Edge → POST /api → webhookCallback → bot handlers
//
// Vercel free tier: 10s function timeout per invocation.
// Session state is per-invocation (in-memory). For persistent multi-step
// wizards across requests, plug in a Redis/Upstash session store.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const grammy_1 = require("grammy");
const bot_1 = require("../bot");
const app = (0, express_1.default)();
// Parse JSON bodies (Telegram sends JSON POST payloads)
app.use(express_1.default.json());
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
app.use("/api", (0, grammy_1.webhookCallback)(bot_1.bot, "express", {
    // Optional: set a secret token to validate webhook requests
    // Telegram sends this in X-Telegram-Bot-Api-Secret-Token header
    secretToken: process.env.WEBHOOK_SECRET,
}));
// ─────────────────────────────────────────────────────────────────────────────
// REGISTER WEBHOOK — GET /api/register?token=YOUR_BOT_TOKEN&url=YOUR_VERCEL_URL
// ─────────────────────────────────────────────────────────────────────────────
// Hit this endpoint once after deployment to tell Telegram where to send updates.
// Example: https://your-project.vercel.app/api/register?url=https://your-project.vercel.app
app.get("/api/register", async (req, res) => {
    const url = req.query.url;
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
        const result = await bot_1.bot.api.setWebhook(webhookUrl, {
            secret_token: process.env.WEBHOOK_SECRET || undefined,
            max_connections: 40,
            allowed_updates: [
                "message",
                "callback_query",
                "inline_query",
            ],
            drop_pending_updates: true,
        });
        res.json({
            ok: result,
            webhook_url: webhookUrl,
            message: "Webhook registered successfully! Bot is now live.",
        });
    }
    catch (err) {
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
        const result = await bot_1.bot.api.deleteWebhook({ drop_pending_updates: true });
        res.json({
            ok: result,
            message: "Webhook removed. Bot can now use long-polling.",
        });
    }
    catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — Vercel serves this as a serverless function
// ─────────────────────────────────────────────────────────────────────────────
exports.default = app;
//# sourceMappingURL=index.js.map