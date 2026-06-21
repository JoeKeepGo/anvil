import { useState } from "react"
import type { FormEvent } from "react"
import {
  createAdminUser,
  disableAdminUser,
  fetchAdminTeams,
  fetchAdminUsers,
  restoreAdminUser,
} from "@/lib/api"
import { hasGlobalAction } from "@/lib/adminAccess"
import { useApi } from "@/hooks/useApi"
import type { GlobalRole, ManagedUser, TeamRole } from "@/types"
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

export function AdminUsers() {
  const { session } = useOutletContext<AppShellContext>()
  const users = useApi(fetchAdminUsers)
  const teams = useApi(fetchAdminTeams)
  const canWrite = hasGlobalAction(session.access, "users:write")

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Users"
        description="Manage admin-plane users without exposing password hashes or session material."
        actions={<RefreshButton onClick={users.refetch} />}
      />

      {canWrite ? (
        <CreateUserPanel
          teams={teams.data ?? []}
          onCreated={() => {
            users.refetch()
          }}
        />
      ) : null}

      {users.loading ? (
        <UsersTable users={[]} loading />
      ) : users.error ? (
        <AdminErrorState message={`Failed to fetch users: ${users.error}`} onRetry={users.refetch} />
      ) : users.data && users.data.length === 0 ? (
        <AdminEmptyState title="No users found" description="No admin users were returned." />
      ) : users.data ? (
        <UsersTable users={users.data} canWrite={canWrite} onChanged={users.refetch} />
      ) : null}
    </div>
  )
}

function CreateUserPanel({
  teams,
  onCreated,
}: {
  teams: Array<{ id: string; name: string; status: string }>
  onCreated: () => void
}) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [globalRole, setGlobalRole] = useState<GlobalRole>("MEMBER")
  const [teamId, setTeamId] = useState("")
  const [teamRole, setTeamRole] = useState<TeamRole>("VIEWER")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      await createAdminUser({
        email: email.trim(),
        name: name.trim(),
        password,
        globalRole,
        memberships: teamId ? [{ teamId, role: teamRole }] : undefined,
      })
      setEmail("")
      setName("")
      setPassword("")
      setGlobalRole("MEMBER")
      setTeamId("")
      setTeamRole("VIEWER")
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
        <CardTitle className="text-base">Create user</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 lg:grid-cols-6" onSubmit={onSubmit}>
          <Input
            className="lg:col-span-2"
            placeholder="email@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
          />
          <Input
            className="lg:col-span-2"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
          <Input
            className="lg:col-span-2"
            placeholder="Temporary password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
          <Select value={globalRole} onValueChange={(value) => setGlobalRole(value as GlobalRole)}>
            <SelectTrigger className="w-full lg:col-span-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={teamId || "none"} onValueChange={(value) => setTeamId(value === "none" ? "" : value)}>
            <SelectTrigger className="w-full lg:col-span-2">
              <SelectValue placeholder="Initial team" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">No initial team</SelectItem>
                {teams
                  .filter((team) => team.status === "ACTIVE")
                  .map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={teamRole} onValueChange={(value) => setTeamRole(value as TeamRole)}>
            <SelectTrigger className="w-full lg:col-span-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="VIEWER">Viewer</SelectItem>
                <SelectItem value="MAINTAINER">Maintainer</SelectItem>
                <SelectItem value="OWNER">Owner</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
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

function UsersTable({
  users,
  loading = false,
  canWrite = false,
  onChanged,
}: {
  users: ManagedUser[]
  loading?: boolean
  canWrite?: boolean
  onChanged?: () => void
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Global role</TableHead>
            <TableHead>Teams</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={5} />
          ) : (
            users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="max-w-[18rem] whitespace-normal">
                  <div className="font-medium">{user.name}</div>
                  <div className="break-all text-xs text-muted-foreground">{user.email}</div>
                </TableCell>
                <TableCell>
                  <StatusPill status={user.status} />
                </TableCell>
                <TableCell>{user.globalRole}</TableCell>
                <TableCell className="max-w-[20rem] whitespace-normal text-muted-foreground">
                  {user.teams.length === 0
                    ? "None"
                    : user.teams.map((team) => `${team.name} (${team.role})`).join(", ")}
                </TableCell>
                <TableCell>
                  {canWrite ? <UserStatusButton user={user} onChanged={onChanged} /> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function UserStatusButton({ user, onChanged }: { user: ManagedUser; onChanged?: () => void }) {
  const [loading, setLoading] = useState(false)
  const action = user.status === "ACTIVE" ? disableAdminUser : restoreAdminUser

  async function onClick() {
    setLoading(true)
    try {
      await action(user.id)
      onChanged?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Updating..." : user.status === "ACTIVE" ? "Disable" : "Restore"}
    </Button>
  )
}
