-- 015_notifications.sql
-- Notification center for B2C customers

CREATE TABLE IF NOT EXISTS gold.b2c_notifications (
    id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES gold.b2c_customers(id) ON DELETE CASCADE,
    type        varchar(30) NOT NULL CHECK (type IN ('meal','nutrition','grocery','budget','family','system')),
    title       varchar(500) NOT NULL,
    body        text,
    icon        varchar(100),
    action_url  varchar(500),
    is_read     boolean DEFAULT false NOT NULL,
    created_at  timestamptz DEFAULT now() NOT NULL,
    read_at     timestamptz
);

COMMENT ON TABLE gold.b2c_notifications IS 'Notification center items for B2C customers';

-- Fast lookup for a user''s notifications (most recent first)
CREATE INDEX IF NOT EXISTS idx_b2c_notifications_customer
    ON gold.b2c_notifications (customer_id, created_at DESC);

-- Fast count of unread notifications
CREATE INDEX IF NOT EXISTS idx_b2c_notifications_unread
    ON gold.b2c_notifications (customer_id)
    WHERE is_read = false;
