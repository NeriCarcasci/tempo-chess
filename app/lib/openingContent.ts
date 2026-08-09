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
  "Italian Game": {
    summary:
      "White develops the bishop to c4, eyeing f7 and preparing quick central play. It ranges from the quiet Giuoco Pianissimo to sharp Evans Gambit lines.",
    ideas: [
      "Fight for the centre with c3 and a later d4.",
      "Slow setups revolve around re-routing the knight via Nbd2-f1-g3.",
      "The bishop on c4 makes f7 a permanent target to keep in mind.",
    ],
    watchFor: "Don't grab the e-pawn or castle carelessly into Fried Liver and Fegatello tactics on f7.",
    notablePlayers: ["Magnus Carlsen", "Fabiano Caruana", "Giuoco Piano masters"],
  },
  "Ruy Lopez": {
    summary:
      "White pins pressure on the knight defending e5 with Bb5. A deeply strategic opening about the fight for the centre and the e-file.",
    ideas: [
      "The a4/Bc2 manoeuvres keep the light-squared bishop and prepare d4.",
      "Black chooses between the solid Closed lines and the sharper open or Berlin structures.",
      "Piece play often centres on the d5 and f5 breaks.",
    ],
    watchFor: "The tension on e5 and the b5 bishop can be released too early; keep the pin working for you.",
    notablePlayers: ["Garry Kasparov", "Anatoly Karpov", "Magnus Carlsen"],
  },
  "Petrov's Defense": {
    summary:
      "Black answers 1.e4 e5 2.Nf3 with Nf6, going straight for symmetry and solidity rather than defending e5.",
    ideas: [
      "Trade into safe, equal structures and neutralise White's initiative.",
      "Accurate move order matters: 3.Nxe5 d6 4.Nf3 Nxe4 is the main tabiya.",
      "Black aims for easy development and a sound, drawish position.",
    ],
    watchFor: "It's solid, not passive — a careless 3...Nxe4 before ...d6 loses material.",
    notablePlayers: ["Vladimir Kramnik", "Fabiano Caruana", "Boris Gelfand"],
  },
  "Philidor Defense": {
    summary:
      "Black supports e5 with d6, accepting a cramped but sturdy position and playing for a later break.",
    ideas: [
      "Complete development with ...Be7, ...O-O and look for ...c6 and ...d5.",
      "Avoid opening the centre while behind in development.",
      "The Hanham setup keeps the structure resilient.",
    ],
    watchFor: "The classic trap after an early ...exd4 and a loose king can lose quickly; keep the centre closed.",
    notablePlayers: ["Étienne Bacrot", "Antoaneta Stefanova", "Philidor himself"],
  },
  "Scandinavian Defense": {
    summary:
      "Black challenges e4 immediately with d5. After exd5 the queen recaptures and retreats, trading time for a clear structure.",
    ideas: [
      "Develop with ...c6, ...Bf5 or ...Bg4, and ...e6 for a solid Caro-like shape.",
      "The queen on a5 or d6 must find a safe home quickly.",
      "Black accepts slightly less space for an easy plan.",
    ],
    watchFor: "Don't let the early queen sortie cost tempi to Nc3 and d4 with gain of time.",
    notablePlayers: ["Magnus Carlsen", "Ian Nepomniachtchi", "Sergei Tiviakov"],
  },
  "Pirc Defense": {
    summary:
      "Black concedes the centre and fianchettoes with ...g6 and ...Bg7, planning to strike back with ...e5 or ...c5.",
    ideas: [
      "Let White build a big centre, then undermine it.",
      "The g7 bishop is the soul of the position; keep its diagonal open.",
      "Time the ...e5 or ...c5 break when White overextends.",
    ],
    watchFor: "Against the Austrian Attack (f4) a slow reaction can be steamrolled; counter in the centre in time.",
    notablePlayers: ["Alexander Beliavsky", "Veselin Topalov", "Hikaru Nakamura"],
  },
  "Modern Defense": {
    summary:
      "Black fianchettoes the king's bishop and stays flexible, inviting White to overextend before counterpunching.",
    ideas: [
      "Delay committing the knights to keep maximum flexibility.",
      "Pressure the centre with ...c5, ...e5, or ...a6 and ...b5 expansion.",
      "The g7 bishop and hypermodern counterplay define the plans.",
    ],
    watchFor: "Flexibility can tip into passivity; you must challenge White's centre before it rolls forward.",
    notablePlayers: ["Tiger Hillarp Persson", "Hikaru Nakamura", "Colin McNab"],
  },
  "Vienna Game": {
    summary:
      "White plays Nc3 before committing, keeping options between quiet development and the aggressive f4 gambit lines.",
    ideas: [
      "The f4 break can open lines quickly against an unprepared opponent.",
      "Bc4 setups renew pressure on f7 in Italian-like fashion.",
      "Flexibility lets White transpose into favourable structures.",
    ],
    watchFor: "The Vienna Gambit is double-edged; know the ...d5 counter-strike before pushing f4.",
    notablePlayers: ["Rudolf Spielmann", "Nigel Short", "Alexei Shirov"],
  },
  "English Opening": {
    summary:
      "White opens 1.c4, fighting for d5 from the flank and keeping a flexible, often reversed-Sicilian structure.",
    ideas: [
      "Fianchetto with g3 and Bg2 to pressure the long diagonal.",
      "Plans hinge on whether White plays d4, keeps a closed centre, or plays for a queenside majority.",
      "Transpositions into Queen's-pawn structures are common.",
    ],
    watchFor: "Move order is everything; a careless ...d5 or ...e5 can hand Black an easy equaliser.",
    notablePlayers: ["Garry Kasparov", "Magnus Carlsen", "Ulf Andersson"],
  },
  "Queen's Gambit Declined": {
    summary:
      "Black holds the centre with ...e6, accepting a slightly passive light-squared bishop for a rock-solid structure.",
    ideas: [
      "Solve the problem bishop with ...b6 and ...Bb7 or a timely ...dxc4 and ...c5.",
      "The minority attack and the ...c5/...e5 breaks define the middlegame.",
      "Trade into sound structures and outplay in the endgame.",
    ],
    watchFor: "Passivity is the danger; find the right freeing break rather than shuffling pieces.",
    notablePlayers: ["José Capablanca", "Anatoly Karpov", "Vladimir Kramnik"],
  },
  "Queen's Gambit": {
    summary:
      "White offers the c-pawn to deflect Black's d-pawn and build a strong centre — one of the oldest and most respected openings.",
    ideas: [
      "If Black takes on c4, White regains it with tempo and central control.",
      "Play for the d4-d5 break or a queenside minority attack.",
      "Sound development beats trying to hold the gambit pawn.",
    ],
    watchFor: "It's a temporary sacrifice, not a real one; don't overreach to win the pawn straight back.",
    notablePlayers: ["Garry Kasparov", "Magnus Carlsen", "Mikhail Botvinnik"],
  },
  "Slav Defense": {
    summary:
      "Black defends d5 with ...c6, keeping the light-squared bishop free — a resilient, flexible answer to the Queen's Gambit.",
    ideas: [
      "Develop the c8 bishop before playing ...e6 to avoid the QGD's problem piece.",
      "The ...dxc4 and ...b5 plan can grab space on the queenside.",
      "Solid structures with long-term counterplay.",
    ],
    watchFor: "Grabbing and holding the c4 pawn with ...b5 needs precise follow-up or it just loses time.",
    notablePlayers: ["Vladimir Kramnik", "Viswanathan Anand", "Wesley So"],
  },
  "Dutch Defense": {
    summary:
      "Black answers d4 with f5, grabbing kingside space and aiming for an attack, at the cost of some structural risk.",
    ideas: [
      "Choose a system: the Leningrad (…g6), Stonewall (…d5/…e6), or Classical (…e6/…d6).",
      "The e4 break and kingside piece play drive Black's attack.",
      "Control e4 and the f-file for active chances.",
    ],
    watchFor: "The early f5 weakens the king; beware sharp gambits like the Staunton (2.e4).",
    notablePlayers: ["Magnus Carlsen", "Hikaru Nakamura", "Simon Williams"],
  },
  "Benoni Defense": {
    summary:
      "Black concedes central space for dynamic piece play and a queenside pawn majority after ...c5 against d4.",
    ideas: [
      "The …b5 break and pressure down the long diagonal fuel counterplay.",
      "Accept a space disadvantage in return for active, unbalanced positions.",
      "The e5 and f5 squares are key battlegrounds.",
    ],
    watchFor: "If White's central pawns get rolling with e4-e5, passive play is quickly lost; stay active.",
    notablePlayers: ["Mikhail Tal", "Garry Kasparov", "Veselin Topalov"],
  },
  "London System": {
    summary:
      "White develops the bishop to f4 and builds a solid, low-theory setup that works against almost anything.",
    ideas: [
      "The Bf4/e3/Bd3/c3 setup is easy to play and hard to crack.",
      "Look for the e4 break or a kingside attack once developed.",
      "Trade the dark-squared bishops on Black's terms only when it helps.",
    ],
    watchFor: "It's solid but not toothless — an early ...c5 and ...Qb6 hits b2 and d4; know the response.",
    notablePlayers: ["Gata Kamsky", "Magnus Carlsen", "Richárd Rapport"],
  },
  "Four Knights Game": {
    summary:
      "Both sides develop symmetrically with all four knights out — classical, sound, and rich in subtle plans.",
    ideas: [
      "The d4 break or the Spanish-style Bb5 keep small pulls alive.",
      "Symmetry can be broken with a well-timed pin or pawn break.",
      "Sound development and small edges, not early fireworks.",
    ],
    watchFor: "Symmetrical doesn't mean drawn; the first side to break correctly gets the initiative.",
    notablePlayers: ["Boris Spassky", "Viswanathan Anand", "Sergey Karjakin"],
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
