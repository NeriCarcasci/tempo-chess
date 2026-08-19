import { ChessComMark, LichessMark } from "../PlatformMarks";

export type Provider = "lichess" | "chesscom";

/**
 * Which site the games come from.
 *
 * The Chess.com caveat is rendered here, inside the chooser, rather than after
 * a sync that never happens: Forma can link a Chess.com account but cannot read
 * its games yet, and the honest place to say so is before somebody picks it.
 *
 * `fieldset.auth-choice label` needs its element selector — app.css sets a
 * competing rule at equal specificity, and "simplifying" it silently loses the
 * styling.
 */
export function ProviderChoice({
  value,
  onChange,
}: {
  value: Provider;
  onChange: (value: Provider) => void;
}) {
  return (
    <>
      <fieldset className="auth-choice" aria-describedby={value === "chesscom" ? "provider-caveat" : undefined}>
        <legend>Where do you play?</legend>
        <label>
          <input
            type="radio"
            name="platform"
            value="lichess"
            checked={value === "lichess"}
            onChange={() => onChange("lichess")}
          />
          <LichessMark size={16} />
          Lichess
        </label>
        <label>
          <input
            type="radio"
            name="platform"
            value="chesscom"
            checked={value === "chesscom"}
            onChange={() => onChange("chesscom")}
          />
          <ChessComMark size={16} />
          Chess.com
        </label>
      </fieldset>
      {/* Inside a live region and referenced by the fieldset, so somebody who
          arrows onto Chess.com hears the caveat rather than only seeing it. */}
      <div aria-live="polite">
        {value === "chesscom" ? (
          <p className="tag-note" id="provider-caveat">
            Forma can connect a Chess.com account, but cannot read its games yet — only Lichess
            archives are supported so far. Connecting now means it is ready when they are.
          </p>
        ) : null}
      </div>
    </>
  );
}
