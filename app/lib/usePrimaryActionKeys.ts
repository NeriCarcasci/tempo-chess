import { useEffect } from "react";

/**
 * Keyboard flow for the drill/lesson side panel: Enter presses the primary action
 * (Start / Continue / Reveal / New line / Play again), R presses "Try again".
 * Bails when a control or field already has focus so it never hijacks activation.
 */
export function usePrimaryActionKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea, [contenteditable='true']")) return;
      if (e.key === "Enter") {
        const btn = document.querySelector<HTMLButtonElement>(".play-side .primary-button");
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      } else if (e.key === "r" || e.key === "R") {
        const btn = [...document.querySelectorAll<HTMLButtonElement>(".play-side button")].find((b) =>
          /try again/i.test(b.textContent || ""),
        );
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
