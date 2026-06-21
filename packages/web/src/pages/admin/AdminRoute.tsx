import { Navigate, Outlet, useOutletContext } from "react-router-dom"
import type { AppShellContext } from "@/components/layout/Layout"
import { canUseAdminConsole } from "@/lib/adminAccess"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function AdminRoute() {
  const context = useOutletContext<AppShellContext>()

  if (!canUseAdminConsole(context.session.access)) {
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Admin access unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your current capability summary does not allow access to the admin console.
        </CardContent>
      </Card>
    )
  }

  if (!context.session.access.bootstrapComplete) {
    return <Navigate to="/admin/bootstrap" replace />
  }

  return <Outlet context={context} />
}
