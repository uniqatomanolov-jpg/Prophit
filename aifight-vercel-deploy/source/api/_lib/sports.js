/**
 * The sport registry — one definition of every market the arena can price.
 *
 * WHY A REGISTRY RATHER THAN PER-SPORT CODE
 * -----------------------------------------
 * The arena was football-only in the places that mattered: the market keys
 * were hard-coded (`1X2`, `btts`, `goals_ou`), the admin's dropdown was a
 * fixed list, and settlement assumed a three-way result with a draw. Adding
 * NBA meant touching all three, and adding F1 — where "the event" is one race
 * with twenty possible winners and no home side — meant touching more.
 *
 * So the differences live in data here, and every consumer reads them:
 *
 *   the admin's odds matrix   renders `marketsFor(sport)`
 *   the pick validator        checks the selection against `outcomesFor()`
 *   settlement                is already sport-agnostic — it only needs
 *                             stake, odds and a result
 *
 * Adding a sport is adding an entry below. Nothing else changes.
 *
 * THREE MARKET SHAPES
 * -------------------
 *   fixed   outcomes are known from the fixture alone — Home/Draw/Away,
 *           Yes/No. The matrix renders one odds box per outcome.
 *   line    outcomes depend on a handicap or total the admin sets — Over 2.5,
 *           Home -4.5. The matrix renders a line input plus two odds boxes.
 *   roster  outcomes are a list the admin supplies — the drivers in a Grand
 *           Prix. The matrix renders a name+odds row per entrant.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Settlement rules. A win is stake x (odds - 1) whether it was a corner count
 * or a podium finish, so encoding "how this market settles" per sport would
 * be inventing a distinction the money does not have.
 */

/** Canonical sport keys. Stored on the event; never shown raw to a user. */
export const SPORTS = ["soccer", "nba", "nfl", "f1"];

const HOME = "{home}";
const AWAY = "{away}";
const LINE = "{line}";
/** The away side of a spread: the same number with the sign flipped. */
const LINE_INVERTED = "{line:invert}";

/**
 * Market definitions, per sport, in the order the admin should see them.
 *
 * `key` is what lands in `bet.market` and must stay stable — it is half of
 * the duplicate-detection key, so renaming one silently un-blocks a duplicate
 * that was previously refused.
 */
