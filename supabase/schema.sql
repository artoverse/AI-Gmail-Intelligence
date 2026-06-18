-- ============================================================
-- Gmail Intelligence Platform — Supabase Schema
-- Run in Supabase SQL Editor AFTER enabling pgvector:
--   CREATE EXTENSION IF NOT EXISTS vector;
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS gmail_accounts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid REFERENCES auth.users NOT NULL,
  email_address   text UNIQUE,
  access_token    text,
  refresh_token   text,
  token_expiry    timestamp with time zone,
  history_id      text,
  last_synced     timestamp with time zone,
  created_at      timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_threads (
  id                  text PRIMARY KEY,          -- Gmail threadId
  gmail_account_id    uuid REFERENCES gmail_accounts ON DELETE CASCADE,
  subject             text,
  participants        jsonb DEFAULT '[]',
  last_message_date   timestamp with time zone,
  labels              text[] DEFAULT '{}',
  summary             text,
  embedding           vector(1024),              -- NIM nv-embedqa-e5-v5 dim
  created_at          timestamp with time zone DEFAULT now(),
  updated_at          timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_messages (
  id              text PRIMARY KEY,              -- Gmail messageId
  thread_id       text REFERENCES email_threads(id) ON DELETE CASCADE,
  from_address    text,
  to_addresses    text[] DEFAULT '{}',
  cc_addresses    text[] DEFAULT '{}',
  date            timestamp with time zone,
  subject         text,
  body_text       text,
  body_html       text,
  labels          text[] DEFAULT '{}',
  raw             jsonb,
  created_at      timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_categories (
  id          serial PRIMARY KEY,
  thread_id   text REFERENCES email_threads(id) ON DELETE CASCADE,
  category    text CHECK (category IN (
    'Newsletter','Job','Finance','Notification','Personal','Work','Other'
  )),
  confidence  float,
  created_at  timestamp with time zone DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Vector similarity search (HNSW for fast ANN)
CREATE INDEX IF NOT EXISTS idx_threads_embedding
  ON email_threads USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_threads_date
  ON email_threads (last_message_date DESC);

CREATE INDEX IF NOT EXISTS idx_threads_account
  ON email_threads (gmail_account_id);

CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON email_messages (thread_id);

CREATE INDEX IF NOT EXISTS idx_messages_date
  ON email_messages (date DESC);

CREATE INDEX IF NOT EXISTS idx_categories_thread
  ON email_categories (thread_id);

CREATE INDEX IF NOT EXISTS idx_gmail_accounts_user
  ON gmail_accounts (user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE gmail_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_threads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_categories ENABLE ROW LEVEL SECURITY;

-- gmail_accounts: users see only their own rows
CREATE POLICY "Users manage own gmail accounts"
  ON gmail_accounts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- email_threads: accessible if the account belongs to the user
CREATE POLICY "Users access own threads"
  ON email_threads FOR ALL
  USING (
    gmail_account_id IN (
      SELECT id FROM gmail_accounts WHERE user_id = auth.uid()
    )
  );

-- email_messages: accessible if the thread belongs to the user
CREATE POLICY "Users access own messages"
  ON email_messages FOR ALL
  USING (
    thread_id IN (
      SELECT t.id FROM email_threads t
      JOIN gmail_accounts a ON a.id = t.gmail_account_id
      WHERE a.user_id = auth.uid()
    )
  );

-- email_categories: same as messages
CREATE POLICY "Users access own categories"
  ON email_categories FOR ALL
  USING (
    thread_id IN (
      SELECT t.id FROM email_threads t
      JOIN gmail_accounts a ON a.id = t.gmail_account_id
      WHERE a.user_id = auth.uid()
    )
  );

-- ============================================================
-- RPC: match_threads (vector similarity search)
-- ============================================================

CREATE OR REPLACE FUNCTION match_threads(
  query_embedding   vector(1024),
  match_threshold   float     DEFAULT 0.75,
  match_count       int       DEFAULT 10,
  account_id        uuid      DEFAULT NULL
)
RETURNS TABLE (
  id                  text,
  subject             text,
  summary             text,
  participants        jsonb,
  last_message_date   timestamp with time zone,
  labels              text[],
  similarity          float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.subject,
    t.summary,
    t.participants,
    t.last_message_date,
    t.labels,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM email_threads t
  WHERE
    t.embedding IS NOT NULL
    AND (account_id IS NULL OR t.gmail_account_id = account_id)
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- UPDATED_AT trigger for email_threads
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER threads_updated_at
  BEFORE UPDATE ON email_threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
