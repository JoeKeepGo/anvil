import { useEffect, useMemo, useState } from "react"
import { useOutletContext } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AppShellContext } from "@/components/layout/Layout"
import { useApi } from "@/hooks/useApi"
import { hasAnyGlobalAction, hasAnyTeamAction } from "@/lib/adminAccess"
import { fetchAdminHosts, syncAdminHostState } from "@/lib/api"
import type { AdminAccessSummary, AdminHostState } from "@/types"
import { canSyncAdminHost, countSyncableHosts } from "./AdminHosts.access"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbiddenState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  FormError,
  RefreshButton,
  formatError,
} from "./adminPageUtils"

const staleThresholdMs = 15 * 60 * 1000

export function AdminHosts() {
  const { session } = useOutletContext<AppShellContext>()
  const [displayHosts, setDisplayHosts] = useState<AdminHostState[]>([])
  const [syncingEndpointId, setSyncingEndpointId] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const canRead =
    hasAnyGlobalAction(session.access, ["hosts:read"]) || hasAnyTeamAction(session.access, "hosts:read")
  const hostsApi = useApi(fetchAdminHosts, { enabled: canRead })

  useEffect(() => {
    if (hostsApi.data) {
      setDisplayHosts(hostsApi.data)
    }
  }, [hostsApi.data])

  const summary = useMemo(() => buildSummary(displayHosts, session.access), [displayHosts, session.access])
  const canSyncHost = (host: AdminHostState) => canSyncAdminHost(session.access, host)
  const hasVisibleHosts = displayHosts.length > 0

  function onRefresh() {
    setSyncError(null)
    setSyncNotice(null)
    hostsApi.refetch()
  }

  async function onSync(host: AdminHostState) {
    setSyncError(null)
    setSyncNotice(null)
    setSyncingEndpointId(host.endpoint.id)
    try {
      const updatedHost = await syncAdminHostState(host.endpoint.id)
      setDisplayHosts((currentHosts) => updateHostState(currentHosts, updatedHost))
      setSyncNotice(`Updated ${updatedHost.host.hostname} from ${updatedHost.endpoint.name}.`)
    } catch (error) {
      setSyncError(formatError(error))
    } finally {
      setSyncingEndpointId(null)
    }
  }

  if (!canRead) {
    return (
      <AdminForbiddenState
        title="Hosts unavailable"
        description="Your current capability summary does not include host visibility."
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Hosts"
        description="Observed host state from accepted backend syncs, with browser-safe health details and controlled refresh actions."
        actions={<RefreshButton onClick={onRefresh} label="Refresh hosts" />}
      />

      {hasVisibleHosts ? <HostSummaryCards summary={summary} /> : null}

      {syncNotice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {syncNotice}
        </div>
      ) : null}

      {syncError ? <FormError message={syncError} /> : null}

      {hostsApi.error && hasVisibleHosts ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to refresh hosts: {hostsApi.error}
        </div>
      ) : null}

      {hostsApi.loading && !hasVisibleHosts ? (
        <HostsTable hosts={[]} canSyncHost={canSyncHost} loading />
      ) : hostsApi.error && !hasVisibleHosts ? (
        <AdminErrorState message={`Failed to fetch hosts: ${hostsApi.error}`} onRetry={onRefresh} />
      ) : hasVisibleHosts ? (
        <HostsTable hosts={displayHosts} canSyncHost={canSyncHost} syncingEndpointId={syncingEndpointId} onSync={onSync} />
      ) : (
        <AdminEmptyState
          title="No hosts observed"
          description="Run a host sync from an active endpoint to populate persisted host state."
        />
      )}
    </div>
  )
}

function HostSummaryCards({
  summary,
}: {
  summary: { total: number; stale: number; unavailable: number; readyToSync: number }
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <SummaryCard title="Observed hosts" value={String(summary.total)} detail="Persisted browser-safe host records." />
      <SummaryCard title="Stale records" value={String(summary.stale)} detail="Older than the current freshness window." />
      <SummaryCard title="Incus unavailable" value={String(summary.unavailable)} detail="Hosts that last reported Incus as unavailable." />
      <SummaryCard title="Sync-ready rows" value={String(summary.readyToSync)} detail="Rows that can be refreshed from an endpoint action." />
    </div>
  )
}

