import type { RawLesson } from "../types";

export const ruyLopez: RawLesson = {
  slug: "ruy-lopez",
  family: "Ruy Lopez",
  color: "white",
  title: "The Ruy Lopez",
  subtitle: "The most respected way to fight for e5",
  intro:
    "The Ruy Lopez (or Spanish) puts **slow, lasting pressure** on Black's centre by attacking the knight that defends e5. Instead of grabbing material or aiming at f7, White develops smoothly, castles early, and keeps the option of the big d4 break. It has been the main battleground of 1.e4 e5 for two centuries because the pressure never really goes away — hence its nickname, the 'Spanish Torture'.",
  ideas: [
    "Bb5 attacks the **c6 knight** — the defender of e5 — rather than lunging at f7.",
    "After …a6/Ba4/…b5/Bb3 the bishop retreats but keeps eyeing **f7** and the a2–g8 diagonal.",
    "c3 **prepares d4**: White wants a broad centre while keeping the Spanish bishop alive.",
  ],
  moves: [
    { san: "e4", explain: "**Occupy the centre** and free the light-squared bishop and the queen. Every 1.e4 opening begins the fight for the central squares." },
    { san: "e5", explain: "Black claims an equal share of the centre. We are in the **Open Game**, where quick, purposeful development matters most." },
    { san: "Nf3", ask: "Develop a piece and put a question to e5.", explain: "Nf3 develops toward the centre and **attacks e5**, forcing Black to react rather than build freely. Attacking while developing is the most efficient way to open." },
    { san: "Nc6", explain: "Black defends e5 with a piece that also fights for d4. Meeting a threat with a **developing move** is the ideal answer." },
    { san: "Bb5", ask: "Attack the piece that holds e5 together.", explain: "The Spanish bishop. It pins nothing yet but pressures the **c6 knight**, the real defender of e5. Undermining a defender is subtler — and often stronger — than the direct Bc4." },
    { san: "a6", explain: "Black 'puts the question' to the bishop, gaining a little space and the future option of **breaking the pin** with …b5." },
    { san: "Ba4", ask: "Keep the pressure — don't trade just yet.", explain: "Retreating keeps the bishop trained on c6 and the long diagonal. Bxc6 is playable but hands Black the **bishop pair**, so White stays flexible for now." },
    { san: "Nf6", explain: "Black develops **with tempo**, hitting e4. Both sides race to finish development before committing to a concrete plan." },
    { san: "O-O", ask: "Safety first — get the king out of the centre.", explain: "White castles even though e4 looks loose. It isn't really: after …Nxe4 White regains the pawn with d4 or Re1, so **king safety** comes first." },
    { san: "Be7", explain: "A modest, solid square: the bishop **steps out of any pin**, supports the knight, and clears the way for Black to castle." },
    { san: "Re1", ask: "Reinforce the centre before Black frees themselves.", explain: "The rook **backs up e4** and takes the open e-file's stem. It also quietly renews the pressure on e5 as the tension in the centre builds." },
    { san: "b5", explain: "Black finally challenges the bishop and grabs **queenside space**. The pawn also prepares …Na5, trading off White's prized Spanish bishop." },
    { san: "Bb3", explain: "The bishop slides to b3, still glaring down the a2–g8 diagonal at **f7**. It stays active while safely tucked away from Black's advancing pawns." },
    { san: "d6", explain: "A small but essential move: it defends e5 for good and opens the c8 bishop. Black's position is solid, if a touch cramped — the classic **Closed Ruy**." },
    { san: "c3", explain: "The keystone of White's plan: c3 **prepares d4** to build a broad centre, and hands the bishop a retreat to c2 should Black ever play …Na5." },
    { san: "O-O", explain: "Black completes development and castles. Both sides are ready for the real Ruy Lopez middlegame: White **expands with d4**, while Black manoeuvres with …Na5, …c5 or …Nd7 to strike at the centre." },
  ],
};
