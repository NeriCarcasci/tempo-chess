import type { RawLesson } from "../types";

export const frenchDefense: RawLesson = {
  slug: "french-defense",
  family: "French Defense",
  color: "black",
  title: "The French Defense",
  subtitle: "Build a pawn chain and break at its base",
  intro:
    "The French is a solid, strategic reply to 1.e4: Black challenges the centre with …e6 and …d5, accepting a little cramping in return for a rock-hard structure and clear long-term plans. The whole game revolves around the **locked pawn chain** — where it points, where it's weak, and how Black pries it open.",
  ideas: [
    "Attack the **base of White's pawn chain** (the d4-pawn) with …c5 — the queenside is where Black's play lives.",
    "…f6 is the **second lever**, striking the head of the chain on e5 to challenge White's space.",
    "With the dark-squared bishops traded, mind the **good-vs-bad bishop** battle: free Black's light bishop so it isn't buried behind …e6.",
  ],
  moves: [
    { san: "e4", explain: "White **claims the centre** and opens lines for the pieces — the standard opening move." },
    { san: "e6", ask: "Prepare …d5 with a supporting pawn.", explain: "…e6 clears the way for …d5 to challenge e4 next move. The trade-off is that it **blocks in the light-squared bishop**, which will need care later." },
    { san: "d4", explain: "White builds a **broad two-pawn centre**, exactly what Black intends to challenge." },
    { san: "d5", ask: "Strike at the centre at once.", explain: "…d5 **confronts e4 head-on** and defines the French. White must decide whether to trade, push, or defend — and that choice shapes the entire game." },
    { san: "Nc3", explain: "White defends e4 and develops, keeping the **central tension**. This is the main-line Classical French." },
    { san: "Nf6", ask: "Pile a second attacker onto e4.", explain: "…Nf6 develops naturally and **adds pressure to e4**, forcing White to resolve the centre rather than leave it hanging." },
    { san: "Bg5", explain: "White **pins the f6-knight** to the queen, adding indirect pressure on e4 and the d5-pawn." },
    { san: "Be7", ask: "Break the pin calmly.", explain: "…Be7 **unpins the knight** so it can move again, and prepares to castle. Sturdy and unhurried — Black is content to be a touch cramped but very solid." },
    { san: "e5", explain: "White gains space and **closes the centre**, forming the classic pawn chain (d4–e5) and kicking the f6-knight." },
    { san: "Nfd7", ask: "Retreat the right knight.", explain: "The f6-knight steps back to d7 — not the b8-knight — keeping the queenside knight's options open. From d7 it eyes the …c5 and …f6 breaks and supports the coming **pawn levers**." },
    { san: "Bxe7", explain: "White **trades the dark-squared bishops**. This eases Black's cramped position by removing a pair of pieces." },
    { san: "Qxe7", explain: "Black recaptures with the queen, which sits comfortably on e7 and clears d8 for a rook. With the dark bishops gone, Black's game is **easier to handle**." },
    { san: "f4", explain: "White reinforces the e5-spearhead and gains **kingside space**, the natural plan behind the pawn chain." },
    { san: "O-O", ask: "Castle into safety.", explain: "The king is snug on the kingside. Since Black will generate all the play on the **opposite wing**, the king sits well away from the coming action." },
    { san: "Nf3", explain: "White completes development, **defending d4** and preparing to castle." },
    { san: "c5", ask: "Hit the base of the chain.", explain: "The **thematic French break**. …c5 attacks d4, the foundation of White's pawn chain; once the tension opens, Black's rooks and queen pour down the half-open c-file and onto the queenside." },
  ],
};
