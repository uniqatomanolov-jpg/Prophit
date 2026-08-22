/**
 * Server-side pick grader.
 *
 * A faithful port of src/lib/autoSettle.ts, which grades picks in the admin
 * UI. The two exist because they run in different places — Vite/TS in the
 * browser, plain ESM in a Vercel function — and they MUST agree, or a bet
 * would settle one way automatically and the opposite way by hand.
 *
 * scripts/grader-parity.mjs runs both over the same fixture table and fails
 * if any verdict differs. Change one, run that, change the other.
 *
 * The contract is the important part: this function *proposes*. Pick text is
 * free-form, so anything it cannot read with confidence comes back with
 * outcome null and certain false, and a human decides. Guessing here moves
 * real bankroll and corrupts every figure downstream.
 */

/** Splits "Botev Plovdiv v Spartak Varna" into its two sides. */
export function teamsFromEvent(event) {
  if (typeof event !== "string") return null;
  const vs = event.split(/\s+(?:vs?\.?|v\.?)\s+/i);
  if (vs.length >= 2 && vs[0] && vs[1]) return { home: vs[0].trim(), away: vs[1].trim() };
  const dash = event.split(/\s*[–—-]\s*/);
  if (dash.length >= 2 && dash[0] && dash[1]) return { home: dash[0].trim(), away: dash[1].trim() };
  return null;
}

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b(fc|pfc|cf|sc|ac|fk|afc)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Does a pick refer to this team? Compares distinctive words, not whole strings. */
function mentionsTeam(pick, team) {
  const p = norm(pick);
  const words = norm(team)
    .split(" ")
    .filter((w) => w.length > 2);
  if (!words.length) return false;
  return words.some((w) => p.includes(w));
}

