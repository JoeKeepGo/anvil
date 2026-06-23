import { useEffect, useMemo, useState, type ReactNode } from "react"
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
import {
  applyAdminNetworkFabric,
  dryRunAdminNetworkFabric,
  fetchAdminNetworkFabrics,
  fetchAdminNetworkFabric,
  syncAdminNetworkFabric,
} from "@/lib/api"
import type {
  AdminNetworkApplyResponse,
  AdminNetworkFabric,
  AdminNetworkFabricDetail,
  AdminNetworkSyncResponse,
} from "@/types"
import {
  canApplyNetwork,
  canDryRunNetwork,
  canReadNetwork,
  canSyncNetwork,
} from "./AdminNetwork.access"
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

type ActionKind = "sync" | "dry-run" | "apply"
type ActionState = {
  kind: ActionKind
  fabricId: string
} | null

export function AdminNetwork() {
  const { session } = useOutletContext<AppShellContext>()
  const canRead = canReadNetwork(session.access)
  const canSync = canSyncNetwork(session.access)
  const canDryRun = canDryRunNetwork(session.access)
  const canApply = canApplyNetwork(session.access)
  const fabricsApi = useApi(fetchAdminNetworkFabrics, { enabled: canRead })

  const [displayFabrics, setDisplayFabrics] = useState<AdminNetworkFabric[]>([])
  const [action, setAction] = useState<ActionState>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, AdminNetworkFabricDetail>>({})

  useEffect(() => {
    if (fabricsApi.data) {
      setDisplayFabrics(fabricsApi.data)
    }
  }, [fabricsApi.data])

  const summary = useMemo(() => buildSummary(displayFabrics), [displayFabrics])
  const hasVisibleFabrics = displayFabrics.length > 0

  function onRefresh() {
    setActionError(null)
    setActionNotice(null)
    fabricsApi.refetch()
  }

  async function runAction(
    kind: ActionKind,
    fabric: AdminNetworkFabric,
    fn: (fabricId: string) => Promise<AdminNetworkSyncResponse | AdminNetworkApplyResponse>
  ) {
    setActionError(null)
    setActionNotice(null)
    setAction({ kind, fabricId: fabric.id })
    try {
      const result = await fn(fabric.id)
      setActionNotice(formatActionResult(kind, fabric, result))
      // Refresh the list so counts/status reflect the latest backend state.
      fabricsApi.refetch()
    } catch (error) {
      setActionError(formatError(error))
    } finally {
      setAction(null)
    }
  }

  async function onSync(fabric: AdminNetworkFabric) {
    await runAction("sync", fabric, syncAdminNetworkFabric)
  }

  async function onDryRun(fabric: AdminNetworkFabric) {
    await runAction("dry-run", fabric, dryRunAdminNetworkFabric)
  }

  async function onApply(fabric: AdminNetworkFabric) {
    await runAction("apply", fabric, applyAdminNetworkFabric)
  }

  async function onExpand(fabric: AdminNetworkFabric) {
    if (detailCache[fabric.id]) {
      setDetailCache((cache) => {
        const next = { ...cache }
        delete next[fabric.id]
        return next
      })
      return
    }
    setActionError(null)
    setAction({ kind: "sync", fabricId: fabric.id })
    try {
      const detail = await fetchAdminNetworkFabric(fabric.id)
      setDetailCache((cache) => ({ ...cache, [fabric.id]: detail }))
    } catch (error) {
      setActionError(formatError(error))
    } finally {
      setAction(null)
    }
  }

  if (!canRead) {
    return (
      <AdminForbiddenState
        title="Network unavailable"
        description="Your current capability summary does not include network visibility."
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Network"
        description="Anvil-managed WireGuard fabrics, hubs, host peers, prefixes, and project pools with controlled sync, dry-run, and apply actions."
        actions={<RefreshButton onClick={onRefresh} label="Refresh fabrics" />}
      />

      {hasVisibleFabrics ? <NetworkSummaryCards summary={summary} /> : null}

      {actionNotice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {actionNotice}
        </div>
      ) : null}

      {actionError ? <FormError message={actionError} /> : null}

      {fabricsApi.error && hasVisibleFabrics ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to refresh fabrics: {fabricsApi.error}
        </div>
      ) : null}

      {fabricsApi.loading && !hasVisibleFabrics ? (
        <FabricsTable
          fabrics={[]}
          canSync={canSync}
          canDryRun={canDryRun}
          canApply={canApply}
          loading
        />
      ) : fabricsApi.error && !hasVisibleFabrics ? (
        <AdminErrorState
          message={`Failed to fetch fabrics: ${fabricsApi.error}`}
          onRetry={onRefresh}
        />
      ) : hasVisibleFabrics ? (
        <FabricsTable
          fabrics={displayFabrics}
          canSync={canSync}
          canDryRun={canDryRun}
          canApply={canApply}
          action={action}
          onSync={onSync}
          onDryRun={onDryRun}
          onApply={onApply}
          onExpand={onExpand}
          detailCache={detailCache}
        />
      ) : (
        <AdminEmptyState
          title="No fabrics configured"
          description="Create a managed WireGuard fabric from the backend admin API to populate the network console."
        />
      )}
    </div>
  )
}

