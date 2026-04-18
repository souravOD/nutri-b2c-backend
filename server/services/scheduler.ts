// B2C-001: Notification scheduling via in-process cron
// Replaces the per-request trigger model with 2×/day batch processing.
import cron from "node-cron";
import { executeRaw } from "../config/database.js";
import { evaluateAndDispatchNotifications } from "./notificationEngine.js";
import { deleteAppwriteUserDirect, deleteAppwriteDocumentsDirect } from "./appwrite.js";
import { hardDeleteUser } from "../routes/user.js";
import { logger } from "../config/logger.js";

const CRON_ENABLED = process.env.NOTIFICATION_CRON_ENABLED === "true";
const MORNING_SCHEDULE = process.env.NOTIFICATION_CRON_MORNING ?? "0 8 * * *";
const EVENING_SCHEDULE = process.env.NOTIFICATION_CRON_EVENING ?? "0 18 * * *";
const BATCH_SIZE = parseInt(process.env.NOTIFICATION_CRON_BATCH_SIZE ?? "100", 10);
const CLEANUP_SCHEDULE = process.env.NOTIFICATION_CLEANUP_CRON ?? "0 3 * * 0"; // Sunday 3 AM
const PURGE_SCHEDULE = process.env.ACCOUNT_PURGE_CRON ?? "0 2 * * *";           // Daily 2 AM
const APPWRITE_RETRY_SCHEDULE = process.env.APPWRITE_RETRY_CRON ?? "0 * * * *"; // Hourly

async function runNotificationBatch(): Promise<void> {
  const startMs = Date.now();
  logger.info(`[scheduler] Notification batch starting...`);

  try {
    // Fetch active customers who have used the platform recently (last 7 days)
    const customers = (await executeRaw(
      `SELECT DISTINCT c.id
       FROM gold.b2c_customers c
       JOIN gold.b2c_session_events se
          ON se.b2c_customer_id = c.id
         AND se.created_at > NOW() - INTERVAL '7 days'
       ORDER BY c.id
       LIMIT $1`,
      [BATCH_SIZE]
    )) as unknown as { id: string }[];

    let success = 0;
    let errors = 0;

    for (const customer of customers) {
      try {
        await evaluateAndDispatchNotifications(customer.id);
        success++;
      } catch {
        errors++;
        // Individual failure should not break batch
      }
    }

    const elapsedMs = Date.now() - startMs;
    logger.info(
      `[scheduler] Notification batch complete: ${success} sent, ${errors} failed, ${elapsedMs}ms`
    );
  } catch (err) {
    logger.error("[scheduler] Notification batch failed:", err);
  }
}

// ── Weekly Notification Cleanup ───────────────────────────────────────────

async function runNotificationCleanup(): Promise<void> {
  // ────────────────────────────────────────────────────────────
  // ⚠️ COMPLIANCE WARNING — DO NOT MODIFY
  // The audit_log table has a 6-year mandatory retention requirement
  // per HIPAA §164.530(j). NEVER add gold.audit_log to any cleanup,
  // purge, or archival job in this scheduler.
  // See: docs/hipaa-compliance/data_retention_policy.md
  // ────────────────────────────────────────────────────────────
  const startMs = Date.now();
  logger.info("[scheduler] Notification cleanup starting...");

  try {
    // Purge ALL notifications (read + unread) older than 30 days
    const deleted = await executeRaw(
      `DELETE FROM gold.b2c_notifications
       WHERE created_at < NOW() - INTERVAL '30 days'
       RETURNING customer_id`,
      []
    );
    const deletedRows = deleted as unknown as { customer_id: string }[];
    const affectedCustomers = [...new Set(deletedRows.map(r => r.customer_id))];

    // Also purge old dispatch log entries (dedup only needs current day)
    const purged = await executeRaw(
      `DELETE FROM gold.b2c_notification_dispatch_log
       WHERE trigger_date < CURRENT_DATE - INTERVAL '30 days'
       RETURNING b2c_customer_id`,
      []
    );
    const purgedRows = purged as unknown as { b2c_customer_id: string }[];
    const affectedDispatchCustomers = [...new Set(purgedRows.map(r => r.b2c_customer_id))];

    const elapsedMs = Date.now() - startMs;
    logger.info(
      `[scheduler] Cleanup done: ${deletedRows.length} notifications (${affectedCustomers.length} customers), ` +
      `${purgedRows.length} dispatch logs (${affectedDispatchCustomers.length} customers) purged (${elapsedMs}ms)`
    );
    if (affectedCustomers.length > 0) {
      logger.info(`[scheduler] Affected notification customers: ${affectedCustomers.join(", ")}`);
    }
    if (affectedDispatchCustomers.length > 0) {
      logger.info(`[scheduler] Affected dispatch log customers: ${affectedDispatchCustomers.join(", ")}`);
    }
  } catch (err) {
    logger.error("[scheduler] Notification cleanup failed:", err);
  }
}

// ── Phase 2: Daily Account Purge ──────────────────────────────────────────────

