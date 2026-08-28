import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { peekSession, setActiveAccount, signOut } from "../lib/session";
import { Logo } from "./Logo";
import { LichessMark, ChessComMark } from "./PlatformMarks";
import {
  BOARD_THEMES,
  loadBoardTheme,
  saveBoardTheme,
  loadShowCoordinates,
  saveShowCoordinates,
} from "../lib/boardThemes";
import { PIECE_SETS, loadPieceSet, savePieceSet } from "../lib/pieceSets";
import { isMuted, setMuted, playSound } from "../lib/sounds";

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "nav-ico",
  "aria-hidden": true,
};

function HomeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function CapIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10 4 2.5 7.5 10 11l7.5-3.5z" />
      <path d="M5.5 9v3.5c0 1 2 2 4.5 2s4.5-1 4.5-2V9" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="4.5" cy="10" r="1.7" />
      <circle cx="15" cy="5" r="1.7" />
      <circle cx="15" cy="15" r="1.7" />
      <path d="M6.2 10 13.3 5.6M6.2 10l7.1 4.4" />
    </svg>
  );
}

/** Two moves crossing: the phase where the pieces are in contact. */
function ClashIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 16 16 4M12 4h4v4" />
      <path d="M16 16 4 4M8 4H4v4" />
    </svg>
  );
}

/** A target: the queue puts one position in front of you at a time. */
function TargetIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
      <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4" />
    </svg>
  );
}

/** A flag: the phase you are converting, not exploring. */
function FlagIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5.5 3v14" />
      <path d="M5.5 4.5h9l-2 3 2 3h-9z" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 6.5h14M3 13.5h14" />
      <circle cx="8" cy="6.5" r="2.1" fill="var(--color-surface)" />
      <circle cx="13" cy="13.5" r="2.1" fill="var(--color-surface)" />
    </svg>
  );
}

