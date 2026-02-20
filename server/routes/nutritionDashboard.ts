import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
  getHouseholdTimezone,
  getNutritionDashboardDaily,
  getNutritionDashboardWeekly,
  getNutritionHealthMetrics,
  getNutritionMemberSummary,
} from "../services/nutritionDashboard.js";

const router = Router();
router.use(authMiddleware);

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

const dailyQuerySchema = z.object({
  date: z.string().regex(isoDateRegex).optional(),
  memberId: z.string().uuid().optional(),
});

const weeklyQuerySchema = z.object({
  weekStart: z.string().regex(isoDateRegex).optional(),
  memberId: z.string().uuid().optional(),
});

const memberSummaryQuerySchema = z.object({
  date: z.string().regex(isoDateRegex).optional(),
});

const healthMetricsQuerySchema = z.object({
  memberId: z.string().uuid().optional(),
});

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

function normalizeTimeZone(tz: string): string {
  const value = (tz || "").trim();
  if (!value) return "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function ymdInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const mapped = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${mapped.year}-${mapped.month}-${mapped.day}`;
}

function toWeekStartMonday(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const diff = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

router.get(
  "/daily",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorMemberId = b2cId(req);
      const parsed = dailyQuerySchema.parse(req.query ?? {});
      const timezone = normalizeTimeZone(await getHouseholdTimezone(actorMemberId));
      const date = parsed.date ?? ymdInTimeZone(timezone);
      const data = await getNutritionDashboardDaily({
        actorMemberId,
        memberId: parsed.memberId,
        date,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/weekly",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorMemberId = b2cId(req);
      const parsed = weeklyQuerySchema.parse(req.query ?? {});
      const timezone = normalizeTimeZone(await getHouseholdTimezone(actorMemberId));
      const baseDate = parsed.weekStart ?? ymdInTimeZone(timezone);
      const weekStart = parsed.weekStart ?? toWeekStartMonday(baseDate);
      const data = await getNutritionDashboardWeekly({
        actorMemberId,
        memberId: parsed.memberId,
        weekStart,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/member-summary",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorMemberId = b2cId(req);
      const parsed = memberSummaryQuerySchema.parse(req.query ?? {});
      const timezone = normalizeTimeZone(await getHouseholdTimezone(actorMemberId));
      const date = parsed.date ?? ymdInTimeZone(timezone);
      const data = await getNutritionMemberSummary({
        actorMemberId,
        date,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/health-metrics",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorMemberId = b2cId(req);
      const parsed = healthMetricsQuerySchema.parse(req.query ?? {});
      const data = await getNutritionHealthMetrics({
        actorMemberId,
        memberId: parsed.memberId,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

export default router;

