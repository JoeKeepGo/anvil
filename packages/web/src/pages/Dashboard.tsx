import { useMemo } from "react"
import { useApi } from "@/hooks/useApi"
import { fetchServer, fetchInstances } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorAlert } from "@/components/ErrorAlert"
import { StatusBadge } from "@/components/StatusBadge"
import { Server, Box, Play, Square } from "lucide-react"

export function Dashboard() {
  const server = useApi(fetchServer)
  const instances = useApi(fetchInstances)

  const stats = useMemo(() => {
    if (!instances.data) return null
    const running = instances.data.filter((i) => i.status === "Running").length
    const stopped = instances.data.filter((i) => i.status === "Stopped").length
    return { total: instances.data.length, running, stopped }
  }, [instances.data])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      {server.loading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-40" />
          </CardContent>
        </Card>
      ) : server.error ? (
        <ErrorAlert
          message={`Failed to connect to server: ${server.error}`}
          onRetry={server.refetch}
        />
      ) : server.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="h-5 w-5" />
              Server Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Server</span>
              <span>{server.data.environment.server_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span>{server.data.version}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">API Version</span>
              <span>{server.data.api_version}</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {instances.loading ? (
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : instances.error ? (
        <ErrorAlert
          message={`Failed to fetch instances: ${instances.error}`}
          onRetry={instances.refetch}
        />
      ) : stats ? (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Instances
              </CardTitle>
              <Box className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Running
              </CardTitle>
              <Play className="h-4 w-4 text-green-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.running}</div>
              {stats.running > 0 && <StatusBadge status="Running" className="mt-1" />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Stopped
              </CardTitle>
              <Square className="h-4 w-4 text-red-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.stopped}</div>
              {stats.stopped > 0 && <StatusBadge status="Stopped" className="mt-1" />}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
