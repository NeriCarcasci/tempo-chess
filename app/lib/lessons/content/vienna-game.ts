import type { RawLesson } from "../types";

export const viennaGame: RawLesson = {
  slug: "vienna-game",
  family: "Vienna Game",
  color: "white",
  title: "The Vienna Game",
  subtitle: "Develop the queenside knight first, then decide how to strike",
  intro:
    "The Vienna develops the queen's knight to c3 before committing the rest of the army, keeping the aggressive **f4 break** in reserve. In the quiet lines with Bc4 and d3 White builds a compact, flexible set-up that looks a lot like the Italian, but with extra control of the central light squares — solid, easy to learn, and rich in long-term plans.",
  ideas: [
    "2.Nc3 guards e4 and keeps the option of a later **f4 pawn storm**.",
    "Bc4 and d3 give a compact, Italian-style centre with a **well-defended e4**.",
    "Answer the …Bb4 pin with **Nge2** so you can recapture on c3 with a knight, not a pawn.",
  ],
  moves: [
    { san: "e4", explain: "**Seize the centre** and free the light-squared bishop and queen — the first move of the open games." },
    { san: "e5", explain: "Black answers symmetrically, **contesting the centre**. The battle for d4 and e5 is under way." },
    { san: "Nc3", ask: "Develop and guard your centre.", explain: "The Vienna move. The knight develops naturally, reinforces e4, and keeps the aggressive **f2–f4 break** available — unlike Nf3, which would block the f-pawn." },
    { san: "Nf6", explain: "Black develops and **counterattacks e4**. Mirroring White's most natural developing move keeps the game balanced." },
    { san: "Bc4", ask: "Take aim at f7.", explain: "The bishop grabs the active a2–g8 diagonal, eyeing **f7** — the square only the king defends. This is the Italian-flavoured, positional Vienna." },
    { san: "Nc6", explain: "Black develops the knight, defends e5, and prepares to contest the centre. Every piece comes out **with a purpose**." },
    { san: "d3", ask: "Cement your centre.", explain: "d3 **defends e4** for good and opens the dark-squared bishop. It keeps the structure compact and flexible instead of rushing an early break." },
    { san: "Bb4", explain: "Black **pins the c3 knight**. There is nothing to win on it, but the pin adds pressure to e4 by tying down its defender." },
    { san: "Nge2", ask: "Prepare to meet the pin without wrecking your pawns.", explain: "A key finesse: the knight develops to e2 so that if Black plays …Bxc3, White recaptures with the knight and **avoids doubled c-pawns**. It also clears the path to castle." },
    { san: "O-O", explain: "Black **tucks the king away** and connects the rooks. With the centre closed, completing development is the priority." },
    { san: "O-O", ask: "Get your own king to safety.", explain: "White castles as well. Both sides are **safely developed** and the slow-burn Vienna middlegame can begin." },
    { san: "d6", explain: "Black **solidifies e5** and opens the light-squared bishop. The pawn structure is now a symmetrical, resilient block." },
    { san: "a3", ask: "Put the question to the pinning bishop.", explain: "a3 challenges the b4 bishop, forcing a decision: retreat and keep the pin, or trade on c3. **Gaining a tempo** on an enemy piece is always welcome." },
    { san: "Bxc3", explain: "Black resolves the tension, trading the bishop for the knight. In return White will get the **bishop pair** — a long-term asset once the position opens up." },
    { san: "Nxc3", explain: "Recapturing with the knight (thanks to Nge2) keeps White's pawns healthy and re-establishes a guard on e4. White ends the opening with a compact centre and the **two bishops** — a small, pleasant edge." },
  ],
};
