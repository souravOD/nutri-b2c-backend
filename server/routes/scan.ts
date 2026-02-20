// server/routes/scan.ts
// API routes for barcode scanning: product lookup, scan history

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
    lookupProductByBarcode,
    saveScanHistory,
    getScanHistory,
} from "../services/scan.js";

const router = Router();

function b2cCustomerId(req: any): string {
    return requireB2cCustomerIdFromReq(req);
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const lookupSchema = z.object({
    barcode: z
        .string()
        .min(4)
        .max(50)
        .regex(/^[0-9A-Za-z\-]+$/, "Invalid barcode format"),
    memberId: z.string().uuid().optional(),
});

const saveHistorySchema = z.object({
    barcode: z
        .string()
        .min(4)
        .max(50)
        .regex(/^[0-9A-Za-z\-]+$/, "Invalid barcode format"),
    productId: z.string().uuid().optional(),
    barcodeFormat: z
        .enum([
            "EAN_13",
            "EAN_8",
            "UPC_A",
            "UPC_E",
            "CODE_128",
            "CODE_39",
            "QR_CODE",
            "Manual",
        ])
        .optional(),
    scanSource: z.enum(["camera", "image", "manual"]).optional(),
});

// ─── POST /api/v1/scan/lookup ───────────────────────────────────────────────
// Look up a product by barcode with personalized warnings
router.post(
    "/lookup",
    authMiddleware,
    rateLimitMiddleware,
    async (req, res, next) => {
        try {
            const id = b2cCustomerId(req);
            const body = lookupSchema.parse(req.body ?? {});

            const result = await lookupProductByBarcode(
                body.barcode,
                id,
                body.memberId
            );

            res.json(result);
        } catch (err) {
            next(err);
        }
    }
);

// ─── POST /api/v1/scan/history ──────────────────────────────────────────────
// Save a scan event to history
router.post(
    "/history",
    authMiddleware,
    rateLimitMiddleware,
    async (req, res, next) => {
        try {
            const id = b2cCustomerId(req);
            const body = saveHistorySchema.parse(req.body ?? {});
            const householdId = (req as any).user?.profile?.householdId ?? undefined;

            const scanId = await saveScanHistory({
                b2cCustomerId: id,
                householdId,
                productId: body.productId,
                barcode: body.barcode,
                barcodeFormat: body.barcodeFormat,
                scanSource: body.scanSource,
            });

            res.status(201).json({ id: scanId, success: true });
        } catch (err) {
            next(err);
        }
    }
);

// ─── GET /api/v1/scan/history ───────────────────────────────────────────────
// Get paginated scan history for the current user
router.get(
    "/history",
    authMiddleware,
    rateLimitMiddleware,
    async (req, res, next) => {
        try {
            const id = b2cCustomerId(req);
            const limit = req.query.limit
                ? parseInt(req.query.limit as string, 10)
                : 20;
            const offset = req.query.offset
                ? parseInt(req.query.offset as string, 10)
                : 0;

            const history = await getScanHistory(id, limit, offset);
            res.json(history);
        } catch (err) {
            next(err);
        }
    }
);

export default router;
