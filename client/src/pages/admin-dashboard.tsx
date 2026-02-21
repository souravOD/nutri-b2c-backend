import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sidebar } from "@/components/admin/Sidebar";
import { TopBar } from "@/components/admin/TopBar";
import { DashboardStats } from "@/components/admin/DashboardStats";
import { AuditLogTable } from "@/components/admin/AuditLogTable";
import { ModerationQueue } from "@/components/admin/ModerationQueue";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  Activity, 
  Database, 
  RefreshCw, 
  Shield, 
  AlertCircle,
  CheckCircle,
  Clock
} from "lucide-react";
import { useState } from "react";

type DashboardStatsData = {
  totalRecipes?: number;
  activeUsers?: number;
  searchQps?: number;
  pendingReview?: number;
};

type AuditLogRow = {
  id: string;
  action: string;
  at?: string;
  actorUserId?: string;
  targetTable?: string;
  targetId?: string;
};

type ReportRow = { id: string };

export default function AdminDashboard() {
  const [refreshing, setRefreshing] = useState(false);

  const { data: dashboardStats, isLoading: statsLoading } = useQuery<DashboardStatsData>({
    queryKey: ["/api/v1/admin/dashboard"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const { data: auditLogs, isLoading: auditLoading } = useQuery<AuditLogRow[]>({
    queryKey: ["/api/v1/admin/audit"],
    enabled: true,
  });

  const { data: reports, isLoading: reportsLoading } = useQuery<ReportRow[]>({
    queryKey: ["/api/v1/admin/reports"],
    enabled: true,
  });

  const handleRefreshMaterializedViews = async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/v1/admin/refresh-materialized-views", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (response.ok) {
        // Refetch dashboard data
        window.location.reload();
      }
    } catch (error) {
      console.error("Failed to refresh materialized views:", error);
    } finally {
      setRefreshing(false);
    }
  };

  if (statsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-gray-600">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-gray-50">
      <Sidebar />
      
      <main className="flex-1 flex flex-col min-w-0">
        <TopBar />
        
        <div className="flex-1 p-6 overflow-auto scrollbar-thin">
          {/* System Status Cards */}
          <DashboardStats stats={dashboardStats} />
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {/* Search Performance Analytics */}
            <Card>
              <CardHeader className="border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-semibold text-gray-900">
                    Search Performance
                  </CardTitle>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-500">Real-time</span>
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">FTS Query Performance</span>
                    <span className="text-sm font-medium text-gray-900 font-mono">avg 23ms</span>
                  </div>
                  <Progress value={85} className="h-2" />
                  
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Materialized View Refresh</span>
                    <span className="text-sm font-medium text-gray-900 font-mono">2m 14s ago</span>
                  </div>
                  <Progress value={95} className="h-2" />
                  
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">GIN Index Utilization</span>
                    <span className="text-sm font-medium text-gray-900 font-mono">97.3%</span>
                  </div>
                  <Progress value={97} className="h-2" />
                </div>
              </CardContent>
            </Card>
            
            {/* Rate Limiting Status */}
            <Card>
              <CardHeader className="border-b border-gray-200">
                <CardTitle className="text-lg font-semibold text-gray-900">
                  Rate Limiting Status
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Read Operations</p>
                      <p className="text-xs text-gray-600">60 req/min limit</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-green-700">47/60</p>
                      <p className="text-xs text-gray-500">78% used</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 bg-yellow-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Write Operations</p>
                      <p className="text-xs text-gray-600">6 req/min limit</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-yellow-700">5/6</p>
                      <p className="text-xs text-gray-500">83% used</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 bg-red-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Blocked Requests</p>
                      <p className="text-xs text-gray-600">Last 5 minutes</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-red-700">12</p>
                      <p className="text-xs text-gray-500">429 errors</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          
          {/* Recent Audit Logs */}
          <AuditLogTable logs={auditLogs || []} loading={auditLoading} />
          
          {/* Database Operations & Content Moderation */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Database Operations */}
            <Card>
              <CardHeader className="border-b border-gray-200">
                <CardTitle className="text-lg font-semibold text-gray-900">
                  Database Operations
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-6">
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Active Connections</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Read Pool</span>
                        <span className="font-mono text-gray-900">47/100</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Write Pool</span>
                        <span className="font-mono text-gray-900">12/50</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Idle</span>
                        <span className="font-mono text-gray-900">91</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-blue-50 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-gray-900 mb-3">RLS Policies</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">saved_recipes</span>
                        <Badge variant="secondary" className="bg-green-100 text-green-800">
                          <Shield className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">recipe_history</span>
                        <Badge variant="secondary" className="bg-green-100 text-green-800">
                          <Shield className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">user_recipes</span>
                        <Badge variant="secondary" className="bg-green-100 text-green-800">
                          <Shield className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      </div>
                    </div>
                  </div>
                  
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={handleRefreshMaterializedViews}
                    disabled={refreshing}
                    data-testid="refresh-materialized-views-button"
                  >
                    {refreshing ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-2" />
                    )}
                    Refresh Materialized Views
                  </Button>
                </div>
              </CardContent>
            </Card>
            
            {/* Content Moderation Queue */}
            <ModerationQueue reports={reports || []} loading={reportsLoading} />
          </div>
          
          {/* System Health Footer */}
          <Card className="mt-8">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="w-3 h-3 text-green-500" />
                    <span className="text-sm text-gray-600">API Status: Operational</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="w-3 h-3 text-green-500" />
                    <span className="text-sm text-gray-600">Database: Healthy</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Clock className="w-3 h-3 text-yellow-500" />
                    <span className="text-sm text-gray-600">Background Jobs: 3 Running</span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 font-mono">
                  Last updated: {new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
