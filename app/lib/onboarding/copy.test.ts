import { describe, expect, test } from "vitest";
import {
  FAILURE_COPY,
  FAILURE_REASONS,
  LIMITATIONS,
  LIMITATION_TEXT,
  SECTION_ORDER,
  entitlementName,
  limitationText,
  sortSections,
  waitLabel,
  workflowStageLabel,
} from "./copy";

/**
 * The copy maps, which fail by printing a slug at somebody.
 *
 * These are cheap tests guarding an expensive failure: `outside_calibrated_rating`
 * on screen is the kind of thing that ships, gets screenshotted, and is the
 * first impression of a product whose whole pitch is care.
 */

describe("limitations", () => {
  test("every limitation the server can send has a sentence", () => {
    expect(Object.keys(LIMITATION_TEXT).sort()).toEqual([...LIMITATIONS].sort());
  });

  test("an unknown limitation gets a sentence, not its slug", () => {
    const text = limitationText("something_invented_later");
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain("something_invented_later");
    expect(text).not.toContain("_");
  });

  test("no sentence is a bare slug", () => {
    for (const [slug, text] of Object.entries(LIMITATION_TEXT)) {
      expect(text, slug).not.toContain("_");
      expect(text.length, slug).toBeGreaterThan(20);
    }
  });
});

describe("failure", () => {
  test("every failure reason has its own sentence", () => {
    for (const reason of FAILURE_REASONS) {
      expect(FAILURE_COPY[reason], reason).toBeTruthy();
    }
    const titles = FAILURE_REASONS.map((reason) => FAILURE_COPY[reason].title);
    expect(new Set(titles).size, "two reasons share a title").toBe(titles.length);
  });

  test("no failure copy is the generic apology", () => {
    for (const reason of FAILURE_REASONS) {
      expect(FAILURE_COPY[reason].title.toLowerCase(), reason).not.toBe("something went wrong");
    }
  });

  test("only the reasons that can be retried offer a retry", () => {
    // Connecting a different account is not a retry of this journey, and
    // there is nothing to retry when no game could be read.
    expect(FAILURE_COPY.no_linked_account.retryable).toBe(false);
    expect(FAILURE_COPY.no_eligible_games.retryable).toBe(false);
    expect(FAILURE_COPY.provider_unavailable.retryable).toBe(true);
    expect(FAILURE_COPY.analysis_failed.retryable).toBe(true);
  });

  test("nothing blames the reader for having unreadable games", () => {
    const detail = FAILURE_COPY.no_eligible_games.detail.toLowerCase();
    expect(detail).not.toContain("you need to");
    expect(detail).not.toContain("invalid");
    expect(detail).toContain("not a judgement");
  });
});

describe("report sections", () => {
  test("sections read in the intended order, not the server's", () => {
    // What the API actually returns: ordered by section name.
    const alphabetical = ["constraints", "coverage", "headline", "strengths"];
    expect(sortSections(alphabetical)).toEqual([
      "headline",
      "coverage",
      "strengths",
      "constraints",
    ]);
  });

  test("coverage comes second, right after the headline", () => {
    const sorted = sortSections([...SECTION_ORDER].reverse());
    expect(sorted[0]).toBe("headline");
    expect(sorted[1]).toBe("coverage");
  });

  test("an unknown section is kept and put last rather than dropped", () => {
    const sorted = sortSections(["invented_section", "headline"]);
    expect(sorted).toEqual(["headline", "invented_section"]);
  });
});

describe("labels", () => {
  test("a wait uses the server's own sentence, only capitalised", () => {
    expect(waitLabel("importing your games")).toBe("Importing your games");
    expect(waitLabel("analysing your games")).toBe("Analysing your games");
  });

  test("a missing stage says nothing rather than inventing one", () => {
    expect(workflowStageLabel(null)).toBeNull();
  });

  test("an unknown task type is labelled, never printed raw", () => {
    const label = workflowStageLabel("some_new_task_type");
    expect(label).toBeTruthy();
    expect(label).not.toContain("_");
  });

  test("an unknown entitlement is named vaguely rather than as a key", () => {
    expect(entitlementName("plan_tier_7")).not.toContain("_");
  });
});