/** Small dropdown that closes on outside click or Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function SettingsMenu() {
  const { open, setOpen, ref } = useDropdown();
  const theme = loadBoardTheme();
  const pieces = loadPieceSet();
  const [muted, setMutedState] = useState(false);
  const [coords, setCoords] = useState(true);
  useEffect(() => {
    setMutedState(isMuted());
    setCoords(loadShowCoordinates());
  }, []);
  const toggleSound = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playSound("move");
  };
  const applyTheme = (id: string) => {
    saveBoardTheme(id);
    location.reload();
  };
  const applyPieces = (id: string) => {
    savePieceSet(id);
    location.reload();
  };
  return (
    <div className="nav-cluster" ref={ref}>
      <button
        type="button"
        className="nav-iconbtn"
        aria-label="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersIcon />
      </button>
      {open && (
        <div className="nav-menu">
          <div className="nav-menu-label">Board</div>
          {BOARD_THEMES.map((t) => (
            <button key={t.id} type="button" className={`nav-menu-item ${theme.id === t.id ? "is-active" : ""}`} onClick={() => applyTheme(t.id)}>
              <span className="swatch"><span style={{ background: t.light }} /><span style={{ background: t.dark }} /></span>
              {t.name}
              {theme.id === t.id && <span className="tick" aria-hidden="true">✓</span>}
            </button>
          ))}
          <div className="nav-menu-label">Pieces</div>
          {PIECE_SETS.map((s) => (
            <button key={s.id} type="button" className={`nav-menu-item ${pieces.id === s.id ? "is-active" : ""}`} onClick={() => applyPieces(s.id)}>
              <span className="glyph">
                <span style={{ color: s.whiteFill }}>{s.whiteGlyphs.n}</span>
                <span style={{ color: s.blackFill }}>{s.blackGlyphs.n}</span>
              </span>
              {s.name}
              {pieces.id === s.id && <span className="tick" aria-hidden="true">✓</span>}
            </button>
          ))}
          <div className="nav-menu-label">Sound</div>
          <button type="button" className={`nav-menu-item ${muted ? "" : "is-active"}`} onClick={toggleSound}>
            <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
            {muted ? "Muted" : "Move sounds on"}
            {!muted && <span className="tick" aria-hidden="true">✓</span>}
          </button>
          <div className="nav-menu-label">Display</div>
          <button
            type="button"
            className={`nav-menu-item ${coords ? "is-active" : ""}`}
            onClick={() => { saveShowCoordinates(!coords); location.reload(); }}
          >
            <span aria-hidden="true">#</span>
            Coordinates
            {coords && <span className="tick" aria-hidden="true">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { open, setOpen, ref } = useDropdown();
  const navigate = useNavigate();
  const session = peekSession();
  // Not `subject.displayLabel` in the middle: it is the constant "My games",
  // which is a name for the analysis and not for the person signed in.
  const name = session?.username || session?.email || "Guest";
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="nav-cluster" ref={ref}>
      <button
        type="button"
        className="nav-account"
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nav-avatar" aria-hidden="true">{initial}</span>
        <small>{name}</small>
      </button>
      {open && (
        <div className="nav-menu">
          <div className="nav-menu-head">
            <strong>{name}</strong>
            {session?.email ? <span>{session.email}</span> : <span>Signed in</span>}
          </div>

          {/* One sign-in can own several chess accounts — a Lichess and a
              Chess.com one, or two names on the same site. Every page reads the
              one ticked here. A full navigation rather than a client one,
              because the choice changes the answer of every loader on the
              page and this is a rare, deliberate action. */}
          {session && session.accounts.length > 1 ? (
            <>
              <div className="nav-menu-label">Chess accounts</div>
              {session.accounts.map((account) => {
                const active = account.id === session.activeAccount?.id;
                return (
                  <button
                    key={account.id}
                    type="button"
                    className={`nav-menu-item ${active ? "is-active" : ""}`}
                    onClick={() => {
                      if (active) return setOpen(false);
                      setActiveAccount(session.userId, account.id);
                      location.href = "/today";
                    }}
                  >
                    <span className="nav-menu-mark" aria-hidden="true">
                      {account.platform === "chesscom" ? <ChessComMark size={15} /> : <LichessMark size={15} />}
                    </span>
                    {account.username}
                    {active && <span className="tick" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </>
          ) : null}

          <div className="nav-menu-label">Study</div>
          <Link to="/lessons" className="nav-menu-item">
            Lessons
          </Link>

          <div className="nav-menu-label">Account</div>
          {/* The profile is where the examination's own numbers live, and
              `/account` is the repertoire, the drills and the bill. Two
              entries because they answer different questions; the profile goes
              first because it is the one nothing else on the product links to. */}
          <Link to="/profile" className="nav-menu-item">
            Everything Forma has measured
          </Link>
          <Link to="/account" className="nav-menu-item">
            Your account &amp; progress
          </Link>
          <Link to="/account/connect" className="nav-menu-item">
            Link another chess account
          </Link>
          <button
            type="button"
            className="nav-menu-item nav-signout"
            onClick={async () => {
              await signOut();
              navigate("/login");
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function TopNav({
  current,
  right,
  back,
}: {
  /**
   * `home` is Today. The primary nav is the three phases of a game plus the
   * queue that draws from all three; lessons moved into the account menu when
   * the phases took the bar, because it is a library rather than a phase.
   */
  current:
    | "home"
    | "openings"
    | "path"
    | "middlegame"
    | "endgame"
    | "practice"
    | "lessons"
    | "account"
    | "game";
  right?: React.ReactNode;
  /** A left-aligned "back to parent" control shown on sub-pages. */
  back?: { to: string; label: string };
}) {
  return (
    <header className="product-header">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          const m = document.querySelector("main");
          if (m) {
            m.setAttribute("tabindex", "-1");
            (m as HTMLElement).focus();
          }
        }}
      >
        Skip to content
      </a>
      <div>
        <div className="product-lead">
          {back ? (
            <Link to={back.to} className="product-back" prefetch="intent" aria-label={`Back to ${back.label}`}>
              <span aria-hidden="true">←</span>
              <span>{back.label}</span>
            </Link>
          ) : null}
          <Link to="/today" className="product-mark" prefetch="intent" aria-label="Forma, today">
            <Logo size={20} />
          </Link>
        </div>
        {/* Three tabs, and each one is a different tense: what is happening
            now, what to work through, what is due right now.

            It was five, and three of those were a third of a game each -
            which is not a thing anybody navigates to. Nobody decides to go
            and look at their middlegame. The three phases are three
            entrances on `/path` now, and Today's dials link straight to
            them. */}
        <nav className="product-tabs" aria-label="Primary navigation">
          <Link to="/today" prefetch="intent" aria-current={current === "home" ? "page" : undefined}>
            <HomeIcon /><span>Today</span>
          </Link>
          <Link
            to="/path"
            prefetch="intent"
            aria-current={
              current === "path" ||
              current === "openings" ||
              current === "middlegame" ||
              current === "endgame"
                ? "page"
                : undefined
            }
          >
            <ClashIcon /><span>Path</span>
          </Link>
          <Link to="/practice" prefetch="intent" aria-current={current === "practice" ? "page" : undefined}>
            <TargetIcon /><span>Practice</span>
          </Link>
        </nav>
        <div className="product-nav-actions">
          {right}
          <SettingsMenu />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
