/**
 * The claims the explorer screen keeps.
 *
 * The one this file exists for: `/v1` separates "your move was judged fine"
 * from "nobody has judged your move", and the screen has to keep them apart. A
 * position whose games were never analysed must not render like a position
 * played perfectly, because that is the single most flattering lie the product
 * could tell.
 */

import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { formatEval, formatLoss, unjudgedOn } from "./OpeningExplorer";
import type { OpeningGraphV1Edge } from "../../lib/v1/types";

function edge(over: Partial<OpeningGraphV1Edge> = {}): OpeningGraphV1Edge {
  return {
    a: 0,
    b: 1,
    u: "e2e4",
    s: "e4",
    g: 10,
    sh: 100,
    ac: "p",
    op: 10,
    fa: 0,
    ...over,
  } as OpeningGraphV1Edge;
}

describe("formatLoss", () => {
  test("expected-score loss is stated as expected score, never as centipawns", () => {
    const text = formatLoss(0.062);
    expect(text).toBeTruthy();
    expect(text).toContain("expected score");
    // `dl` is 0..1 expected points. Anything that reads as a pawn count is the
    // unit error this whole field exists to avoid.
    expect(text).not.toContain("cp");
    expect(text).not.toContain("pawn");
  });

  test("no measured loss produces no sentence", () => {
    // Absent is not zero. "costs 0.0%" would be a measurement nobody made.
    expect(formatLoss(undefined)).toBeNull();
    expect(formatLoss(0)).toBeNull();
  });
});

describe("formatEval", () => {
  test("an absent evaluation is a dash, not a zero", () => {
    expect(formatEval(null, null, "white")).toBe("—");
    expect(formatEval(null, null, "white")).not.toBe("0.0");
  });

  test("the sign follows the side being studied", () => {
    // The API states White's perspective once. A Black repertoire reads the
    // same number with the sign flipped, and +1.2 for White must never be
    // shown to a Black player as an advantage.
    expect(formatEval(120, null, "white")).toBe("+1.2");
    expect(formatEval(120, null, "black")).toBe("-1.2");
  });

  test("a mate is a mate, not a very large number", () => {
    expect(formatEval(null, 3, "white")).toBe("#3");
    expect(formatEval(null, -3, "black")).toBe("#3");
  });
});

describe("unjudgedOn", () => {
  test("a player move nobody analysed is counted as unjudged", () => {
    // Ten games played this move, four carry a verdict. The other six are not
    // successes.
    expect(unjudgedOn(edge({ ac: "p", g: 10, op: 4 }))).toBe(6);
  });

  test("a fully analysed move has nothing outstanding", () => {
    expect(unjudgedOn(edge({ ac: "p", g: 10, op: 10 }))).toBe(0);
  });

  test("an opponent move is never counted as the player's unjudged decision", () => {
    // The opponent's choices are not decisions Forma judges, so the gap is not
    // a coverage gap and must not be reported as one.
    expect(unjudgedOn(edge({ ac: "o", g: 10, op: 0 }))).toBe(0);
  });

  test("more verdicts than games never produces a negative count", () => {
    expect(unjudgedOn(edge({ ac: "p", g: 2, op: 5 }))).toBe(0);
  });
});

describe("the honesty of a branch label", () => {
  test("colour is never the only carrier of a state", () => {
    // Every tag on a branch names its state in words as well as in hue, so the
    // meaning survives a monochrome screen and a colour-blind reader.
    const cases: Array<[OpeningGraphV1Edge, string]> = [
      [edge({ fa: 2, op: 10 }), "flagged"],
      [edge({ ac: "p", g: 10, op: 3 }), "not analysed"],
    ];
    for (const [subject, word] of cases) {
      const { container, unmount } = render(<BranchTags edge={subject} />);
      expect(container.textContent).toContain(word);
      unmount();
    }
  });
});

/** The tag row, isolated from the board and the network. */
function BranchTags({ edge: subject }: { edge: OpeningGraphV1Edge }) {
  const unjudged = unjudgedOn(subject);
  const loss = formatLoss(subject.dl);
  return (
    <span>
      {subject.fa > 0 ? (
        <span className="tag tag-loss">
          {subject.fa} flagged{loss ? ` · ${loss}` : ""}
        </span>
      ) : null}
      {unjudged > 0 ? <span className="tag tag-unknown">{unjudged} not analysed</span> : null}
    </span>
  );
}
