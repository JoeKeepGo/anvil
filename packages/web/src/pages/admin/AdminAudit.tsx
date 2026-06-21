import { useCallback, useState } from "react"
import { fetchAdminAudit } from "@/lib/api"
import { useApi } from "@/hooks/useApi"
import type { AuditQuery, BrowserAuditEntry } from "@/types"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  RefreshButton,
} from "./adminPageUtils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function AdminAudit() {
  const [targetType, setTargetType] = useState("")
  const [action, setAction] = useState("")
  const [query, setQuery] = useState<AuditQuery>({ limit: 25 })
  const fetchAudit = useCallback(() => fetchAdminAudit(query), [query])
  const audit = useApi(fetchAudit)

  function applyFilters() {
    setQuery({
      limit: 25,
      targetType: targetType.trim() || undefined,
      action: action.trim() || undefined,
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Audit"
        description="Management activity with sensitive metadata redacted by the backend."
        actions={<RefreshButton onClick={audit.refetch} />}
      />

      <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_1fr_auto]">
        <Input
          placeholder="Target type, e.g. endpoint"
          value={targetType}
          onChange={(event) => setTargetType(event.target.value)}
        />
        <Input
          placeholder="Action, e.g. endpoint.create"
          value={action}
          onChange={(event) => setAction(event.target.value)}
        />
        <Button type="button" onClick={applyFilters}>
          Apply filters
        </Button>
      </div>

      {audit.loading ? (
        <AuditTable entries={[]} loading />
      ) : audit.error ? (
        <AdminErrorState message={`Failed to fetch audit: ${audit.error}`} onRetry={audit.refetch} />
      ) : audit.data && audit.data.audit.length === 0 ? (
        <AdminEmptyState title="No audit entries found" description="No entries matched the current filters." />
      ) : audit.data ? (
        <AuditTable entries={audit.data.audit} total={audit.data.page.total} />
      ) : null}
    </div>
  )
}

function AuditTable({
  entries,
  loading = false,
  total,
}: {
  entries: BrowserAuditEntry[]
  loading?: boolean
  total?: number
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Metadata</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={5} />
          ) : (
            entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <Badge variant="outline">{entry.action}</Badge>
                </TableCell>
                <TableCell className="max-w-[16rem] whitespace-normal">
                  <div>{entry.actor.name}</div>
                  <div className="break-all text-xs text-muted-foreground">{entry.actor.email}</div>
                </TableCell>
                <TableCell className="max-w-[16rem] whitespace-normal">
                  <div>{entry.targetType}</div>
                  <div className="break-all text-xs text-muted-foreground">{entry.targetId}</div>
                </TableCell>
                <TableCell className="max-w-[24rem] whitespace-normal">
                  <code className="break-words text-xs text-muted-foreground">
                    {entry.metadata ? JSON.stringify(entry.metadata) : "{}"}
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">{entry.createdAt}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {total !== undefined ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {total} total entries
        </div>
      ) : null}
    </AdminTableShell>
  )
}