const MARKETS = {
  soccer: [
    {
      key: "1X2",
      label: "Match Result",
      shape: "fixed",
      // Three-way: the draw is a real outcome, not an edge case.
      outcomes: [HOME, "Draw", AWAY],
      note: "Exactly one wins.",
    },
    {
      key: "dc",
      label: "Double Chance",
      shape: "fixed",
      outcomes: ["Home or Draw", "Home or Away", "Draw or Away"],
      note: "Covers two of the three results.",
    },
    {
      key: "btts",
      label: "Both Teams To Score",
      shape: "fixed",
      outcomes: ["Yes", "No"],
    },
    {
      key: "goals_ou",
      label: "Total Goals",
      shape: "line",
      defaultLine: 2.5,
      lineLabel: "Goals",
      // A .5 line cannot push. Whole numbers can, which is why VOID exists.
      lineStep: 0.5,
      outcomes: [`Over ${LINE}`, `Under ${LINE}`],
    },
    {
      key: "corners_ou",
      label: "Total Corners",
      shape: "line",
      defaultLine: 9.5,
      lineLabel: "Corners",
      lineStep: 0.5,
      outcomes: [`Over ${LINE}`, `Under ${LINE}`],
    },
    {
      key: "cards_ou",
      label: "Total Cards",
      shape: "line",
      defaultLine: 3.5,
      lineLabel: "Cards",
      lineStep: 0.5,
      outcomes: [`Over ${LINE}`, `Under ${LINE}`],
    },
  ],

  nba: [
    {
      key: "ml",
      label: "Moneyline",
      shape: "fixed",
      // Two-way. Basketball plays overtime, so there is no draw to price.
      outcomes: [HOME, AWAY],
      note: "Two-way — overtime decides ties.",
    },
    {
      key: "spread",
      label: "Spread",
      shape: "line",
      defaultLine: -4.5,
      lineLabel: "Home spread",
      lineStep: 0.5,
      // The away side is the mirror, so the admin sets one number.
      outcomes: [`${HOME} ${LINE}`, `${AWAY} ${LINE_INVERTED}`],
      invertAway: true,
    },
    {
      key: "totals",
      label: "Total Points",
      shape: "line",
      defaultLine: 224.5,
      lineLabel: "Points",
      lineStep: 0.5,
      outcomes: [`Over ${LINE}`, `Under ${LINE}`],
    },
  ],

  nfl: [
    {
      key: "ml",
      label: "Moneyline",
      shape: "fixed",
      // NFL ties are possible but rare enough that books price two-way and
      // void on a tie. VOID is the correct settlement, not a third outcome.
      outcomes: [HOME, AWAY],
      note: "Two-way — a tie voids.",
    },
    {
      key: "spread",
      label: "Spread",
      shape: "line",
      defaultLine: -3.5,
      lineLabel: "Home spread",
      lineStep: 0.5,
      outcomes: [`${HOME} ${LINE}`, `${AWAY} ${LINE_INVERTED}`],
      invertAway: true,
    },
    {
      key: "totals",
      label: "Total Points",
      shape: "line",
      defaultLine: 44.5,
      lineLabel: "Points",
      lineStep: 0.5,
      outcomes: [`Over ${LINE}`, `Under ${LINE}`],
    },
  ],

  f1: [
    {
      key: "winner",
      label: "Race Winner",
      shape: "roster",
      entrantLabel: "Driver",
      note: "One winner from the field.",
    },
    {
      key: "podium",
      label: "Podium Finish (Top 3)",
      shape: "roster",
      entrantLabel: "Driver",
      // Several entrants win. That changes nothing about the payout — each
      // bet settles on its own selection — but the admin should know.
      multiWinner: true,
      note: "Three of these win.",
    },
    {
      key: "h2h",
      label: "Driver Head-to-Head",
      shape: "roster",
      entrantLabel: "Driver",
      maxEntrants: 2,
      note: "Which of the two finishes ahead.",
    },
  ],
};

/**
 * Per-sport shape of the event itself.
 *
 * F1 is the reason this exists: a Grand Prix has no home and away side, so an
 * admin form that demands both would either be lying or blocked.
 */
