/**
 * THE SPORT REGISTRY
 * ==================
 * One definition of every sport and every market the arena can price.
 *
 * Everything downstream reads from here:
 *   - the admin's sport tabs        -> SPORTS
 *   - the fixture form's inputs     -> sport.fields
 *   - the odds matrix               -> sport.markets + market.outcomes(ctx)
 *   - the pick dropdown             -> outcomesFor()
 *   - the public arena's labels     -> sportLabel() / marketLabel()
 *
 * Adding a sport is adding an object below. Nothing else changes.
 *
 * THREE MARKET SHAPES
 * -------------------
 *   fixed   Outcomes are known from the fixture alone (Home / Draw / Away,
 *           Yes / No). The matrix renders one price box per outcome.
 *   line    Outcomes depend on a handicap or total the operator sets
 *           (Over 2.5, Home -4.5). The matrix renders a line input plus
 *           two price boxes.
 *   roster  Outcomes are a list the operator supplies (the drivers in a
 *           Grand Prix, the plausible correct scores). The matrix renders
 *           a name + price row per entrant.
 *
 * WHY `outcomes` IS A FUNCTION
 * ----------------------------
 * The previous incarnation of this file stored outcome *templates* as
 * strings with "{home}" placeholders and substituted them in two different
 * places. The two implementations drifted, and because the stored selection
 * text is half of the duplicate-detection key, a drift silently un-blocked
 * duplicate bets. A function has exactly one implementation, so it cannot
 * drift from itself.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Settlement rules. A winning bet returns stake x odds whether it was a
 * corner count or a podium finish, so encoding "how this market settles"
 * per sport would be inventing a distinction the money does not have.
 */

/* ------------------------------------------------------------------ */
/* Helpers used by the market definitions                              */
/* ------------------------------------------------------------------ */

/**
 * Format a line for display.
 *
 * A handicap is signed and the sign carries meaning -- "-4.5" and "+4.5"
 * are opposite bets -- so a positive handicap keeps its plus. Totals are
 * unsigned, because "Over 2.5" needs no decoration.
 */
