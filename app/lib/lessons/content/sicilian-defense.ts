import type { RawLesson } from "../types";

export const sicilianDefense: RawLesson = {
  slug: "sicilian-defense",
  family: "Sicilian Defense",
  color: "black",
  title: "The Sicilian Defense",
  subtitle: "Fight for the win with asymmetric counterplay",
  intro:
    "The Sicilian is Black's most ambitious answer to 1.e4. Instead of copying White with …e5, Black meets the centre from the side with …c5, creating an **unbalanced position** where both sides play for the full point. The Najdorf — with the flexible …a6 and a central strike …e5 — is its most respected weapon.",
  ideas: [
    "Trade your c-pawn for White's d-pawn to win a **half-open c-file** and a central pawn majority.",
    "The …a6/…e5 set-up grabs space, denies White's pieces the **b5 square**, and prepares …b5 expansion.",
    "Black's counterplay lives on the **queenside** — …b5, …Bb7, pressure down the c-file — while White races on the kingside.",
  ],
  moves: [
    { san: "e4", explain: "White **stakes out the centre** and frees the bishop and queen — the standard, principled first move." },
    { san: "c5", ask: "Fight for the centre from the flank.", explain: "The Sicilian. Rather than mirror with …e5, Black attacks the d4-square from the wing, steering the game into an unbalanced struggle where Black **plays for a win**, not just equality." },
    { san: "Nf3", explain: "White develops and prepares the **central break d4**, the move that opens the Open Sicilian." },
    { san: "d6", ask: "Control e5 and give your king's knight a home.", explain: "…d6 **covers the e5-square**, keeps the centre flexible, and clears the way for …Nf6 without allowing e4–e5. A quiet, purposeful Najdorf move." },
    { san: "d4", explain: "White **opens the centre** while slightly ahead in development — the defining decision of the Open Sicilian." },
    { san: "cxd4", ask: "Take — swap your wing pawn for a centre pawn.", explain: "Black trades the c-pawn for White's d-pawn, gaining a **central pawn majority** and, crucially, a half-open c-file that becomes the main highway for Black's counterplay." },
    { san: "Nxd4", explain: "White recaptures with a **centralised knight**. White has more space; Black has the healthier long-term structure." },
    { san: "Nf6", ask: "Develop and hit e4.", explain: "The knight develops **with tempo**, forcing White to defend e4 and settle for a set-up rather than attack freely." },
    { san: "Nc3", explain: "White defends e4 and develops, reaching the **main tabiya** of the Open Sicilian." },
    { san: "a6", ask: "Deny White's pieces the b5 square.", explain: "The **signature Najdorf move**. …a6 stops any knight or bishop landing on b5, and prepares …b5 to expand on the queenside and fianchetto the light bishop to b7." },
    { san: "Be2", explain: "A **calm, solid development** — White will castle and choose a plan without committing the bishop to a sharp square yet." },
    { san: "e5", ask: "Kick the knight and claim central space.", explain: "…e5 **seizes the centre** and drives the d4-knight back. It concedes the d5-square, but Black will contest d5 with pieces and generate active play on the wings — a favourable trade in the Najdorf." },
    { san: "Nb3", explain: "The knight retreats to b3, **keeping off passive squares** and eyeing a5 and c5." },
    { san: "Be7", ask: "Finish the kingside and prepare to castle.", explain: "A modest but flexible square: the bishop guards d8, covers c5, and **clears the path to safety**. Black's development is harmonious and nearly complete." },
    { san: "O-O", explain: "White tucks the king away and connects the rooks, ready to **expand on the kingside**." },
    { san: "O-O", explain: "Black castles too. Now the thematic middlegame begins — …b5, …Bb7 and …Nbd7 for **queenside pressure**, while both sides keep an eye on the d5 hole." },
  ],
};
