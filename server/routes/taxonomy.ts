import { Router } from "express";
import { executeRaw } from "../config/database.js";

const router = Router();

router.get("/allergens", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.allergens
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/health-conditions", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.health_conditions
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/dietary-preferences", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.dietary_preferences
      where upper(category) in ('ETHICAL_RELIGIOUS', 'LIFESTYLE')
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/cuisines", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, coalesce(region, country) as category
      from gold.cuisines
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

export default router;