function NetworkSummaryCards({
  summary,
}: {
  summary: { total: number; active: number; planned: number; archived: number }
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <SummaryCard title="Fabrics" value={String(summary.total)} detail="Persisted browser-safe fabric records." />
      <SummaryCard title="Active" value={String(summary.active)} detail="Fabrics in ACTIVE status." />
      <SummaryCard title="Planned" value={String(summary.planned)} detail="Fabrics in PLANNED status." />
      <SummaryCard title="Archived" value={String(summary.archived)} detail="Fabrics in ARCHIVED status." />
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

function FabricsTable({
  fabrics,
  canSync,
  canDryRun,
  canApply,
  loading = false,
  action,
  onSync,
  onDryRun,
  onApply,
  onExpand,
  detailCache,
}: {
  fabrics: AdminNetworkFabric[]
  canSync: boolean
  canDryRun: boolean
  canApply: boolean
  loading?: boolean
  action?: ActionState
  onSync?: (fabric: AdminNetworkFabric) => void
  onDryRun?: (fabric: AdminNetworkFabric) => void
  onApply?: (fabric: AdminNetworkFabric) => void
  onExpand?: (fabric: AdminNetworkFabric) => void
  detailCache?: Record<string, AdminNetworkFabricDetail>
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fabric</TableHead>
            <TableHead>Topology</TableHead>
            <TableHead>Overlay</TableHead>
            <TableHead>Counts</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={6} />
          ) : (
            fabrics.map((fabric) => {
              const stale = isFabricStale(fabric)
              const detail = detailCache?.[fabric.id]
              const acting = action?.fabricId === fabric.id
              const expanded = Boolean(detail)

              return (
                <FabricRow
                  key={fabric.id}
                  fabric={fabric}
                  stale={stale}
                  canSync={canSync}
                  canDryRun={canDryRun}
                  canApply={canApply}
                  acting={acting}
                  actionKind={action?.fabricId === fabric.id ? action.kind : undefined}
                  expanded={expanded}
                  detail={detail}
                  onSync={onSync}
                  onDryRun={onDryRun}
                  onApply={onApply}
                  onExpand={onExpand}
                />
              )
            })
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function FabricRow({
  fabric,
  stale,
  canSync,
  canDryRun,
  canApply,
  acting,
  actionKind,
  expanded,
  detail,
  onSync,
  onDryRun,
  onApply,
  onExpand,
}: {
  fabric: AdminNetworkFabric
  stale: boolean
  canSync: boolean
  canDryRun: boolean
  canApply: boolean
  acting: boolean
  actionKind?: ActionKind
  expanded: boolean
  detail?: AdminNetworkFabricDetail
  onSync?: (fabric: AdminNetworkFabric) => void
  onDryRun?: (fabric: AdminNetworkFabric) => void
  onApply?: (fabric: AdminNetworkFabric) => void
  onExpand?: (fabric: AdminNetworkFabric) => void
}) {
  return (
    <>
      <TableRow>
        <TableCell className="max-w-[16rem] whitespace-normal">
          <div className="font-medium">{fabric.name}</div>
          <div className="text-xs text-muted-foreground">{fabric.slug}</div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{fabric.mode}</Badge>
            <Badge variant={fabric.status === "ACTIVE" ? "secondary" : "outline"}>
              {fabric.status}
            </Badge>
            <Badge variant={stale ? "outline" : "secondary"}>
              {stale ? "Stale" : "Current"}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="max-w-[20rem] whitespace-normal text-sm text-muted-foreground">
          <div className="break-all">{fabric.overlayIpv4Cidr}</div>
          <div className="break-all">{fabric.overlayIpv6Cidr}</div>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          <div>{fabric.hubCount} hubs</div>
          <div>{fabric.peerCount} peers</div>
          <div>{fabric.prefixCount} prefixes</div>
          <div>{fabric.poolCount} pools</div>
        </TableCell>
        <TableCell className="max-w-[16rem] whitespace-normal text-sm text-muted-foreground">
          <div>Updated {formatAge(fabric.updatedAt)}</div>
          <div>{formatTimestamp(fabric.updatedAt)}</div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-2">
            {onExpand ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onExpand(fabric)}
                disabled={acting && actionKind === "sync" && !expanded}
              >
                {expanded ? "Hide detail" : "View detail"}
              </Button>
            ) : null}
            {canSync && onSync ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onSync(fabric)}
                disabled={acting}
              >
                {acting && actionKind === "sync" && expanded ? "Syncing..." : "Sync"}
              </Button>
            ) : null}
            {canDryRun && onDryRun ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onDryRun(fabric)}
                disabled={acting}
              >
                {acting && actionKind === "dry-run" ? "Dry-run..." : "Dry-run"}
              </Button>
            ) : null}
            {canApply && onApply ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onApply(fabric)}
                disabled={acting}
              >
                {acting && actionKind === "apply" ? "Applying..." : "Apply"}
              </Button>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded && detail ? <FabricDetailRow detail={detail} /> : null}
    </>
  )
}

