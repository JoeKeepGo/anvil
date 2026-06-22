import { useState, useEffect, useCallback, useRef } from "react"

interface UseApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

interface UseApiOptions {
  enabled?: boolean
}

export function useApi<T>(fetcher: () => Promise<T>, options: UseApiOptions = {}): UseApiState<T> {
  const enabled = options.enabled ?? true
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchData = useCallback(() => {
    if (!enabled) {
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    fetcher()
      .then((result) => {
        if (mountedRef.current) setData(result)
      })
      .catch((err: Error) => {
        if (mountedRef.current) setError(err.message)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
  }, [enabled, fetcher])

  useEffect(() => {
    mountedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData()
    return () => {
      mountedRef.current = false
    }
  }, [fetchData])

  return { data, loading, error, refetch: fetchData }
}
