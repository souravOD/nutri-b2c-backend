import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "@/components/admin/Sidebar";
import { TopBar } from "@/components/admin/TopBar";
import { ModerationQueue } from "@/components/admin/ModerationQueue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Clock, CheckCircle, XCircle } from "lucide-react";

type ReportRow = { id: string };

type ReviewStatus = "pending" | "approved" | "rejected";

type UserRecipeRow = {
  id: string;
  title: string;
  ownerUserId?: string;
  createdAt?: string;
  reviewStatus: ReviewStatus;
};

const statusBadgeClass: Record<ReviewStatus, string> = {
  pending: "bg-orange-100 text-orange-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export default function AdminUserContent() {
  const { data: reports, isLoading: reportsLoading } = useQuery<ReportRow[]>({
    queryKey: ["/api/v1/admin/reports"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const { data: userRecipes, isLoading: recipesLoading } = useQuery<UserRecipeRow[]>({
    queryKey: ["/api/v1/user-recipes"],
  });

  const pendingCount = Array.isArray(userRecipes) ? userRecipes.filter((r) => r.reviewStatus === "pending").length : 0;
  const approvedCount = Array.isArray(userRecipes) ? userRecipes.filter((r) => r.reviewStatus === "approved").length : 0;
  const rejectedCount = Array.isArray(userRecipes) ? userRecipes.filter((r) => r.reviewStatus === "rejected").length : 0;

  return (
    <div className="min-h-screen flex bg-gray-50">
      <Sidebar />
      
      <main className="flex-1 flex flex-col min-w-0">
        <TopBar />
        
        <div className="flex-1 p-6 overflow-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-4">User Content Moderation</h1>
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Pending Review</p>
                      <p className="text-2xl font-bold text-orange-600">{pendingCount}</p>
                    </div>
                    <Clock className="w-8 h-8 text-orange-500" />
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Approved</p>
                      <p className="text-2xl font-bold text-green-600">{approvedCount}</p>
                    </div>
                    <CheckCircle className="w-8 h-8 text-green-500" />
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Rejected</p>
                      <p className="text-2xl font-bold text-red-600">{rejectedCount}</p>
                    </div>
                    <XCircle className="w-8 h-8 text-red-500" />
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Open Reports</p>
                      <p className="text-2xl font-bold text-blue-600">{Array.isArray(reports) ? reports.length : 0}</p>
                    </div>
                    <MessageSquare className="w-8 h-8 text-blue-500" />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Content Moderation Queue */}
          <ModerationQueue reports={reports || []} loading={reportsLoading} />
          
          {/* Recent User Recipes */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Recent User Submissions</CardTitle>
            </CardHeader>
            <CardContent>
              {recipesLoading ? (
                <div className="animate-pulse space-y-4">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center space-x-4 p-4 border rounded">
                      <div className="h-12 w-12 bg-gray-200 rounded"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-gray-200 rounded w-1/3"></div>
                        <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : Array.isArray(userRecipes) && userRecipes.length > 0 ? (
                <div className="space-y-4">
                  {userRecipes.slice(0, 5).map((recipe) => (
                    <div key={recipe.id} className="flex items-center justify-between p-4 border rounded-lg" data-testid={`user-recipe-${recipe.id}`}>
                      <div>
                        <h4 className="font-medium">{recipe.title}</h4>
                        <p className="text-sm text-gray-600">by {recipe.ownerUserId}</p>
                        <p className="text-xs text-gray-500">
                          Submitted {recipe.createdAt ? new Date(recipe.createdAt).toLocaleDateString() : "N/A"}
                        </p>
                      </div>
                      <Badge className={statusBadgeClass[recipe.reviewStatus]}>
                        {recipe.reviewStatus}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No user recipes found.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
