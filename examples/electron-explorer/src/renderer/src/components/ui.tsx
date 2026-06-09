import type { ReactNode } from 'react';

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const s = status.toLowerCase();
  const cls = s.includes('run')
    ? 'badge badge-running'
    : s.includes('error') || s.includes('fail')
      ? 'badge badge-error'
      : s.includes('start')
        ? 'badge badge-starting'
        : 'badge badge-stopped';
  return <span className={cls}>{status}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function JsonEditor({
  value,
  onChange,
  rows = 8,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}): JSX.Element {
  const valid = isValidJson(value);
  return (
    <div className="json-editor">
      <textarea
        className={valid ? 'code' : 'code code-invalid'}
        spellCheck={false}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {!valid && <span className="hint hint-error">Invalid JSON</span>}
    </div>
  );
}

export function isValidJson(v: string): boolean {
  if (v.trim() === '') return true;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

export function Banner({
  kind,
  message,
  onClose,
}: {
  kind: 'error' | 'info';
  message: string;
  onClose?: () => void;
}): JSX.Element {
  return (
    <div className={`banner banner-${kind}`}>
      <span>{message}</span>
      {onClose && (
        <button className="banner-close" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}
