import { useId } from 'react'

export function SkyBackdrop() {
  return <svg className="p862-sky" viewBox="0 0 1672 180" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="p862-header-sky"><stop stopColor="#edf5ff" /><stop offset="1" stopColor="#87baff" /></linearGradient></defs><path fill="url(#p862-header-sky)" d="M0 0h1672v140c-150-100-230-160-405-100S1100 125 965 60 800 15 640 65 270 160 0 135Z" /><path fill="#b7d8ff" opacity=".28" d="M0 105c230 65 340 15 510-25s260-40 380 10 220 60 380-5 265-35 402 15v80H0Z" /></svg>
}

// Original, static vector scenery. It neither loads external art nor animates.
export function Landscape({ trees = false }: { trees?: boolean }) {
  const id = useId().replaceAll(':', '')
  return <svg viewBox="0 0 600 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="#6daafa" /><stop offset="1" stopColor="#e5f3ff" /></linearGradient>
      <linearGradient id={`${id}-mountain`} x2="1" y2="1"><stop stopColor="#accfff" /><stop offset="1" stopColor="#437fce" /></linearGradient></defs>
    <path fill={`url(#${id}-sky)`} d="M0 0h600v240H0z" />
    <path fill="#d5e7ff" d="m0 190 112-66 75 39L326 24l124 138 150-50v128H0z" />
    <path fill={`url(#${id}-mountain)`} d="m90 240 228-207 75 79 50 23 93 105z" />
    <path fill="#f8fcff" d="m318 33-83 88 68-37 13 32 19-40 58 36z" />
    <path fill="#bfd9ff" d="m318 33 17 43 58 36-30-13 26 42-60-41-13 16-13-32 5 42-60 39 42-61z" />
    <path fill="#5489d0" d="m329 100 41 39-18 7 39 30-39-5 52 32-33 37h165l-93-105-50-23-58-36z" opacity=".5" />
    <path fill="#eef7ff" opacity=".8" d="M0 208q30-25 63-7t59-4 66 6q38 5 65-8 28-15 62-1t72 4q53-8 81 9 52-28 132-8v26H0Z" />
    <path fill="#76a9eb" d="m0 227 102-47 121 38 178-34 199 26v30H0z" />
    <path fill="#d8ebff" d="M0 223q90-45 184-12t218 0 198-5v34H0z" />
    {trees && <g fill="#286bc5"><path d="m517 92-16 38h10l-24 40h15l-28 43h35v27h16v-27h34l-28-43h15l-24-40h11z" /><path d="m564 148-16 35h9l-21 34h22v23h12v-23h22l-21-34h9zM50 171l-13 28h7l-17 27h17v14h10v-14h17l-17-27h7z" /></g>}
    <path fill="#94bdf5" opacity=".6" d="M0 239q140-30 281-12t319-5v18H0z" />
  </svg>
}
