import { useCallback, useEffect, useState } from "react"
import { Link, useOutletContext, useParams } from "react-router-dom"
import { ArrowLeft, Play, Square, RotateCcw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  deleteAdminVm,
  fetchAdminVm,
  fetchAdminVmOperations,
  performVmAction,
} from "@/lib/api"
import type {
  BrowserVmInstance,
  BrowserVmLifecycleOperation,
  VmInstanceStatus,
  VmLifecycleAction,
  VmLifecycleOperationStatus,
} from "@/types"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { canReadVms, canWriteVms } from "./AdminVms.access"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbiddenState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  FormError,
  formatError,
} from "./adminPageUtils"

const statusBadgeVariant: Record<VmInstanceStatus, "secondary" | "outline" | "destructive"> = {
  PROVISIONING: "outline",
  RUNNING: "secondary",
  STOPPED: "outline",
  FAILED: "destructive",
  DELETED: "outline",
}

const operationStatusBadgeVariant: Record<
  VmLifecycleOperationStatus,
  "secondary" | "outline" | "destructive"
> = {
  QUEUED: "outline",
  RUNNING: "secondary",
  SUCCEEDED: "secondary",
  FAILED: "destructive",
  CANCELLED: "outline",
}

// Actions that are valid for a given VM status.
const allowedActions: Record<VmInstanceStatus, VmLifecycleAction[]> = {
  PROVISIONING: [],
  RUNNING: ["STOP", "RESTART"],
  STOPPED: ["START", "DELETE"],
  FAILED: ["DELETE"],
  DELETED: [],
}

type ActionInProgress = {
  action: VmLifecycleAction
} | null

