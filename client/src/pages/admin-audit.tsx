import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "@/components/admin/Sidebar";
import { TopBar } from "@/components/admin/TopBar";
import { AuditLogTable } from "@/components/admin/AuditLogTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, Download, Filter } from "lucide-react";

export default function AdminAudit() {
  const [searchTerm, setSearchTerm] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [limit, setLimit] = useState(100);

  const { data: auditLogs, isLoading: auditLoading, refetch } = useQuery({
    queryKey: ["/api/v1/admin/audit", { limit, action: actionFilter !== "all" ? actionFilter : undefined }],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const filteredLogs = Array.isArray(auditLogs) ? auditLogs.filter((log: any) => {
    const matchesSearch = searchTerm === "" || 
      log.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.actorUserId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.targetTable.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch;
  }) : [];

  const uniqueActions = Array.isArray(auditLogs)
    ? Array.from(new Set(auditLogs.map((log: any) => log.action)))
    : [];

  const handleExport = () => {
    if (filteredLogs.length === 0) return;
    
    const csv = [
      ['Timestamp', 'Actor', 'Action', 'Target Table', 'Target ID', 'Reason'].join(','),
      ...filteredLogs.map((log: any) => [
        log.at,
        log.actorUserId,
        log.action,
        log.targetTable,
        log.targetId,
        log.reason || ''
      ].join(','))
    ].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex bg-gray-50">
      <Sidebar />
      
      <main className="flex-1 flex flex-col min-w-0">
        <TopBar />
        
        <div className="flex-1 p-6 overflow-auto">
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-2xl font-bold text-gray-900">Audit Logs</h1>
              <div className="flex items-center space-x-2">
                <Button variant="outline" onClick={() => refetch()} data-testid="refresh-audit-logs">
                  <Filter className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
                <Button variant="outline" onClick={handleExport} data-testid="export-audit-logs">
                  <Download className="w-4 h-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </div>
            
            <div className="flex items-center space-x-4 mb-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search logs by action, user, or table..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="search-audit-logs"
                />
              </div>
              
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Filter by action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {uniqueActions.map((action) => (
                    <SelectItem key={action} value={action}>{action}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={limit.toString()} onValueChange={(value) => setLimit(parseInt(value))}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">50 entries</SelectItem>
                  <SelectItem value="100">100 entries</SelectItem>
                  <SelectItem value="250">250 entries</SelectItem>
                  <SelectItem value="500">500 entries</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <Card>
                <CardContent className="p-4">
                  <div className="text-center">
                    <p className="text-sm text-gray-600">Total Entries</p>
                    <p className="text-2xl font-bold text-blue-600">{Array.isArray(auditLogs) ? auditLogs.length : 0}</p>
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="text-center">
                    <p className="text-sm text-gray-600">Filtered Results</p>
                    <p className="text-2xl font-bold text-green-600">{filteredLogs.length}</p>
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="text-center">
                    <p className="text-sm text-gray-600">Unique Actions</p>
                    <p className="text-2xl font-bold text-purple-600">{uniqueActions.length}</p>
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4">
                  <div className="text-center">
                    <p className="text-sm text-gray-600">Today's Entries</p>
                    <p className="text-2xl font-bold text-orange-600">
                      {Array.isArray(auditLogs) ? 
                        auditLogs.filter((log: any) => 
                          new Date(log.at).toDateString() === new Date().toDateString()
                        ).length : 0
                      }
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Audit Log Table */}
          <AuditLogTable logs={filteredLogs} loading={auditLoading} />
        </div>
      </main>
    </div>
  );
}
