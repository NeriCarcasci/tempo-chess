import type { RawLesson } from "../types";

export const scandinavianDefense: RawLesson = {
  slug: "scandinavian-defense",
  family: "Scandinavian Defense",
  color: "black",
  title: "The Scandinavian Defense",
  subtitle: "Challenge the centre on move one",
  intro:
    "The Scandinavian challenges White's centre **on the very first move** with 1…d5. After the exchange Black recaptures with the queen, calmly reroutes it to safety, and develops with easy, natural moves. It is one of the most solid, low-maintenance answers to 1.e4 — you reach the same sound structure in almost every game.",
  ideas: [
    "Meet 1.e4 with 1…d5, an **immediate strike at the centre**.",
    "After …Qxd5–Qa5 the queen sits **safely and actively**, out of the way of White's tempi.",
    "Develop simply: …Nf6, …c6, …Bf5 (**bishop outside the chain**), …e6, then castle.",
  ],
  moves: [
    { san: "e4", explain: "White opens the king's pawn, freeing the queen and bishop. The Scandinavian answers with the **most direct reply** in chess — an immediate challenge to the centre." },
    { san: "d5", ask: "Strike at White's centre at once.", explain: "Black **attacks e4 head-on** before developing anything else. This is the Scandinavian's calling card: no slow manoeuvring, just an instant fight for the centre." },
    { san: "exd5", explain: "White captures, the critical test. Declining with 3.e5 or 3.Nc3 is possible, but taking **wins the centre pawn** and asks Black to spend time recapturing." },
    { san: "Qxd5", ask: "Recapture and centralise.", explain: "Black **regains the pawn** immediately with the queen. It sits actively in the centre, though it must be ready to move again the moment it is attacked." },
    { san: "Nc3", explain: "White **develops with tempo**, hitting the queen. This is what White wants — but the tempo costs less than it looks, because the knight also blocks White's own c-pawn." },
    { san: "Qa5", ask: "Retreat to a safe, active square.", explain: "The **classical retreat**. From a5 the queen stays active on the e1–a5 diagonal, supports a later …Bb4 or queenside play, and sidesteps further harassment." },
    { san: "d4", explain: "White builds the **ideal broad centre**, gaining space and opening lines for the pieces. Black will not try to demolish it at once but will develop soundly around it." },
    { san: "Nf6", explain: "A natural developing move that **controls e4 and d5** and prepares to castle. Black's setup is simple and solid — every piece goes to a sensible square." },
    { san: "Nf3", explain: "White develops the kingside knight toward a quick castle, covering e5 and d4. Both sides are simply following **classical development principles**." },
    { san: "c6", explain: "A quiet, multi-purpose move: it gives the queen a **bolt-hole on c7**, controls d5 and b5, and prepares …Bf5 and …e6 without shutting in the light-squared bishop." },
    { san: "Bc4", explain: "White develops actively toward **f7** and the a2–g8 diagonal and prepares to castle. Rapid, natural development is White's entire plan here." },
    { san: "Bf5", explain: "The point of playing …c6 first: the light-squared bishop develops **outside the pawn chain** to an active post before …e6 would lock it in. This is the modern Scandinavian's key idea." },
    { san: "Bd2", explain: "White connects the pieces and prepares **queenside castling** and Nd5 ideas, keeping an eye on Black's queen on a5." },
    { san: "e6", explain: "Now …e6 gives the position a **rock-solid structure**. Black is ready to finish developing with …Bb4, …Nbd7, and castling, with a resilient, easy-to-play game against White's bigger centre." },
  ],
};