const EVENT_SHAPES = {
  soccer: {
    label: "Football",
    kind: "fixture",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Arsenal" },
      { key: "away", label: "Away team", required: true, placeholder: "Chelsea" },
      { key: "competition", label: "Competition", required: false, placeholder: "Premier League" },
    ],
    /** How the stored `event` string is composed. */
    name: (e) => `${e.home} v ${e.away}`,
  },
  nba: {
    label: "NBA",
    kind: "fixture",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Boston Celtics" },
      { key: "away", label: "Away team", required: true, placeholder: "Miami Heat" },
      { key: "competition", label: "Competition", required: false, placeholder: "NBA Regular Season" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
  },
  nfl: {
    label: "NFL",
    kind: "fixture",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Kansas City Chiefs" },
      { key: "away", label: "Away team", required: true, placeholder: "Buffalo Bills" },
      { key: "competition", label: "Competition", required: false, placeholder: "NFL Week 5" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
  },
  f1: {
    label: "Formula 1",
    kind: "race",
    fields: [
      { key: "home", label: "Grand Prix", required: true, placeholder: "Monaco Grand Prix" },
      { key: "session", label: "Session", required: false, placeholder: "Race" },
      { key: "competition", label: "Championship", required: false, placeholder: "F1 2026" },
    ],
    // No away side. The session qualifies the name so Qualifying and Race at
    // the same Grand Prix are distinct events rather than a duplicate.
    name: (e) => (e.session ? `${e.home} — ${e.session}` : e.home),
  },
};

/* ------------------------------------------------------------------ */
/* Accessors                                                           */
/* ------------------------------------------------------------------ */

export function isSport(sport) {
  return SPORTS.includes(sport);
}

export function eventShape(sport) {
  return EVENT_SHAPES[sport] ?? null;
}

export function sportLabel(sport) {
  return EVENT_SHAPES[sport]?.label ?? sport;
}

/** Every market for a sport, with placeholders left intact. */
export function marketsFor(sport) {
  return MARKETS[sport] ?? [];
}

export function marketFor(sport, key) {
  return marketsFor(sport).find((m) => m.key === key) ?? null;
}

/**
 * Format a line for display.
 *
 * A spread is signed and the sign carries meaning — "-4.5" and "4.5" are
 * opposite bets — so a positive number keeps its plus. Totals are unsigned.
 */
function formatLine(value, { signed = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  return signed && n > 0 ? `+${text}` : text;
}

/**
 * Resolve a market's outcome labels for a specific event.
 *
 * This is the single place placeholders are substituted, so the admin matrix,
 * the pick validator and anything rendering a stored bet all produce the same
 * string. Two implementations of this would drift and quietly break the
 * duplicate check, which compares on the selection text.
 */
export function outcomesFor(sport, marketKey, context = {}) {
  const market = marketFor(sport, marketKey);
  if (!market) return [];

  const home = context.home ?? "Home";
  const away = context.away ?? "Away";

  if (market.shape === "roster") {
    const entrants = Array.isArray(context.entrants) ? context.entrants : [];
    return entrants
      .map((e) => (typeof e === "string" ? e : e?.label))
      .filter((label) => typeof label === "string" && label.trim())
      .map((label) => label.trim());
  }

  if (market.shape === "line") {
    const line = context.line ?? market.defaultLine;
    return market.outcomes.map((template) => {
      // The away side of a spread mirrors the home line.
      if (template.includes(LINE_INVERTED)) {
        return template
          .replace(LINE_INVERTED, formatLine(-Number(line), { signed: true }))
          .replace(HOME, home)
          .replace(AWAY, away);
      }
      return template
        .replace(LINE, formatLine(line, { signed: Boolean(market.invertAway) }))
        .replace(HOME, home)
        .replace(AWAY, away);
    });
  }

  return market.outcomes.map((label) => label.replace(HOME, home).replace(AWAY, away));
}

/**
 * The whole registry, shaped for the browser.
 *
 * Sent to the admin console so the matrix renders from the same definitions
 * the server validates against — the client cannot invent a market the server
 * will then reject, which is the failure mode of a hard-coded dropdown.
 */
export function registry() {
  return SPORTS.map((sport) => ({
    key: sport,
    label: sportLabel(sport),
    kind: EVENT_SHAPES[sport].kind,
    fields: EVENT_SHAPES[sport].fields,
    markets: marketsFor(sport).map((m) => ({
      key: m.key,
      label: m.label,
      shape: m.shape,
      note: m.note ?? null,
      defaultLine: m.defaultLine ?? null,
      lineLabel: m.lineLabel ?? null,
      lineStep: m.lineStep ?? null,
      entrantLabel: m.entrantLabel ?? null,
      maxEntrants: m.maxEntrants ?? null,
      multiWinner: Boolean(m.multiWinner),
      // Placeholders intact — the client substitutes with the same helper.
      outcomeTemplates: m.outcomes ?? null,
    })),
  }));
}

/**
 * Compose the stored event name from the admin's fields.
 *
 * One function, so `eventCode()` and the duplicate check always see the same
 * string the operator saw when they created the event.
 */
export function composeEventName(sport, fields) {
  const shape = EVENT_SHAPES[sport];
  if (!shape) return "";
  try {
    return String(shape.name(fields) ?? "").trim();
  } catch {
    return "";
  }
}
