import { compileAll } from "./compile";
import type { CompiledLesson, RawLesson } from "./types";
import { italianGame } from "./content/italian-game";
import { ruyLopez } from "./content/ruy-lopez";
import { scotchGame } from "./content/scotch-game";
import { viennaGame } from "./content/vienna-game";
import { londonSystem } from "./content/london-system";
import { queensGambit } from "./content/queens-gambit";
import { sicilianDefense } from "./content/sicilian-defense";
import { frenchDefense } from "./content/french-defense";
import { caroKannDefense } from "./content/caro-kann-defense";
import { kingsIndianDefense } from "./content/kings-indian-defense";
import { dutchDefense } from "./content/dutch-defense";
import { queensGambitDeclined } from "./content/queens-gambit-declined";
import { scandinavianDefense } from "./content/scandinavian-defense";

// Raw lessons are authored per-file under ./content and compiled (validated) once.
// Order here is the display order in the lessons index (White first, then Black).
const RAW: RawLesson[] = [
  italianGame,
  ruyLopez,
  scotchGame,
  viennaGame,
  londonSystem,
  queensGambit,
  sicilianDefense,
  frenchDefense,
  caroKannDefense,
  kingsIndianDefense,
  dutchDefense,
  queensGambitDeclined,
  scandinavianDefense,
];

export const LESSONS: CompiledLesson[] = compileAll(RAW);

export function getLesson(slug: string): CompiledLesson | null {
  return LESSONS.find((l) => l.slug === slug) ?? null;
}

export function lessonsForColor(color: "white" | "black"): CompiledLesson[] {
  return LESSONS.filter((l) => l.color === color);
}

export function lessonForFamily(family: string, color: "white" | "black"): CompiledLesson | null {
  return LESSONS.find((l) => l.family === family && l.color === color) ?? null;
}
