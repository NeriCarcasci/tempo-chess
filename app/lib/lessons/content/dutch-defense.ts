import type { RawLesson } from "../types";

export const dutchDefense: RawLesson = {
  slug: "dutch-defense",
  family: "Dutch Defense",
  color: "black",
  title: "The Dutch Defense",
  subtitle: "Answer 1.d4 with an aggressive …f5",
  intro:
    "The Dutch meets 1.d4 with the bold …f5, **seizing the e4 square** and pointing Black's play at the kingside from move one. The Leningrad variation blends this aggression with a King's-Indian-style fianchetto, giving Black a fighting, unbalanced game with a clear plan: castle, prepare the …e5 break, and storm the enemy king.",
  ideas: [
    "…f5 **grips e4** and marks the kingside as your attacking zone.",
    "Fianchetto with …g6/…Bg7 (**the Leningrad**) to combine solidity with punch.",
    "Prepare the …e5 break, then **push the f-, g-, and h-pawns** at White's king.",
  ],
  moves: [
    { san: "d4", explain: "White opens with the queen's pawn, planning a slow, spatial game. The Dutch answers with **unusual aggression** right away." },
    { san: "f5", ask: "Seize the e4 square and signal kingside ambitions.", explain: "The move that names the opening. …f5 **clamps down on e4**, stops White's e-pawn from advancing, and stakes out the kingside as Black's zone of attack." },
    { san: "g3", explain: "White heads for a fianchetto to g2, the **critical test** of the Dutch — the bishop will contest the long light diagonal that …f5 slightly weakened." },
    { san: "Nf6", ask: "Develop toward the centre and reinforce e4.", explain: "A natural developing move that adds a **second guard to e4** and heads for the kingside. Black mirrors White's plan but with more central bite." },
    { san: "Bg2", explain: "White completes the fianchetto. The bishop eyes e4, d5, and the **long diagonal**, pressuring Black's centre from a distance." },
    { san: "g6", ask: "Choose the Leningrad setup.", explain: "This is the **Leningrad Dutch**: Black fianchettoes to g7, marrying a solid King's-Indian structure to the aggressive …f5. The g7-bishop and the f5-pawn form the backbone of Black's game." },
    { san: "Nf3", explain: "White develops and takes a **grip on e5**, a key central square. Both sides are building mirror fianchetto structures — the difference is Black's advanced f-pawn." },
    { san: "Bg7", explain: "The bishop takes the long diagonal, **aiming at d4** and the centre. Together with …f5, Black's forces point squarely at White's centre and king." },
    { san: "O-O", explain: "White castles, tucking the king safely behind the fianchetto and preparing to **expand in the centre** and on the queenside." },
    { san: "O-O", explain: "Black castles too. Both kings sit behind their fianchettoes, but Black's intent is unusual: the f-, g-, and h-pawns may later **storm forward** rather than stay home as a shield." },
    { san: "c4", explain: "White grabs **queenside space** and prepares Nc3, directing play at the centre and the c- and d-files. The two sides will attack on opposite wings." },
    { san: "d6", explain: "A quiet, flexible move that guards e5 and, crucially, prepares the central break …e5 — **the lever that opens the position** in Black's favour." },
    { san: "Nc3", explain: "White completes development and reinforces d5 and e4. The stage is set: White presses in the centre and on the queenside, **Black looks to the king**." },
    { san: "Qe8", explain: "A typical Leningrad regrouping. The queen clears d8 for a rook, guards the e-file, and can later swing to h5 or g6 to **feed the kingside attack** — all while preparing …e5." },
    { san: "b3", explain: "White prepares Bb2 to reinforce the long diagonal and the d4-pawn, **bracing the centre** before Black strikes." },
    { san: "e5", explain: "The **freeing break** Black has been building toward. …e5 challenges d4, activates the g7-bishop, and cracks the position open — exactly the sharp, double-edged game the Dutch is played for." },
  ],
};
