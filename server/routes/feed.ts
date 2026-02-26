import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { getPersonalizedFeedWithRAG, getFeedRecommendationsWithRAG } from "../services/feed.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";

const router = Router();

// PRD-11: Graph-enhanced feed (RAG → SQL fallback)
router.get("/", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 200;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const results = await getPersonalizedFeedWithRAG(b2cCustomerId, limit, offset);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

router.get("/recommendations", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const recommendations = await getFeedRecommendationsWithRAG(b2cCustomerId);
    res.json(recommendations);
  } catch (error) {
    next(error);
  }
});

export default router;