/** Pulls the line out of "Over 2.5 Goals" / "under 3.5". */
function goalLine(pick) {
  const m = String(pick).match(/(\d+(?:\.\d+)?)/);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {{outcome: "win"|"loss"|"void"|null, why: string, certain: boolean}}
 */
export function proposeOutcome(bet, home, away) {
  const total = home + away;
  const pick = String(bet.pick ?? "")
    .toLowerCase()
    .trim();
  const market = String(bet.market ?? "").toLowerCase();
  const teams = teamsFromEvent(bet.event);
  const score = `${home}-${away}`;

  const win = (why) => ({ outcome: "win", why, certain: true });
  const loss = (why) => ({ outcome: "loss", why, certain: true });
  const unsure = (why) => ({ outcome: null, why, certain: false });

  /* --- Both teams to score --- */
  if (market === "btts") {
    const both = home > 0 && away > 0;
    if (/\b(yes|both)\b/.test(pick)) {
      return both ? win(`${score}: both scored`) : loss(`${score}: only one side scored`);
    }
    if (/\bno\b/.test(pick)) {
      return both ? loss(`${score}: both scored`) : win(`${score}: one side blanked`);
    }
    return unsure(`Couldn't read "${bet.pick}" as Yes or No`);
  }

  /* --- Totals --- */
  if (market === "goals_ou") {
    const line = goalLine(pick);
    if (line === null) return unsure(`No goal line found in "${bet.pick}"`);
    // A whole-number line can push; halves never can.
    if (Number.isInteger(line) && total === line) {
      return {
        outcome: "void",
        why: `${total} goals exactly — push on the ${line} line`,
        certain: true,
      };
    }
    if (/\bover\b/.test(pick)) {
      return total > line
        ? win(`${total} goals, over ${line}`)
        : loss(`${total} goals, not over ${line}`);
    }
    if (/\bunder\b/.test(pick)) {
      return total < line
        ? win(`${total} goals, under ${line}`)
        : loss(`${total} goals, not under ${line}`);
    }
    return unsure(`Couldn't tell if "${bet.pick}" is over or under`);
  }

  /* --- Match result / moneyline --- */
  if (market === "x12" || market === "ml") {
    const draw = home === away;

    // Double chance MUST be tested before the plain-draw rule below —
    // "Botev or Draw" contains the word "draw" and would otherwise be graded
    // as a straight draw bet, turning a winner into a loser.
    const dc = pick.split(/\s+or\s+/);
    if (dc.length === 2 && dc[0] && dc[1]) {
      const side = (part) => {
        const t = part.trim();
        if (/^(x|draw|tie)$/.test(t) || /\bdraw\b/.test(t)) return "draw";
        if (t === "1" || /\bhome\b/.test(t)) return "home";
        if (t === "2" || /\baway\b/.test(t)) return "away";
        if (teams) {
          const h = mentionsTeam(t, teams.home);
          const a = mentionsTeam(t, teams.away);
          if (h && !a) return "home";
          if (a && !h) return "away";
        }
        return null;
      };
      const a = side(dc[0]);
      const b = side(dc[1]);
      if (a && b && a !== b) {
        const hit = (s) => (s === "draw" ? draw : s === "home" ? home > away : away > home);
        const won = hit(a) || hit(b);
        const label = `${a}/${b}`;
        return won
          ? win(`${score}: double chance ${label} landed`)
          : loss(`${score}: double chance ${label} missed`);
      }
      return unsure(`Couldn't read both sides of "${bet.pick}"`);
    }

    if (/^(x|draw|tie)$/.test(pick) || /\bdraw\b/.test(pick)) {
      return draw ? win(`${score}: drawn`) : loss(`${score}: not a draw`);
    }
    if (pick === "1")
      return home > away ? win(`${score}: home won`) : loss(`${score}: home didn't win`);
    if (pick === "2")
      return away > home ? win(`${score}: away won`) : loss(`${score}: away didn't win`);

    const saysHome = /\bhome\b/.test(pick);
    const saysAway = /\baway\b/.test(pick);
    if (saysHome && !saysAway) {
      return home > away ? win(`${score}: home won`) : loss(`${score}: home didn't win`);
    }
    if (saysAway && !saysHome) {
      return away > home ? win(`${score}: away won`) : loss(`${score}: away didn't win`);
    }

    if (teams) {
      const isHome = mentionsTeam(pick, teams.home);
      const isAway = mentionsTeam(pick, teams.away);
      if (isHome && !isAway) {
        return home > away
          ? win(`${score}: ${teams.home} won`)
          : loss(`${score}: ${teams.home} didn't win`);
      }
      if (isAway && !isHome) {
        return away > home
          ? win(`${score}: ${teams.away} won`)
          : loss(`${score}: ${teams.away} didn't win`);
      }
    }
    return unsure(`Couldn't tell which side "${bet.pick}" backs`);
  }

  /* --- Handicaps: line direction is too easy to misread. --- */
  if (market === "spread") {
    return unsure("Handicaps need grading by hand — check the line direction");
  }

  return unsure(`No grading rule for the "${bet.market}" market`);
}

/* ------------------------------------------------------------------ *
 * Fixture matching
 * ------------------------------------------------------------------ */

/**
 * Links a logged bet to a scored fixture.
 *
 * The two names come from different places: the bet's `event` was typed or
 * pasted by an admin, the score's team names come from the feed. They agree
 * often but not always ("Man Utd" vs "Manchester United"), so match on
 * distinctive words of BOTH teams rather than on the whole string, and
 * require both sides to hit before calling it the same game.
 */
export function matchFixture(event, games) {
  const teams = teamsFromEvent(event);
  if (!teams) return null;

  let best = null;
  let bestScore = 0;

  for (const g of games) {
    if (!g?.home_team || !g?.away_team) continue;
    const straight = similarity(teams.home, g.home_team) + similarity(teams.away, g.away_team);
    // Some sources list the fixture the other way round.
    const flipped = similarity(teams.home, g.away_team) + similarity(teams.away, g.home_team);
    const score = Math.max(straight, flipped);

    if (score > bestScore) {
      bestScore = score;
      best = { game: g, flipped: flipped > straight };
    }
  }

  // Both halves must be a strong match. A single confident team name is not
  // enough — "Arsenal v Chelsea" and "Arsenal v Spurs" share one side.
  return bestScore >= 1.6 ? { ...best, confidence: bestScore / 2 } : null;
}

/** 0..1 word-overlap score between two team names. */
function similarity(a, b) {
  const wa = norm(a)
    .split(" ")
    .filter((w) => w.length > 2);
  const wb = norm(b)
    .split(" ")
    .filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  if (norm(a) === norm(b)) return 1;

  let hits = 0;
  for (const w of wa) {
    if (wb.some((x) => x === w || x.startsWith(w) || w.startsWith(x))) hits += 1;
  }
  return hits / Math.max(wa.length, wb.length);
}
