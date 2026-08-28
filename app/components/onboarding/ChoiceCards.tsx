import { RookMark } from "../Logo";

/**
 * A question asked as cards rather than as a row of radio pills.
 *
 * Onboarding is the one place in the product where somebody is being asked
 * something rather than shown something, and the control it used was a strip of
 * small pills — the cheapest possible rendering of a choice, and one that gives
 * a reader no way to tell what each option actually means before picking it.
 *
 * A card has room for the consequence, which is the thing that makes a choice
 * answerable. Everything else about it is the same key edge the rest of the
 * product presses with, at the depth an object this size needs.
 *
 * ## The suggestion tab
 *
 * An option may be marked as the one Forma suggests, and it renders as a tab
 * notched over the card's top edge. It is deliberately awkward to use: `why`
 * is required alongside `suggested`, because a confident recommendation with
 * no reason under it is the one move that would contradict everything else
 * this product does. If there is no honest reason to prefer an option, it does
 * not get the tab.
 *
 * Nothing here pre-selects. The suggestion is visible and the choice is still
 * the reader's to make, which is the difference between a recommendation and a
 * default somebody has to notice and undo.
 */
export interface Choice<T extends string> {
  value: T;
  /** The option itself. Set in the numeral face when it is a quantity. */
  label: string;
  /** What picking it means. Four or five words, never a sentence. */
  detail?: string;
  /** A mark for the option, when it has one of its own. */
  mark?: React.ReactNode;
  /** Forma's suggestion. Requires `why`, which is shown on the card. */
  suggested?: { why: string };
  /** Set when the option is offered but cannot be taken yet. */
  caveat?: string;
}

export function ChoiceCards<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
  numeric = false,
}: {
  legend: string;
  /** The radio group's name. One per question on a screen. */
  name: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  /** Sets the label in the numeral face, for options that are quantities. */
  numeric?: boolean;
}) {
  return (
    <fieldset className={`choicecards${numeric ? " is-numeric" : ""}`}>
      <legend>{legend}</legend>
      {choices.map((choice) => {
        const checked = value === choice.value;
        return (
          <label
            key={choice.value}
            className={`choicecard${checked ? " is-on" : ""}${choice.suggested ? " has-tab" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={checked}
              onChange={() => onChange(choice.value)}
            />
            {choice.suggested ? (
              <span className="choicecard-tab">
                <RookMark size={13} />
                Forma suggests
              </span>
            ) : null}

            <span className="choicecard-copy">
              <span className="choicecard-label">
                {choice.mark ? (
                  <span className="choicecard-mark" aria-hidden="true">
                    {choice.mark}
                  </span>
                ) : null}
                {choice.label}
              </span>
              {choice.detail ? <small>{choice.detail}</small> : null}
              {/* The reason lives on the card, always, not in a tooltip and not
                  only when the option is selected. A suggestion a reader has to
                  hover to interrogate is not a suggestion. */}
              {choice.suggested ? <em>{choice.suggested.why}</em> : null}
            </span>

            {/* The same disc the dials use, at the size of a control. */}
            <span className="choicecard-dot" aria-hidden="true" />
          </label>
        );
      })}
    </fieldset>
  );
}
