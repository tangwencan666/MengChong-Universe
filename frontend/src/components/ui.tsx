import { useEffect, useId, useRef } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { CircleAlert, LoaderCircle, Sprout, X } from 'lucide-react'

export function Button({ variant = 'primary', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button type="button" className={`button button-${variant} ${className}`} {...props} />
}

export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`card ${className}`} {...props}>{children}</section>
}

export function Modal({ open, onClose, title, children }:
  { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    if (open && !element?.open) element?.showModal()
    if (!open && element?.open) element.close()
  }, [open])
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onCancel={onClose} onClose={onClose}>
    <div className="section-heading"><h2 id={titleId}>{title}</h2><Button variant="ghost" onClick={onClose} aria-label="关闭弹窗"><X size={18} /></Button></div>
    {children}
  </dialog>
}

export function FormField({ label, hint, ...props }:
  InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId()
  return <div className="form-field"><label htmlFor={id}>{label}</label><input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} />{hint && <small id={`${id}-hint`}>{hint}</small>}</div>
}

export function Loading({ message = '正在加载…' }: { message?: string }) {
  return <div className="state" role="status"><LoaderCircle className="spin" size={24} /><p>{message}</p></div>
}

export function EmptyState({ title, description, action }:
  { title: string; description: string; action?: ReactNode }) {
  return <div className="state"><span className="state-icon"><Sprout size={30} /></span><h3>{title}</h3><p>{description}</p>{action}</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-state" role="alert"><CircleAlert size={20} /><div><strong>暂时无法完成</strong><p>{message}</p>{onRetry && <Button variant="secondary" onClick={onRetry}>重试</Button>}</div></div>
}
