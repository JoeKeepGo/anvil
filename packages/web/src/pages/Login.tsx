import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { Navigate, useLocation, useNavigate } from "react-router-dom"
import { LockKeyhole, ShieldCheck } from "lucide-react"
import { ApiRequestError, fetchMe, login } from "@/lib/api"
import type { AuthUser } from "@/types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type LoginLocationState = {
  from?: {
    pathname?: string
    search?: string
  }
}

function getSafeReturnPath(state: unknown): string {
  const locationState = state as LoginLocationState | null
  const pathname = locationState?.from?.pathname
  const search = locationState?.from?.search ?? ""

  if (!pathname || pathname === "/login" || !pathname.startsWith("/")) {
    return "/"
  }

  return `${pathname}${search}`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message
  }

  return "Unable to reach Anvil authentication."
}

export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const returnPath = getSafeReturnPath(location.state)

  useEffect(() => {
    let cancelled = false

    fetchMe()
      .then((user) => {
        if (!cancelled) {
          setCurrentUser(user)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentUser(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCheckingSession(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (currentUser) {
    return <Navigate to={returnPath} replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!email.trim() || !password) {
      setError("Email and password are required.")
      return
    }

    setSubmitting(true)

    try {
      await login(email.trim(), password)
      navigate(returnPath, { replace: true })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <div className="w-full max-w-[25rem] space-y-4">
        <div className="space-y-3 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border bg-card">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to Anvil</h1>
            <p className="text-sm text-muted-foreground">
              Access the control plane with your configured account.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
                <LockKeyhole className="h-5 w-5 shrink-0" />
                <span>Authentication</span>
              </CardTitle>
            </div>
            <CardDescription>
              Enter the administrator credentials configured for this Anvil deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="email">
                  Email
                </label>
                <Input
                  id="email"
                  autoComplete="username"
                  inputMode="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={submitting || checkingSession}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="password">
                  Password
                </label>
                <Input
                  id="password"
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting || checkingSession}
                />
              </div>

              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button className="w-full" type="submit" disabled={submitting || checkingSession}>
                {submitting ? "Signing in..." : checkingSession ? "Checking session..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
