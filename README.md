# 🎯 SeaDrop NFT Sniper Bot

A high-performance Telegram bot for sniping SeaDrop NFT public mints on EVM networks (default: **Robinhood Chain Mainnet**, Chain ID: `4663`). Built with [grammY](https://grammy.dev), [Express](https://expressjs.com), and [ethers.js v6](https://docs.ethers.org/v6/).

## Features

- **Mobile Telegram UI** — Complete snipe setup & monitoring directly in chat.
- **Multi-Wallet Support** — Encrypts ephemeral private keys in-memory (AES-256-GCM).
- **Pre-Signing & Multi-RPC Blasting** — Pre-signs transactions and broadcasts simultaneously across multiple RPCs at T-0.
- **Interactive Wizard & Scheduler** — Guided 6-step setup with countdown timers for scheduled drops.
- **Hybrid Deployment** — Run locally via long-polling or deploy serverlessly to Vercel.

---

## Project Structure

```
├── api/
│   └── index.ts          # Express webhook entry point (Vercel serverless)
├── contracts/
│   └── MockSeaDrop.sol   # Mock contract for local/testnet testing
├── src/
│   ├── index.ts          # Local development entry point (long-polling)
│   ├── bot.ts            # Bot commands, middleware, and wizard logic
│   ├── chains.ts         # Chain registry & block explorer URLs
│   ├── mint.ts           # Sign, blast, and receipt polling pipeline
│   ├── seadrop.ts        # SeaDrop ABI & calldata construction
│   └── session.ts        # Encrypted session state management
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```

---

## Environment Variables

Create a `.env` file in the root directory:

```ini
BOT_TOKEN=your_telegram_bot_token
DEFAULT_RPC_URL=https://rpc.mainnet.chain.robinhood.com
WEBHOOK_SECRET=your_12_char_secret_token
# Optional:
# ADDITIONAL_RPC_URLS=https://rpc2.example.com,https://rpc3.example.com
# SESSION_ENCRYPTION_KEY=your_32_byte_custom_hex_key
```

---

## Quick Start

### 1. Local Development (Long-Polling)
```bash
npm install
npm run dev
```

### 2. Production Deployment (Vercel Webhook)
1. Deploy the repository to [Vercel](https://vercel.com).
2. Set environment variables (`BOT_TOKEN`, `DEFAULT_RPC_URL`, `WEBHOOK_SECRET`) in your Vercel project settings.
3. Register your webhook URL with Telegram:
   ```bash
   curl "https://your-project.vercel.app/api/register?url=https://your-project.vercel.app"
   ```

---

## Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | View status dashboard, loaded wallets, and gas settings |
| `/wallets` | Manage in-memory encrypted wallets (`/wallets_add`, `/wallets_view`, `/wallets_clear`) |
| `/snipe` | Start the 6-step interactive mint snipe wizard |
| `/confirm_snipe` | Fire or schedule the configured snipe |
| `/settings` | Configure RPCs, gas caps, and network |
| `/status` | View active snipes, countdowns, and execution logs |
| `/cancel` | Cancel pending or scheduled snipes |

---

## License

MIT
