-- 002_appwrite_cleanup_queue.sql
-- Phase 4: Retry queue for failed Appwrite API operations.
-- When deleteAppwriteUser/deleteAppwriteDocuments/disableAppwriteUser fails,
-- the operation is queued here and retried hourly by the scheduler cron.

CREATE TABLE IF NOT EXISTS gold.b2c_appwrite_cleanup_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appwrite_user_id TEXT NOT NULL,
  operation VARCHAR(30) NOT NULL DEFAULT 'delete_user',
  -- Supported operations:
  --   'delete_user'      → users.delete()
  --   'delete_documents' → deleteAppwriteDocuments()
  --   'disable_user'     → users.updateStatus(false)
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Partial index: only pending items (fast lookups for the retry worker)
CREATE INDEX IF NOT EXISTS idx_b2c_appwrite_queue_pending
  ON gold.b2c_appwrite_cleanup_queue (next_retry_at)
  WHERE completed_at IS NULL AND attempts < max_attempts;

