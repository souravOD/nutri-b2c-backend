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

    // Build parameterized type filter (defense-in-depth against SQL injection)
    const baseParams: (string | number)[] = [customerId];
    let typeClause = "";
    if (type) {
        baseParams.push(type);
        typeClause = `AND type = $${baseParams.length}`;
    }

    const countRows = await executeRaw(
        `SELECT count(*)::int AS total
     FROM gold.b2c_notifications
     WHERE customer_id = $1 ${typeClause}`,
        baseParams
    );

    const dataParams: (string | number)[] = [...baseParams, limit, offset];
    const limitIdx = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    const rows = await executeRaw(
        `SELECT id, customer_id, type, title, body, icon, action_url,
            is_read, created_at, read_at
     FROM gold.b2c_notifications
     WHERE customer_id = $1 ${typeClause}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        dataParams
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

export async function createNotification(input: {
    customerId: string;
    type: string;
    title: string;
    body?: string;
    icon?: string;
    actionUrl?: string;
}): Promise<Notification> {
    const rows = await executeRaw(
        `INSERT INTO gold.b2c_notifications
             (customer_id, type, title, body, icon, action_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, customer_id, type, title, body, icon, action_url,
                   is_read, created_at, read_at`,
        [
            input.customerId,
            input.type,
            input.title,
            input.body ?? null,
            input.icon ?? null,
            input.actionUrl ?? null,
        ]
    );
    return mapRow(rows[0]);
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
