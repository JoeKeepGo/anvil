import { Activity } from "lucide-react"
import { ErrorAlert } from "@/components/ErrorAlert"
import { StatusBadge } from "@/components/StatusBadge"
import { Badge } from "@/components/ui/badge"
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
import { fetchOperations } from "@/lib/api"
import type { OperationSummary } from "@/types"

interface OperationsViewState {
  data: OperationSummary[] | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function Operations() {
  const operations = useApi(fetchOperations)

  return <OperationsView operations={operations} />
}

export function OperationsView({ operations }: { operations: OperationsViewState }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only operation activity from the configured host.
        </p>
      </div>

      {operations.loading ? (
        <OperationsSkeleton />
      ) : operations.error ? (
        <ErrorAlert
          message={`Failed to fetch operations: ${operations.error}`}
          onRetry={operations.refetch}
        />
      ) : operations.data && operations.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-24 text-center">
          <Activity className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No operations found</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The configured host has no active or retained operations to show.
          </p>
        </div>
      ) : operations.data ? (
        <OperationsTable operations={operations.data} />
      ) : null}
    </div>
  )
}

function OperationsTable({ operations }: { operations: OperationSummary[] }) {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Operation</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status code</TableHead>
            <TableHead>May cancel</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Resources</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {operations.map((operation) => (
            <TableRow key={operation.id}>
              <TableCell className="max-w-[18rem] whitespace-normal font-mono text-xs">
                <span className="block break-all">{operation.id}</span>
              </TableCell>
              <TableCell>
                <StatusBadge status={operation.status} />
              </TableCell>
              <TableCell>{operation.class}</TableCell>
              <TableCell className="max-w-[18rem] whitespace-normal">
                <span className="block break-words">{operation.description || "None"}</span>
              </TableCell>
              <TableCell className="text-muted-foreground">{operation.statusCode}</TableCell>
              <TableCell className="text-muted-foreground">
                {operation.mayCancel ? "Yes" : "No"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatTimestamp(operation.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatTimestamp(operation.updatedAt)}
              </TableCell>
              <TableCell>
                <ResourceBadges resources={operation.resources} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ResourceBadges({ resources }: { resources: Record<string, unknown> }) {
  const entries = Object.entries(resources).filter(([, value]) => {
    return Array.isArray(value) && value.length > 0
  })

  if (entries.length === 0) {
    return <span className="text-muted-foreground">None</span>
  }

  return (
    <div className="flex max-w-[16rem] flex-wrap gap-1">
      {entries.map(([resource, values]) => (
        <Badge key={resource} variant="outline">
          {resource}: {(values as unknown[]).length}
        </Badge>
      ))}
    </div>
  )
}

function OperationsSkeleton() {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Operation</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status code</TableHead>
            <TableHead>May cancel</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Resources</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 3 }).map((_, index) => (
            <TableRow key={index}>
              {Array.from({ length: 9 }).map((__, cellIndex) => (
                <TableCell key={cellIndex}>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatTimestamp(value: string | null): string {
  return value ?? "Unknown"
}