function SummaryCard({
  title,
  value,
  detail,
}: {
  title: string
  value: string
  detail: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function HostsTable({
  hosts,
  canSyncHost,
  loading = false,
  syncingEndpointId,
  onSync,
}: {
  hosts: AdminHostState[]
  canSyncHost: (host: AdminHostState) => boolean
  loading?: boolean
  syncingEndpointId?: string | null
  onSync?: (host: AdminHostState) => void
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Host</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Snapshot</TableHead>
            <TableHead>Seen</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={7} />
          ) : (
            hosts.map((host) => {
              const stale = isHostStale(host)
              const syncing = syncingEndpointId === host.endpoint.id

              return (
                <TableRow key={host.id}>
                  <TableCell className="max-w-[16rem] whitespace-normal">
                    <div className="font-medium">{host.host.hostname}</div>
                    <div className="text-xs text-muted-foreground">
                      {host.host.os} / {host.host.arch}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[18rem] whitespace-normal">
                    <div className="font-medium">{host.endpoint.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {host.endpoint.team?.name ?? "Team unavailable"}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[20rem] whitespace-normal">
                    <div className="break-all font-medium">{host.agent.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {host.agent.version} / schema {host.agent.stateSchemaVersion}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Agent features: {countEnabledCapabilities(host)} / 5
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{host.status}</Badge>
                      <Badge variant={stale ? "outline" : "secondary"}>{stale ? "Stale" : "Current"}</Badge>
                      <Badge variant={host.incus.available ? "secondary" : "outline"}>
                        {host.incus.available ? "Incus ready" : "Incus unavailable"}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div>{host.snapshot.instancesTotal} instances</div>
                    <div>{host.snapshot.imagesTotal} images</div>
                    <div>{host.snapshot.operationsTotal} operations</div>
                  </TableCell>
                  <TableCell className="max-w-[16rem] whitespace-normal text-sm text-muted-foreground">
                    <div>Last seen {formatAge(host.lastSeenAt)}</div>
                    <div>{formatTimestamp(host.lastSeenAt)}</div>
                    <div className="mt-1">First seen {formatTimestamp(host.firstSeenAt)}</div>
                  </TableCell>
                  <TableCell>
                    {canSyncHost(host) ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onSync?.(host)}
                        disabled={syncing}
                      >
                        {syncing ? "Syncing..." : "Sync now"}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function buildSummary(hosts: AdminHostState[], access: AdminAccessSummary) {
  let stale = 0
  let unavailable = 0

  for (const host of hosts) {
    if (isHostStale(host)) {
      stale += 1
    }
    if (!host.incus.available) {
      unavailable += 1
    }
  }

  return {
    total: hosts.length,
    stale,
    unavailable,
    readyToSync: countSyncableHosts(access, hosts),
  }
}

function updateHostState(hosts: AdminHostState[], updatedHost: AdminHostState): AdminHostState[] {
  const nextHosts = hosts.map((host) => (host.id === updatedHost.id ? updatedHost : host))
  return nextHosts.some((host) => host.id === updatedHost.id)
    ? nextHosts
    : [updatedHost, ...nextHosts]
}

function isHostStale(host: AdminHostState): boolean {
  const lastSeenAt = Date.parse(host.lastSeenAt)
  if (!Number.isFinite(lastSeenAt)) {
    return false
  }
  return Date.now() - lastSeenAt > staleThresholdMs
}

function countEnabledCapabilities(host: AdminHostState): number {
  let total = 0
  if (host.capabilities.incusProxy) total += 1
  if (host.capabilities.events) total += 1
  if (host.capabilities.stateReport) total += 1
  if (host.capabilities.wireGuard) total += 1
  if (host.capabilities.vmLifecycle) total += 1
  return total
}

function formatAge(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }

  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes <= 1) {
    return "just now"
  }
  if (minutes < 60) {
    return `${minutes} minutes ago`
  }

  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `${hours} hours ago`
  }

  const days = Math.round(hours / 24)
  return `${days} days ago`
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp))
}
