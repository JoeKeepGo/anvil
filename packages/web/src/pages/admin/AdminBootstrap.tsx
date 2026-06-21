import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { ShieldCheck } from "lucide-react"
import { bootstrapAdmin, fetchBootstrapStatus, fetchMe } from "@/lib/api"
import type { AuthSession, BootstrapStatus } from "@/types"
import { formatError, FormError } from "./adminPageUtils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

export function AdminBootstrap() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [teamName, setTeamName] = useState("Primary Team")

  useEffect(() => {
    let cancelled = false

    Promise.allSettled([fetchBootstrapStatus(), fetchMe()])
      .then(([bootstrapResult, sessionResult]) => {
        if (cancelled) {
          return
        }
        if (bootstrapResult.status === "fulfilled") {
          setStatus(bootstrapResult.value)
        }
        if (sessionResult.status === "fulfilled") {
          setSession(sessionResult.value)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
        <div className="flex w-full max-w-[28rem] flex-col gap-4">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-80 w-full" />
        </div>
      </main>
    )
  }

  if (session?.access.bootstrapComplete && !status?.available) {
    return <Navigate to="/admin" replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!email.trim() || !name.trim() || !password || !teamName.trim()) {
      setError("Email, name, password, and team name are required.")
      return
    }

    setSubmitting(true)
    try {
      await bootstrapAdmin({
        email: email.trim(),
        name: name.trim(),
        password,
        teamName: teamName.trim(),
      })
      navigate("/admin", { replace: true })
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <div className="w-full max-w-[28rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
              Bootstrap admin
            </CardTitle>
            <CardDescription>
              Create the first administrator and default team for this Anvil deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status && !status.available ? (
              <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p>Bootstrap is already complete.</p>
                <Button type="button" onClick={() => navigate("/login")}>
                  Return to sign in
                </Button>
              </div>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={onSubmit}>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Email
                  <Input
                    autoComplete="username"
                    inputMode="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Name
                  <Input
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Password
                  <Input
                    autoComplete="new-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Team name
                  <Input
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                    disabled={submitting}
                  />
                </label>
                <FormError message={error} />
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating admin..." : "Create first admin"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