async function runAccountPurge(): Promise<void> {
  const startMs = Date.now();
  logger.info("[scheduler] Account purge starting...");

  try {
    const expired = (await executeRaw(
      `SELECT id, appwrite_user_id FROM gold.b2c_customers
       WHERE account_status = 'pending_deletion'
       AND deletion_scheduled_at <= NOW()`,
      []
    )) as unknown as { id: string; appwrite_user_id: string }[];

    if (expired.length === 0) {
      logger.info("[scheduler] Account purge: no expired accounts");
      return;
    }

    let success = 0;
    let errors = 0;

    for (const row of expired) {
      try {
        await hardDeleteUser(row.id, row.appwrite_user_id);
        success++;
        logger.info(`[scheduler] Purged account ${row.id}`);
      } catch (err) {
        errors++;
        logger.error({ err, userId: row.id }, "[scheduler] Account purge failed for user");
      }
    }

    const elapsedMs = Date.now() - startMs;
    logger.info(
      `[scheduler] Account purge complete: ${success} purged, ${errors} failed, ${elapsedMs}ms`
    );
  } catch (err) {
    logger.error("[scheduler] Account purge batch failed:", err);
  }
}

// ── Phase 4: Appwrite Cleanup Retry ───────────────────────────────────────────

async function runAppwriteCleanupRetry(): Promise<void> {
  const startMs = Date.now();

  try {
    const pending = (await executeRaw(
      `SELECT id, appwrite_user_id, operation, attempts
       FROM gold.b2c_appwrite_cleanup_queue
       WHERE completed_at IS NULL
         AND attempts < max_attempts
         AND next_retry_at <= NOW()
       ORDER BY created_at
       LIMIT 10`,
      []
    )) as unknown as {
      id: string;
      appwrite_user_id: string;
      operation: string;
      attempts: number;
    }[];

    if (pending.length === 0) return;

    logger.info(`[scheduler] Appwrite retry: ${pending.length} pending jobs`);

    let success = 0;
    let failed = 0;

    for (const job of pending) {
      try {
        switch (job.operation) {
          case "delete_user":
            await deleteAppwriteUserDirect(job.appwrite_user_id);
            break;
          case "delete_documents":
            await deleteAppwriteDocumentsDirect(job.appwrite_user_id);
            break;
          case "disable_user": {
            // Re-use admin client inline — disableAppwriteUser has its own queue fallback
            const { Client, Users } = await import("node-appwrite");
            const client = new Client()
              .setEndpoint(process.env.APPWRITE_ENDPOINT!)
              .setProject(process.env.APPWRITE_PROJECT_ID!)
              .setKey(process.env.APPWRITE_API_KEY!);
            await new Users(client).updateStatus(job.appwrite_user_id, false);
            break;
          }
        }

        // Mark completed
        await executeRaw(
          `UPDATE gold.b2c_appwrite_cleanup_queue SET completed_at = NOW() WHERE id = $1`,
          [job.id]
        );
        success++;
        logger.info(`[scheduler] Appwrite retry succeeded: ${job.operation} for ${job.appwrite_user_id}`);
      } catch (e: any) {
        failed++;
        const errMsg = e?.message ?? String(e);
        // Exponential backoff: 15m → 30m → 60m
        const backoffMinutes = Math.pow(2, job.attempts) * 15;

        await executeRaw(
          `UPDATE gold.b2c_appwrite_cleanup_queue
           SET attempts = attempts + 1,
               last_error = $2,
               next_retry_at = NOW() + INTERVAL '1 minute' * $3
           WHERE id = $1`,
          [job.id, errMsg, backoffMinutes]
        );

        // Dead-letter alert: if this was the last attempt
        if (job.attempts + 1 >= 3) {
          logger.error(
            { userId: job.appwrite_user_id, operation: job.operation, attempts: job.attempts + 1 },
            "[scheduler] ⚠️ APPWRITE CLEANUP EXHAUSTED — manual intervention required"
          );
        }
      }
    }

    const elapsed = Date.now() - startMs;
    if (success + failed > 0) {
      logger.info(`[scheduler] Appwrite retry complete: ${success} ok, ${failed} failed, ${elapsed}ms`);
    }
  } catch (err) {
    logger.error("[scheduler] Appwrite retry batch failed:", err);
  }
}

export function initScheduler(): void {
  // ── Account lifecycle crons (always active — independent of notification toggle) ──
  cron.schedule(PURGE_SCHEDULE, runAccountPurge, {
    timezone: "America/New_York",
  });
  cron.schedule(APPWRITE_RETRY_SCHEDULE, runAppwriteCleanupRetry, {
    timezone: "America/New_York",
  });
  logger.info(
    `[scheduler] Account crons active: purge=${PURGE_SCHEDULE}, appwrite-retry=${APPWRITE_RETRY_SCHEDULE}`
  );

  // ── Notification crons (opt-in via NOTIFICATION_CRON_ENABLED) ──
  if (!CRON_ENABLED) {
    logger.info("[scheduler] Notification cron disabled (NOTIFICATION_CRON_ENABLED != true)");
    return;
  }

  if (!cron.validate(MORNING_SCHEDULE)) {
    logger.error(`[scheduler] Invalid morning cron: ${MORNING_SCHEDULE}`);
    return;
  }
  if (!cron.validate(EVENING_SCHEDULE)) {
    logger.error(`[scheduler] Invalid evening cron: ${EVENING_SCHEDULE}`);
    return;
  }

  // Notification crons
  cron.schedule(MORNING_SCHEDULE, runNotificationBatch, {
    timezone: "America/New_York",
  });
  cron.schedule(EVENING_SCHEDULE, runNotificationBatch, {
    timezone: "America/New_York",
  });
  cron.schedule(CLEANUP_SCHEDULE, runNotificationCleanup, {
    timezone: "America/New_York",
  });

  logger.info(
    `[scheduler] Notification crons active: morning=${MORNING_SCHEDULE}, evening=${EVENING_SCHEDULE}, ` +
    `cleanup=${CLEANUP_SCHEDULE}`
  );
}
