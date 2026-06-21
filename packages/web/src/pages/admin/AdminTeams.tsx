import { useState } from "react"
import type { FormEvent } from "react"
import {
  archiveAdminTeam,
  createAdminTeam,
  fetchAdminTeams,
  restoreAdminTeam,
} from "@/lib/api"
import { hasGlobalAction, hasAnyTeamAction } from "@/lib/adminAccess"
import { useApi } from "@/hooks/useApi"
import type { ManagedTeam } from "@/types"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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

export function AdminTeams() {
  const { session } = useOutletContext<AppShellContext>()
  const teams = useApi(fetchAdminTeams)
  const canCreate = hasGlobalAction(session.access, "teams:write")
  const canWrite = canCreate || hasAnyTeamAction(session.access, "members:write")

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Teams"
        description="Manage teams and inspect active membership state."
        actions={<RefreshButton onClick={teams.refetch} />}
      />

      {canCreate ? <CreateTeamPanel onCreated={teams.refetch} /> : null}

      {teams.loading ? (
        <TeamsTable teams={[]} loading />
      ) : teams.error ? (
        <AdminErrorState message={`Failed to fetch teams: ${teams.error}`} onRetry={teams.refetch} />
      ) : teams.data && teams.data.length === 0 ? (
        <AdminEmptyState title="No teams found" description="No teams were returned." />
      ) : teams.data ? (
        <TeamsTable teams={teams.data} canWrite={canWrite} onChanged={teams.refetch} />
      ) : null}
    </div>
  )
}

function CreateTeamPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await createAdminTeam({ name: name.trim() })
      setName("")
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
        <CardTitle className="text-base">Create team</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={onSubmit}>
          <Input
            placeholder="Team name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create"}
          </Button>
          <div className="sm:col-span-2">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TeamsTable({
  teams,
  loading = false,
  canWrite = false,
  onChanged,
}: {
  teams: ManagedTeam[]
  loading?: boolean
  canWrite?: boolean
  onChanged?: () => void
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Team</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={4} />
          ) : (
            teams.map((team) => (
              <TableRow key={team.id}>
                <TableCell className="font-medium">{team.name}</TableCell>
                <TableCell>
                  <StatusPill status={team.status} />
                </TableCell>
                <TableCell className="max-w-[26rem] whitespace-normal text-muted-foreground">
                  {team.members.length === 0
                    ? "No active members"
                    : team.members.map((member) => `${member.email} (${member.role})`).join(", ")}
                </TableCell>
                <TableCell>
                  {canWrite ? <TeamStatusButton team={team} onChanged={onChanged} /> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function TeamStatusButton({ team, onChanged }: { team: ManagedTeam; onChanged?: () => void }) {
  const [loading, setLoading] = useState(false)
  const action = team.status === "ACTIVE" ? archiveAdminTeam : restoreAdminTeam

  async function onClick() {
    setLoading(true)
    try {
      await action(team.id)
      onChanged?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Updating..." : team.status === "ACTIVE" ? "Archive" : "Restore"}
    </Button>
  )
}
