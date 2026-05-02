import { useMemo } from "react"
import { useApi } from "@/hooks/useApi"
import { fetchImages, fetchInstances, fetchOperations, fetchServer } from "@/lib/api"
import type { Instance, OperationSummary } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorAlert } from "@/components/ErrorAlert"
import { StatusBadge } from "@/components/StatusBadge"
import { Activity, Box, Image, Server } from "lucide-react"

export function Dashboard() {
  const server = useApi(fetchServer)
  const instances = useApi(fetchInstances)
  const images = useApi(fetchImages)
  const operations = useApi(fetchOperations)

  const instanceStats = useMemo(() => {
    return summarizeInstances(instances.data)
  }, [instances.data])

  const operationStats = useMemo(() => {
    return summarizeOperations(operations.data)
  }, [operations.data])

  const loadingAny =
    server.loading || instances.loading || images.loading || operations.loading
  const errorCount = [server.error, instances.error, images.error, operations.error].filter(
    Boolean
  ).length
  const emptyCount = [
    instances.data?.length === 0,
    images.data?.length === 0,
    operations.data?.length === 0,
  ].filter(Boolean).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Single-host read-only summary from the configured host.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Backend"
          icon={<Server className="h-4 w-4 text-muted-foreground" />}
          loading={server.loading}
          error={server.error}
          value={server.data ? "Online" : "Unknown"}
          detail={
            server.data
              ? `${server.data.environment.server_name} / API ${server.data.api_version}`
              : "Waiting for server status"
          }
          badge={server.data ? <StatusBadge status="Running" /> : undefined}
        />
        <SummaryCard
          title="Instances"
          icon={<Box className="h-4 w-4 text-muted-foreground" />}
          loading={instances.loading}
          error={instances.error}
          value={instanceStats ? String(instanceStats.total) : "0"}
          detail={
            instanceStats
              ? `${instanceStats.running} running / ${instanceStats.stopped} stopped`
              : "Waiting for instance inventory"
          }
          badge={
            instanceStats && instanceStats.total === 0 ? (
              <Badge variant="outline">Empty</Badge>
            ) : undefined
          }
        />
        <SummaryCard
          title="Images"
          icon={<Image className="h-4 w-4 text-muted-foreground" />}
          loading={images.loading}
          error={images.error}
          value={images.data ? String(images.data.length) : "0"}
          detail={images.data ? describeImages(images.data.length) : "Waiting for image inventory"}
          badge={
            images.data && images.data.length === 0 ? (
              <Badge variant="outline">Empty</Badge>
            ) : undefined
          }
        />
        <SummaryCard
          title="Operations"
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          loading={operations.loading}
          error={operations.error}
          value={operationStats ? String(operationStats.visible) : "0"}
          detail={
            operationStats
              ? `${operationStats.active} active / ${operationStats.visible} visible`
              : "Waiting for operation inventory"
          }
          badge={
            operationStats && operationStats.visible === 0 ? (
              <Badge variant="outline">Empty</Badge>
            ) : undefined
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Host Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SummaryRow
              label="Server"
              loading={server.loading}
              error={server.error}
              value={server.data?.environment.server_name ?? "Unknown"}
              detail={server.data ? `Version ${server.data.version}` : "No server data"}
            />
            <SummaryRow
              label="Instances"
              loading={instances.loading}
              error={instances.error}
              value={instanceStats ? `${instanceStats.total} total` : "Unknown"}
              detail={
                instanceStats
                  ? `${instanceStats.running} running, ${instanceStats.stopped} stopped, ${instanceStats.other} other`
                  : "No instance data"
              }
            />
            <SummaryRow
              label="Images"
              loading={images.loading}
              error={images.error}
              value={images.data ? `${images.data.length} available` : "Unknown"}
              detail={images.data && images.data.length === 0 ? "No images returned" : "Image inventory loaded"}
            />
            <SummaryRow
              label="Operations"
              loading={operations.loading}
              error={operations.error}
              value={operationStats ? `${operationStats.visible} visible` : "Unknown"}
              detail={
                operationStats && operationStats.visible === 0
                  ? "No active or retained operations"
                  : `${operationStats?.active ?? 0} active operations`
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Panel State</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {loadingAny ? (
              <PanelNotice
                title="Loading host data"
                detail="Host summary is still loading."
              />
            ) : errorCount > 0 ? (
              <PanelNotice
                title="Some data did not load"
                detail={`${errorCount} summary section${errorCount === 1 ? "" : "s"} could not load.`}
              />
            ) : emptyCount > 0 ? (
              <PanelNotice
                title="Host inventory has empty areas"
                detail={`${emptyCount} summary section${emptyCount === 1 ? "" : "s"} returned an empty list.`}
              />
            ) : (
              <PanelNotice
                title="Host summary loaded"
                detail="All dashboard read-only summaries are available."
              />
            )}

            <div className="space-y-2">
              <InlineError label="Server" error={server.error} onRetry={server.refetch} />
              <InlineError label="Instances" error={instances.error} onRetry={instances.refetch} />
              <InlineError label="Images" error={images.error} onRetry={images.refetch} />
              <InlineError label="Operations" error={operations.error} onRetry={operations.refetch} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

interface SummaryCardProps {
  title: string
  icon: React.ReactNode
  loading: boolean
  error: string | null
  value: string
  detail: string
  badge?: React.ReactNode
}

function SummaryCard({ title, icon, loading, error, value, detail, badge }: SummaryCardProps) {
  return (
    <Card className="min-h-[9rem]">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <>
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-4 w-full max-w-40" />
          </>
        ) : error ? (
          <>
            <div className="text-2xl font-bold text-destructive">Unavailable</div>
            <p className="line-clamp-2 text-xs text-muted-foreground">{error}</p>
          </>
        ) : (
          <>
            <div className="flex min-h-7 items-center gap-2">
              <span className="text-2xl font-bold">{value}</span>
              {badge}
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">{detail}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

interface SummaryRowProps {
  label: string
  loading: boolean
  error: string | null
  value: string
  detail: string
}

function SummaryRow({ label, loading, error, value, detail }: SummaryRowProps) {
  return (
    <div className="grid min-h-12 gap-1 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:items-start">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        ) : error ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Unavailable</p>
            <p className="break-words text-xs text-muted-foreground">{error}</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="break-words text-sm font-medium">{value}</p>
            <p className="break-words text-xs text-muted-foreground">{detail}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function PanelNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function InlineError({
  label,
  error,
  onRetry,
}: {
  label: string
  error: string | null
  onRetry: () => void
}) {
  if (!error) return null

  return (
    <ErrorAlert message={`${label}: ${error}`} onRetry={onRetry} />
  )
}

function summarizeInstances(instances: Instance[] | null) {
  if (!instances) return null

  const running = instances.filter((instance) => instance.status === "Running").length
  const stopped = instances.filter((instance) => instance.status === "Stopped").length

  return {
    total: instances.length,
    running,
    stopped,
    other: instances.length - running - stopped,
  }
}

function summarizeOperations(operations: OperationSummary[] | null) {
  if (!operations) return null

  const active = operations.filter((operation) => isActiveOperationStatus(operation.status)).length

  return {
    active,
    visible: operations.length,
  }
}

function isActiveOperationStatus(status: string) {
  const normalized = status.toLowerCase()
  return normalized === "running" || normalized === "pending" || normalized === "cancelling"
}

function describeImages(count: number) {
  if (count === 0) return "No images returned by the host"
  if (count === 1) return "1 image available"
  return `${count} images available`
}
