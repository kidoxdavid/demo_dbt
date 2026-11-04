import { ReactNode, useId } from 'react';
export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div><label htmlFor={id}>{label}</label>{children(id)}{hint && <div className="muted small">{hint}</div>}</div>;
}
export const Alert = ({ kind, children }: { kind: 'err' | 'ok' | 'warn'; children: ReactNode }) =>
  <div className={`alert ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>{children}</div>;
export const Badge = ({ s }: { s: string }) => <span className={`badge ${s}`}>{s.replace(/_/g, ' ')}</span>;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) =>
  <div className="empty"><h3>{title}</h3><p>{children}</p></div>;
