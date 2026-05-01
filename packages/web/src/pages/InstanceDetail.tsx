import { useCallback } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Box } from "lucide-react"
import { ErrorAlert } from "@/components/ErrorAlert"
import { StatusBadge } from "@/components/StatusBadge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useApi } from "@/hooks/useApi"
import { fetchInstance } from "@/lib/api"
import type { InstanceDetail as InstanceDetailType } from "@/types"

interface InstanceDetailViewState {
  data: InstanceDetailType | null
  loading: boolean
  error: string | null
  refetch: () => void
}

interface InstanceDetailViewProps {
  name: string
  instance: InstanceDetailViewState
  notFound: boolean
}

export function InstanceDetail() {
  const { name } = useParams<{ name: string }>()
  const instanceName = name ?? ""
  const loadInstance = useCallback(() => fetchInstance(instanceName), [instanceName])
  const instance = useApi(loadInstance)
  const notFound = instance.error === "Instance not found"

  return <InstanceDetailView name={instanceName} instance={instance} notFound={notFound} />
}

export function InstanceDetailView({ name, instance, notFound }: InstanceDetailViewProps) {
  return (
    <div className="space-y-6">
      <Button variant="ghost" asChild className="gap-2">
        <Link to="/instances">
          <ArrowLeft className="h-4 w-4" />
          Back to Instances
        </Link>
      </Button>

      {instance.loading ? (
        <InstanceDetailSkeleton />
      ) : notFound ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-24 text-center">
          <Box className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Instance not found</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The configured host did not return an instance named {name || "this instance"}.
          </p>
        </div>
      ) : instance.error ? (
        <ErrorAlert
          message={`Failed to fetch instance: ${instance.error}`}
          onRetry={instance.refetch}
        />
      ) : instance.data ? (
        <InstanceDetailContent instance={instance.data} />
      ) : null}
    </div>
  )
}

function InstanceDetailContent({ instance }: { instance: InstanceDetailType }) {
  const rows = [
    { label: "Type", value: instance.type },
    { label: "Architecture", value: instance.architecture ?? "Unknown" },
    { label: "Created", value: instance.createdAt ?? "Unknown" },
    { label: "Description", value: instance.description || "None" },
    { label: "Ephemeral", value: formatBoolean(instance.ephemeral) },
    { label: "Stateful", value: formatBoolean(instance.stateful) },
    { label: "Profiles", value: instance.profiles.length > 0 ? instance.profiles.join(", ") : "None" },
    { label: "Memory limit", value: instance.limits.memory ?? "None" },
    { label: "CPU limit", value: instance.limits.cpu ?? "None" },
    { label: "Root disk pool", value: instance.rootDisk?.pool ?? "None" },
    { label: "Root disk size", value: instance.rootDisk?.size ?? "None" },
    { label: "Root disk type", value: instance.rootDisk?.type ?? "None" },
  ]

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{instance.name}</h1>
        </div>
        <StatusBadge status={instance.status} />
      </div>

      <div className="rounded-lg border border-border">
        <dl className="divide-y divide-border">
          {rows.map((row) => (
            <div
              key={row.label}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4"
            >
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="break-words text-sm text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  )
}

function InstanceDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="rounded-lg border border-border">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-4"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
    </div>
  )
}

function formatBoolean(value: boolean): string {
  return value ? "Yes" : "No"
}
