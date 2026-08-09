import type { RawLesson } from "../types";

export const queensGambit: RawLesson = {
  slug: "queens-gambit",
  family: "Queen's Gambit",
  color: "white",
  title: "The Queen's Gambit",
  subtitle: "Offer a pawn to dominate the centre — then take it back",
  intro:
    "The Queen's Gambit is **not a real sacrifice**: you offer the c-pawn to pull Black's d5-pawn off the centre, and you can always regain it. Against the solid Declined setup you develop smoothly with Nc3, Bg5, e3, Nf3 and Bd3, keep a grip on the centre, and prepare the classic minority attack down the c-file.",
  ideas: [
    "c4 lures the d5-pawn away from the centre; the pawn is only ever **a loan** you reclaim with Bxc4.",
    "Pin with Bg5 to remove a **defender of d5** and pressure Black's centre.",
    "Put a rook on c1 and prepare a **minority attack** (b4-b5) to create lasting queenside weaknesses.",
  ],
  moves: [
    { san: "d4", ask: "Claim the centre with a queen's-pawn move.", explain: "Open the queen's pawn, taking **central space** and freeing the c1-bishop's diagonal." },
    { san: "d5", explain: "Black meets it head-on, staking a **symmetric claim** in the centre." },
    { san: "c4", ask: "Offer a wing pawn to challenge Black's centre.", explain: "The Queen's Gambit. You offer the c-pawn to **deflect Black's d5-pawn** — it is not a true sacrifice, because the pawn can always be won back." },
    { san: "e6", explain: "Black declines and reinforces d5. The catch: the c8-bishop is now boxed in behind the pawn chain — Black's long-term **problem piece**." },
    { san: "Nc3", ask: "Develop a knight and pressure d5.", explain: "Develop with purpose, adding a **second attacker to d5** and preparing to lean on Black's centre." },
    { san: "Nf6", explain: "Black develops and **defends d5** a second time while contesting e4." },
    { san: "Bg5", ask: "Pin the knight that guards d5.", explain: "Pin the f6-knight to the queen. This undermines a **key defender of d5** and ramps up the pressure on Black's centre." },
    { san: "Be7", explain: "Black **breaks the pin** and prepares to castle — unhurried, solid play, the hallmark of the Declined." },
    { san: "e3", explain: "Modest but strong: it **solidifies d4** and opens the f1-bishop. White is content to develop soundly and lean on the extra central space." },
    { san: "O-O", explain: "Black **castles to safety**, completing kingside development." },
    { san: "Nf3", explain: "Develop the last minor piece, **controlling e5** and getting ready to castle. Every piece flows to a natural square." },
    { san: "Nbd7", explain: "Black develops flexibly, keeping the ...dxc4 and ...c5 breaks in reserve **without blocking the c-pawn**." },
    { san: "Rc1", explain: "Place the rook on the file it will come to own. This is the **launch pad** for the minority attack — a later b4-b5 to fracture Black's queenside." },
    { san: "dxc4", explain: "Black **releases the central tension**, capturing to open the game and give the light-squared bishop breathing room." },
    { san: "Bxc4", explain: "Regain the pawn with a **developing move** — the gambit was only ever a loan. The bishop lands on an active diagonal pointing at f7." },
    { san: "c5", explain: "Black **hits d4** to free the position (the Capablanca method). White keeps a slight space edge and easy play; the coming battle is over the hanging pawns and the open c-file." },
  ],
};
