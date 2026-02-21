import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sidebar } from "@/components/admin/Sidebar";
import { TopBar } from "@/components/admin/TopBar";
import { Plus, Search, Edit, Trash2, Clock, Users } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface Recipe {
  id: string;
  title: string;
  description?: string;
  calories?: number;
  totalTimeMinutes?: number;
  servings?: number;
  status: string;
  cuisines: string[];
  dietTags: string[];
  createdAt: string;
  updatedAt: string;
}

export default function AdminRecipes() {
  const [searchTerm, setSearchTerm] = useState("");
  const queryClient = useQueryClient();

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ["/api/v1/recipes"],
    select: (data: Recipe[]) => data.filter(recipe => 
      recipe.title.toLowerCase().includes(searchTerm.toLowerCase())
    )
  });

  const deleteRecipe = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/v1/admin/recipes/${id}`, {
        reason: "Deleted via admin interface",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/v1/recipes"] });
    }
  });

  const getStatusBadge = (status: string) => {
    const variants = {
      published: "bg-green-100 text-green-800",
      draft: "bg-yellow-100 text-yellow-800", 
      archived: "bg-gray-100 text-gray-800"
    };
    return variants[status as keyof typeof variants] || "bg-gray-100 text-gray-800";
  };

  return (
    <div className="min-h-screen flex bg-gray-50">
      <Sidebar />
      
      <main className="flex-1 flex flex-col min-w-0">
        <TopBar />
        
        <div className="flex-1 p-6 overflow-auto">
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-2xl font-bold text-gray-900">Recipe Management</h1>
              <Button className="bg-blue-600 hover:bg-blue-700" data-testid="add-recipe-button">
                <Plus className="w-4 h-4 mr-2" />
                Add Recipe
              </Button>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search recipes..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="search-recipes-input"
                />
              </div>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>All Recipes ({recipes.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-6">
                  <div className="animate-pulse space-y-4">
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="flex items-center space-x-4 p-4 border rounded">
                        <div className="h-16 w-16 bg-gray-200 rounded"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-4 bg-gray-200 rounded w-1/3"></div>
                          <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : recipes.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-gray-500">No recipes found matching your search.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-200">
                  {recipes.map((recipe) => (
                    <div key={recipe.id} className="p-6 hover:bg-gray-50" data-testid={`recipe-row-${recipe.id}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <h3 className="text-lg font-medium text-gray-900">{recipe.title}</h3>
                            <Badge className={getStatusBadge(recipe.status)}>
                              {recipe.status}
                            </Badge>
                          </div>
                          
                          <p className="text-gray-600 mb-3">{recipe.description || "No description"}</p>
                          
                          <div className="flex items-center space-x-6 text-sm text-gray-500">
                            {recipe.calories && (
                              <span>{recipe.calories} cal</span>
                            )}
                            {recipe.totalTimeMinutes && (
                              <span className="flex items-center">
                                <Clock className="w-4 h-4 mr-1" />
                                {recipe.totalTimeMinutes}m
                              </span>
                            )}
                            {recipe.servings && (
                              <span className="flex items-center">
                                <Users className="w-4 h-4 mr-1" />
                                {recipe.servings} servings
                              </span>
                            )}
                          </div>
                          
                          <div className="flex items-center space-x-2 mt-2">
                            {recipe.cuisines.map((cuisine) => (
                              <Badge key={cuisine} variant="outline" className="text-xs">
                                {cuisine}
                              </Badge>
                            ))}
                            {recipe.dietTags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        
                        <div className="flex items-center space-x-2 ml-4">
                          <Button variant="outline" size="sm" data-testid={`edit-recipe-${recipe.id}`}>
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => deleteRecipe.mutate(recipe.id)}
                            disabled={deleteRecipe.isPending}
                            data-testid={`delete-recipe-${recipe.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
