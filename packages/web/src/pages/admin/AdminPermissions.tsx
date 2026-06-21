import { fetchAdminPermissionMatrix } from "@/lib/api"
import { useApi } from "@/hooks/useApi"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  RefreshButton,
} from "./adminPageUtils"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function AdminPermissions() {
  const matrix = useApi(fetchAdminPermissionMatrix)

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Permissions"
        description="Read-only view of the backend permission matrix used by route enforcement."
        actions={<RefreshButton onClick={matrix.refetch} />}
      />

      {matrix.loading ? (
        <AdminTableShell>
          <table className="w-full text-sm">
            <tbody>
              <AdminLoadingRows columns={2} />
            </tbody>
          </table>
        </AdminTableShell>
      ) : matrix.error ? (
        <AdminErrorState
          message={`Failed to fetch permissions: ${matrix.error}`}
          onRetry={matrix.refetch}
        />
      ) : matrix.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <MatrixTable title="Global roles" rows={matrix.data.global} />
          <MatrixTable title="Team roles" rows={matrix.data.team} />
        </div>
      ) : (
        <AdminEmptyState title="No permissions returned" description="The permission matrix was empty." />
      )}
    </div>
  )
}

function MatrixTable({
  title,
  rows,
}: {
  title: string
  rows: Array<{ role: string; actions: string[] }>
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{title}</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.role}>
              <TableCell className="font-medium">{row.role}</TableCell>
              <TableCell>
                <div className="flex max-w-[34rem] flex-wrap gap-1">
                  {row.actions.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    row.actions.map((action) => (
                      <Badge key={action} variant="outline">
                        {action}
                      </Badge>
                    ))
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}
