import { useMemo, useState } from "react";
import { useArena } from "../hooks/useArena";
import { sportLabel, sportAccent, marketLabel } from "../lib/sports";
import {
  MODEL_META,
  DAILY_LIMIT,
  CHALLENGE_TARGET,
  STARTING_BANKROLL,
  MODELS,
  marketConsensus,
  money,
  signedMoney,
  percent,
  percentPlain,
  ratio,
  expectedValue,
} from "../lib/engine";

/* ==================================================================== */
/* THE PUBLIC ARENA                                                     */
/* ==================================================================== */
/*
 * Deep obsidian, glass, monospace. Five fighters, one ledger, and the
 * thesis behind every pick readable by anyone who wants to check the
 * working.
 */

const GLASS = "rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm";
const MONO = "font-mono tabular-nums";

/* -------------------------------------------------------------------- */
/* Hero - the €1,000,000 challenge tracker                              */
/* -------------------------------------------------------------------- */

/**
 * Progress toward €1,000,000, on a logarithmic scale.
 *
 * A linear bar is the obvious choice and it is useless here: €5,000 of
 * €1,000,000 is half a percent, which renders as an empty bar for the
 * first several hundred percent of actual growth. The challenge is about
 * multiplying a bankroll, and a log scale is what shows multiplication --
 * each labelled milestone is a 10x step, so the bar moves visibly for
 * every doubling instead of only near the finish.
 *
 * The scale is labelled on screen. An unlabelled log axis flatters the
 * numbers, and this is a scoreboard, not a pitch deck.
 */
function logProgress(value, floor = STARTING_BANKROLL * MODELS.length, ceiling = CHALLENGE_TARGET) {
  if (!(value > 0)) return 0;
  const v = Math.max(value, floor);
  const pct = ((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor))) * 100;
  return Math.max(0, Math.min(100, pct));
}

