import type { ReactNode } from 'react'

export function DemoNotice({ children = '当前为本地体验，尚未连接真实模型。' }: { children?: ReactNode }) {
  return <div className="demo-notice"><span className="demo-tag">体验说明</span><span>{children}</span></div>
}
