import type { Express } from "express";
import { createServer, type Server } from "http";
import recipesRouter from "./routes/recipes.js";
import feedRouter from "./routes/feed.js";
import userRouter from "./routes/user.js";
import adminRouter from "./routes/admin.js";
import healthRouter from "./routes/health.js";
import syncRouter from "./routes/sync.js";
import taxonomyRouter from "./routes/taxonomy.js";
import scanRouter from "./routes/scan.js";
import analyzerRouter from "./routes/analyzer.js";
import mealLogRouter from "./routes/mealLog.js";
import householdRouter from "./routes/household.js";
import mealPlanRouter from "./routes/mealPlan.js";
import groceryListRouter from "./routes/groceryList.js";
import budgetRouter from "./routes/budget.js";
import nutritionDashboardRouter from "./routes/nutritionDashboard.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { idempotencyMiddleware, storeIdempotentResponse } from "./middleware/idempotency.js";
import userRecipesRouter from "./routes/userRecipes.js";

export async function registerRoutes(app: Express): Promise<Server> {
  // Global middleware
  app.use(idempotencyMiddleware);
  app.use(storeIdempotentResponse);

  // API routes
  app.use("/api/v1/recipes", recipesRouter);
  app.use("/api/v1/feed", feedRouter);
  app.use("/api/v1/me", userRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/sync", syncRouter);
  app.use("/api/v1/taxonomy", taxonomyRouter);
  app.use("/api/v1/user-recipes", userRecipesRouter);
  app.use("/api/v1/scan", scanRouter);
  app.use("/api/v1/analyzer", analyzerRouter);
  app.use("/api/v1/meal-log", mealLogRouter);
  app.use("/api/v1/households", householdRouter);
  app.use("/api/v1/meal-plans", mealPlanRouter);
  app.use("/api/v1/grocery-lists", groceryListRouter);
  app.use("/api/v1/budget", budgetRouter);
  app.use("/api/v1/nutrition-dashboard", nutritionDashboardRouter);
  // Health checks (no /api prefix)
  app.use("/", healthRouter);

  // Error handling - Note: notFoundHandler will be added after Vite middleware in index.ts
  app.use(errorHandler);

  const httpServer = createServer(app);
  return httpServer;
}
