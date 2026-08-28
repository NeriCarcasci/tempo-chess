/**
 * Forma's marks.
 *
 * Drawn from Streamline's **Plump Color** set (CC BY 4.0, commercial use
 * allowed, credited on `/brand` and in NOTICE). Plump is built on a 48 grid
 * with chunky rounded forms, which is the register this product wanted and
 * the one three hand-rolled attempts failed to reach: hairline geometry has
 * no mass at the size a mark actually appears, and a solid silhouette with
 * no interior has no character.
 *
 * ## Why these survive contact with the brand
 *
 * Every icon in the set ships exactly two hardcoded tones. They are rewritten
 * here as `--mark-wash` and `--mark-ink`, so a mark is two tints of **one**
 * hue rather than two new colours: DESIGN.md allows the accent and a semantic
 * result to carry colour, and a tint of the accent is still the accent. The
 * same mark can therefore run accent where it is live and ink where it is
 * only labelling, without shipping a second set.
 *
 * ## Choosing them
 *
 * A mark has to be *correct*, not merely available. The book is what chess
 * calls opening theory; the compass is the middlegame, where you are out of
 * the book and navigating without one; the flag is the finish. The pawn this
 * set ships is deliberately unused: it is the weakest drawing in the family,
 * and the board's own Cburnett pieces are the product's piece artwork
 * anyway.
 */

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="plumpmark" aria-hidden="true">
      {children}
    </svg>
  );
}