function FabricDetailRow({ detail }: { detail: AdminNetworkFabricDetail }) {
  return (
    <TableRow className="bg-muted/30">
      <TableCell colSpan={6} className="p-4">
        <div className="flex flex-col gap-6">
          <FabricDetailSection title="Hubs">
            {detail.hubs.length === 0 ? (
              <DetailEmpty text="No hubs configured." />
            ) : (
              <DetailGrid>
                {detail.hubs.map((hub) => (
                  <DetailCard key={hub.id} title={hub.name}>
                    <DetailLine label="Status" value={hub.status} />
                    <DetailLine label="Listen port" value={String(hub.listenPort)} />
                    <DetailLine label="Endpoint host" value={hub.endpointHost} />
                    <DetailLine label="Public key" value={hub.publicKey} mono break />
                    <DetailLine
                      label="Private key"
                      value={hub.privateKeyConfigured ? "configured (server-side)" : "not configured"}
                    />
                    <DetailLine label="Preshared key mode" value={hub.presharedKeyMode} />
                  </DetailCard>
                ))}
              </DetailGrid>
            )}
          </FabricDetailSection>

          <FabricDetailSection title="Host peers">
            {detail.peers.length === 0 ? (
              <DetailEmpty text="No host peers configured." />
            ) : (
              <DetailGrid>
                {detail.peers.map((peer) => (
                  <DetailCard key={peer.id} title={peer.name}>
                    <DetailLine label="Status" value={peer.status} />
                    <DetailLine label="Role" value={peer.role} />
                    <DetailLine label="Overlay IPv4" value={peer.overlayIpv4Address ?? "—"} />
                    <DetailLine label="Overlay IPv6" value={peer.overlayIpv6Address ?? "—"} break />
                    <DetailLine label="Public key" value={peer.publicKey} mono break />
                    <DetailLine
                      label="Private key"
                      value={peer.privateKeyConfigured ? "configured (server-side)" : "not configured"}
                    />
                    <DetailLine
                      label="Preshared key"
                      value={peer.presharedKeyConfigured ? "configured (server-side)" : "not configured"}
                    />
                    <DetailLine label="Endpoint" value={peer.endpointId ?? "unbound"} />
                  </DetailCard>
                ))}
              </DetailGrid>
            )}
          </FabricDetailSection>

          <FabricDetailSection title="Prefixes">
            {detail.prefixes.length === 0 ? (
              <DetailEmpty text="No prefixes configured." />
            ) : (
              <DetailGrid>
                {detail.prefixes.map((prefix) => (
                  <DetailCard key={prefix.id} title={prefix.cidr}>
                    <DetailLine label="Kind" value={prefix.kind} />
                    <DetailLine label="Family" value={prefix.family === 4 ? "IPv4" : "IPv6"} />
                    <DetailLine label="Status" value={prefix.status} />
                    <DetailLine label="Owner peer" value={prefix.ownerPeerId ?? "—"} />
                  </DetailCard>
                ))}
              </DetailGrid>
            )}
          </FabricDetailSection>

          <FabricDetailSection title="Project pools">
            {detail.pools.length === 0 ? (
              <DetailEmpty text="No project pools configured." />
            ) : (
              <DetailGrid>
                {detail.pools.map((pool) => (
                  <DetailCard key={pool.id} title={`Pool ${pool.id.slice(0, 8)}`}>
                    <DetailLine label="Project" value={pool.projectId} />
                    <DetailLine label="IPv4 CIDR" value={pool.ipv4Cidr ?? "—"} />
                    <DetailLine label="IPv6 CIDR" value={pool.ipv6Cidr ?? "—"} break />
                    <DetailLine label="Allocation" value={pool.allocationMode} />
                    <DetailLine label="Status" value={pool.status} />
                  </DetailCard>
                ))}
              </DetailGrid>
            )}
          </FabricDetailSection>
        </div>
      </TableCell>
    </TableRow>
  )
}

function FabricDetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function DetailGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 break-all text-sm font-medium">{title}</div>
      <dl className="flex flex-col gap-1 text-xs text-muted-foreground">{children}</dl>
    </div>
  )
}

function DetailLine({
  label,
  value,
  mono,
  break: breakAll = false,
}: {
  label: string
  value: string
  mono?: boolean
  break?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-medium text-foreground/70">{label}</dt>
      <dd className={mono ? "break-all font-mono text-[11px]" : breakAll ? "break-all" : ""}>{value}</dd>
    </div>
  )
}

function DetailEmpty({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground">{text}</p>
}

function buildSummary(fabrics: AdminNetworkFabric[]) {
  let active = 0
  let planned = 0
  let archived = 0
  for (const fabric of fabrics) {
    if (fabric.status === "ACTIVE") active += 1
    else if (fabric.status === "PLANNED") planned += 1
    else if (fabric.status === "ARCHIVED") archived += 1
  }
  return { total: fabrics.length, active, planned, archived }
}

function isFabricStale(fabric: AdminNetworkFabric): boolean {
  const updatedAt = Date.parse(fabric.updatedAt)
  if (!Number.isFinite(updatedAt)) {
    return false
  }
  return Date.now() - updatedAt > staleThresholdMs
}

function formatActionResult(
  kind: ActionKind,
  fabric: AdminNetworkFabric,
  result: AdminNetworkSyncResponse | AdminNetworkApplyResponse
): string {
  if (kind === "sync") {
    const sync = result as AdminNetworkSyncResponse
    const synced = sync.endpoints.filter((e) => e.status === "SYNCED").length
    const failed = sync.endpoints.filter((e) => e.status === "FAILED").length
    return `Synced ${fabric.name}: ${synced} endpoint(s) synced, ${failed} failed.`
  }
  const apply = result as AdminNetworkApplyResponse
  return `${kind === "dry-run" ? "Dry-run" : "Apply"} ${fabric.name}: ${apply.summary}`
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