-- 014_chat_sessions.sql
-- PRD-09: Chat session tracking for AI chatbot (PRD-16)

CREATE TABLE IF NOT EXISTS gold.chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  b2c_customer_id UUID NOT NULL REFERENCES gold.b2c_customers(id) ON DELETE CASCADE,
  session_data JSONB NOT NULL DEFAULT '{}',
  message_count INT NOT NULL DEFAULT 0,
  last_intent VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
);

CREATE INDEX idx_chat_sessions_customer ON gold.chat_sessions(b2c_customer_id);
CREATE INDEX idx_chat_sessions_expires ON gold.chat_sessions(expires_at);