export function AdminVmDetail() {
  const { session } = useOutletContext<AppShellContext>()
  const { vmId } = useParams<{ vmId: string }>()
  const canRead = canReadVms(session.access)
  const canWrite = canWriteVms(session.access)

  const vmApi = useApi(() => fetchAdminVm(vmId!), { enabled: canRead && Boolean(vmId) })
  const opsApi = useApi(() => fetchAdminVmOperations(vmId), {
    enabled: canRead && Boolean(vmId),
  })

  const [vm, setVm] = useState<BrowserVmInstance | null>(null)
  const [operations, setOperations] = useState<BrowserVmLifecycleOperation[]>([])
  const [actionInProgress, setActionInProgress] = useState<ActionInProgress>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  useEffect(() => {
    if (vmApi.data) setVm(vmApi.data)
  }, [vmApi.data])

  useEffect(() => {
    if (opsApi.data) setOperations(opsApi.data.operations)
  }, [opsApi.data])

  const onRefresh = useCallback(() => {
    setActionError(null)
    setActionNotice(null)
    vmApi.refetch()
    opsApi.refetch()
  }, [vmApi, opsApi])

  async function handleAction(action: Exclude<VmLifecycleAction, "CREATE">) {
    if (!vm) return
    setActionError(null)
    setActionNotice(null)
    setActionInProgress({ action })

    try {
      if (action === "DELETE") {
        await deleteAdminVm(vm.id)
      } else {
        await performVmAction(vm.id, action as "START" | "STOP" | "RESTART")
      }
      setActionNotice(`VM ${action.toLowerCase()} request submitted.`)
      onRefresh()
    } catch (error) {
      setActionError(formatError(error))
    } finally {
      setActionInProgress(null)
      setDeleteConfirmOpen(false)
    }
  }

  if (!vmId) {
    return (
      <AdminEmptyState title="Missing VM ID" description="No VM instance ID was provided in the URL." />
    )
  }

  if (!canRead) {
    return (
      <AdminForbiddenState
        title="VM lifecycle unavailable"
        description="Your current capability summary does not include VM lifecycle visibility."
      />
    )
  }

  if (vmApi.loading && !vm) {
    return (
      <div className="flex flex-col gap-6">
        <AdminPageHeader title="Loading..." description="Fetching VM instance details." />
        <div className="rounded-lg border border-border">
          <SkeletonTable columns={4} rows={3} />
        </div>
      </div>
    )
  }

  if (vmApi.error && !vm) {
    return (
      <AdminErrorState message={`Failed to fetch VM: ${vmApi.error}`} onRetry={onRefresh} />
    )
  }

  if (!vm) {
    return (
      <AdminEmptyState title="VM not found" description="The requested VM instance does not exist." />
    )
  }

  const available = allowedActions[vm.status] ?? []
  const isDeleting = actionInProgress?.action === "DELETE"

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title={vm.name}
        description={`VM instance ${vm.id} — ${vm.status}`}
        actions={
          <Button type="button" variant="outline" asChild>
            <Link to="/admin/vms">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to VMs
            </Link>
          </Button>
        }
      />

      {actionNotice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {actionNotice}
        </div>
      ) : null}

      {actionError ? <FormError message={actionError} /> : null}

      {vmApi.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to refresh: {vmApi.error}
        </div>
      ) : null}

      {/* VM summary card */}
      <div className="rounded-lg border border-border">
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          <DetailField label="Status" value={vm.status} badge={vm.status} />
          <DetailField label="Project ID" value={vm.projectId} />
          <DetailField label="Tenant ID" value={vm.tenantId} />
          <DetailField label="Endpoint ID" value={vm.endpointId} />
          <DetailField label="Image" value={vm.imageReference} />
          <DetailField label="CPU" value={`${vm.limits.cpu} vCPU`} />
          <DetailField label="Memory" value={formatBytes(vm.limits.memoryBytes)} />
          <DetailField label="Root disk" value={formatBytes(vm.limits.rootDiskBytes)} />
          <DetailField label="Address family" value={vm.network.addressFamily} />
          <DetailField label="Network pool" value={vm.network.poolId ?? "None"} />
          <DetailField label="Created" value={formatTimestamp(vm.createdAt)} />
          <DetailField label="Updated" value={formatTimestamp(vm.updatedAt)} />
        </div>
      </div>

      {/* Lifecycle action controls */}
      {canWrite && vm.status !== "DELETED" ? (
        <div className="flex flex-wrap gap-3">
          {available.includes("START") ? (
            <Button
              type="button"
              onClick={() => handleAction("START")}
              disabled={actionInProgress !== null}
            >
              <Play className="mr-1 h-4 w-4" />
              {actionInProgress?.action === "START" ? "Starting..." : "Start"}
            </Button>
          ) : null}
          {available.includes("STOP") ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleAction("STOP")}
              disabled={actionInProgress !== null}
            >
              <Square className="mr-1 h-4 w-4" />
              {actionInProgress?.action === "STOP" ? "Stopping..." : "Stop"}
            </Button>
          ) : null}
          {available.includes("RESTART") ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleAction("RESTART")}
              disabled={actionInProgress !== null}
            >
              <RotateCcw className="mr-1 h-4 w-4" />
              {actionInProgress?.action === "RESTART" ? "Restarting..." : "Restart"}
            </Button>
          ) : null}
          {available.includes("DELETE") ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={actionInProgress !== null}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Operations history */}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Operations</h2>
        {opsApi.loading && operations.length === 0 ? (
          <AdminTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <AdminLoadingRows columns={4} />
              </TableBody>
            </Table>
          </AdminTableShell>
        ) : operations.length > 0 ? (
          <AdminTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell>
                      <Badge variant="outline">{op.action}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={operationStatusBadgeVariant[op.status]}>{op.status}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[24rem] whitespace-normal text-sm text-muted-foreground">
                      {op.summary ?? op.errorSummary ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatAge(op.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AdminTableShell>
        ) : (
          <p className="text-sm text-muted-foreground">No operations recorded for this VM instance.</p>
        )}
      </section>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete VM instance?"
        description={`This action will permanently delete VM "${vm.name}" (${vm.id}). This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => handleAction("DELETE")}
        loading={isDeleting}
      />
    </div>
  )
}

function DetailField({
  label,
  value,
  badge,
}: {
  label: string
  value: string
  badge?: VmInstanceStatus
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant={statusBadgeVariant[badge]} className="w-fit">
          {value}
        </Badge>
      ) : (
        <span className="break-all text-sm">{value}</span>
      )}
    </div>
  )
}

function SkeletonTable({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: columns }).map((_, i) => (
            <TableHead key={i}>
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <TableRow key={rowIndex}>
            {Array.from({ length: columns }).map((__, colIndex) => (
              <TableCell key={colIndex}>
                <div className="h-4 w-28 animate-pulse rounded bg-muted" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`
  return `${bytes} B`
}

function formatAge(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes <= 1) return "just now"
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp))
}