import type { RawLesson } from "../types";

export const kingsIndianDefense: RawLesson = {
  slug: "kings-indian-defense",
  family: "King's Indian Defense",
  color: "black",
  title: "The King's Indian Defense",
  subtitle: "Give up the centre, then tear it down",
  intro:
    "The King's Indian is the great **counter-attacking defence**. Black lets White build a big pawn centre without a fight, fianchettoes the dark-squared bishop, and castles — then blows the centre open with …e5 and hunts the enemy king. It is uncompromising, double-edged, and one of the best openings for learning how to attack with pawns.",
  ideas: [
    "Let White build the centre, then **strike back** with …e5 (or …c5).",
    "The g7-bishop plus a …f5–…f4–…g5 **pawn storm** aim straight at White's king.",
    "When the centre locks with d5, race on **opposite wings** — your target is the king.",
  ],
  moves: [
    { san: "d4", explain: "White **grabs the centre** with the queen's pawn, the calm, space-gaining start to a closed game. Black will not challenge this head-on." },
    { san: "Nf6", ask: "Develop and pressure the centre from a distance.", explain: "The hypermodern signature: instead of occupying the centre, Black **attacks it from the side**. The knight eyes e4 and heads toward a kingside castle." },
    { san: "c4", explain: "White claims even more space with the c-pawn, a Queen's-Gambit-style grip. A broad centre looks great — the King's Indian is a bet that it can be **turned into a target**." },
    { san: "g6", ask: "Prepare a home for your best bishop.", explain: "Black prepares to **fianchetto** the dark-squared bishop to g7, where it will rake the long a1–h8 diagonal and press against White's centre for the whole game." },
    { san: "Nc3", explain: "White develops the knight and **defends e4** in advance, completing the broad c4–d4–e4 centre that defines the main lines." },
    { san: "Bg7", ask: "Complete the fianchetto.", explain: "The King's Indian bishop takes its diagonal. It looks quiet behind the g-pawn, but **the moment the centre opens** it becomes one of the strongest pieces on the board." },
    { san: "e4", explain: "White finishes the ideal pawn centre. Black has deliberately allowed this — the plan is to **let White overextend**, then hit back with …e5 or …c5." },
    { san: "d6", ask: "Support the coming …e5 break.", explain: "A modest but essential move: it **stakes a share of the centre**, frees the c8-bishop, and above all prepares the freeing …e5 thrust." },
    { san: "Nf3", explain: "White develops naturally and guards e5, discouraging Black's break for the moment. This is the **Classical Variation**, the main road of the King's Indian." },
    { san: "O-O", ask: "Tuck the king away before the fight begins.", explain: "Black castles behind the fianchetto — the **safest king shelter** in chess. With the king secure, Black is free to hurl the kingside pawns forward later." },
    { san: "Be2", explain: "A calm, solid developing move; the bishop supports White's setup and finishes the kingside. White will look to **expand on the queenside** with c5 and b4." },
    { san: "e5", explain: "The **thematic strike**. Black challenges the centre directly; if White locks it with d5 the game becomes a race — White attacks on the queenside, Black storms the king." },
    { san: "O-O", explain: "White castles too. Material is level and the position is balanced, but the plans point in **opposite directions** — that clash is what makes the King's Indian so combative." },
    { san: "Nc6", explain: "Black develops **with tempo**, pressing d4 and daring White to advance. After the natural d5 the knight will reroute toward the kingside, where the attack is coming." },
    { san: "d5", explain: "White accepts the challenge, gains space, and **locks the centre**. Now the pawn chains point in opposite directions and both sides know exactly where to attack." },
    { san: "Ne7", explain: "The knight steps back to swing to g6 or f5 and join the …f5–…f4–…g5 pawn storm aimed at White's king. This is the **Mar del Plata**, the beating heart of the King's Indian." },
  ],
};
