// server/scheduler.ts
// PRD-29: Background notification cron scheduler
// ─────────────────────────────────────────────────

import cron from "node-cron";
import {
    evaluateAndDispatchNotifications,
    getActiveCustomerIds,
} from "./services/notificationEngine.js";

export function startNotificationCron(): void {
    if (process.env.NOTIFICATION_CRON_ENABLED !== "true") {
        console.log("[CRON] Notification scheduler disabled (NOTIFICATION_CRON_ENABLED != true)");
        return;
    }

    // 4 batches daily at 11 AM, 2 PM, 6 PM, 9 PM UTC
    cron.schedule("0 11,14,18,21 * * *", async () => {
        console.log("[CRON] Starting notification batch evaluation...");
        const start = Date.now();

        try {
            const customerIds = await getActiveCustomerIds();
            let totalDispatched = 0;

            for (const id of customerIds) {
                try {
                    const result = await evaluateAndDispatchNotifications(id);
                    totalDispatched += result.dispatched;
                } catch (err) {
                    console.error(`[CRON] Error evaluating customer ${id}:`, err);
                }
            }

            const elapsed = Date.now() - start;
            console.log(
                `[CRON] Batch complete: ${customerIds.length} customers, ${totalDispatched} dispatched, ${elapsed}ms`
            );
        } catch (err) {
            console.error("[CRON] Batch evaluation failed:", err);
        }
    });

    console.log("[CRON] Notification scheduler started (4x daily: 11,14,18,21 UTC)");
}
