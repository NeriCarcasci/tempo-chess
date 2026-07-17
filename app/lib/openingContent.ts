export interface OpeningLesson {
  summary: string;
  ideas: string[];
  watchFor: string;
  notablePlayers: string[];
}

const LESSONS: Record<string, OpeningLesson> = {
  "Sicilian Defense": {
    summary:
      "Black fights for the centre from the flank with …c5, creating an unbalanced game where both sides usually have active chances.",
    ideas: [
      "White often uses a lead in development and kingside space.",
      "Black looks for pressure on the c-file and breaks with …d5 or …b5.",
      "Move order matters: an early d4 usually changes the game into an Open Sicilian.",
    ],
    watchFor: "Do not copy plans between Sicilian systems—the pawn structure decides the plan.",
    notablePlayers: ["Garry Kasparov", "Bobby Fischer", "Judit Polgár"],
  },
  "Scotch Game": {
    summary:
      "White challenges Black’s e5 pawn immediately with d4, opening the centre and asking both sides to develop accurately.",
    ideas: [
      "Use the open files and quick development before making extra pawn moves.",
      "The d4 exchanges can leave White with freer pieces but an exposed e4 pawn.",
      "Black’s …Bc5 and …Nf6 setups attack the centre in different ways.",
    ],
    watchFor: "Recaptures on d4 are not interchangeable; check development, queen exposure, and tactics on e4.",
    notablePlayers: ["Garry Kasparov", "Ian Nepomniachtchi", "Alexei Shirov"],
  },
  "French Defense": {
    summary:
      "Black supports a later …d5 with …e6. The locked centre often creates a race between White’s kingside space and Black’s queenside counterplay.",
    ideas: [
      "Identify the pawn-chain base before choosing a pawn break.",
      "Black commonly challenges the centre with …c5 and sometimes …f6.",
      "White’s space is useful only when the pieces can support it.",
    ],
    watchFor: "The light-squared bishop is a strategic problem for Black, but solving it must not lose time or pawns.",
    notablePlayers: ["Viktor Korchnoi", "Mikhail Botvinnik", "Alexander Morozevich"],
  },
  "Caro-Kann Defense": {
    summary:
      "Black prepares …d5 with …c6, aiming for a sound centre while usually developing the light-squared bishop outside the pawn chain.",
    ideas: [
      "Black accepts slightly less space in return for a durable structure.",
      "White chooses between maintaining space, exchanging, or creating an isolated queen’s pawn.",
      "Endgames can favour Black if the opening pressure is neutralised.",
    ],
    watchFor: "Solid does not mean passive—Black must challenge White’s centre at the right moment.",
    notablePlayers: ["Anatoly Karpov", "Vassily Ivanchuk", "Alireza Firouzja"],
  },
  "Queen's Pawn Game": {
    summary:
      "White begins with d4 and builds around central space, often delaying the exact pawn structure until the next few moves.",
    ideas: [
      "Develop behind the d4 pawn while watching the c- and e-pawn breaks.",
      "The opening name becomes more specific only after both sides reveal their structure.",
      "Piece placement should match the intended centre, not a memorised setup.",
    ],
    watchFor: "Avoid locking in a bishop before deciding whether the centre calls for e3, c4, or e4.",
    notablePlayers: ["Vladimir Kramnik", "Magnus Carlsen", "José Capablanca"],
  },
};

const FALLBACK: OpeningLesson = {
  summary:
    "This workspace follows the positions from your own games. The opening name becomes more precise as the move order reveals the pawn structure.",
  ideas: [
    "Compare the moves you repeat with the alternatives your opponents choose.",
    "Treat one-game branches as examples, not established habits.",
    "Use the board when the pawn structure is easier to understand visually.",
  ],
  watchFor: "A branch is evidence only from the games that reached it, not from your entire history.",
  notablePlayers: [],
};

export function openingLesson(family: string): OpeningLesson {
  return LESSONS[family] ?? FALLBACK;
}

export function openingSlug(family: string): string {
  return family
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
