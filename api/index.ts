// SeaDrop Sniper Bot — Vercel Serverless Entry Point & Gated Web Dashboard
// Web dashboard at https://nft-bot-by-valor.vercel.app/ is gated by a 12-character access key.

import "dotenv/config";
import express from "express";
import { webhookCallback } from "grammy";
import { bot, registerBotCommands } from "../src/bot";
import { precisionScheduler } from "../src/scheduler";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 12-Character Access Key for Web Dashboard
const ACCESS_KEY = (process.env.ACCESS_KEY || "v9x2m4k7p8q3").trim();

// ─────────────────────────────────────────────────────────────────────────────
// COOKIE PARSER HELPER
// ─────────────────────────────────────────────────────────────────────────────
function getCookie(req: express.Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function isAuthorized(req: express.Request): boolean {
  const queryKey = req.query.key as string;
  const cookieKey = getCookie(req, "gate_pass");
  const headerKey = req.headers["x-access-key"] as string;
  const authHeader = req.headers.authorization;
  const bearerKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  const key = queryKey || cookieKey || headerKey || bearerKey;
  return Boolean(key && key.trim().toLowerCase() === ACCESS_KEY.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-REGISTRATION HELPER
// ─────────────────────────────────────────────────────────────────────────────
let isWebhookAutoRegistered = false;

async function ensureWebhookRegistered(hostHeader?: string) {
  if (isWebhookAutoRegistered) return;

  const rawHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.APP_URL ||
    hostHeader ||
    process.env.VERCEL_URL;

  if (!rawHost || rawHost.includes("localhost")) return;

  const cleanHost = rawHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const webhookUrl = `https://${cleanHost}/api`;

  try {
    const info = await bot.api.getWebhookInfo();
    if (info.url !== webhookUrl) {
      const opts: Record<string, unknown> = {
        max_connections: 40,
        allowed_updates: ["message", "callback_query", "inline_query"],
        drop_pending_updates: false,
      };
      if (process.env.WEBHOOK_SECRET) {
        opts.secret_token = process.env.WEBHOOK_SECRET;
      }
      await bot.api.setWebhook(webhookUrl, opts);
      await registerBotCommands().catch(console.error);
      console.log(`✅ Webhook auto-registered to ${webhookUrl}`);
    }
    isWebhookAutoRegistered = true;
  } catch (err: any) {
    console.error("⚠️ Failed to auto-register webhook:", err.message);
  }
}

// Attach auto-registration middleware for background webhooks
app.use(async (req, _res, next) => {
  const host = req.headers.host;
  ensureWebhookRegistered(host).catch(console.error);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML TEMPLATES: LOGIN GATE & DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
function renderLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SeaDrop Sniper Bot — Access Gate</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0b0e14; color: #e1e7ec; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #151a23; border: 1px solid #242c3d; border-radius: 16px; width: 100%; max-width: 420px; padding: 36px 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    p { font-size: 14px; color: #8b9bb4; line-height: 1.5; margin-bottom: 24px; }
    .input-group { margin-bottom: 20px; text-align: left; }
    label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 8px; }
    input[type="password"], input[type="text"] { width: 100%; padding: 14px 16px; background: #0f131a; border: 1px solid #2a3449; border-radius: 10px; color: #fff; font-size: 16px; font-family: monospace; letter-spacing: 2px; text-align: center; outline: none; transition: border-color 0.2s; }
    input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
    button { width: 100%; padding: 14px; background: linear-gradient(135deg, #2563eb, #1d4ed8); border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    button:hover { background: linear-gradient(135deg, #1d4ed8, #1e40af); transform: translateY(-1px); }
    .error { background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #fca5a5; padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 18px; }
    .footer { margin-top: 24px; font-size: 12px; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1>SeaDrop Sniper Bot</h1>
    <p>This deployment is private. Please enter your 12-character access key to access the control panel.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form action="/login" method="POST">
      <div class="input-group">
        <label for="key">12-Character Access Key</label>
        <input type="text" id="key" name="key" placeholder="••••••••••••" maxlength="12" required autofocus autocomplete="off" autocorrect="off" autocapitalize="off">
      </div>
      <button type="submit">Unlock Dashboard</button>
    </form>
    <div class="footer">Robinhood Chain Mainnet • SeaDrop Protocol</div>
  </div>
</body>
</html>`;
}

function renderDashboardHtml(
  botUsername: string,
  webhookInfo: any,
  baseUrl: string,
): string {
  const isHookActive = Boolean(webhookInfo?.url);
  const statusBadge = isHookActive
    ? `<span style="background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid #22c55e; padding:4px 10px; border-radius:20px; font-size:12px; font-weight:600;">ACTIVE</span>`
    : `<span style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid #ef4444; padding:4px 10px; border-radius:20px; font-size:12px; font-weight:600;">NOT REGISTERED</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SeaDrop Sniper Bot — Control Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0b0e14; color: #e1e7ec; display: flex; justify-content: center; padding: 40px 20px; min-height: 100vh; }
    .container { width: 100%; max-width: 640px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 700; color: #fff; }
    .logout-btn { color: #94a3b8; text-decoration: none; font-size: 13px; padding: 6px 12px; border: 1px solid #334155; border-radius: 8px; transition: all 0.2s; }
    .logout-btn:hover { background: #1e293b; color: #fff; }
    .card { background: #151a23; border: 1px solid #242c3d; border-radius: 16px; padding: 24px; margin-bottom: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.3); }
    .card-title { font-size: 15px; font-weight: 600; color: #cbd5e1; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #1e2736; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .label { color: #64748b; }
    .value { font-weight: 500; font-family: monospace; color: #f1f5f9; word-break: break-all; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 16px; border-radius: 10px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; text-align: center; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
    .btn-secondary:hover { background: #334155; color: #fff; }
    .btn-danger { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
    .btn-danger:hover { background: rgba(239,68,68,0.25); }
    .tg-btn { grid-column: span 2; background: #0088cc; color: #fff; margin-top: 4px; }
    .tg-btn:hover { background: #0077b5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎯 SeaDrop Sniper Control Panel</h1>
      <a href="/logout" class="logout-btn">🔒 Lock Portal</a>
    </div>

    <div class="card">
      <div class="card-title">
        <span>🤖 Bot Instance</span>
        <span>${statusBadge}</span>
      </div>
      <div class="row">
        <span class="label">Telegram Bot</span>
        <span class="value">${botUsername}</span>
      </div>
      <div class="row">
        <span class="label">Network</span>
        <span class="value">Robinhood Chain (Chain ID: 4663)</span>
      </div>
      <div class="row">
        <span class="label">Webhook Target</span>
        <span class="value">${webhookInfo?.url || "None"}</span>
      </div>
      <div class="row">
        <span class="label">Pending Telegram Updates</span>
        <span class="value">${webhookInfo?.pending_update_count || 0}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">⚡ Quick Management Actions</div>
      <div class="actions">
        <a href="/register" class="btn btn-primary">🚀 Register Webhook</a>
        <a href="/deregister" class="btn btn-danger">🧹 Deregister Webhook</a>
        <a href="/api/info" target="_blank" class="btn btn-secondary">📊 Raw Diagnostics (JSON)</a>
        <a href="/" class="btn btn-secondary">🔄 Refresh Panel</a>
        <a href="https://t.me/${botUsername.replace(/^@/, "")}" target="_blank" class="btn tg-btn">💬 Open Bot in Telegram (${botUsername})</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES: LOGIN & LOGOUT
// ─────────────────────────────────────────────────────────────────────────────
app.post("/login", (req, res) => {
  const inputKey = (req.body.key as string)?.trim() || "";
  if (inputKey.toLowerCase() === ACCESS_KEY.toLowerCase()) {
    res.setHeader(
      "Set-Cookie",
      `gate_pass=${encodeURIComponent(ACCESS_KEY)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`,
    );
    return res.redirect("/");
  }
  res
    .status(401)
    .send(
      renderLoginHtml("❌ Invalid 12-character access key. Please try again."),
    );
});

app.get("/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    `gate_pass=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
  );
  res.redirect("/");
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD & HEALTH CHECK — GET / and GET /api
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/", "/api"], async (req, res) => {
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  const authorized = isAuthorized(req);

  // If browser request and not authorized -> show access gate page
  const acceptsHtml = req.headers.accept?.includes("text/html");
  if (!authorized) {
    if (acceptsHtml) {
      return res.send(renderLoginHtml());
    }
    return res.status(401).json({
      ok: false,
      error:
        "Access Restricted: 12-character access key required. Access via browser or pass ?key=...",
    });
  }

  // Authorized user
  let botUsername = "unknown";
  let webhookInfo: any = {};
  try {
    const [me, info] = await Promise.all([
      bot.api.getMe(),
      bot.api.getWebhookInfo(),
    ]);
    botUsername = me?.username ? `@${me.username}` : "unknown";
    webhookInfo = info;
  } catch {}

  if (acceptsHtml) {
    return res.send(renderDashboardHtml(botUsername, webhookInfo, baseUrl));
  }

  res.json({
    ok: true,
    bot: "SeaDrop Sniper Bot",
    username: botUsername,
    status: "online",
    network: "Robinhood Chain (4663)",
    webhook: webhookInfo,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK STATUS & DIAGNOSTICS — GET /api/info and GET /info
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/info", "/api/info"], async (req, res) => {
  if (!isAuthorized(req)) {
    if (req.headers.accept?.includes("text/html")) {
      return res.send(renderLoginHtml());
    }
    return res.status(401).json({
      ok: false,
      error: "Access Restricted: 12-character access key required.",
    });
  }

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
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/register", "/api/register"], async (req, res) => {
  if (!isAuthorized(req)) {
    if (req.headers.accept?.includes("text/html")) {
      return res.send(renderLoginHtml());
    }
    return res.status(401).json({
      ok: false,
      error: "Access Restricted: 12-character access key required.",
    });
  }

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
    const parsedUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
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

    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/");
    }

    res.json({
      ok: result,
      webhook_url: webhookUrl,
      message:
        "Webhook registered successfully! Bot is now live and receiving updates.",
      webhookInfo,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE WEBHOOK — GET /api/deregister and GET /deregister
// ─────────────────────────────────────────────────────────────────────────────
app.get(["/deregister", "/api/deregister"], async (req, res) => {
  if (!isAuthorized(req)) {
    if (req.headers.accept?.includes("text/html")) {
      return res.send(renderLoginHtml());
    }
    return res.status(401).json({
      ok: false,
      error: "Access Restricted: 12-character access key required.",
    });
  }

  try {
    const result = await bot.api.deleteWebhook({ drop_pending_updates: true });

    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/");
    }

    res.json({
      ok: result,
      message:
        "Webhook removed. Bot can now use local long-polling (npm run dev).",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK ENDPOINT (GET /api/ping or GET /ping)
// ─────────────────────────────────────────────────────────────────────────────
app.all(["/api/ping", "/ping", "/api/health", "/health"], (_req, res) => {
  res.json({
    ok: true,
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM WEBHOOK HANDLER (POST /api and POST /)
// Incoming Telegram server updates bypass browser HTML gate
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
