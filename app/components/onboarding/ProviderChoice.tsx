import { ChessComMark, LichessMark } from "../PlatformMarks";
import { ChoiceCards } from "./ChoiceCards";

export type Provider = "lichess" | "chesscom";

/**
 * Which site the games come from.
 *
 * The Chess.com caveat is rendered here, inside the chooser, rather than after
 * a sync that never happens: Forma can link a Chess.com account but cannot read
 * its games yet, and the honest place to say so is before somebody picks it.
 *
 * Lichess carries the suggestion tab and Chess.com does not, and the reason on
 * the tab is the same fact the caveat states from the other side. That is the
 * only kind of recommendation this component is allowed to make — one whose
 * reason is a thing that is true about the product rather than a nudge.
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
      <ChoiceCards<Provider>
        legend="Where do you play?"
        name="platform"
        value={value}
        onChange={onChange}
        choices={[
          {
            value: "lichess",
            label: "Lichess",
            mark: <LichessMark size={18} />,
            suggested: { why: "The only archive Forma can read today." },
          },
          {
            value: "chesscom",
            label: "Chess.com",
            mark: <ChessComMark size={18} />,
            detail: "Connect now, read later",
          },
        ]}
      />

      {/* Inside a live region, so somebody who arrows onto Chess.com hears the
          caveat rather than only seeing it. */}
      <div aria-live="polite">
        {value === "chesscom" ? (
          <p className="tag-note" id="provider-caveat">
            Forma cannot read Chess.com games yet. Connecting now means it is ready when it
            can.
          </p>
        ) : null}
      </div>
    </>
  );
}
