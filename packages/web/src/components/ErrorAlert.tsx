import { AlertCircle } from "lucide-react"

interface ErrorAlertProps {
  message: string
  onRetry?: () => void
}

export function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12">
      <AlertCircle className="h-8 w-8 text-destructive" />
      <p className="text-sm text-destructive">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 text-sm text-muted-foreground underline hover:text-foreground"
        >
          Try again
        </button>
      )}
    </div>
  )
}
