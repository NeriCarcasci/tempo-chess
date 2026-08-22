export const CONTINUATION_RATINGS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400] as const;
export type ContinuationRating = (typeof CONTINUATION_RATINGS)[number];

export function isContinuationRating(value: number): value is ContinuationRating {
  return (CONTINUATION_RATINGS as readonly number[]).includes(value);
}
