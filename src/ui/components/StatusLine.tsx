import type { ReactNode } from "react";

type Tone = "ok" | "warning" | "error" | "pending";

interface StatusLineProps {
  label: string;
  status: string;
  tone: Tone;
  detail?: ReactNode;
}

export function StatusLine({ label, status, tone, detail }: StatusLineProps) {
  return (
    <div className="status-line">
      <div>
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        <strong>{label}</strong>
      </div>
      <div className="status-value">
        <span>{status}</span>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}
