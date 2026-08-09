import type { RawLesson } from "../types";

export const londonSystem: RawLesson = {
  slug: "london-system",
  family: "London System",
  color: "white",
  title: "The London System",
  subtitle: "A rock-solid setup you can aim for against almost anything",
  intro:
    "The London is a system rather than a memorised line: you develop the dark-squared bishop to f4 (**outside the pawn chain**), build the pawn pyramid c3-d4-e3, and follow with Nf3, Nbd2 and Bd3. It is safe, easy to play, and quietly aggressive — the bishop on the b8-h2 diagonal and a later Ne5 give White a natural kingside plan.",
  ideas: [
    "Get the dark-squared bishop out to f4 **before playing e3**, so it never gets trapped behind its own pawns.",
    "Build the **pyramid c3-d4-e3** — a centre that is almost impossible to break down.",
    "Aim the Bd3 (and a future Qc2) at **h7**, and jump a knight into e5 to start a kingside attack.",
  ],
  moves: [
    { san: "d4", ask: "Open with a central pawn.", explain: "Claim the centre and, just as importantly, open the diagonal for the dark-squared bishop — which will come to **f4**, the whole idea of the London." },
    { san: "d5", explain: "Black stakes an equal claim in the centre. Because the London is a setup, White will steer for the **same structure** whatever Black chooses." },
    { san: "Bf4", ask: "Develop your dark-squared bishop before you lock it in.", explain: "The London bishop. Getting it outside the pawn chain before playing e3 is the **key move-order point** — stuck behind e3 it would be a permanently bad piece." },
    { san: "Nf6", explain: "Black develops naturally and fights for the **e4 square**, the most principled way to meet a queen's-pawn opening." },
    { san: "e3", ask: "Support d4 and free your other bishop.", explain: "Now e3 is ideal: it **props up d4** and opens the light-squared bishop, and the dark-squared bishop is already safely developed outside the chain." },
    { san: "e6", explain: "Black mirrors, opening the f8-bishop. A solid, **symmetrical structure** takes shape." },
    { san: "Nf3", ask: "Develop a knight and head for castling.", explain: "The knight goes to its best square, **controlling e5** and preparing to castle. Notice how each London move is quick and low-maintenance." },
    { san: "Bd6", explain: "Black offers to **trade dark-squared bishops**, challenging White's well-placed piece on f4." },
    { san: "Bg3", explain: "**Sidestep the trade** — this bishop is the pride of White's position. From g3 it still eyes the b8-h2 diagonal and the black kingside." },
    { san: "O-O", explain: "Black **castles into safety** and connects the rooks." },
    { san: "Bd3", explain: "Complete the classic London setup. The bishop on d3, backed by a later Qc2, forms a **battery** aimed straight at h7 — the seed of a kingside attack." },
    { san: "c5", explain: "Black strikes at the **base of White's chain**, the standard way to challenge the d4-e3 structure." },
    { san: "c3", explain: "Reinforce d4 and finish the pyramid c3-d4-e3. This **rock-solid centre** is exactly what makes the London so hard to break down." },
    { san: "Nc6", explain: "Black develops and **piles pressure on d4**, the tension point of the whole position." },
    { san: "Nbd2", explain: "Finish developing. The knight supports a future e4 break and clears the way for the thematic **Ne5 jump**, supported by the d4-pawn." },
    { san: "b6", explain: "Black prepares ...Bb7 to **contest e4** and the long diagonal. Both sides are set up: White will castle and look for Ne5, while Black breaks with ...cxd4 or expands on the queenside." },
  ],
};
