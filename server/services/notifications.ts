import { executeRaw } from "../config/database.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Notification {
    id: string;
    customerId: string;
    type: string;
    title: string;
    body: string | null;
    icon: string | null;
    actionUrl: string | null;
    isRead: boolean;
    createdAt: string;
    readAt: string | null;
}

export interface GetNotificationsParams {
    customerId: string;
    type?: string;
    limit?: number;
    offset?: number;
}

// ── Service Functions ───────────────────────────────────────────────────────

export async function getNotifications(
    params: GetNotificationsParams
): Promise<{ notifications: Notification[]; total: number }> {
    const { customerId, type, limit = 20, offset = 0 } = params;

    const typeFilter = type ? `AND type = '${type}'` : "";

    const countRows = await executeRaw(
        `SELECT count(*)::int AS total
     FROM gold.b2c_notifications
     WHERE customer_id = $1 ${typeFilter}`,
        [customerId]
    );

    const rows = await executeRaw(
        `SELECT id, customer_id, type, title, body, icon, action_url,
            is_read, created_at, read_at
     FROM gold.b2c_notifications
     WHERE customer_id = $1 ${typeFilter}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
        [customerId, limit, offset]
    );

    return {
        notifications: rows.map(mapRow),
        total: (countRows[0] as any)?.total ?? 0,
    };
}

export async function getUnreadCount(customerId: string): Promise<number> {
    const rows = await executeRaw(
        `SELECT count(*)::int AS count
     FROM gold.b2c_notifications
     WHERE customer_id = $1 AND is_read = false`,
        [customerId]
    );
    return (rows[0] as any)?.count ?? 0;
}

export async function markAsRead(
    notificationId: string,
    customerId: string
): Promise<Notification | null> {
    const rows = await executeRaw(
        `UPDATE gold.b2c_notifications
     SET is_read = true, read_at = now()
     WHERE id = $1 AND customer_id = $2
     RETURNING id, customer_id, type, title, body, icon, action_url,
               is_read, created_at, read_at`,
        [notificationId, customerId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
}

export async function markAllAsRead(customerId: string): Promise<number> {
    const rows = await executeRaw(
        `UPDATE gold.b2c_notifications
     SET is_read = true, read_at = now()
     WHERE customer_id = $1 AND is_read = false
     RETURNING id`,
        [customerId]
    );
    return rows.length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRow(row: any): Notification {
    return {
        id: row.id,
        customerId: row.customer_id,
        type: row.type,
        title: row.title,
        body: row.body,
        icon: row.icon,
        actionUrl: row.action_url,
        isRead: row.is_read,
        createdAt: row.created_at,
        readAt: row.read_at,
    };
}