export function formatLine(value, { signed = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const text = Number.isInteger(n) ? String(n) : String(n);
  return signed && n > 0 ? `+${text}` : text;
}

const overUnder = (noun) => (ctx) => {
  const line = formatLine(ctx.line);
  return [`Over ${line} ${noun}`, `Under ${line} ${noun}`];
};

/** Home handicap as set, away handicap mirrored. One number, two sides. */
const handicap = (ctx) => [
  `${ctx.home} ${formatLine(ctx.line, { signed: true })}`,
  `${ctx.away} ${formatLine(-Number(ctx.line || 0), { signed: true })}`,
];

const twoWay = (ctx) => [ctx.home, ctx.away];
const threeWay = (ctx) => [ctx.home, "Draw", ctx.away];

/** Roster markets read their outcomes off the operator-supplied entrant list. */
const fromRoster = (ctx) =>
  (Array.isArray(ctx.entrants) ? ctx.entrants : [])
    .map((e) => String(e ?? "").trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

/**
 * `key` on a market is what lands in `bets.market` and must stay stable --
 * renaming one orphans every historical bet that used it.
 */
export const SPORTS = [
  {
    key: "soccer",
    label: "Soccer",
    icon: "SOC",
    kind: "fixture",
    accent: "#22c55e",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Arsenal" },
      { key: "away", label: "Away team", required: true, placeholder: "Chelsea" },
      { key: "competition", label: "Competition", required: false, placeholder: "Premier League" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "1X2",
        label: "Match Result (1X2)",
        shape: "fixed",
        note: "Three-way. The draw is a real outcome, not an edge case.",
        outcomes: threeWay,
      },
      {
        key: "dc",
        label: "Double Chance",
        shape: "fixed",
        note: "Covers two of the three results.",
        outcomes: (ctx) => [
          `${ctx.home} or Draw`,
          `${ctx.home} or ${ctx.away}`,
          `Draw or ${ctx.away}`,
        ],
      },
      {
        key: "btts",
        label: "Both Teams To Score",
        shape: "fixed",
        outcomes: () => ["Yes", "No"],
      },
      {
        key: "goals_ou",
        label: "Total Goals",
        shape: "line",
        defaultLine: 2.5,
        lineLabel: "Goals",
        lineStep: 0.5,
        // A .5 line cannot push. Whole numbers can -- that is what VOID is for.
        note: "A whole-number line can push. Settle those as VOID.",
        outcomes: overUnder("Goals"),
      },
      {
        key: "ah",
        label: "Asian Handicap",
        shape: "line",
        defaultLine: -0.5,
        lineLabel: "Home handicap",
        lineStep: 0.25,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "corners_ou",
        label: "Total Corners",
        shape: "line",
        defaultLine: 9.5,
        lineLabel: "Corners",
        lineStep: 0.5,
        outcomes: overUnder("Corners"),
      },
      {
        key: "cards_ou",
        label: "Total Cards",
        shape: "line",
        defaultLine: 3.5,
        lineLabel: "Cards",
        lineStep: 0.5,
        outcomes: overUnder("Cards"),
      },
      {
        key: "correct_score",
        label: "Correct Score",
        shape: "roster",
        entrantLabel: "Score",
        note: "Add only the scorelines you are actually pricing.",
        presets: ["1-0", "2-0", "2-1", "3-1", "0-0", "1-1", "2-2", "0-1", "0-2", "1-2"],
        outcomes: fromRoster,
      },
    ],
  },

  {
    key: "nba",
    label: "NBA",
    icon: "NBA",
    kind: "fixture",
    accent: "#f97316",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Boston Celtics" },
      { key: "away", label: "Away team", required: true, placeholder: "Miami Heat" },
      { key: "competition", label: "Competition", required: false, placeholder: "NBA Regular Season" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "ml",
        label: "Moneyline",
        shape: "fixed",
        note: "Two-way -- overtime decides ties.",
        outcomes: twoWay,
      },
      {
        key: "spread",
        label: "Spread",
        shape: "line",
        defaultLine: -4.5,
        lineLabel: "Home spread",
        lineStep: 0.5,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "totals",
        label: "Total Points",
        shape: "line",
        defaultLine: 224.5,
        lineLabel: "Points",
        lineStep: 0.5,
        outcomes: overUnder("Points"),
      },
    ],
  },

  {
    key: "nfl",
    label: "NFL",
    icon: "NFL",
    kind: "fixture",
    accent: "#eab308",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Kansas City Chiefs" },
      { key: "away", label: "Away team", required: true, placeholder: "Buffalo Bills" },
      { key: "competition", label: "Competition", required: false, placeholder: "NFL Week 5" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "ml",
        label: "Moneyline",
        shape: "fixed",
        // Ties happen but are rare enough that books price two-way and void.
        note: "Two-way -- a tie settles as VOID, not a third outcome.",
        outcomes: twoWay,
      },
      {
        key: "spread",
        label: "Spread",
        shape: "line",
        defaultLine: -3.5,
        lineLabel: "Home spread",
        lineStep: 0.5,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "totals",
        label: "Total Points",
        shape: "line",
        defaultLine: 44.5,
        lineLabel: "Points",
        lineStep: 0.5,
        outcomes: overUnder("Points"),
      },
    ],
  },

  {
    key: "nhl",
    label: "Ice Hockey",
    icon: "NHL",
    kind: "fixture",
    accent: "#38bdf8",
    fields: [
      { key: "home", label: "Home team", required: true, placeholder: "Boston Bruins" },
      { key: "away", label: "Away team", required: true, placeholder: "Toronto Maple Leafs" },
      { key: "competition", label: "Competition", required: false, placeholder: "NHL Regular Season" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "ml",
        label: "Moneyline (incl. OT/SO)",
        shape: "fixed",
        note: "Two-way -- overtime and the shootout count.",
        outcomes: twoWay,
      },
      {
        key: "reg_1x2",
        label: "60-Minute Result",
        shape: "fixed",
        note: "Regulation only. The tie is a live outcome here.",
        outcomes: threeWay,
      },
      {
        key: "puckline",
        label: "Puck Line",
        shape: "line",
        defaultLine: -1.5,
        lineLabel: "Home puck line",
        lineStep: 0.5,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "totals",
        label: "Total Goals",
        shape: "line",
        defaultLine: 5.5,
        lineLabel: "Goals",
        lineStep: 0.5,
        outcomes: overUnder("Goals"),
      },
    ],
  },

  {
    key: "darts",
    label: "Darts",
    icon: "DRT",
    kind: "fixture",
    accent: "#a855f7",
    fields: [
      { key: "home", label: "Player A", required: true, placeholder: "Luke Humphries" },
      { key: "away", label: "Player B", required: true, placeholder: "Michael van Gerwen" },
      { key: "competition", label: "Tournament", required: false, placeholder: "PDC World Championship" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "ml",
        label: "Match Winner",
        shape: "fixed",
        note: "No draw -- the match plays to a decision.",
        outcomes: twoWay,
      },
      {
        key: "handicap",
        label: "Set / Leg Handicap",
        shape: "line",
        defaultLine: -1.5,
        lineLabel: "Player A handicap",
        lineStep: 0.5,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "total_legs",
        label: "Total Legs",
        shape: "line",
        defaultLine: 10.5,
        lineLabel: "Legs",
        lineStep: 0.5,
        outcomes: overUnder("Legs"),
      },
      {
        key: "total_180s",
        label: "Total 180s",
        shape: "line",
        defaultLine: 6.5,
        lineLabel: "180s",
        lineStep: 0.5,
        outcomes: overUnder("180s"),
      },
      {
        key: "most_180s",
        label: "Most 180s",
        shape: "fixed",
        note: "A tie on maximums normally voids.",
        outcomes: threeWay,
      },
      {
        key: "correct_score",
        label: "Correct Score",
        shape: "roster",
        entrantLabel: "Score",
        presets: ["3-0", "3-1", "3-2", "2-3", "1-3", "0-3"],
        outcomes: fromRoster,
      },
    ],
  },

  {
    key: "snooker",
    label: "Snooker",
    icon: "SNK",
    kind: "fixture",
    accent: "#14b8a6",
    fields: [
      { key: "home", label: "Player A", required: true, placeholder: "Ronnie O'Sullivan" },
      { key: "away", label: "Player B", required: true, placeholder: "Judd Trump" },
      { key: "competition", label: "Tournament", required: false, placeholder: "World Championship" },
    ],
    name: (e) => `${e.home} v ${e.away}`,
    markets: [
      {
        key: "ml",
        label: "Match Winner",
        shape: "fixed",
        outcomes: twoWay,
      },
      {
        key: "handicap",
        label: "Frame Handicap",
        shape: "line",
        defaultLine: -2.5,
        lineLabel: "Player A handicap",
        lineStep: 0.5,
        signedLine: true,
        outcomes: handicap,
      },
      {
        key: "total_frames",
        label: "Total Frames",
        shape: "line",
        defaultLine: 8.5,
        lineLabel: "Frames",
        lineStep: 0.5,
        outcomes: overUnder("Frames"),
      },
      {
        key: "century",
        label: "Century Break In Match",
        shape: "fixed",
        outcomes: () => ["Yes", "No"],
      },
      {
        key: "correct_score",
        label: "Correct Score",
        shape: "roster",
        entrantLabel: "Score",
        presets: ["5-0", "5-1", "5-2", "5-3", "5-4", "4-5", "3-5", "2-5", "1-5", "0-5"],
        outcomes: fromRoster,
      },
    ],
  },

  {
    key: "f1",
    label: "Formula 1",
    icon: "F1",
    kind: "race",
    accent: "#ef4444",
    // No home and away side. A form that demanded both would either be lying
    // or blocked, which is why `kind` exists at all.
    fields: [
      { key: "home", label: "Grand Prix", required: true, placeholder: "Monaco Grand Prix" },
      { key: "session", label: "Session", required: false, placeholder: "Race" },
      { key: "competition", label: "Championship", required: false, placeholder: "F1 2026" },
    ],
    // The session qualifies the name, so Qualifying and Race at the same
    // Grand Prix are distinct events rather than a refused duplicate.
    name: (e) => (e.session ? `${e.home} - ${e.session}` : e.home),
    markets: [
      {
        key: "winner",
        label: "Race Winner",
        shape: "roster",
        entrantLabel: "Driver",
        note: "One winner from the field.",
        outcomes: fromRoster,
      },
      {
        key: "podium",
        label: "Podium Finish (Top 3)",
        shape: "roster",
        entrantLabel: "Driver",
        // Several entrants win. That changes nothing about the payout -- each
        // bet settles on its own selection -- but the operator should know.
        multiWinner: true,
        note: "Three of these win. Grade each pick on its own driver.",
        outcomes: fromRoster,
      },
      {
        key: "h2h",
        label: "Driver Head-to-Head",
        shape: "roster",
        entrantLabel: "Driver",
        maxEntrants: 2,
        note: "Which of the two finishes ahead. A double DNF voids.",
        outcomes: fromRoster,
      },
      {
        key: "fastest_lap",
        label: "Fastest Lap",
        shape: "roster",
        entrantLabel: "Driver",
        outcomes: fromRoster,
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Accessors                                                           */
/* ------------------------------------------------------------------ */

const BY_KEY = Object.fromEntries(SPORTS.map((s) => [s.key, s]));

export const SPORT_KEYS = SPORTS.map((s) => s.key);

export function getSport(key) {
  return BY_KEY[key] ?? null;
}

export function sportLabel(key) {
  return BY_KEY[key]?.label ?? key ?? "Unknown";
}

export function sportAccent(key) {
  return BY_KEY[key]?.accent ?? "#94a3b8";
}

export function marketsFor(sportKey) {
  return BY_KEY[sportKey]?.markets ?? [];
}

export function getMarket(sportKey, marketKey) {
  return marketsFor(sportKey).find((m) => m.key === marketKey) ?? null;
}

export function marketLabel(sportKey, marketKey) {
  return getMarket(sportKey, marketKey)?.label ?? marketKey ?? "";
}

/**
 * Resolve a market's outcome labels for one specific event.
 *
 * `ctx` carries whatever the market's shape needs: `home`/`away` for a
 * fixture, `line` for a handicap or total, `entrants` for a roster. Missing
 * values fall back to something readable rather than throwing, because this
 * runs while the operator is still typing the fixture in.
 */
export function outcomesFor(sportKey, marketKey, ctx = {}) {
  const market = getMarket(sportKey, marketKey);
  if (!market) return [];
  const resolved = {
    home: ctx.home || "Home",
    away: ctx.away || "Away",
    line: ctx.line ?? market.defaultLine ?? 0,
    entrants: ctx.entrants ?? [],
  };
  try {
    return market.outcomes(resolved).filter(Boolean);
  } catch {
    return [];
  }
}

/** Compose the stored `event_name` from the operator's fixture fields. */
export function composeEventName(sportKey, fields) {
  const sport = BY_KEY[sportKey];
  if (!sport) return "";
  try {
    return String(sport.name(fields) ?? "").trim();
  } catch {
    return "";
  }
}

/** True when this sport's markets can need an operator-supplied entrant list. */
export function usesRoster(sportKey) {
  return marketsFor(sportKey).some((m) => m.shape === "roster");
}
