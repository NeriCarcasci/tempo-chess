import type { RawLesson } from "../types";

export const scotchGame: RawLesson = {
  slug: "scotch-game",
  family: "Scotch Game",
  color: "white",
  title: "The Scotch Game",
  subtitle: "Open the centre early and let your pieces breathe",
  intro:
    "The Scotch strikes in the centre at once with 3.d4, trading a central pawn to open lines and plant a knight on the **strong d4 square**. Where the Italian and Ruy Lopez keep things closed and manoeuvre slowly, the Scotch gives White easy, active development and a clear plan — a practical weapon that sidesteps a mountain of memorised theory.",
  ideas: [
    "3.d4 opens the position immediately; the knight recaptures into a **dominant central post**.",
    "Meet …Bc5 with Be3 and c3 to **over-protect d4** and prepare a broad pawn centre.",
    "Finish with quick castling — White's freer pieces give a small but **lasting pull**.",
  ],
  moves: [
    { san: "e4", explain: "**Claim the centre** and open lines for the bishop and queen — the standard first step of every open game." },
    { san: "e5", explain: "Black stakes out **equal central space**. Both sides will now develop toward these contested squares." },
    { san: "Nf3", ask: "Develop and attack e5.", explain: "Nf3 develops and **hits the e5 pawn**, forcing Black to respond. Combining development with a threat is the most economical way to play the opening." },
    { san: "Nc6", explain: "Black defends e5 with a **developing move** — the model way to answer a threat." },
    { san: "d4", ask: "Strike in the centre before Black gets comfortable.", explain: "The **Scotch break**. White challenges e5 head-on; after the coming exchange the position opens and White's pieces flow out with tempo." },
    { san: "exd4", explain: "Black captures, since **ignoring the tension** would let White play dxe5 with a pleasant pull. White will recapture and centralise." },
    { san: "Nxd4", ask: "Recapture into the centre.", explain: "The knight recaptures and lands on the powerful **d4 outpost**, eyeing c6, e6, f5 and b5. This centralised knight is the heart of the Scotch." },
    { san: "Bc5", explain: "Black develops **with tempo**, attacking the d4 knight and daring White to move it. This is the sound Classical Scotch." },
    { san: "Be3", ask: "Defend the knight and develop at the same time.", explain: "Be3 **supports d4** and develops a piece. If Black ever takes on d4, White recaptures with the bishop and keeps a firm grip on the centre." },
    { san: "Qf6", explain: "Black **piles pressure onto d4** while eyeing f2 and discouraging White's Nf5 ideas. The queen is active, but it must eventually make way for the minor pieces." },
    { san: "c3", ask: "Build a wall around d4.", explain: "c3 gives the d4 knight a **pawn defender** and braces the centre for future expansion. White's position becomes rock-solid and hard to break down." },
    { san: "Nge7", explain: "Black brings the last knight out toward g6 and prepares to castle. Choosing the g8 knight (…Nge7, not …Nce7) keeps the c6 knight **pressuring d4**." },
    { san: "Bc4", ask: "Point the bishop at f7 and get ready to castle.", explain: "The bishop takes its most active diagonal, eyeing **f7** and clearing the last piece for kingside castling. White has developed smoothly with an easy, harmonious game." },
    { san: "O-O", explain: "Black **castles into safety** and connects the rooks. Both sides have steered through the opening with their kings tucked away." },
    { san: "O-O", explain: "White castles too, finishing development. The freer pieces and the **strong d4 knight** promise White a pleasant, slightly more comfortable middlegame." },
  ],
};
