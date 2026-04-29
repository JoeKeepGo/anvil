import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface StatusBadgeProps {
  status: string
  className?: string
}

const statusVariants: Record<string, string> = {
  Running: "bg-green-500/10 text-green-400 hover:bg-green-500/20 border-green-500/20",
  Stopped: "bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20",
  Frozen: "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border-blue-500/20",
  Stopping: "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border-yellow-500/20",
  Starting: "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border-yellow-500/20",
  Pending: "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border-yellow-500/20",
  Success: "bg-green-500/10 text-green-400 hover:bg-green-500/20 border-green-500/20",
  Failure: "bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20",
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        statusVariants[status] || "bg-muted text-muted-foreground",
        className
      )}
    >
      {status}
    </Badge>
  )
}
