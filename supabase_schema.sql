-- Supabase PostgreSQL Schema for SeaDrop NFT Sniper Bot
-- Zero Private Key Storage Paradigm: Wallets table stores ONLY public addresses.
-- Sensitive RPC endpoints are encrypted using AES-256-GCM before storage.

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS public.users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  custom_rpc_encrypted TEXT,
  max_fee_per_gas TEXT DEFAULT '0.1',
  max_priority_fee TEXT DEFAULT '0.01',
  gas_safety_cap BOOLEAN DEFAULT true,
  active_chain TEXT DEFAULT 'robinhood',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. WALLETS TABLE (PUBLIC ADDRESSES ONLY - NO PRIVATE KEYS)
CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_wallet UNIQUE (user_id, address)
);

-- 3. MINT TASKS TABLE
CREATE TABLE IF NOT EXISTS public.mint_tasks (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  message_id BIGINT,
  contract_address TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  max_fee_per_gas TEXT NOT NULL,
  max_priority_fee TEXT NOT NULL,
  timing_mode TEXT NOT NULL,
  target_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'armed',
  tx_hashes JSONB DEFAULT '[]'::jsonb,
  attempts_run INTEGER DEFAULT 0,
  successful_attempt INTEGER,
  block_number BIGINT,
  gas_used TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ACTIVITY LOGS TABLE
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  task_id TEXT,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEXES FOR MAXIMUM QUERY PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_mint_tasks_user_id ON public.mint_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_mint_tasks_status ON public.mint_tasks(status);
CREATE INDEX IF NOT EXISTS idx_mint_tasks_target_time ON public.mint_tasks(target_time);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON public.activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs(created_at DESC);

-- DISABLE ROW LEVEL SECURITY (RLS) FOR DIRECT BOT ACCESS
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mint_tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs DISABLE ROW LEVEL SECURITY;
