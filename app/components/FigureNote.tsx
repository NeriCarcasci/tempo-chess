import { useEffect, useId, useRef, useState } from "react";

/**
 * An instrument's definitions, behind one mark.
 *
 * Both figures in the product carry a note that has to exist — each defines
 * what its own picture counts, and those thresholds are what make the picture
 * checkable rather than decorative — and that a returning reader reads past
 * every single time. It used to be a `<details>` sitting under the figure,
 * which meant a line of chrome ("HOW THIS IS MEASURED +") permanently attached
 * to the bottom of an instrument that had just finished making its point.
 *
 * A mark and a modal costs nothing when it is not wanted and gives the note
 * the whole page when it is. Built on a real `<dialog>` rather than a div with
 * a z-index, so the focus trap, Escape, inert-ing the page behind it and the
 * top layer all come from the platform instead of from us getting them subtly
 * wrong — the same reason `BetaForm` is one.
 *
 * One component, used by both figures, so the two instruments cannot end up
 * explaining themselves in two different shapes.
 */
export function FigureNote({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  // showModal()/close() are imperative by design; mirroring React state onto
  // them is the supported way to drive a <dialog>.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="fignote-open"
        onClick={() => setOpen(true)}
        aria-label={title}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.4" />
          <path d="M8 7.3v4" />
          <path d="M8 4.7v0.1" />
        </svg>
      </button>

      <dialog
        ref={ref}
        className="fignote"
        aria-labelledby={`${id}-title`}
        // Escape and the backdrop both close it; React state stays the source
        // of truth so the caller never gets out of step with the element.
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === ref.current) setOpen(false);
        }}
      >
        <div className="fignote-body">
          <h2 id={`${id}-title`}>{title}</h2>
          {children}
          <button type="button" className="fignote-close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
