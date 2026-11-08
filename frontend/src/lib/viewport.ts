import { useCallback, useEffect, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string) {
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query)
    media.addEventListener('change', notify)
    return () => media.removeEventListener('change', notify)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      // iOS keyboards can pan as well as resize the visual viewport.
      document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`)
      document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`)
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      document.documentElement.style.removeProperty('--app-height')
      document.documentElement.style.removeProperty('--viewport-top')
    }
  }, [])
}
