import type { ReactNode } from "react"
import { ApiRequestError } from "@/lib/api"
import { ErrorAlert } from "@/components/ErrorAlert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

export function AdminTableShell({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-border">{children}</div>
}

export function AdminEmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-20 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function AdminLoadingRows({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <td key={columnIndex} className="p-2">
              <Skeleton className="h-4 w-28" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export function AdminErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return <ErrorAlert message={message} onRetry={onRetry} />
}

export function AdminForbiddenState({
  title = "Capability unavailable",
  description = "Your current capability summary does not allow this admin view.",
}: {
  title?: string
  description?: string
}) {
  return (
    <div className="max-w-2xl rounded-lg border border-border px-6 py-8">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) {
    return null
  }

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  )
}

export function formatError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return "Request failed."
}

export function StatusPill({ status }: { status: string }) {
  return <Badge variant={status === "ACTIVE" ? "secondary" : "outline"}>{status}</Badge>
}

export function RefreshButton({
  onClick,
  label = "Refresh",
}: {
  onClick: () => void
  label?: string
}) {
  return (
    <Button type="button" variant="outline" onClick={onClick}>
      {label}
    </Button>
  )
}
