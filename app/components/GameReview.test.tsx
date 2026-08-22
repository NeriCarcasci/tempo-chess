import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ConceptsAtMove } from "./GameReview";
import type { GameReview as GameReviewData } from "../lib/v1/types";

type ReviewEvent = GameReviewData["events"][number];

function concept(over: Partial<ReviewEvent["concepts"][number]> = {}) {
  return {
    slug: "critical_moment",
    displayName: "Positions that decide the game",
    definition: "The retained moves led to genuinely different games.",
    conceptVersionId: "version-id-never-rendered",
    versionNo: 2,
    role: "recognize",
    color: "white",
    detectorVersion: "detector-id-never-rendered",
    observed: true,
    success: true,
    score: null,
    censoredReason: null,
    opportunityPly: 4,
    responsePly: 4,
    difficulty: null,
    confidence: null,
    evidenceSourceKind: "engine" as const,
    evidenceItemId: "evidence-id-never-rendered",
    ...over,
  };
}

function event(concepts: ReviewEvent["concepts"]): ReviewEvent {
  return {
    eventType: "critical_moment",
    startPly: 4,
    focalPly: 4,
    endPly: 5,
    actorColor: "white",
    affectedColor: "white",
    completeness: "complete",
    confidence: null,
    facts: { criticality: 0.4, rank: 1, acceptable: true, acceptableMoveCount: 1 },
    concepts,
  };
}

describe("ConceptsAtMove", () => {
  test("one physical event stays one row when it carries two labels", () => {
    const { container } = render(
      <ConceptsAtMove
        absence={{ kind: "ready" }}
        events={[event([concept(), concept({ role: "execute", success: false })])]}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("missed")).toBeTruthy();
  });

  test("a censored label is textually set aside and never rendered as missed", () => {
    render(
      <ConceptsAtMove
        absence={{ kind: "ready" }}
        events={[event([concept({
          observed: false,
          success: null,
          responsePly: null,
          censoredReason: "opponent_resigned",
        })])]}
      />,
    );
    expect(screen.getByText("not asked")).toBeTruthy();
    expect(screen.queryByText("missed")).toBeNull();
    expect(screen.getByText(/opponent resigned/i)).toBeTruthy();
  });

  test("published empty and unavailable use different copy", () => {
    const { rerender } = render(<ConceptsAtMove absence={{ kind: "ready" }} events={[]} />);
    expect(screen.getByText(/nothing it names/i)).toBeTruthy();
    rerender(
      <ConceptsAtMove
        absence={{ kind: "absent", text: "That part of the review is unavailable." }}
        events={[]}
      />,
    );
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  test("database and detector identifiers are never printed", () => {
    render(<ConceptsAtMove absence={{ kind: "ready" }} events={[event([concept()])]} />);
    expect(screen.queryByText(/version-id-never-rendered/)).toBeNull();
    expect(screen.queryByText(/detector-id-never-rendered/)).toBeNull();
    expect(screen.queryByText(/evidence-id-never-rendered/)).toBeNull();
  });
});
