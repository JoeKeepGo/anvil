import { useState } from "react"
import type { FormEvent } from "react"
import {
  archiveAdminEndpoint,
  createAdminEndpoint,
  fetchAdminEndpoints,
  fetchAdminTeams,
  restoreAdminEndpoint,
} from "@/lib/api"
import { hasGlobalAction, hasAnyTeamAction } from "@/lib/adminAccess"
import { useApi } from "@/hooks/useApi"
import type { ManagedEndpoint } from "@/types"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  formatError,
  FormError,
  RefreshButton,
  StatusPill,
} from "./adminPageUtils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useOutletContext } from "react-router-dom"
import type { AppShellContext } from "@/components/layout/Layout"

export function AdminEndpoints() {
  const { session } = useOutletContext<AppShellContext>()
  const endpoints = useApi(fetchAdminEndpoints)
  const teams = useApi(fetchAdminTeams)
  const canCreate =
    hasGlobalAction(session.access, "endpoints:write") ||
    hasAnyTeamAction(session.access, "endpoints:write")

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Endpoints"
        description="Manage Anvil Agent endpoints. Submitted tokens are never displayed after save."
        actions={<RefreshButton onClick={endpoints.refetch} />}
      />

      {canCreate ? (
        <CreateEndpointPanel
          teams={(teams.data ?? []).filter((team) => team.status === "ACTIVE")}
          onCreated={endpoints.refetch}
        />
      ) : null}

      {endpoints.loading ? (
        <EndpointsTable endpoints={[]} loading />
      ) : endpoints.error ? (
        <AdminErrorState
          message={`Failed to fetch endpoints: ${endpoints.error}`}
          onRetry={endpoints.refetch}
        />
      ) : endpoints.data && endpoints.data.length === 0 ? (
        <AdminEmptyState title="No endpoints found" description="No endpoint inventory records were returned." />
      ) : endpoints.data ? (
        <EndpointsTable endpoints={endpoints.data} canWrite={canCreate} onChanged={endpoints.refetch} />
      ) : null}
    </div>
  )
}

function CreateEndpointPanel({
  teams,
  onCreated,
}: {
  teams: Array<{ id: string; name: string }>
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [teamId, setTeamId] = useState("")
  const [token, setToken] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await createAdminEndpoint({
        name: name.trim(),
        url: url.trim(),
        token: token || undefined,
        teamId,
      })
      setName("")
      setUrl("")
      setTeamId("")
      setToken("")
      onCreated()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create endpoint</CardTitle>
        <CardDescription>
          Token input is write-only. Saved endpoint responses expose only credential status.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 lg:grid-cols-6" onSubmit={onSubmit}>
          <Input
            className="lg:col-span-2"
            placeholder="Endpoint name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
          <Input
            className="lg:col-span-2"
            placeholder="wss://agent.example.com/ws"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={submitting}
          />
          <Select value={teamId} onValueChange={setTeamId}>
            <SelectTrigger className="w-full lg:col-span-2">
              <SelectValue placeholder="Team" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            className="lg:col-span-5"
            placeholder="Endpoint token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create"}
          </Button>
          <div className="lg:col-span-6">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function EndpointsTable({
  endpoints,
  loading = false,
  canWrite = false,
  onChanged,
}: {
  endpoints: ManagedEndpoint[]
  loading?: boolean
  canWrite?: boolean
  onChanged?: () => void
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Endpoint</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Credential</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={5} />
          ) : (
            endpoints.map((endpoint) => (
              <TableRow key={endpoint.id}>
                <TableCell className="max-w-[22rem] whitespace-normal">
                  <div className="font-medium">{endpoint.name}</div>
                  <div className="break-all text-xs text-muted-foreground">{endpoint.url}</div>
                </TableCell>
                <TableCell>{endpoint.team.name}</TableCell>
                <TableCell>
                  <StatusPill status={endpoint.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {endpoint.credentialConfigured ? "Configured" : "Not configured"}
                </TableCell>
                <TableCell>
                  {canWrite ? <EndpointStatusButton endpoint={endpoint} onChanged={onChanged} /> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function EndpointStatusButton({
  endpoint,
  onChanged,
}: {
  endpoint: ManagedEndpoint
  onChanged?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const action = endpoint.status === "ACTIVE" ? archiveAdminEndpoint : restoreAdminEndpoint

  async function onClick() {
    setLoading(true)
    try {
      await action(endpoint.id)
      onChanged?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Updating..." : endpoint.status === "ACTIVE" ? "Archive" : "Restore"}
    </Button>
  )
}