/** The book: opening theory, and the openings sheet. */
export function MarkBook() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M24 1.516c-6.41 0-10.991.254-13.976.51c-3.297.281-5.791 2.858-6.032 6.135c-.24 3.267-.492 8.455-.492 15.855s.252 12.587.492 15.855c.24 3.276 2.735 5.853 6.032 6.135c2.985.255 7.567.51 13.976.51s10.991-.255 13.976-.51c3.297-.282 5.791-2.859 6.032-6.135c.24-3.268.492-8.456.492-15.855s-.252-12.588-.492-15.855c-.24-3.277-2.735-5.854-6.032-6.136c-2.985-.255-7.567-.51-13.976-.51"/><path fill="var(--mark-ink)" fillRule="evenodd" d="M22 10a2 2 0 1 0 0 4h12a2 2 0 1 0 0-4zm-2 11a2 2 0 0 1 2-2h6a2 2 0 1 1 0 4h-6a2 2 0 0 1-2-2" clipRule="evenodd"/><path fill="var(--mark-ink)" d="M14 1.755v44.52a121 121 0 0 1-3.976-.27c-3.297-.281-5.791-2.858-6.032-6.134c-.24-3.268-.492-8.456-.492-15.855s.252-12.588.492-15.856c.24-3.276 2.735-5.853 6.032-6.135c1.103-.094 2.425-.188 3.976-.27"/></g></Mark>
  );
}
/** The middlegame: out of the book, navigating without one. */
export function MarkCompass() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M46.745 6.383a4.364 4.364 0 0 0-5.13-5.11c-4.052.774-10.499 2.104-16.464 3.766c-2.981.83-5.872 1.751-8.297 2.738c-2.371.965-4.487 2.066-5.749 3.327s-2.362 3.378-3.327 5.75c-.986 2.424-1.908 5.315-2.738 8.296c-1.662 5.966-2.993 12.412-3.768 16.465a4.364 4.364 0 0 0 5.111 5.13c4.04-.756 10.457-2.061 16.413-3.717c2.975-.828 5.866-1.751 8.3-2.748c2.385-.978 4.512-2.096 5.8-3.385s2.407-3.415 3.384-5.8c.997-2.433 1.92-5.324 2.748-8.3c1.656-5.955 2.96-12.372 3.717-16.412"/><path fill="var(--mark-ink)" d="M31.5 24a7.5 7.5 0 1 1-15 0a7.5 7.5 0 0 1 15 0"/></g></Mark>
  );
}
/** The endgame: the finish, where the game is actually settled. */
export function MarkFlag() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M6 1.5A1.5 1.5 0 0 0 4.5 3v28.888a1.5 1.5 0 0 0 1.5 1.5c5.312 0 9.28.841 13.14 1.66c1.47.311 2.924.62 4.43.876c5.47.934 11.148 1.052 19.583-2.127c1.257-.474 2.284-1.547 2.544-2.985c.34-1.88.803-5.672.803-12.419c0-5-.254-8.377-.524-10.554c-.353-2.85-3.18-4.033-5.516-3.274c-7.143 2.32-11.945 1.616-16.807.309c-.928-.25-1.87-.526-2.836-.81C16.681 2.852 12.074 1.5 6 1.5"/><path fill="var(--mark-ink)" d="M1.5 24c0-12.738.127-18.19.179-19.9c.02-.65.291-1.838 1.513-2.304C3.664 1.616 4.258 1.5 5 1.5s1.336.116 1.808.296C8.03 2.262 8.3 3.45 8.32 4.1c.052 1.71.179 7.162.179 19.9s-.127 18.19-.18 19.9c-.019.65-.29 1.838-1.512 2.304c-.472.18-1.066.296-1.808.296s-1.336-.116-1.808-.296C1.97 45.738 1.7 44.55 1.68 43.9c-.053-1.71-.18-7.162-.18-19.9"/></g></Mark>
  );
}
/** A chance, and whether it was taken. Tactics and the drill queue. */
export function MarkTarget() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M1.5 24c0 12.426 10.074 22.5 22.5 22.5S46.5 36.426 46.5 24S36.426 1.5 24 1.5S1.5 11.574 1.5 24"/><path fill="var(--mark-ink)" fillRule="evenodd" d="M6 24c0-9.941 8.059-18 18-18s18 8.059 18 18s-8.059 18-18 18S6 33.941 6 24m31.858-2H36a2 2 0 1 0 0 4h1.858C36.981 32.131 32.131 36.981 26 37.858V36a2 2 0 1 0-4 0v1.858C15.869 36.981 11.019 32.131 10.142 26H12a2 2 0 1 0 0-4h-1.858c.877-6.131 5.727-10.981 11.858-11.858V12a2 2 0 1 0 4 0v-1.858c6.131.877 10.981 5.727 11.858 11.858" clipRule="evenodd"/><path fill="var(--mark-ink)" d="M19 24a2 2 0 0 0 2 2h1v1a2 2 0 1 0 4 0v-1h1a2 2 0 1 0 0-4h-1v-1a2 2 0 1 0-4 0v1h-1a2 2 0 0 0-2 2"/></g></Mark>
  );
}
/** Holding a position you are worse in. */
export function MarkShield() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M24 1.5c-9.787 0-15.06.707-17.823 1.334C3.81 3.37 2.463 5.36 2.212 7.498a108 108 0 0 0-.71 12.893c.055 9.622 5.145 18.618 13.713 23.154c1.534.812 3.091 1.541 4.56 2.07c1.451.523 2.912.885 4.225.885s2.774-.362 4.224-.885c1.47-.529 3.027-1.258 4.56-2.07c8.569-4.536 13.659-13.532 13.714-23.154l.002-.591c0-5.232-.401-9.66-.712-12.302c-.25-2.137-1.6-4.128-3.965-4.664C39.06 2.207 33.787 1.5 24 1.5"/><path fill="var(--mark-ink)" d="M24 8.5c-5.095 0-8.245.32-10.171.667c-2.41.435-3.77 2.434-3.98 4.573A73 73 0 0 0 9.5 20.8c0 5.81 2.823 11.156 7.53 14.522c1.135.812 2.336 1.585 3.484 2.16c1.11.557 2.34 1.018 3.486 1.018s2.377-.461 3.486-1.017c1.148-.576 2.349-1.35 3.484-2.161c4.707-3.366 7.53-8.712 7.53-14.522c0-2.848-.177-5.327-.348-7.06c-.211-2.139-1.571-4.138-3.98-4.573C32.244 8.82 29.094 8.5 24 8.5"/></g></Mark>
  );
}
/** A win you already had, and whether you collected it. */
export function MarkMedal() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M13.426 16.386a1.5 1.5 0 0 0 1.416-.145l.012-.005c.113-.045.416-.147 1.04-.26c1.249-.227 3.649-.476 8.106-.476s6.857.249 8.107.476c.623.113.926.215 1.04.26l.01.005A1.5 1.5 0 0 0 35.5 15V4.54c0-.958-.625-1.885-1.663-2.139C32.583 2.094 29.45 1.5 24 1.5s-8.583.594-9.837.901c-1.038.254-1.663 1.181-1.663 2.14V15a1.5 1.5 0 0 0 .926 1.386"/><path fill="var(--mark-ink)" fillRule="evenodd" d="M33.398 2.568a1.5 1.5 0 0 0-.938.852a97 97 0 0 1-1.4 3.132a170 170 0 0 1-3.917 7.9c-3.355 6.346-8.045 14.236-13.442 20.576a1.5 1.5 0 0 0 1.143 2.472h14a1.5 1.5 0 0 0 .996-.379c7.088-6.3 13.236-14.868 15.404-18.028c.81-1.181 1.021-2.735.379-4.115c-1.75-3.759-4.508-6.816-6.779-8.91c-1.305-1.203-2.693-2.367-4.19-3.33a1.5 1.5 0 0 0-1.256-.17" clipRule="evenodd"/><path fill="var(--mark-ink)" fillRule="evenodd" d="M14.602 2.568a1.5 1.5 0 0 1 .938.852a94 94 0 0 0 1.4 3.132a170 170 0 0 0 3.917 7.9c3.355 6.346 8.045 14.236 13.441 20.576a1.5 1.5 0 0 1-1.142 2.472h-14a1.5 1.5 0 0 1-.996-.379c-7.088-6.3-13.236-14.868-15.404-18.028c-.81-1.181-1.021-2.735-.378-4.115c1.749-3.759 4.507-6.816 6.778-8.91c1.305-1.203 2.693-2.367 4.19-3.33a1.5 1.5 0 0 1 1.256-.17" clipRule="evenodd"/><path fill="var(--mark-wash)" fillRule="evenodd" d="M11.5 34c0-6.904 5.596-12.5 12.5-12.5S36.5 27.096 36.5 34S30.904 46.5 24 46.5S11.5 40.904 11.5 34" clipRule="evenodd"/><path fill="var(--mark-ink)" fillRule="evenodd" d="m26.62 30.552l-1.51-2.913a1.25 1.25 0 0 0-2.22 0l-1.51 2.913l-3.22.634a1.25 1.25 0 0 0-.688 2.062l2.288 2.545l-.42 3.395a1.25 1.25 0 0 0 1.8 1.272L24 39.032l2.86 1.428a1.25 1.25 0 0 0 1.799-1.272l-.42-3.395l2.289-2.545a1.25 1.25 0 0 0-.688-2.062z" clipRule="evenodd"/></g></Mark>
  );
}
/** Everything measured. */
export function MarkChart() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-wash)" d="M1.5 39c0 1.966.073 3.326.169 4.27c.201 1.99 1.798 3.131 3.547 3.19A84 84 0 0 0 8 46.5c1.187 0 2.097-.017 2.784-.04c1.749-.059 3.346-1.2 3.547-3.19c.096-.944.169-2.304.169-4.27s-.073-3.326-.168-4.27c-.202-1.99-1.8-3.131-3.548-3.19A84 84 0 0 0 8 31.5a84 84 0 0 0-2.784.04c-1.749.059-3.346 1.2-3.547 3.19c-.096.944-.169 2.304-.169 4.27m32-7c0 5.686.132 8.914.264 10.726c.146 2.01 1.614 3.578 3.702 3.706c.664.04 1.497.068 2.534.068s1.87-.028 2.534-.068c2.088-.128 3.556-1.696 3.702-3.706c.132-1.812.264-5.04.264-10.726s-.132-8.914-.264-10.726c-.146-2.01-1.614-3.578-3.702-3.706A42 42 0 0 0 40 17.5c-1.037 0-1.87.028-2.534.068c-2.088.128-3.556 1.696-3.702 3.706c-.132 1.812-.264 5.04-.264 10.726m-16 4c0 3.411.099 5.564.212 6.917c.173 2.048 1.74 3.447 3.721 3.534c.664.029 1.506.049 2.567.049c1.06 0 1.903-.02 2.567-.05c1.98-.086 3.548-1.485 3.72-3.533c.114-1.353.213-3.506.213-6.917s-.099-5.564-.212-6.917c-.173-2.048-1.74-3.447-3.721-3.534A59 59 0 0 0 24 25.5c-1.06 0-1.903.02-2.567.05c-1.98.086-3.548 1.485-3.72 3.533c-.114 1.353-.213 3.506-.213 6.917"/><path fill="var(--mark-ink)" d="M42.171 1.525a33.2 33.2 0 0 0-7.795.63c-2.003.41-2.546 2.819-1.217 4.147l1.791 1.792c-.57.518-1.308 1.198-2.14 1.991c-1.939 1.847-4.43 4.342-6.565 6.879a.19.19 0 0 1-.152.06a.2.2 0 0 1-.073-.016a.1.1 0 0 1-.026-.023a97 97 0 0 0-3.381-4.472c-1.235-1.527-3.443-1.92-5.126-.779c-2.406 1.632-7.403 5.392-12.993 11.784q-.508.582-1.024 1.193a2 2 0 0 0 3.06 2.577q.49-.582.976-1.137c5.214-5.963 9.852-9.482 12.086-11.011a94 94 0 0 1 3.148 4.17c1.598 2.238 4.863 2.252 6.565.23c2-2.377 4.373-4.758 6.264-6.559a116 116 0 0 1 2.213-2.055l1.917 1.916c1.328 1.329 3.736.786 4.147-1.217c.697-3.396.69-6.38.63-7.795a2.4 2.4 0 0 0-2.305-2.305"/></g></Mark>
  );
}
/** Work still running: the read that has not finished. */
export function MarkClock() {
  return (
    <Mark><g fill="none" fillRule="evenodd" clipRule="evenodd"><path fill="var(--mark-wash)" d="M1.5 24C1.5 11.574 11.574 1.5 24 1.5S46.5 11.574 46.5 24S36.426 46.5 24 46.5S1.5 36.426 1.5 24"/><path fill="var(--mark-ink)" d="M24 40c8.837 0 16-7.163 16-16S32.837 8 24 8S8 15.163 8 24s7.163 16 16 16"/><path fill="var(--mark-wash)" d="M24 12.5a2.5 2.5 0 0 1 2.5 2.5v7.965l5.268 5.267a2.5 2.5 0 0 1-3.536 3.536l-6-6A2.5 2.5 0 0 1 21.5 24v-9a2.5 2.5 0 0 1 2.5-2.5"/></g></Mark>
  );
}
/** Looking at a game again. */
export function MarkEye() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-ink)" fillRule="evenodd" d="M24 0a2 2 0 0 1 2 2v7a2 2 0 1 1-4 0V2a2 2 0 0 1 2-2M10.5 3a2 2 0 0 1 2.732.732l3.5 6.062a2 2 0 0 1-3.464 2l-3.5-6.062A2 2 0 0 1 10.5 3m27 0a2 2 0 0 0-2.732.732l-3.5 6.062a2 2 0 0 0 3.464 2l3.5-6.062A2 2 0 0 0 37.5 3M.615 10.617a2 2 0 0 1 2.829 0l4.95 4.95a2 2 0 1 1-2.83 2.828l-4.949-4.95a2 2 0 0 1 0-2.828m46.77 0a2 2 0 0 0-2.828 0l-4.95 4.95a2 2 0 1 0 2.829 2.828l4.95-4.95a2 2 0 0 0 0-2.828Z" clipRule="evenodd"/><path fill="var(--mark-wash)" d="M24 7.5c-10.797 0-19.89 7.28-22.645 17.198a4.87 4.87 0 0 0 0 2.604C4.11 37.22 13.203 44.5 24 44.5c10.798 0 19.89-7.28 22.645-17.198a4.87 4.87 0 0 0 0-2.604C43.891 14.78 34.798 7.5 24 7.5"/><path fill="var(--mark-ink)" d="M15.5 26a8.5 8.5 0 1 1 17 0a8.5 8.5 0 0 1-17 0"/></g></Mark>
  );
}
/** A chance worth spotting, when the catalogue has no better mark. */
export function MarkIdea() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-ink)" d="M14.509 35.162a1.5 1.5 0 0 1 1.964-1.585h-.001l.015.004l.08.025q.115.035.358.099c.326.085.82.202 1.468.32c1.297.235 3.207.475 5.607.475s4.31-.24 5.607-.476a20 20 0 0 0 1.468-.319a11 11 0 0 0 .438-.124l.014-.004h.002a1.5 1.5 0 0 1 1.962 1.585l-.716 6.614c-.235 2.165-1.787 4.128-4.162 4.44c-1.19.156-2.74.284-4.613.284c-1.97 0-3.499-.142-4.622-.312c-2.067-.313-3.428-1.955-3.773-3.797c-.337-1.795-.801-4.506-1.096-7.23Z"/><path fill="var(--mark-wash)" fillRule="evenodd" d="M5.5 20C5.5 9.783 13.783 1.5 24 1.5S42.5 9.783 42.5 20c0 5.885-2.75 11.128-7.028 14.515a75 75 0 0 1-.526 1.788c-.47 1.534-1.775 2.709-3.452 2.884c-1.453.151-3.855.313-7.494.313c-3.64 0-6.041-.162-7.494-.313c-1.677-.175-2.981-1.35-3.452-2.884a75 75 0 0 1-.526-1.788C8.25 31.128 5.5 25.885 5.5 20" clipRule="evenodd"/><path fill="var(--mark-ink)" d="M24 11.5a7.5 7.5 0 0 1 7.5 7.5a2.5 2.5 0 0 0 5 0c0-6.904-5.596-12.5-12.5-12.5a2.5 2.5 0 0 0 0 5"/></g></Mark>
  );
}

