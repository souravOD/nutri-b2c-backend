// server/routes/analyzer.ts
// API routes for recipe analyzer: text, URL, image, barcode analysis

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
  analyzeText,
  analyzeUrl,
  analyzeImage,
  analyzeBarcode,
  saveAnalyzedRecipe,
  type AnalyzeResult,
} from "../services/analyzer.js";
import multer from "multer";

const router = Router();

// Configure multer for image uploads (Phase 2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

function b2cCustomerId(req: any): string {
  return requireB2cCustomerIdFromReq(req);
}

// ─── Validation Schemas ───────────────────────────────────────────────────────

const textAnalysisSchema = z.object({
  text: z.string().min(3).max(50000), // Reduced min from 10 to 3 to allow short recipe names
  memberId: z.string().uuid().optional(),
});

const urlAnalysisSchema = z.object({
  url: z.string().url(),
  memberId: z.string().uuid().optional(),
});

const barcodeAnalysisSchema = z.object({
  barcode: z.string().min(4).max(30),
  memberId: z.string().uuid().optional(),
});

const saveRecipeSchema = z.object({
  result: z.custom<AnalyzeResult>(),
});

// ─── POST /api/v1/analyzer/text ───────────────────────────────────────────────
// Analyze pasted recipe text

router.post(
  "/text",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    try {
      const b2cId = b2cCustomerId(req);
      const body = textAnalysisSchema.parse(req.body ?? {});

      console.log("[Analyzer] Text analysis request:", { textLength: body.text.length, hasMemberId: !!body.memberId });

      const result = await analyzeText(body.text, b2cId, body.memberId);

      console.log("[Analyzer] Text analysis success:", { title: result.title, ingredientsCount: result.ingredients?.length || 0 });

      res.on("close", () => {
        console.log("[Analyzer] Response stream closed, writableFinished:", res.writableFinished);
      });

      res.json(result);
      console.log("[Analyzer] res.json() called, headersSent:", res.headersSent);
    } catch (err: any) {
      console.error("[Analyzer] Text analysis error:", err?.message || err, err?.stack);
      next(err);
    }
  }
);

// ─── POST /api/v1/analyzer/url ────────────────────────────────────────────────
// Scrape URL and analyze recipe

router.post(
  "/url",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    try {
      const b2cId = b2cCustomerId(req);
      const body = urlAnalysisSchema.parse(req.body ?? {});

      const result = await analyzeUrl(body.url, b2cId, body.memberId);

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/v1/analyzer/image ──────────────────────────────────────────────
// OCR image and analyze recipe (Phase 2)

router.post(
  "/image",
  authMiddleware,
  rateLimitMiddleware,
  upload.single("image"),
  async (req, res, next) => {
    try {
      const b2cId = b2cCustomerId(req);
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const memberId = req.body?.memberId;

      const result = await analyzeImage(file.buffer, b2cId, memberId);

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/v1/analyzer/barcode ───────────────────────────────────────────
// Look up product by barcode, then LLM-analyze

router.post(
  "/barcode",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    try {
      const b2cId = b2cCustomerId(req);
      const body = barcodeAnalysisSchema.parse(req.body ?? {});

      const result = await analyzeBarcode(body.barcode, b2cId, body.memberId);

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/v1/analyzer/save ──────────────────────────────────────────────
// Save analyzed recipe to user's collection

router.post(
  "/save",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    try {
      const b2cId = b2cCustomerId(req);
      const body = saveRecipeSchema.parse(req.body ?? {});

      const saved = await saveAnalyzedRecipe(body.result, b2cId);

      res.status(201).json(saved);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
