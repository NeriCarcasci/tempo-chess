import type { RawLesson } from "../types";

export const caroKannDefense: RawLesson = {
  slug: "caro-kann-defense",
  family: "Caro-Kann Defense",
  color: "black",
  title: "The Caro-Kann Defense",
  subtitle: "Solid structure and a bishop that breathes",
  intro:
    "The Caro-Kann answers 1.e4 with the same central idea as the French — …d5 — but prepares it with …c6 instead of …e6. That one difference is everything: the light-squared bishop can **leave the pawn chain** to an active post before …e6 shuts it in. The result is a rock-solid, low-risk defence prized for its long-term soundness.",
  ideas: [
    "Play …c6 and …d5, then develop the light-squared bishop OUTSIDE the chain to f5/g6 before …e6 — solving the French's **bad-bishop problem** before it starts.",
    "Accept a slightly passive but **weakness-free structure**; the Caro trades early activity for long-term soundness and a safe king.",
    "The …h6/…Bh7 manoeuvre keeps that **good bishop** alive; then …e6, …Nd7 and …Ngf6 complete a harmonious set-up.",
  ],
  moves: [
    { san: "e4", explain: "White **claims the centre** — the standard opening move." },
    { san: "c6", ask: "Prepare …d5 while keeping the c8-bishop's diagonal open.", explain: "The Caro-Kann. Like the French, Black readies …d5; unlike the French, the **c6-pawn supports it**, so the light-squared bishop can still get out before the centre closes." },
    { san: "d4", explain: "White builds the **broad centre** Black intends to challenge." },
    { san: "d5", ask: "Challenge e4 immediately.", explain: "…d5 **strikes at the centre**. Black will resolve the tension and — crucially — get the light bishop developed before ever playing …e6." },
    { san: "Nc3", explain: "White defends e4 and develops, inviting the **central trade** of the Classical Caro-Kann." },
    { san: "dxe4", ask: "Trade in the centre.", explain: "Black removes White's e4-pawn, giving up the centre but gaining a **clean structure** with no weaknesses to defend. This is the main-line Classical Caro-Kann." },
    { san: "Nxe4", explain: "White recaptures with an **actively placed knight**, the natural continuation." },
    { san: "Bf5", ask: "Develop the bishop OUTSIDE the pawn chain.", explain: "The whole point of the Caro-Kann. Before …e6 ever locks it in, the light-squared bishop reaches an **active square** and hits the e4-knight — the 'good' bishop a French player only dreams of." },
    { san: "Ng3", explain: "White attacks the bishop, **gaining a tempo** and asking it to commit." },
    { san: "Bg6", ask: "Keep the bishop on its best diagonal.", explain: "The bishop sidesteps to g6, still eyeing the b1–h7 diagonal. Retreating to c8 or trading passively would **throw away the entire idea** of the line." },
    { san: "h4", explain: "White grabs **kingside space** and threatens h5, aiming to harass or trap the g6-bishop." },
    { san: "h6", ask: "Make a safe home for the bishop.", explain: "A small but essential **prophylactic move**. After a later h5, the bishop will need the h7-square to retreat to; …h6 prepares exactly that and avoids getting the bishop entombed." },
    { san: "Nf3", explain: "White develops and prepares Bd3 and castling — a standard, **harmonious set-up**." },
    { san: "Nd7", ask: "Develop toward the centre and keep f6 free.", explain: "The queen's knight comes to d7 first, so the other knight can later reach f6 **without allowing Nxf6**, which would wreck Black's kingside pawns. Flexible and precise." },
    { san: "h5", explain: "White chases the bishop **with tempo**, claiming still more space on the kingside." },
    { san: "Bh7", explain: "The bishop calmly steps back to h7, exactly as …h6 prepared. It is briefly passive but perfectly safe, and Black's **rock-solid structure** — with …e6, …Ngf6 and …Bd6 to follow — guarantees a sound, resilient middlegame." },
  ],
};
