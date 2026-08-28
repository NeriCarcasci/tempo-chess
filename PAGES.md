# Forma client stats and page contract

Status: product direction

This document defines what the client should say with the player data Forma
already publishes. It does not define layout, components, colours, formulas, or
analysis thresholds.

## Product decision

Use three main destinations:

- **Today** — How am I doing, and what should I do next?
- **Patterns** — What keeps happening in my games?
- **Practice** — What should I work on now?

Do not make Opening, Middlegame, and Endgame three separate pages. They are
three parts of the same story and should be sections within Patterns. Separating
them makes the user hunt across pages to understand one game.

Opening can link to a deeper **Your lines** page. Forma has specific repertoire,
book, variation, and move-choice data for openings that it does not have for the
other phases. That makes it a genuine detail page rather than an arbitrary
fourth navigation item.

## The main player-facing stat

The shared unit is a **key moment**.

Use:

> You handled 98 of 129 key moments.

Avoid “chances not taken” as the main wording. It starts with failure and does
not describe defensive moments well. Avoid “opportunities capitalised” as the
universal wording because not every measured moment is an attacking
opportunity.

At the detailed level, use the natural verb for the pattern:

- “You took 18 of 24 pieces that were left available.”
- “You found the move that held 12 of 17 times.”
- “You converted 9 of 14 winning positions.”
- “You answered the fork threat 11 of 16 times.”

The client may simplify the language. It must not merge unrelated measurements
into a new overall chess score.

## What Forma knows about a player

### Phase performance

For Opening, Middlegame, and Endgame, Forma has:

- key moments seen;
- key moments handled;
- key moments set aside because the player never got the chance to respond;
- Forma's estimated success rate and likely range;
- how the recent period compares with the earlier period;
- how many games reached the phase;
- whether the result has enough evidence to present confidently.

This answers: **How often am I handling the important moments in this part of
the game?**

The three phase rates should not be presented as a strongest-to-weakest ranking.
Each phase contains a different mix of chess situations.

### Playing patterns

Forma measures these patterns:

- keeping pieces safe;
- taking what is offered;
- recognising positions that decide the game;
- following through in positions that decide the game;
- finding the move that held;
- converting a winning position;
- defending a worse position;
- creating and answering forks;
- creating and answering pins;
- creating and answering skewers;
- creating and answering discovered attacks;
- removing and protecting defenders;
- trapping and rescuing pieces with nowhere to go.

Some patterns have more than one job. The role must be shown because
“recognising a critical position” and “playing it correctly” are different
skills. The supported roles are:

- recognising the chance;
- following it through;
- responding to it;
- converting it.

For each pattern and role, Forma has the rate, likely range, evidence count,
successful and unsuccessful outcomes, set-aside moments, and movement over
time.

This answers: **What kind of situation do I repeatedly handle well or miss?**

### Findings

Forma publishes a small set of supported conclusions about strengths,
constraints, phase differences, changes over time, and gaps in the evidence.

Use a finding as a sentence the player can understand. Keep its explanation and
evidence attached. Do not turn a finding identifier into new copy or invent a
conclusion when Forma has held one back.

This answers: **What is the clearest thing Forma has learned about my chess?**

### Game trajectory

Forma knows whether the player's games tend to stay close or spread apart as
they move from the opening through the endgame, how many games support each
part, and how often games reach each phase.

Use it to describe where games tend to turn, separate, or lose ground. Do not
present it as a move-by-move evaluation or as proof that one phase is the
player's weakest skill.

This answers: **Where do my games usually change direction?**

### Opening behaviour

Forma knows:

- which opening families and variations the player reaches;
- how often they reach them;
- which moves they choose;
- which decisions were analysed;
- where mistakes occur;
- the average expected-score loss where available;
- whether moves remain in the book;
- the first departure from book;
- book continuations and the engine's preferred move where available.

Analysed and unanalysed decisions must stay separate. A line cannot be called
clean while some of its decisions have not been analysed.

This answers: **Which lines do I actually play, and where does my preparation
break down?**

### Practice

Forma knows what is due, what is overdue, what remains in the queue, why an item
was chosen, whether the latest answer succeeded, the expected continuation, and
when the item is due again.

Forma does not currently publish lifetime practice accuracy, XP, or a practice
streak. The client should not create them.

This answers: **What should I practise now?**

### Goals and ratings

Goals keep readiness, practice adherence, and real-game evidence separate. A
goal is complete only when Forma reports that its target has been achieved.

Ratings stay separated by provider and by the rating category the provider
reports. Never blend them into one Forma rating, and always name the source and
category beside the number.

## Circular progress charts

Use one circular reading for each phase, not one ring for the whole player.

Each phase reading contains:

- **Opening**, **Middlegame**, or **Endgame**;
- Forma's published estimated percentage of key moments handled;
- the plain count, such as “98 of 129”;
- the direction of movement: improving, slipping, or no clear change;
- a short evidence state when the reading is still early or limited.

The fill uses Forma's published estimated percentage. The plain count underneath
shows the actual handled and seen moments behind that estimate. Set-aside
moments are shown separately and do not count as handled or missed.

