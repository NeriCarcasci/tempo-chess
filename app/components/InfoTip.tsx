import { useId, useState } from "react";

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-button"
        aria-label={`About ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        i
      </button>
      {open ? (
        <span className="info-tip-copy" id={id} role="tooltip">
          {children}
        </span>
      ) : null}
    </span>
  );
}