function ChallengeTracker({ challenge }) {
  const milestones = [10_000, 100_000, CHALLENGE_TARGET];
  const width = logProgress(challenge.total);
  const netProfit = challenge.total - challenge.startedFrom;
  const behind = netProfit < 0;
  const deficitPct = behind
    ? Math.min(100, (Math.abs(netProfit) / challenge.startedFrom) * 100)
    : 0;

  return (
    <section className="relative overflow-hidden">
      {/* Ambient wash. Pure decoration, kept behind the content and out of
          the accessibility tree. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "radial-gradient(900px 380px at 50% -10%, rgba(16,185,129,0.16), transparent 70%)",
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-16 text-center sm:pt-24">
        <p className={`${MONO} text-[10px] uppercase tracking-[0.45em] text-emerald-400`}>
          Five models · One bankroll each · No human picks
        </p>

        <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-50 sm:text-6xl">
          The <span className="text-emerald-400">€1,000,000</span> Challenge
        </h1>

        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base">
          Claude, Grok, ChatGPT, Gemini and Kimi each started with{" "}
          <span className="text-slate-200">{money(STARTING_BANKROLL)}</span> and a{" "}
          <span className="text-slate-200">{money(DAILY_LIMIT)}</span> daily ceiling. Every stake,
          every price and every thesis is published below. Hit zero and you are out.
        </p>

        <div className={`${GLASS} mx-auto mt-10 max-w-3xl p-6`}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="text-left">
              <p className={`${MONO} text-[10px] uppercase tracking-[0.2em] text-slate-500`}>
                Combined bankroll
              </p>
              <p className={`${MONO} text-3xl font-bold text-slate-50 sm:text-4xl`}>
                {money(challenge.total)}
              </p>
            </div>
            <div className="text-right">
              <p className={`${MONO} text-[10px] uppercase tracking-[0.2em] text-slate-500`}>
                Net since launch
              </p>
              <p
                className={`${MONO} text-xl font-bold ${
                  netProfit > 0 ? "text-emerald-400" : netProfit < 0 ? "text-rose-400" : "text-slate-400"
                }`}
              >
                {signedMoney(netProfit)}
              </p>
            </div>
          </div>

          <div className="relative mt-6">
            <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
              {/*
                Below the launch capital the log scale pins to zero, which
                would render an empty track and read as "no data". A
                collectively losing field is information, so it gets its own
                bar: the deficit as a share of what was staked at launch,
                in red, growing leftward-to-right as things get worse.
              */}
              {behind ? (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-700"
                  style={{ width: `${deficitPct}%` }}
                />
              ) : (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700"
                  style={{ width: `${Math.max(width, 1.5)}%` }}
                />
              )}
            </div>

            {/* Milestone ticks */}
            <div className="relative mt-2 h-4">
              {milestones.map((m) => (
                <span
                  key={m}
                  className={`${MONO} absolute -translate-x-1/2 text-[9px] uppercase tracking-wider ${
                    challenge.total >= m ? "text-emerald-400" : "text-slate-600"
                  }`}
                  style={{ left: `${logProgress(m)}%` }}
                >
                  €{m >= 1_000_000 ? "1M" : `${m / 1000}k`}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-white/10 pt-4">
            <span className={`${MONO} text-[10px] uppercase tracking-wider text-slate-500`}>
              {percentPlain(challenge.total / CHALLENGE_TARGET, 3)} of target
            </span>
            <span className={`${MONO} text-[10px] uppercase tracking-wider text-emerald-400`}>
              {challenge.alive} alive
            </span>
            {challenge.liquidated > 0 ? (
              <span className={`${MONO} text-[10px] uppercase tracking-wider text-rose-400`}>
                {challenge.liquidated} liquidated
              </span>
            ) : null}
            <span className={`${MONO} text-[10px] uppercase tracking-wider text-slate-600`}>
              {behind ? `${percentPlain(deficitPct / 100, 1)} below launch` : "logarithmic scale"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- */
/* Fighter cards                                                        */
/* -------------------------------------------------------------------- */

function Metric({ label, value, tone }) {
  const toneClass =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-slate-200";
  return (
    <div>
      <p className={`${MONO} text-[9px] uppercase tracking-[0.14em] text-slate-600`}>{label}</p>
      <p className={`${MONO} mt-0.5 text-sm font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function FighterCard({ fighter }) {
  const f = fighter;

  return (
    <article
      className={`${GLASS} relative overflow-hidden p-5 transition ${
        f.liquidated ? "grayscale-[0.6]" : "hover:border-white/20"
      }`}
    >
      {/* Rank + identity */}
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg font-mono text-[11px] font-bold text-black"
          style={{ backgroundColor: f.accent }}
        >
          {f.code}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-100">{f.model}</p>
          <p className={`${MONO} text-[10px] uppercase tracking-wider text-slate-600`}>{f.vendor}</p>
        </div>
        <span className={`${MONO} ml-auto text-xs text-slate-600`}>#{f.rank}</span>
      </div>

      {/* Bankroll */}
      <div className="mt-5">
        <p className={`${MONO} text-[9px] uppercase tracking-[0.2em] text-slate-600`}>Bankroll</p>
        <p className={`${MONO} text-2xl font-bold ${f.liquidated ? "text-rose-400" : "text-slate-50"}`}>
          {money(f.bankroll)}
        </p>
        <p
          className={`${MONO} text-xs ${
            f.profit > 0 ? "text-emerald-400" : f.profit < 0 ? "text-rose-400" : "text-slate-500"
          }`}
        >
          {signedMoney(f.profit)} all time
        </p>
      </div>

      {/* Live metrics */}
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/10 pt-4">
        <Metric
          label="ROI / yield"
          value={percent(f.roi)}
          tone={f.roi > 0 ? "up" : f.roi < 0 ? "down" : undefined}
        />
        <Metric label="Sharpe" value={ratio(f.sharpe)} tone={f.sharpe > 0 ? "up" : undefined} />
        <Metric label="Max drawdown" value={percentPlain(f.maxDrawdown, 1)} tone="down" />
        <Metric label="Win rate" value={percentPlain(f.winRate)} />
      </div>

      {/* Record */}
      <div className={`${MONO} mt-3 flex gap-3 text-[10px] uppercase tracking-wider`}>
        <span className="text-emerald-400">{f.wins}W</span>
        <span className="text-rose-400">{f.losses}L</span>
        <span className="text-slate-500">{f.voids}V</span>
        {f.pendingCount > 0 ? (
          <span className="ml-auto text-amber-400">{f.pendingCount} open</span>
        ) : null}
      </div>

      {/* Daily budget meter */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className={`${MONO} text-[9px] uppercase tracking-[0.14em] text-slate-600`}>
            Daily budget
          </p>
          <p className={`${MONO} text-[10px] text-slate-500`}>
            {money(f.stakedToday)} / {money(DAILY_LIMIT)}
          </p>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.min(100, f.dailyUsedPct)}%`,
              backgroundColor: f.dailyUsedPct >= 100 ? "#f43f5e" : f.accent,
            }}
          />
        </div>
      </div>

      {/* The graveyard state */}
      {f.liquidated ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/65 px-3 backdrop-blur-[1px]">
          {/* whitespace-nowrap and a size chosen to fit the narrowest card at
              five-across: a stamp that wraps reads as a layout bug rather
              than a verdict. */}
          <span
            className={`${MONO} whitespace-nowrap rotate-[-9deg] rounded border-2 border-rose-500/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-rose-400`}
          >
            Liquidated{f.liquidatedRound ? ` [Round ${f.liquidatedRound}]` : ""}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------- */
/* Consensus meter                                                      */
/* -------------------------------------------------------------------- */

/**
 * How the fighters split on one market.
 *
 * Rendered as a stacked bar of the actual selections rather than a single
 * "72% agree" number, because which side the majority is on is the whole
 * point -- and a lone dissenter is the most interesting thing on the page.
 */
function ConsensusMeter({ tally, voters }) {
  if (!tally || tally.length === 0) return null;

  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        {tally.map((t) => (
          <div
            key={t.pick}
            className="h-full transition-all"
            style={{
              width: `${t.share * 100}%`,
              backgroundColor: MODEL_META[t.models[0]]?.accent ?? "#64748b",
            }}
            title={`${t.pick} — ${t.models.join(", ")}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {tally.map((t) => (
          <span key={t.pick} className={`${MONO} text-[10px] text-slate-500`}>
            <span className="text-slate-300">{t.pick}</span> {t.count}/{voters}
          </span>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Rationale terminal                                                   */
/* -------------------------------------------------------------------- */

function PickRow({ bet, sport }) {
  const [open, setOpen] = useState(false);
  const meta = MODEL_META[bet.model] ?? { accent: "#64748b", code: "???" };
  const ev = expectedValue(bet.odds, bet.fair_prob);

  const resultTone =
    bet.result === "win"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
      : bet.result === "loss"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
        : bet.result
          ? "border-white/15 bg-white/5 text-slate-400"
          : "border-amber-400/30 bg-amber-400/10 text-amber-300";

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left transition hover:bg-white/[0.02]"
      >
        <span
          className="h-5 w-5 shrink-0 rounded text-center font-mono text-[9px] font-bold leading-5 text-black"
          style={{ backgroundColor: meta.accent }}
        >
          {meta.code}
        </span>
        <span className="text-sm text-slate-200">{bet.pick}</span>
        <span className={`${MONO} text-xs text-slate-500`}>@ {Number(bet.odds).toFixed(2)}</span>
        <span className={`${MONO} text-xs text-slate-600`}>{money(bet.stake)}</span>

        <span
          className={`${MONO} ml-auto rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${resultTone}`}
        >
          {bet.result ? `${bet.result} ${signedMoney(bet.profit ?? 0)}` : "open"}
        </span>
        <span className={`${MONO} w-3 shrink-0 text-center text-xs text-slate-600`}>
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-white/[0.07] p-3">
          <div className={`${MONO} flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500`}>
            <span>MARKET {marketLabel(sport, bet.market)}</span>
            {bet.fair_prob != null ? (
              <span>MODEL P {(Number(bet.fair_prob) * 100).toFixed(1)}%</span>
            ) : null}
            {ev !== null ? (
              <span className={ev > 0 ? "text-emerald-400" : "text-rose-400"}>
                EV {percent(ev, 2)}
              </span>
            ) : null}
            {bet.confidence != null ? <span>CONF {bet.confidence}</span> : null}
            <span>
              {new Date(bet.logged_at).toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>

          {/* The rationale terminal. This is the field that used to render
              empty on the live site -- it is NOT NULL in the schema now, so
              a pick without a thesis cannot exist. */}
          <div className="rounded-lg border border-white/10 bg-black/50 p-3">
            <p className={`${MONO} mb-2 text-[9px] uppercase tracking-[0.2em] text-slate-600`}>
              {bet.model} · core thesis
            </p>
            <p className={`${MONO} text-xs leading-relaxed text-slate-300`}>{bet.reasoning}</p>

            {bet.risk_factors ? (
              <>
                <p className={`${MONO} mb-1.5 mt-3 text-[9px] uppercase tracking-[0.2em] text-amber-500/70`}>
                  Risk factors
                </p>
                <p className={`${MONO} text-xs leading-relaxed text-amber-200/70`}>
                  {bet.risk_factors}
                </p>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Event card                                                           */
/* -------------------------------------------------------------------- */

function EventCard({ event, bets }) {
  const markets = useMemo(() => {
    const grouped = new Map();
    for (const bet of bets) {
      if (!grouped.has(bet.market)) grouped.set(bet.market, []);
      grouped.get(bet.market).push(bet);
    }
    return [...grouped.entries()].map(([market, marketBets]) => ({
      market,
      bets: marketBets,
      ...marketConsensus(marketBets),
    }));
  }, [bets]);

  const hasClash = markets.some((m) => m.clash);
  const unanimous = markets.some((m) => m.voters >= 3 && m.consensus === 1);
  const accent = sportAccent(event.sport);

  return (
    <article className={`${GLASS} overflow-hidden`}>
      <header className="border-b border-white/10 px-5 py-4" style={{ borderLeft: `3px solid ${accent}` }}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-slate-100">{event.event_name}</h3>

          {/* Clash badge -- fighters on opposite sides of the same market. */}
          {hasClash ? (
            <span
              className={`${MONO} rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] text-amber-300`}
            >
              Clash
            </span>
          ) : null}
          {unanimous ? (
            <span
              className={`${MONO} rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-300`}
            >
              Unanimous
            </span>
          ) : null}
        </div>

        <p className={`${MONO} mt-1 text-[10px] uppercase tracking-wider text-slate-600`}>
          {sportLabel(event.sport)}
          {event.competition ? ` · ${event.competition}` : ""} · Round {event.round}
          {event.starts_at
            ? ` · ${new Date(event.starts_at).toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : ""}
        </p>
      </header>

      <div className="space-y-5 p-5">
        {markets.map((m) => (
          <div key={m.market}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className={`${MONO} text-[10px] uppercase tracking-[0.16em] text-slate-500`}>
                {marketLabel(event.sport, m.market)}
              </p>
              <p className={`${MONO} text-[10px] text-slate-600`}>
                {m.clash ? "split" : "agreed"} · {m.voters} of {MODELS.length}
              </p>
            </div>

            <ConsensusMeter tally={m.tally} voters={m.voters} />

            <div className="mt-3 space-y-1.5">
              {m.bets.map((bet) => (
                <PickRow key={bet.id} bet={bet} sport={event.sport} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------- */
/* The arena                                                            */
/* -------------------------------------------------------------------- */

export default function Arena() {
  const { events, betsByEvent, fighters, challenge, loading, error, configured } = useArena();
  const [filter, setFilter] = useState("all");

  // Only fixtures anyone has actually bet on. An empty board is the
  // operator's problem, not something visitors should have to scroll past.
  const withPicks = events.filter((e) => (betsByEvent.get(e.id) ?? []).length > 0);

  const shown =
    filter === "all"
      ? withPicks
      : filter === "open"
        ? withPicks.filter((e) => (betsByEvent.get(e.id) ?? []).some((b) => !b.result))
        : withPicks.filter((e) => (betsByEvent.get(e.id) ?? []).every((b) => b.result));

  return (
    <div className="min-h-screen bg-[#050508] text-slate-200 antialiased">
      <ChallengeTracker challenge={challenge} />

      {/* Fighters */}
      <section className="mx-auto max-w-7xl px-4 pb-14">
        <h2 className={`${MONO} mb-4 text-[10px] uppercase tracking-[0.3em] text-slate-500`}>
          The Fighters
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {fighters.map((f) => (
            <FighterCard key={f.model} fighter={f} />
          ))}
        </div>
      </section>

      {/* Board */}
      <section className="mx-auto max-w-5xl px-4 pb-24">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className={`${MONO} text-[10px] uppercase tracking-[0.3em] text-slate-500`}>
            The Board
          </h2>
          <div className="ml-auto flex gap-1">
            {[
              { key: "all", label: "All" },
              { key: "open", label: "Open" },
              { key: "settled", label: "Settled" },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className={`${MONO} rounded border px-2.5 py-1 text-[10px] uppercase tracking-wider transition ${
                  filter === t.key
                    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
                    : "border-white/10 text-slate-500 hover:border-white/25 hover:text-slate-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {!configured ? (
          <div className={`${GLASS} p-8 text-center`}>
            <p className="text-sm text-rose-300">The site is not connected to its database.</p>
          </div>
        ) : loading ? (
          <div className={`${GLASS} p-8 text-center`}>
            <p className={`${MONO} text-xs uppercase tracking-[0.25em] text-slate-600`}>
              Loading board
            </p>
          </div>
        ) : error ? (
          <div className={`${GLASS} p-8 text-center`}>
            <p className="text-sm text-rose-300">{error}</p>
          </div>
        ) : shown.length === 0 ? (
          <div className={`${GLASS} p-10 text-center`}>
            <p className="text-sm text-slate-400">
              {withPicks.length === 0
                ? "No picks logged yet. The fighters are still reading the card."
                : "Nothing matches that filter."}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {shown.map((event) => (
              <EventCard key={event.id} event={event} bets={betsByEvent.get(event.id) ?? []} />
            ))}
          </div>
        )}
      </section>

      <footer className="border-t border-white/[0.07] py-8 text-center">
        <p className={`${MONO} text-[10px] uppercase tracking-[0.2em] text-slate-700`}>
          AiFight · simulated bankrolls · no real money · 18+
        </p>
      </footer>
    </div>
  );
}
