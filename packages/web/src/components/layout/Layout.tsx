import { useEffect, useState } from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"
import { useNavigate } from "react-router-dom"
import { Sidebar } from "./Sidebar"
import { fetchMe, logout } from "@/lib/api"
import { ApiRequestError } from "@/lib/api"
import type { AuthUser } from "@/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  function checkCurrentUser() {
    setLoading(true)
    setError(null)

    fetchMe()
      .then((currentUser) => {
        setUser(currentUser)
      })
      .catch((err: unknown) => {
        setUser(null)
        setError(err)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  async function signOut() {
    setSigningOut(true)
    setSignOutError(null)

    try {
      await logout()
      setUser(null)
      navigate("/login", { replace: true })
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : "Unable to sign out.")
    } finally {
      setSigningOut(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)

    fetchMe()
      .then((currentUser) => {
        if (!cancelled) {
          setUser(currentUser)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setUser(null)
          setError(err)
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
      <div className="min-h-screen bg-background">
        <Sidebar user={null} />
        <main className="ml-56 min-h-screen p-6">
          <div className="max-w-xl space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        </main>
      </div>
    )
  }

  if (error) {
    const authError = error instanceof ApiRequestError && error.status === 401

    if (authError) {
      return <Navigate to="/login" replace state={{ from: location }} />
    }

    return (
      <div className="min-h-screen bg-background">
        <Sidebar user={null} />
        <main className="ml-56 min-h-screen p-6">
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>Authentication unavailable</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>{error instanceof Error ? error.message : "Unable to load current user."}</p>
              <Button onClick={checkCurrentUser} type="button" variant="outline">
                Retry current user check
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar user={user} onSignOut={signOut} signingOut={signingOut} />
      <main className="ml-56 min-h-screen p-6">
        {signOutError ? (
          <div className="mb-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {signOutError}
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  )
}
