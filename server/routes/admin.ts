import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { auditedRoute } from "../middleware/audit.js";
import { requireAdmin } from "../auth/admin.js";
import { setCurrentUser } from "../config/database.js";
import { 
  createCuratedRecipe, 
  updateCuratedRecipe, 
  deleteCuratedRecipe,
  getAuditLog,
  getDashboardStats
} from "../services/admin.js";
import { insertRecipeSchema } from "../../shared/goldSchema.js";

const router = Router();

// Development bypass for all admin routes
if (process.env.NODE_ENV === 'development') {
  router.use(async (req, res, next) => {
    console.log(`[ADMIN] Development bypass for: ${req.url}`);
    req.user = {
      userId: 'dev-admin-user',
      isAdmin: true,
      effectiveUserId: 'dev-admin-user',
      isImpersonating: false,
      profile: { role: 'admin' }
    };
    await setCurrentUser('dev-admin-user');
    next();
  });
} else {
  // Require admin for all routes in production
  router.use(authMiddleware);
  router.use((req, res, next) => {
    requireAdmin(req.user);
    next();
  });
}
router.use(rateLimitMiddleware);

// Dashboard
router.get("/dashboard", async (req, res, next) => {
  try {
    const stats = await getDashboardStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// Curated recipe management
router.post("/recipes", auditedRoute(async (req, res, next) => {
  try {
    const recipeData = insertRecipeSchema.parse(req.body);
    const recipe = await createCuratedRecipe(req.user.userId, recipeData, req.body.reason);
    res.status(201).json(recipe);
  } catch (error) {
    next(error);
  }
}));

router.put("/recipes/:id", auditedRoute(async (req, res, next) => {
  try {
    const updates = insertRecipeSchema.partial().parse(req.body);
    const recipe = await updateCuratedRecipe(req.user.userId, req.params.id, updates, req.body.reason);
    res.json(recipe);
  } catch (error) {
    next(error);
  }
}));

router.delete("/recipes/:id", auditedRoute(async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Reason is required for recipe deletion',
        instance: req.url
      });
    }
    
    const result = await deleteCuratedRecipe(req.user.userId, req.params.id, reason);
    res.json(result);
  } catch (error) {
    next(error);
  }
}));

// User content moderation
router.post("/user-recipes/:id/approve", auditedRoute(async (req, res, next) => {
  try {
    res.status(501).json({ error: "User recipe moderation is not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
}));

router.post("/user-recipes/:id/reject", auditedRoute(async (req, res, next) => {
  try {
    res.status(501).json({ error: "User recipe moderation is not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
}));

// Reports and moderation
router.get("/reports", async (req, res, next) => {
  try {
    res.status(501).json({ error: "Reports are not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
});

router.post("/reports/:id/resolve", auditedRoute(async (req, res, next) => {
  try {
    res.status(501).json({ error: "Report resolution is not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
}));

// Audit logs
router.get("/audit", async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    const actorUserId = req.query.actor_user_id as string;
    
    const logs = await getAuditLog(limit, offset, actorUserId);
    res.json(logs);
  } catch (error) {
    next(error);
  }
});

// System operations
router.post("/refresh-materialized-views", auditedRoute(async (req, res, next) => {
  try {
    res.status(501).json({ error: "Materialized views are not configured in the gold schema." });
  } catch (error) {
    next(error);
  }
}));

export default router;
