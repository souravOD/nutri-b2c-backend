import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import AdminDashboard from "@/pages/admin-dashboard";
import AdminRecipes from "@/pages/admin-recipes";
import AdminUsers from "@/pages/admin-users";
import AdminUserContent from "@/pages/admin-user-content";
import AdminSearch from "@/pages/admin-search";
import AdminPerformance from "@/pages/admin-performance";
import AdminAudit from "@/pages/admin-audit";
import AdminDatabase from "@/pages/admin-database";
import AdminAuth from "@/pages/admin-auth";
import AdminTeams from "@/pages/admin-teams";
import AdminRateLimits from "@/pages/admin-rate-limits";
import Home from "@/pages/home";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/" component={AdminDashboard} />
      <Route path="/admin/recipes" component={AdminRecipes} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/admin/user-content" component={AdminUserContent} />
      <Route path="/admin/search" component={AdminSearch} />
      <Route path="/admin/performance" component={AdminPerformance} />
      <Route path="/admin/audit" component={AdminAudit} />
      <Route path="/admin/database" component={AdminDatabase} />
      <Route path="/admin/auth" component={AdminAuth} />
      <Route path="/admin/teams" component={AdminTeams} />
      <Route path="/admin/rate-limits" component={AdminRateLimits} />
      {/* Fallback to 404 */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
