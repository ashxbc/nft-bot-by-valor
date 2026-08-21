# 🎯 SeaDrop NFT Sniper Bot

A Telegram bot interface for sniping SeaDrop NFT mints, built with **grammY**, **Express**, and **ethers.js v6**.

**Network:** Robinhood Chain Mainnet (Chain ID: 4663)  
**Default RPC:** `https://rpc.mainnet.chain.robinhood.com`

## Features

- **Mobile-friendly Telegram UI** — Snipe NFTs right from your phone
- **Multi-wallet support** — Add multiple wallets, snipe from all simultaneously
- **Multi-RPC blasting** — Broadcast to multiple RPCs for fastest inclusion
- **Pre-signing** — Sign transactions before the stage opens; blast raw bytes at T-0
- **Interactive snipe wizard** — Step-by-step guided mint configuration
- **Scheduled mints** — Set exact mint times with countdown timers
- **Encrypted session storage** — Private keys encrypted in memory with AES-256-GCM
- **Gas safety caps** — Protect against runaway gas prices
- **Real-time TX notifications** — Instant hash, block, and gas confirmation in chat
- **Webhook mode** — Runs on Vercel serverless with auto-scaling and 24/7 uptime

## Architecture

```
                    ┌─────────────┐
                    │  Telegram   │
                    │   Servers   │
                    └──────┬──────┘
                           │ HTTPS POST /api
                    ┌──────▼──────┐
                    │   Vercel    │
                    │  Edge/CDN   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Express +  │
                    │  webhookCal │
                    │  lback      │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  grammY Bot │
                    │  Middleware  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Robinhood  │
                    │  Chain RPC  │
                    └─────────────┘
```

## Quick Start

### 1. Get a Telegram Bot Token

1. Open Telegram → search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts and copy your bot token

### 2. Install & Configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
BOT_TOKEN=your_bot_token_here
DEFAULT_RPC_URL=https://rpc.mainnet.chain.robinhood.com
WEBHOOK_SECRET=your_random_secret_here
```

Generate a webhook secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deployment to Vercel (Production)

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USER/seadrop-sniper-bot.git
git push -u origin main
```

### Step 2: Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository
3. Vercel auto-detects the Node.js project
4. Add environment variables in the Vercel dashboard:
   - `BOT_TOKEN` → your Telegram bot token
   - `DEFAULT_RPC_URL` → `https://rpc.mainnet.chain.robinhood.com`
   - `WEBHOOK_SECRET` → your random secret string
5. Click **Deploy**

### Step 3: Register the Webhook

After deployment, Vercel gives you a URL like `https://seadrop-sniper-bot.vercel.app`. Register it with Telegram:

```bash
curl "https://seadrop-sniper-bot.vercel.app/api/register?url=https://seadrop-sniper-bot.vercel.app"
```

Response:
```json
{
  "ok": true,
  "webhook_url": "https://seadrop-sniper-bot.vercel.app/api",
  "message": "Webhook registered successfully! Bot is now live."
}
```

### Step 4: Test

Open Telegram → find your bot → send `/start`

**Done!** The bot is now running 24/7 on Vercel's free tier with automatic scaling.

### Useful Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api` | GET | Health check — returns `{"ok": true}` |
| `/api` | POST | Telegram webhook (auto-registered) |
| `/api/register` | GET | Register webhook with Telegram |
| `/api/deregister` | GET | Remove webhook (for local dev) |

## Local Development (Long-Polling)

For local development, use long-polling mode instead of webhooks.

1. Make sure the webhook is removed:
```bash
curl "http://localhost:3000/api/deregister"
# or from Vercel:
curl "https://seadrop-sniper-bot.vercel.app/api/deregister"
```

2. Run locally:
```bash
npm run dev
```

This starts the bot with long-polling (no Vercel needed).

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show main dashboard with wallet status, gas, network |
| `/wallets` | Wallet manager — add, view, or clear wallets |
| `/wallets_add` | Add a private key (encrypted in memory) |
| `/wallets_view` | View wallet addresses and ETH balances |
| `/wallets_clear` | Clear all wallets from memory |
| `/snipe` | Start the interactive snipe wizard (6 steps) |
| `/confirm_snipe` | Execute the configured snipe |
| `/settings` | Adjust gas, RPC, network settings |
| `/set_chain` | Switch network |
| `/set_rpc` | Set custom RPC URL |
| `/set_maxfee` | Set max gas price (Gwei) |
| `/set_priority` | Set priority fee / tip (Gwei) |
| `/toggle_safety` | Toggle gas safety cap |
| `/status` | View active snipes, countdowns, and logs |
| `/cancel` | Abort pending or scheduled tasks |

## Snipe Flow

1. `/snipe` — Start the wizard
2. Send contract address (`0x...`)
3. Send quantity (1–100)
4. Send max fee per gas (Gwei)
5. Send priority fee / tip (Gwei)
6. Choose timing: `now` or `scheduled`
7. Review summary
8. `/confirm_snipe` — Fire!

## Project Structure

```
├── api/
│   └── index.ts          # Express webhook server (Vercel entry point)
├── contracts/
│   └── MockSeaDrop.sol   # Mock SeaDrop contract for testing
├── src/
│   ├── index.ts          # Local development entry point (long-polling)
│   ├── bot.ts            # grammY bot: commands, wizard, middleware
│   ├── chains.ts         # Chain registry (Robinhood Chain 4663)
│   ├── seadrop.ts        # SeaDrop mintPublic() calldata builder
│   ├── mint.ts           # Sign → blast → receipt pipeline
│   └── session.ts        # AES-256-GCM encrypted wallet storage
├── .env.example          # Environment template
├── package.json          # Dependencies & scripts
├── tsconfig.json         # TypeScript config
├── vercel.json           # Vercel deployment config
└── README.md             # Documentation
```

## How It Works

### Webhook Mode (Production)

1. Telegram sends updates to `POST /api` as HTTPS requests
2. Vercel routes the request to the serverless function
3. `webhookCallback` validates the request and parses the update
4. grammY runs the bot's middleware chain (session → handlers → wizard)
5. The bot responds via Telegram's `sendMessage` API
6. Vercel returns 200 OK to Telegram (must be <5 seconds)

### Multi-RPC Blasting

1. Wallet transactions are pre-signed before the fire moment
2. Raw signed bytes are sent to multiple RPCs simultaneously via `eth_sendRawTransaction`
3. First accepted transaction wins — receipts are polled for confirmation
4. TX hash, block number, and gas used are sent to the chat

### Security

- Private keys are **encrypted in memory** using AES-256-GCM
- Keys are **never written to disk**
- Webhook requests are validated with `WEBHOOK_SECRET`
- Vercel automatically handles HTTPS and DDoS protection

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DEFAULT_RPC_URL` | ❌ | Default RPC endpoint (defaults to Robinhood Chain) |
| `WEBHOOK_SECRET` | ⚠️ | Secret token for webhook validation (recommended) |
| `ADDITIONAL_RPC_URLS` | ❌ | Comma-separated backup RPC endpoints |
| `SESSION_ENCRYPTION_KEY` | ❌ | 32-byte hex key for wallet encryption |

## License

MIT
