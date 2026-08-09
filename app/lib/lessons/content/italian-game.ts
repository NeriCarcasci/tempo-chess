import type { RawLesson } from "../types";

export const italianGame: RawLesson = {
  slug: "italian-game",
  family: "Italian Game",
  color: "white",
  title: "The Italian Game",
  subtitle: "Fast development and an early eye on f7",
  intro:
    "The Italian is one of the oldest and most natural openings: you develop your knight and bishop toward the centre, point the bishop at Black's weakest square (**f7**), and castle quickly. It teaches the core opening principles better than almost any other line.",
  ideas: [
    "Develop **knights before bishops**, then castle early.",
    "The bishop on c4 eyes **f7** — Black's only square defended just by the king.",
    "With c3 and d4 (or a slow d3), White builds a **strong pawn centre**.",
  ],
  moves: [
    { san: "e4", explain: "Stake a claim in the centre and open lines for the bishop and queen. **Controlling the centre** is the first job of the opening." },
    { san: "e5", explain: "Black mirrors, fighting for the same central squares. This is the **Open Game** — both sides will develop quickly." },
    { san: "Nf3", ask: "Develop a piece and attack something.", explain: "Nf3 develops toward the centre and immediately **attacks the e5 pawn**, so Black must respond rather than do as they please." },
    { san: "Nc6", explain: "Black defends e5 with a **developing move** — the ideal way to meet a threat, solving a problem and improving a piece at once." },
    { san: "Bc4", ask: "Aim your bishop at Black's weakest point.", explain: "The Italian bishop. It targets **f7**, the square only the king defends, and takes an active diagonal before Black can play …d5 to blunt it." },
    { san: "Bc5", explain: "Black copies the idea, aiming at White's f2. This is the **Giuoco Piano** — the 'quiet game' — where small central plans matter more than early tactics." },
    { san: "c3", ask: "Prepare the big central break.", explain: "c3 supports a **future d4**, when White can build a broad pawn centre. It also opens a retreat square (c2) for the bishop if Black plays …Na5." },
    { san: "Nf6", explain: "Black develops the knight and **pressures e4**. Every piece Black brings out now defends and attacks at the same time." },
    { san: "d3", explain: "A solid choice: it defends e4, opens the dark-squared bishop, and **keeps the tension low**. The immediate d4 is sharper; d3 keeps a safe, strategic game." },
    { san: "d6", explain: "Black mirrors again, giving the bishop on c5 a retreat and **defending e5**. Both sides now have a sound, flexible set-up." },
    { san: "O-O", ask: "Get your king to safety.", explain: "Castling tucks the king away and connects the rooks. Do this early — a **king stuck in the centre** is the most common cause of opening disasters." },
    { san: "O-O", explain: "Black castles too. Both kings are safe, development is nearly done, and the middlegame plans — an eventual **d4 break** for White, …d5 or queenside play for Black — can begin." },
  ],
};