/** The middlegame: the balance of the position, and which way it tips. */
export function MarkBalance() {
  return (
    <Mark><g fill="none"><path fill="var(--mark-ink)" fillRule="evenodd" d="M37.382 7.331a2 2 0 0 0-3.77 0l-.072.207l-.206.584a540 540 0 0 0-3.064 8.989c-1.721 5.207-3.646 11.346-4.239 14.522a2 2 0 0 0 3.933.734c.532-2.855 2.357-8.716 4.104-14c.5-1.512.988-2.961 1.43-4.258c.44 1.297.929 2.746 1.429 4.257c1.747 5.285 3.572 11.146 4.104 14a2 2 0 0 0 3.933-.733c-.593-3.176-2.518-9.315-4.24-14.522a538 538 0 0 0-3.063-8.99l-.206-.583zm-23 5a2 2 0 0 0-3.77 0l-.072.207l-.206.584A539 539 0 0 0 7.27 22.11c-1.72 5.208-3.646 11.347-4.239 14.523a2 2 0 0 0 3.933.734c.532-2.855 2.357-8.716 4.104-14c.5-1.512.988-2.961 1.43-4.258c.44 1.297.929 2.746 1.429 4.257c1.747 5.285 3.572 11.146 4.104 14a2 2 0 0 0 3.933-.733c-.593-3.176-2.518-9.315-4.24-14.522a538 538 0 0 0-3.063-8.99l-.206-.583z" clipRule="evenodd"/><path fill="var(--mark-wash)" d="M12.499 33.5c3.584 0 6.325.21 7.973.384c1.697.179 3.208 1.702 2.85 3.662c-.933 5.102-5.43 8.954-10.823 8.954s-9.89-3.852-10.823-8.954c-.359-1.96 1.153-3.483 2.85-3.662c1.647-.173 4.388-.384 7.973-.384m23-5c3.584 0 6.325.21 7.973.384c1.697.179 3.208 1.702 2.85 3.662c-.933 5.102-5.43 8.954-10.823 8.954s-9.89-3.852-10.823-8.954c-.359-1.96 1.153-3.483 2.85-3.662c1.647-.173 4.388-.384 7.973-.384"/><path fill="var(--mark-wash)" fillRule="evenodd" d="M21.498 4a2.5 2.5 0 0 1 5 0v2.905c7.869-1.737 11.72-2.523 13.26-2.827c.416-.082.952-.117 1.493.035a2.35 2.35 0 0 1 1.521 1.272q.186.395.3.899q.111.505.11.94c0 .792-.38 1.403-.837 1.798c-.426.368-.926.564-1.338.666c-1.71.425-6.325 1.538-16.316 3.764s-14.642 3.176-16.37 3.517c-.418.082-.953.117-1.495-.035a2.35 2.35 0 0 1-1.52-1.272a4.4 4.4 0 0 1-.3-.899a4.3 4.3 0 0 1-.11-.94a2.35 2.35 0 0 1 .837-1.798c.426-.367.925-.563 1.338-.666c1.598-.397 5.735-1.396 14.427-3.342z" clipRule="evenodd"/></g></Mark>
  );
}

/**
 * Which mark stands for a measured concept.
 *
 * Keyed on the catalogue's own category so a concept promoted after this
 * build ships still gets a mark rather than a blank. The fallback is the
 * idea, which is true of any chance worth measuring: something there to be
 * spotted.
 */
export function ConceptMark({ category }: { category: string | null }) {
  switch (category) {
    case "tactical":
      return <MarkTarget />;
    case "defensive":
      return <MarkShield />;
    case "conversion":
      return <MarkMedal />;
    case "opening":
      return <MarkBook />;
    default:
      return <MarkIdea />;
  }
}

/**
 * The three phases: the book, the balance, the finish.
 *
 * The middlegame was the compass for one revision. At ring size its needle
 * read as an eye, and a mark a reader has to decode is worse than no mark;
 * the balance is what a middlegame actually is, and a scale is unmistakable
 * at any size.
 */
export function PhaseMark({ phase }: { phase: string }) {
  switch (phase) {
    case "opening":
      return <MarkBook />;
    case "middlegame":
      return <MarkBalance />;
    default:
      return <MarkFlag />;
  }
}
