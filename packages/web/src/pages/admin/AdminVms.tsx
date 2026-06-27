import { useEffect, useMemo, useState } from "react"
import { Link, useOutletContext } from "react-router-dom"
import { Plus } from "lucide-react"
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
import { fetchAdminVms } from "@/lib/api"
import type { BrowserVmInstance, VmInstanceStatus } from "@/types"
import { canCreateVm, canReadVms } from "./AdminVms.access"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbiddenState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  RefreshButton,
} from "./adminPageUtils"

const statusBadgeVariant: Record<VmInstanceStatus, "secondary" | "outline" | "destructive"> = {
  PROVISIONING: "outline",
  RUNNING: "secondary",
  STOPPED: "outline",
  FAILED: "destructive",
  DELETED: "outline",
}

export function AdminVms() {
  const { session } = useOutletContext<AppShellContext>()
  const canRead = canReadVms(session.access)
  const canCreate = canCreateVm(session.access)
  const useApiOptions = useMemo(() => ({ enabled: canRead }), [canRead])
  const vmsApi = useApi(fetchAdminVms, useApiOptions)
  const [displayVms, setDisplayVms] = useState<BrowserVmInstance[]>([])

  useEffect(() => {
    if (vmsApi.data) {
      setDisplayVms(vmsApi.data)
    }
  }, [vmsApi.data])

  const hasVisibleVms = displayVms.length > 0

  function onRefresh() {
    vmsApi.refetch()
  }

  if (!canRead) {
    return (
      <AdminForbiddenState
        title="VM lifecycle unavailable"
        description="Your current capability summary does not include VM lifecycle visibility."
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="VM Instances"
        description="Tenant-scoped VM lifecycle instances with create, start, stop, restart, and delete controls."
        actions={
          <div className="flex shrink-0 flex-wrap gap-2">
            <RefreshButton onClick={onRefresh} label="Refresh VMs" />
            {canCreate ? (
              <Button type="button" asChild>
                <Link to="/admin/vms/create">
                  <Plus className="mr-1 h-4 w-4" />
                  Create VM
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {vmsApi.error && hasVisibleVms ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to refresh VMs: {vmsApi.error}
        </div>
      ) : null}

      {vmsApi.loading && !hasVisibleVms ? (
        <VmsTable vms={[]} loading />
      ) : vmsApi.error && !hasVisibleVms ? (
        <AdminErrorState
          message={`Failed to fetch VMs: ${vmsApi.error}`}
          onRetry={onRefresh}
        />
      ) : hasVisibleVms ? (
        <VmsTable vms={displayVms} />
      ) : (
        <AdminEmptyState
          title="No VM instances"
          description="Create a VM instance from the admin console to get started."
        />
      )}
    </div>
  )
}

function VmsTable({
  vms,
  loading = false,
}: {
  vms: BrowserVmInstance[]
  loading?: boolean
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Tenant</TableHead>
            <TableHead>Limits</TableHead>
            <TableHead>Network</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={7} />
          ) : (
            vms.map((vm) => (
              <TableRow key={vm.id}>
                <TableCell className="max-w-[14rem] whitespace-normal">
                  <Link
                    to={`/admin/vms/${encodeURIComponent(vm.id)}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {vm.name}
                  </Link>
                  <div className="text-xs text-muted-foreground break-all">{vm.id}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant[vm.status]}>{vm.status}</Badge>
                </TableCell>
                <TableCell className="max-w-[12rem] whitespace-normal text-sm text-muted-foreground break-all">
                  {vm.projectId}
                </TableCell>
                <TableCell className="max-w-[12rem] whitespace-normal text-sm text-muted-foreground break-all">
                  {vm.tenantId}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div>{vm.limits.cpu} vCPU</div>
                  <div>{formatBytes(vm.limits.memoryBytes)} RAM</div>
                  <div>{formatBytes(vm.limits.rootDiskBytes)} disk</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div>{vm.network.addressFamily}</div>
                  <div className="text-xs break-all">{vm.network.poolId ?? "No pool"}</div>
                </TableCell>
                <TableCell className="max-w-[12rem] whitespace-normal text-sm text-muted-foreground">
                  <div>{formatAge(vm.createdAt)}</div>
                  <div>{formatTimestamp(vm.createdAt)}</div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) {
    return `${(bytes / 1073741824).toFixed(1)} GB`
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(0)} MB`
  }
  return `${bytes} B`
}

function formatAge(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }
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
