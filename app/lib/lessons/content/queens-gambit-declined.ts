import type { RawLesson } from "../types";

export const queensGambitDeclined: RawLesson = {
  slug: "queens-gambit-declined",
  family: "Queen's Gambit Declined",
  color: "black",
  title: "The Queen's Gambit Declined",
  subtitle: "Meet 1.d4 with a solid, unshakeable centre",
  intro:
    "The Queen's Gambit Declined is Black's most reliable answer to 1.d4: you support d5 with ...e6, develop calmly with ...Nf6, ...Be7 and ...Nbd7, and castle. The price is a hemmed-in light-squared bishop, so much of Black's plan is about **freeing it** — usually with a well-timed ...dxc4 followed by ...b5, ...c5, or ...Nd5.",
  ideas: [
    "Hold the centre with the ...e6, ...d5 (and often ...c6) **pawn triangle** — patient, resilient, hard to break.",
    "The c8-bishop is Black's **problem piece**; ...dxc4 opens its diagonal and often gains a tempo on White's bishop.",
    "Free the position **at the right moment** with ...c5 or ...Nd5 once you are fully developed and castled.",
  ],
  moves: [
    { san: "d4", explain: "White claims the centre and opens the queen's bishop. You'll answer with a **solid, classical setup**." },
    { san: "d5", ask: "Contest the centre head-on.", explain: "**Answer in the centre**, staking your own claim. Refusing to concede the middle is the foundation of the Queen's Gambit Declined." },
    { san: "c4", explain: "The Queen's Gambit — White offers the c-pawn to **deflect your d5-pawn** and seize central control." },
    { san: "e6", ask: "Reinforce d5, even at the cost of boxing in a bishop.", explain: "Decline the gambit and **prop up d5** with a pawn. The small cost is that your light-squared bishop is now hemmed in behind the chain — managing that bishop is Black's main strategic task." },
    { san: "Nc3", explain: "White develops and **adds pressure to d5**." },
    { san: "Nf6", ask: "Develop a knight and guard d5.", explain: "Develop and **defend d5** again while contesting e4 — one move doing several jobs at once." },
    { san: "Bg5", explain: "White **pins your knight** to the queen, leaning further on your central pawn." },
    { san: "Be7", ask: "Unpin the knight and ready your king to castle.", explain: "**Break the pin** calmly and prepare to castle. Patient, solid piece play is exactly the QGD's philosophy." },
    { san: "e3", explain: "White **solidifies d4** and opens the light-squared bishop — a modest, sound build-up." },
    { san: "O-O", explain: "**Tuck your king away** and connect the rooks before starting any active operations." },
    { san: "Nf3", explain: "White develops the **last knight** and prepares to castle." },
    { san: "Nbd7", explain: "Develop the knight to d7, **keeping the c-pawn free** for ...c6 or ...c5. Choosing d7 over c6 means you never block your own pawn breaks." },
    { san: "Rc1", explain: "White eyes the c-file, preparing the classic **minority attack** with b4-b5 to weaken your queenside." },
    { san: "c6", explain: "Reinforce d5 a third time (the **Orthodox setup**). The pawn triangle e6-d5-c6 is tough to crack and keeps both the ...dxc4 and ...b5 ideas alive." },
    { san: "Bd3", explain: "White develops the bishop toward your king — and, crucially, now allows you to **release the central tension** with tempo." },
    { san: "dxc4", explain: "Capture toward the centre, hitting the d3-bishop with tempo and finally **opening the c8-bishop's diagonal**. After White recaptures Bxc4, ...b5 and ...c5 (or ...Nd5) complete your freeing plan and solve Black's problem piece." },
  ],
};
