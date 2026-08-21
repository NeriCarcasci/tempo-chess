import { useEffect, useId, useRef, useState } from "react";
import {
  PLATFORMS,
  RATINGS,
  submitBetaSignup,
  type BetaSignup,
  type Platform,
  type RatingBand,
} from "../lib/betaSignup";

/**
 * "Join beta testing" — five short answers in a modal.
 *
 * Built on a real <dialog> rather than a div with a high z-index, so the focus
 * trap, the Escape key, inert-ing the page behind it and the top layer all come
 * from the platform instead of from us getting them subtly wrong.
 *
 * The form is deliberately shorter than it wants to be. Every field past the
 * email address costs signups, so only name, email and platform are required;
 * rating is one tap, and the free-text question is optional and last. We can
 * ask anything else by replying to them.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type Status = "idle" | "sending" | "done";

export function BetaForm({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("lichess");
  const [rating, setRating] = useState<RatingBand>("1400-1800");
  const ids = useId();

  // showModal()/close() are imperative by design; mirroring React state onto
  // them is the supported way to drive a <dialog>.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  // Reset on the way out, so reopening is a fresh form rather than a stale
  // success screen. Runs on close, not on open, to avoid a flash of the empty
  // form over the top of the closing animation.
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setStatus("idle");
      setError(null);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    const data = new FormData(event.currentTarget);
    const payload: BetaSignup = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      platform,
      username: String(data.get("username") ?? "").trim(),
      ratingBand: rating,
      goal: String(data.get("goal") ?? "").trim(),
    };
    setStatus("sending");
    setError(null);
    try {
      await submitBetaSignup(payload);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("idle");
    }
  }

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={`${ids}-title`}
      // Escape and the backdrop both close it; React state stays the source of
      // truth so the parent never gets out of step with the element.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="sheet-body">
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {status === "done" ? (
          <div className="sheet-done" role="status">
            <span className="sheet-tick" aria-hidden="true">
              ✓
            </span>
            <h2 id={`${ids}-title`}>You are on the list.</h2>
            <p>
              We read every one of these. When there is a slot we will email you
              from a real address, and you can reply to it.
            </p>
            <button type="button" className="primary-button btn-lg" onClick={onClose}>
              Back to the site
            </button>
          </div>
        ) : (
          <form className="sheet-form" onSubmit={onSubmit}>
            <h2 id={`${ids}-title`}>Join beta testing</h2>
            <p className="sheet-lede">
              Four questions, about thirty seconds. We use the answers to decide
              who to let in next, so the honest ones help most.
            </p>

            <div className="field-row">
              <label className="field">
                <span>Name</span>
                <input name="name" required maxLength={80} autoComplete="name" />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={160}
                  autoComplete="email"
                  inputMode="email"
                />
              </label>
            </div>

            <fieldset className="field choice-set">
              <legend>Where do you play?</legend>
              <div className="choices">
                {PLATFORMS.map((option) => (
                  <label
                    key={option.value}
                    className={`choice ${platform === option.value ? "is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="platform"
                      value={option.value}
                      checked={platform === option.value}
                      onChange={() => setPlatform(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="field choice-set">
              <legend>Roughly what rating?</legend>
              <div className="choices">
                {RATINGS.map((option) => (
                  <label
                    key={option.value}
                    className={`choice ${rating === option.value ? "is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="rating"
                      value={option.value}
                      checked={rating === option.value}
                      onChange={() => setRating(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="field-row">
              <label className="field">
                <span>
                  Your username <i>optional</i>
                </span>
                <input name="username" maxLength={60} autoComplete="off" />
              </label>
              <label className="field">
                <span>
                  What keeps going wrong? <i>optional</i>
                </span>
                <input name="goal" maxLength={400} autoComplete="off" />
              </label>
            </div>

            {error ? (
              <p className="sheet-error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="primary-button btn-lg sheet-submit"
              disabled={status === "sending"}
            >
              {status === "sending" ? "Sending…" : "Request a slot"}
            </button>
            <p className="sheet-fine">
              We email you about the beta and nothing else. No list, no partners.
            </p>
          </form>
        )}
      </div>
    </dialog>
  );
}
