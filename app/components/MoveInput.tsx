import { useState } from "react";
import { Chess } from "chess.js";

const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);

/**
 * A keyboard path for making moves: type SAN ("Nf3", "exd5", "O-O") or UCI
 * ("g1f3") and press Enter. Resolves the move against the current FEN with
 * chess.js, then hands 0-63 from/to squares to the same onMove the board uses —
 * so keyboard-only users can play, and the page handles correct/wrong feedback.
 */
export function MoveInput({
  fen,
  onMove,
  disabled,
}: {
  fen: string;
  onMove: (from: number, to: number) => boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    let move: { from: string; to: string } | null = null;
    try {
      move = new Chess(fen).move(text);
    } catch {
      /* not SAN — try UCI below */
    }
    if (!move) {
      const uci = text.replace(/[^a-h1-8qrbnQRBN]/g, "").toLowerCase();
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
        try {
          move = new Chess(fen).move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            promotion: (uci[4] as "q" | "r" | "b" | "n") || undefined,
          });
        } catch {
          move = null;
        }
      }
    }
    if (!move) {
      setError("Not a legal move here.");
      return;
    }
    setError("");
    setValue("");
    onMove(sqFromAlg(move.from), sqFromAlg(move.to));
  };

  return (
    <form className="move-input" onSubmit={submit}>
      <input
        type="text"
        className="move-input-field"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        placeholder="Type a move (e.g. Nf3)"
        aria-label="Type your move in algebraic notation"
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button type="submit" className="secondary-button" disabled={disabled}>Play</button>
      {error ? <span className="move-input-err" role="alert">{error}</span> : null}
    </form>
  );
}