The phase rings are a summary and a way into Patterns. They are not levels, do
not add up to 100%, and must not be averaged into an overall ring.

If a phase has no publishable rate, show the reason in place of the percentage.
For example: “Only a few of your games reach the endgame.” Do not render an
empty phase as 0%.

## Achievements and feedback

The existing data supports **milestones**, not a large permanent badge system.

Use milestones for:

- a supported improvement in a specific pattern and role;
- a supported improvement in a phase;
- completing a goal.

A successful practice attempt gets immediate positive feedback, but it is not a
milestone and does not become a profile achievement.

Name the measured thing:

- “Taking what is offered is improving.”
- “Your endgame key moments are improving.”
- “Goal reached: convert winning positions.”

Do not award achievements for a high percentage alone. Pattern difficulty and
role differ, so the number is not a fair universal score. Do not create badges
for streaks, XP, perfect games, or lifetime totals until those are published as
real product data.

Movement milestones describe the current evidence. They should not become
permanent historical trophies unless Forma begins storing an achievement
history.

## Page contracts

### Today

**Answers:** How is my chess going, and what should I do next?

Show:

1. One supported summary from the trajectory or Forma's clearest finding.
2. One rating, labelled with its provider and rating category.
3. The three phase readings.
4. One next action: resume an examination, complete due practice, or inspect a
   real opening line that Forma has identified.
5. Up to three important movements, including improvements and declines.
6. The active goal, with real-game progress kept separate from practice
   activity.

Today is a summary. Every item should lead somewhere useful. It should not
contain the full concept catalogue, opening tree, or practice history.

### Patterns

**Answers:** What keeps happening in my games?

Use one page with these sections in order:

1. Opening
2. Middlegame
3. Endgame

Each section shows:

- the same phase reading used on Today;
- the leading recurring pattern and its role;
- the count of handled and missed moments;
- the most recent supported board example, when one exists;
- the remaining measured patterns;
- where misses cluster by move number, when Forma has that information;
- a clear limited-evidence or not-reached state when needed.

Patterns should lead with what affects the player most often, not necessarily
the lowest percentage. A board position must illustrate a real published
example, never a generated example.

The Opening section links to Your lines. Middlegame and Endgame do not need
matching subpages because the client has no equivalent line-level data for
them.

### Your lines

**Answers:** Which openings do I reach, what do I play, and where do they go
wrong?

Show White and Black separately. Within each side show opening families,
variations, games reaching the line, decisions analysed, mistakes among those
decisions, and decisions still unanalysed.

Opening lines are for browsing. The line suggested on Today is the one Forma has
already identified as the most useful place to start; the client should not
invent a different weakness from the same table.

When a line is opened, show its move path, the player's choices, book status,
departure point, published loss, and preferred continuation where available.

Use “No mistakes found” only when all decisions in the selected view were
analysed and none was marked as a mistake. Otherwise state how much remains
unanalysed.

### Practice

**Answers:** What should I work on now?

Lead with due and overdue work. Each item says what position it comes from and
why it was selected. After an attempt, show whether it worked, the expected
continuation, and when it returns.

Practice is an action surface. Do not turn queue size, repetition count, or time
spent into claims about chess improvement.

### Profile and report

**Answers:** What does Forma know about me, and what evidence supports it?

Profile is the current detailed record. It includes every phase reading, every measured
pattern and role, all supported movements and findings, the full trajectory,
coverage, ratings, recent source games, and publication information.

The report is a separate fixed snapshot opened or exported from Profile. It
captures a completed examination and should not mix in live practice state or
silently change after publication.

## Language and evidence rules

- Say **handled** for the universal positive outcome and **missed** for the
  universal negative outcome.
- Use the pattern's natural verb whenever possible.
- Say **key moments**, not attempts, puzzles, or games.
- A likely range stays available wherever Forma presents an estimated rate.
- A set-aside moment is neither success nor failure.
- An unanalysed opening decision is neither success nor failure.
- “No clear change” means Forma cannot yet call the direction, not that the
  player stayed exactly the same.
- “Not enough evidence” is a valid result and should not be replaced with a
  score.
- Show when the analysis was published and how many games support it wherever a
  claim could otherwise look current or universal.

## What the client must not create

- an overall chess score;
- a single player level;
- a combined rating;
- a strongest-to-weakest phase ranking;
- an opening mastery score;
- lifetime practice accuracy;
- XP or streaks;
- a permanent achievement history;
- a claim that unanalysed or set-aside moments were successful or missed;
- a claim that practice activity proves improvement in real games.

## Final navigation model

```text
Today
  ├─ phase summaries → Patterns sections
  ├─ suggested line → Your lines
  └─ next drill → Practice

Patterns
  ├─ Opening → Your lines
  ├─ Middlegame
  └─ Endgame

Practice

Profile (secondary, current detailed record)
  └─ published report (fixed snapshot)
```

The important distinction is not Opening versus Middlegame versus Endgame. It
is **summary versus explanation versus action**:

- Today summarises.
- Patterns explains.
- Practice acts.
- Your lines investigates the one phase with deeper published data.
