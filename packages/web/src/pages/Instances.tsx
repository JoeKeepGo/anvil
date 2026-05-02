import { Box } from "lucide-react"
import { Link } from "react-router-dom"
import { ErrorAlert } from "@/components/ErrorAlert"
import { StatusBadge } from "@/components/StatusBadge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/hooks/useApi"
import { fetchInstances } from "@/lib/api"
import type { Instance } from "@/types"

interface InstancesViewState {
  data: Instance[] | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function Instances() {
  const instances = useApi(fetchInstances)

  return <InstancesView instances={instances} />
}

export function InstancesView({ instances }: { instances: InstancesViewState }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only instance inventory from the configured host.
        </p>
      </div>

      {instances.loading ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Architecture</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 3 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-36" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : instances.error ? (
        <ErrorAlert
          message={`Failed to fetch instances: ${instances.error}`}
          onRetry={instances.refetch}
        />
      ) : instances.data && instances.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-24 text-center">
          <Box className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No instances found</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The configured host returned an empty instance list.
          </p>
        </div>
      ) : instances.data ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Architecture</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.data.map((instance) => (
                <TableRow key={instance.name}>
                  <TableCell className="max-w-[18rem] whitespace-normal font-medium">
                    <Link
                      to={`/instances/${encodeURIComponent(instance.name)}`}
                      className="block break-all text-foreground underline-offset-4 hover:underline"
                    >
                      {instance.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={instance.status} />
                  </TableCell>
                  <TableCell>{instance.type}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {instance.architecture ?? "Unknown"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {instance.createdAt ?? "Unknown"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  )
}
