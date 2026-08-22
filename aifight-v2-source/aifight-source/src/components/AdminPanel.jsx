import { useEffect, useMemo, useState } from "react";
import { supabase, describeError, isSupabaseConfigured } from "../lib/supabaseClient";
import { useArena, useAuthSession } from "../hooks/useArena";
import {
  SPORTS,
  getSport,
  marketsFor,
  outcomesFor,
  composeEventName,
  usesRoster,
  sportLabel,
  marketLabel,
} from "../lib/sports";
import {
  MODELS,
  MODEL_META,
  DAILY_LIMIT,
  payoutFor,
  settlementPatch,
  validatePick,
  expectedValue,
  impliedProbability,
  toNumber,
  money,
  signedMoney,
  percent,
} from "../lib/engine";

/* ==================================================================== */
/* THE ADMIN PANEL                                                      */
/* ==================================================================== */
/*
 * One file, two columns, no wizard.
 *
 * LEFT  - The Match Board. Create a fixture in any of seven sports and
 *         price its markets in a single matrix.
 * RIGHT - The AI Dispatcher & Settler. Every live fixture stacked, each
 *         with five fighter rows to log against and inline WIN / LOSS /
 *         VOID grading underneath.
 *
 * The old panel put these behind four numbered steps, which meant the
 * operator could not see a fixture and its picks at the same time -- so
 * logging the wrong fighter against the wrong match was a two-click
 * mistake with no visual contradiction. Here both halves are always on
 * screen and the money moves the instant you click a grade.
 *
 * There are no serverless functions. Every write below is a direct
 * PostgREST call, authorised by a Supabase Auth session and constrained by
 * the RLS policies in supabase/schema.sql.
 */

/* -------------------------------------------------------------------- */
/* Local primitives                                                     */
/* -------------------------------------------------------------------- */

const CARD = "rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm";
const INPUT =
  "w-full rounded-lg border border-white/10 bg-[#0a0a10] px-3 py-2 text-sm text-slate-100 " +
  "placeholder:text-slate-600 outline-none transition focus:border-emerald-400/60 " +
  "focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-40";
const LABEL =
  "mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500";

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className={LABEL}>
        {label}
        {hint ? <span className="ml-2 normal-case tracking-normal text-slate-600">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function Pill({ children, tone = "slate" }) {
  const tones = {
    slate: "border-white/10 bg-white/5 text-slate-400",
    green: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    red: "border-rose-400/30 bg-rose-400/10 text-rose-300",
    amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    blue: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Toast({ message, tone, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, tone === "error" ? 9000 : 3500);
    return () => clearTimeout(t);
  }, [message, tone, onDismiss]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-2xl backdrop-blur ${
        tone === "error"
          ? "border-rose-400/40 bg-rose-950/90 text-rose-100"
          : "border-emerald-400/40 bg-emerald-950/90 text-emerald-100"
      }`}
    >
      {message}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* The gate                                                             */
/* -------------------------------------------------------------------- */

/**
 * Supabase Auth sign-in.
 *
 * Not a password compared in JavaScript. That approach protects nothing --
 * the attacker never runs your component, they call the REST endpoint
 * directly with the anon key from your bundle. The only thing standing
 * between an anonymous caller and this data is the RLS policy set, and RLS
 * distinguishes `anon` from `authenticated`. So the gate has to mint a real
 * session, and that is what this does.
 */
function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(describeError(authError));
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050508] px-4">
      <form onSubmit={submit} className={`${CARD} w-full max-w-sm p-7`}>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-400">
          AiFight
        </p>
        <h1 className="mt-1 mb-6 text-2xl font-semibold text-slate-50">Operator sign-in</h1>

        <div className="space-y-4">
          <Field label="Email">
            <input
              className={INPUT}
              type="email"
              value={email}
              autoComplete="username"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Password">
            <input
              className={INPUT}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-emerald-400 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>

        <p className="mt-4 text-center text-xs leading-relaxed text-slate-600">
          Accounts are created in the Supabase dashboard under
          Authentication &rarr; Users. Public sign-ups should be disabled.
        </p>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Odds matrix                                                          */
/* -------------------------------------------------------------------- */

/**
 * Build the empty pricing draft for a sport.
 *
 * Prices are held by outcome INDEX rather than by label. Labels move --
 * changing a total from 2.5 to 3.5 rewrites "Over 2.5 Goals" into "Over 3.5
 * Goals", and a label-keyed map would strand the price the operator had
 * already typed under a key nothing reads any more. The index is stable
 * across every edit; the label is resolved once, at save.
 */
function emptyOddsDraft(sportKey) {
  const draft = {};
  for (const market of marketsFor(sportKey)) {
    draft[market.key] = {
      enabled: false,
      line: market.defaultLine ?? null,
      prices: {},
    };
  }
  return draft;
}

function MarketPricer({ sportKey, market, ctx, value, onChange }) {
  const outcomes = outcomesFor(sportKey, market.key, {
    ...ctx,
    line: value.line ?? market.defaultLine,
  });

  const set = (patch) => onChange({ ...value, ...patch });
  const setPrice = (index, price) =>
    onChange({ ...value, prices: { ...value.prices, [index]: price } });

  const priced = outcomes.filter((_, i) => toNumber(value.prices[i]) > 1).length;
  // The book's overround. Under 100% means the prices are arbitrageable --
  // almost always a typo, and worth flagging before it is published.
  const bookSum = outcomes.reduce((acc, _, i) => {
    const p = impliedProbability(value.prices[i]);
    return acc + (p ?? 0);
  }, 0);

  return (
    <div
      className={`rounded-lg border p-3 transition ${
        value.enabled ? "border-emerald-400/25 bg-emerald-400/[0.04]" : "border-white/10 bg-black/20"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-400"
          />
          <span>
            <span className="block text-sm font-medium text-slate-200">{market.label}</span>
            {market.note ? (
              <span className="mt-0.5 block text-xs leading-snug text-slate-500">{market.note}</span>
            ) : null}
          </span>
        </label>

        {value.enabled && priced > 0 ? (
          <Pill tone={bookSum > 0 && bookSum < 1 ? "red" : "slate"}>
            book {(bookSum * 100).toFixed(1)}%
          </Pill>
        ) : null}
      </div>

      {value.enabled ? (
        <div className="mt-3 space-y-2">
          {market.shape === "line" ? (
            <div className="flex items-center gap-2">
              <span className={`${LABEL} mb-0`}>{market.lineLabel}</span>
              <input
                className={`${INPUT} w-28 py-1 font-mono`}
                type="number"
                step={market.lineStep ?? 0.5}
                value={value.line ?? ""}
                onChange={(e) => set({ line: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
          ) : null}

          {outcomes.length === 0 ? (
            <p className="rounded border border-amber-400/25 bg-amber-400/5 px-2.5 py-2 text-xs text-amber-300/90">
              {market.shape === "roster"
                ? `Add ${market.entrantLabel?.toLowerCase() ?? "entrant"} names above to price this market.`
                : "Fill in the fixture above first."}
            </p>
          ) : (
            <div className="grid gap-1.5">
              {outcomes.map((outcome, i) => (
                <div key={`${outcome}-${i}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={outcome}>
                    {outcome}
                  </span>
                  <input
                    className={`${INPUT} w-24 py-1 text-right font-mono`}
                    type="number"
                    step="0.01"
                    min="1.01"
                    placeholder="--"
                    value={value.prices[i] ?? ""}
                    onChange={(e) => setPrice(i, e.target.value)}
                  />
                  <span className="w-12 shrink-0 text-right font-mono text-[10px] text-slate-600">
                    {impliedProbability(value.prices[i])
                      ? `${(impliedProbability(value.prices[i]) * 100).toFixed(0)}%`
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* LEFT COLUMN - The Match Board                                        */
/* -------------------------------------------------------------------- */

function MatchBoard({ events, onToast, reload }) {
  const [sportKey, setSportKey] = useState("soccer");
  const sport = getSport(sportKey);

  const [fields, setFields] = useState({});
  const [startsAt, setStartsAt] = useState("");
  const [round, setRound] = useState(1);
  const [entrantText, setEntrantText] = useState("");
  const [odds, setOdds] = useState(() => emptyOddsDraft("soccer"));
  const [busy, setBusy] = useState(false);

  // Switching sport clears the fixture as well as the prices. Carrying
  // "Arsenal" over into the NBA tab is not a convenience, it is a trap.
  useEffect(() => {
    setFields({});
    setEntrantText("");
    setOdds(emptyOddsDraft(sportKey));
  }, [sportKey]);

  // Default to the round already in progress rather than always 1.
  useEffect(() => {
    if (events.length > 0) {
      setRound(Math.max(...events.map((e) => e.round ?? 1)));
    }
  }, [events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const entrants = useMemo(
    () =>
      entrantText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [entrantText]
  );

  const ctx = { home: fields.home, away: fields.away, entrants };
  const eventName = composeEventName(sportKey, fields);

  const missing = (sport?.fields ?? [])
    .filter((f) => f.required && !String(fields[f.key] ?? "").trim())
    .map((f) => f.label);

  const pricedMarkets = Object.entries(odds).filter(
    ([, v]) => v.enabled && Object.values(v.prices).some((p) => toNumber(p) > 1)
  );

  async function publish(e) {
    e.preventDefault();
    if (missing.length > 0) {
      onToast(`Missing: ${missing.join(", ")}`, "error");
      return;
    }
    if (pricedMarkets.length === 0) {
      onToast("Price at least one market before publishing.", "error");
      return;
    }

    // Resolve index-keyed prices into the label-keyed matrix that is stored.
    // This is the single place that translation happens.
    const matrix = {};
    for (const [marketKey, draft] of pricedMarkets) {
      const labels = outcomesFor(sportKey, marketKey, { ...ctx, line: draft.line });
      const prices = {};
      labels.forEach((label, i) => {
        const price = toNumber(draft.prices[i]);
        // A blank box means "not offered", not "priced at zero".
        if (price > 1) prices[label] = price;
      });
      if (Object.keys(prices).length > 0) {
        matrix[marketKey] = { line: draft.line ?? null, prices };
      }
    }

    setBusy(true);
    const { error } = await supabase.from("events").insert({
      sport: sportKey,
      home: String(fields.home ?? "").trim(),
      away: fields.away ? String(fields.away).trim() : null,
      session: fields.session ? String(fields.session).trim() : null,
      competition: fields.competition ? String(fields.competition).trim() : null,
      event_name: eventName,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      round: Number(round) || 1,
      entrants,
      odds: matrix,
      status: "open",
    });
    setBusy(false);

    if (error) {
      onToast(describeError(error), "error");
      return;
    }
    onToast(`${eventName} published with ${Object.keys(matrix).length} market(s).`);
    setFields({});
    setEntrantText("");
    setStartsAt("");
    setOdds(emptyOddsDraft(sportKey));
    reload();
  }

  const sportEvents = events.filter((e) => e.sport === sportKey);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="font-mono text-xs uppercase tracking-[0.22em] text-emerald-400">
          The Match Board
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Create a fixture and price its markets. Published fixtures appear in the dispatcher.
        </p>
      </header>

      {/* Sport tabs */}
      <div className="flex flex-wrap gap-1.5">
        {SPORTS.map((s) => {
          const active = s.key === sportKey;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSportKey(s.key)}
              style={active ? { backgroundColor: s.accent, borderColor: s.accent } : undefined}
              className={`rounded-md border px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition ${
                active
                  ? "text-black"
                  : "border-white/10 bg-white/5 text-slate-400 hover:border-white/25 hover:text-slate-200"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <form onSubmit={publish} className={`${CARD} space-y-4 p-4`}>
        {/* Dynamic fixture fields */}
        <div className="grid gap-3 sm:grid-cols-2">
          {sport.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.required ? null : "optional"}>
              <input
                className={INPUT}
                type="text"
                placeholder={f.placeholder}
                value={fields[f.key] ?? ""}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
          <Field label="Starts" hint="optional">
            <input
              className={INPUT}
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label="Round">
            <input
              className={INPUT}
              type="number"
              min="1"
              value={round}
              onChange={(e) => setRound(e.target.value)}
            />
          </Field>
        </div>

        {/* Only once the required fields are actually filled -- previewing
            "undefined v undefined" is noise, not feedback. */}
        {missing.length === 0 && eventName ? (
          <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-400">
            Will be stored as <span className="text-slate-100">{eventName}</span>
          </p>
        ) : null}

        {/* Roster pool, only where a roster market exists */}
        {usesRoster(sportKey) ? (
          <div>
            <Field
              label={sport.kind === "race" ? "Drivers / entrants" : "Correct-score lines"}
              hint="one per line, or comma separated"
            >
              <textarea
                className={`${INPUT} min-h-[72px] font-mono`}
                value={entrantText}
                placeholder={
                  sport.kind === "race"
                    ? "Max Verstappen\nLando Norris\nCharles Leclerc"
                    : "2-1, 1-1, 1-0"
                }
                onChange={(e) => setEntrantText(e.target.value)}
              />
            </Field>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(marketsFor(sportKey).find((m) => m.presets)?.presets ?? []).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setEntrantText((prev) =>
                      prev
                        .split(/[\n,]/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .includes(p)
                        ? prev
                        : (prev.trim() ? `${prev.trim()}\n` : "") + p
                    )
                  }
                  className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-400 transition hover:border-white/25 hover:text-slate-100"
                >
                  +{p}
                </button>
              ))}
              {entrants.length > 0 ? (
                <span className="ml-auto font-mono text-[10px] text-slate-600">
                  {entrants.length} entrant{entrants.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* The odds matrix */}
        <div>
          <p className={LABEL}>Odds matrix &mdash; {sportLabel(sportKey)}</p>
          <div className="space-y-2">
            {marketsFor(sportKey).map((market) => (
              <MarketPricer
                key={market.key}
                sportKey={sportKey}
                market={market}
                ctx={ctx}
                value={odds[market.key] ?? { enabled: false, line: market.defaultLine, prices: {} }}
                onChange={(next) => setOdds((prev) => ({ ...prev, [market.key]: next }))}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-white/10 pt-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-emerald-400 px-5 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-40"
          >
            {busy ? "Publishing..." : "Publish fixture"}
          </button>
          <span className="font-mono text-[11px] text-slate-600">
            {pricedMarkets.length} market{pricedMarkets.length === 1 ? "" : "s"} priced
          </span>
        </div>
      </form>

      {/* Existing fixtures for this sport */}
      <div className={`${CARD} p-4`}>
        <p className={LABEL}>Published &mdash; {sportLabel(sportKey)}</p>
        {sportEvents.length === 0 ? (
          <p className="text-xs text-slate-600">Nothing on the board for this sport yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {sportEvents.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">{e.event_name}</p>
                  <p className="font-mono text-[10px] text-slate-600">
                    R{e.round} &middot; {Object.keys(e.odds ?? {}).length} markets &middot; {e.status}
                  </p>
                </div>
                <EventControls event={e} onToast={onToast} reload={reload} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EventControls({ event, onToast, reload }) {
  const [busy, setBusy] = useState(false);

  async function setStatus(status) {
    setBusy(true);
    const { error } = await supabase.from("events").update({ status }).eq("id", event.id);
    setBusy(false);
    if (error) onToast(describeError(error), "error");
    else reload();
  }

  async function remove() {
    // Bets cascade-delete with the fixture, so this is destructive to the
    // ledger and the confirmation is not decoration.
    if (!window.confirm(`Delete "${event.event_name}" and every pick logged against it?`)) return;
    setBusy(true);
    const { error } = await supabase.from("events").delete().eq("id", event.id);
    setBusy(false);
    if (error) onToast(describeError(error), "error");
    else {
      onToast("Fixture deleted.");
      reload();
    }
  }

  const btn =
    "rounded border border-white/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-slate-400 transition hover:border-white/30 hover:text-slate-100 disabled:opacity-40";

  return (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        disabled={busy}
        className={btn}
        onClick={() => setStatus(event.status === "open" ? "closed" : "open")}
      >
        {event.status === "open" ? "Close" : "Reopen"}
      </button>
      <button
        type="button"
        disabled={busy}
        className={`${btn} hover:border-rose-400/50 hover:text-rose-300`}
        onClick={remove}
      >
        Delete
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* RIGHT COLUMN - The Dispatcher & Settler                              */
/* -------------------------------------------------------------------- */

const EMPTY_ROW = {
  market: "",
  pick: "",
  odds: "",
  stake: "",
  fair_prob: "",
  confidence: "",
  reasoning: "",
  risk_factors: "",
};

/**
 * One fighter's input row for one fixture.
 *
 * Market and selection are dropdowns fed by the event's own priced matrix,
 * so a fighter cannot be logged onto a market that was never published --
 * the failure mode of the old free-text market box, which produced bets
 * nothing could render. Choosing a selection auto-fills the price, and the
 * price stays editable because the operator sometimes gets a better one
 * than the board.
 */
function FighterRow({ model, event, standing, existingBets, onToast, reload }) {
  const [row, setRow] = useState(EMPTY_ROW);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const meta = MODEL_META[model];
  const matrix = event.odds ?? {};
  const marketKeys = Object.keys(matrix);

  const selections = row.market ? Object.entries(matrix[row.market]?.prices ?? {}) : [];

  const alreadyLogged = existingBets.filter((b) => b.model === model);

  function set(patch) {
    setRow((prev) => ({ ...prev, ...patch }));
  }

  function choosePick(pick) {
    const price = matrix[row.market]?.prices?.[pick];
    set({ pick, odds: price != null ? String(price) : row.odds });
  }

  const ev = expectedValue(row.odds, row.fair_prob);
  const problems = validatePick(
    { ...row, model, event_id: event.id },
    { standing, existingBets }
  );
  // Only nag once the operator has actually engaged with the row.
  const started = Boolean(row.market || row.pick || row.stake || row.reasoning);

  async function log(e) {
    e.preventDefault();
    if (problems.length > 0) {
      onToast(problems[0], "error");
      return;
    }
    setBusy(true);

    let prob = row.fair_prob === "" ? null : toNumber(row.fair_prob);
    if (prob !== null && prob > 1) prob = prob / 100; // operators type both

    const { error } = await supabase.from("bets").insert({
      event_id: event.id,
      model,
      market: row.market,
      pick: row.pick,
      odds: toNumber(row.odds),
      stake: toNumber(row.stake),
      fair_prob: prob,
      confidence: row.confidence === "" ? null : Math.round(toNumber(row.confidence)),
      reasoning: row.reasoning.trim(),
      risk_factors: row.risk_factors.trim() || null,
      round: event.round ?? 1,
    });
    setBusy(false);

    if (error) {
      onToast(describeError(error), "error");
      return;
    }
    onToast(`${model} logged ${row.pick} @ ${row.odds}`);
    setRow(EMPTY_ROW);
    setOpen(false);
    reload();
  }

  const locked = standing?.liquidated || event.status !== "open";

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span
          className="h-6 w-6 shrink-0 rounded font-mono text-[10px] font-bold leading-6 text-center text-black"
          style={{ backgroundColor: meta.accent }}
        >
          {meta.code}
        </span>
        <span className="flex-1 text-sm font-medium text-slate-200">{model}</span>

        {alreadyLogged.length > 0 ? (
          <Pill tone="blue">{alreadyLogged.length} logged</Pill>
        ) : null}
        {standing?.liquidated ? (
          <Pill tone="red">liquidated</Pill>
        ) : (
          <span className="font-mono text-[10px] text-slate-500">
            {money(standing?.dailyRemaining ?? 0)} left today
          </span>
        )}
        <span className="font-mono text-xs text-slate-600">{open ? "−" : "+"}</span>
      </button>

      {open ? (
        <form onSubmit={log} className="space-y-2.5 border-t border-white/[0.07] p-3">
          {locked ? (
            <p className="rounded border border-amber-400/25 bg-amber-400/5 px-2.5 py-2 text-xs text-amber-300/90">
              {standing?.liquidated
                ? `${model} is liquidated. No further bets.`
                : "This fixture is closed. Reopen it on the match board to log picks."}
            </p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Market">
              <select
                className={INPUT}
                value={row.market}
                disabled={locked}
                onChange={(e) => set({ market: e.target.value, pick: "", odds: "" })}
              >
                <option value="">Select...</option>
                {marketKeys.map((k) => (
                  <option key={k} value={k}>
                    {marketLabel(event.sport, k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Selection">
              <select
                className={INPUT}
                value={row.pick}
                disabled={locked || !row.market}
                onChange={(e) => choosePick(e.target.value)}
              >
                <option value="">Select...</option>
                {selections.map(([label, price]) => (
                  <option key={label} value={label}>
                    {label} @ {price}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field label="Odds">
              <input
                className={`${INPUT} font-mono`}
                type="number"
                step="0.01"
                min="1.01"
                disabled={locked}
                value={row.odds}
                onChange={(e) => set({ odds: e.target.value })}
              />
            </Field>
            <Field label="Stake" hint={`max ${money(standing?.dailyRemaining ?? 0)}`}>
              <input
                className={`${INPUT} font-mono`}
                type="number"
                step="1"
                min="1"
                disabled={locked}
                value={row.stake}
                onChange={(e) => set({ stake: e.target.value })}
              />
            </Field>
            <Field label="Probability" hint="0-1 or %">
              <input
                className={`${INPUT} font-mono`}
                type="number"
                step="0.01"
                disabled={locked}
                value={row.fair_prob}
                onChange={(e) => set({ fair_prob: e.target.value })}
              />
            </Field>
          </div>

          {/* Live EV, recomputed from the operator's own numbers rather than
              trusted from whatever the model asserted in its reply. */}
          {ev !== null ? (
            <p
              className={`font-mono text-[11px] ${ev > 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              EV {percent(ev, 2)} per unit &middot; returns{" "}
              {money(toNumber(row.stake) * toNumber(row.odds))} on a win
            </p>
          ) : null}

          <Field label="Thesis" hint="published in the public rationale drawer">
            <textarea
              className={`${INPUT} min-h-[72px]`}
              value={row.reasoning}
              disabled={locked}
              placeholder="Why this bet exists. Include the assumption most likely to be wrong."
              onChange={(e) => set({ reasoning: e.target.value })}
            />
          </Field>

          <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
            <Field label="Risk factors" hint="optional">
              <input
                className={INPUT}
                type="text"
                disabled={locked}
                value={row.risk_factors}
                onChange={(e) => set({ risk_factors: e.target.value })}
              />
            </Field>
            <Field label="Confidence" hint="0-100">
              <input
                className={`${INPUT} font-mono`}
                type="number"
                min="0"
                max="100"
                disabled={locked}
                value={row.confidence}
                onChange={(e) => set({ confidence: e.target.value })}
              />
            </Field>
          </div>

          {started && problems.length > 0 ? (
            <ul className="space-y-0.5 rounded border border-amber-400/25 bg-amber-400/5 px-2.5 py-2">
              {problems.map((p) => (
                <li key={p} className="text-xs text-amber-300/90">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || locked || problems.length > 0}
              className="rounded-lg bg-emerald-400 px-4 py-1.5 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-30"
            >
              {busy ? "Logging..." : "Log pick"}
            </button>
            <button
              type="button"
              onClick={() => setRow(EMPTY_ROW)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:text-slate-100"
            >
              Clear
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * A logged pick with its grading controls.
 *
 * The three buttons show what each grade WOULD pay before it is clicked, so
 * settlement is never a guess. Clicking the grade a bet already holds
 * removes it and returns the bet to pending -- grading is a correction, not
 * a commitment, and there is no separate "undo" to hunt for.
 */
function LedgerRow({ bet, onToast, reload }) {
  const [busy, setBusy] = useState(false);
  const meta = MODEL_META[bet.model] ?? { accent: "#94a3b8", code: "???" };

  async function grade(result) {
    setBusy(true);
    // Toggle: re-clicking the current grade un-grades it.
    const next = bet.result === result ? null : result;
    const { error } = await supabase
      .from("bets")
      .update(settlementPatch(bet, next))
      .eq("id", bet.id);
    setBusy(false);
    if (error) onToast(describeError(error), "error");
    else {
      onToast(next ? `${bet.model}: ${bet.pick} graded ${next.toUpperCase()}` : "Grade cleared.");
      reload();
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${bet.model}'s ${bet.pick} bet? This changes the bankroll.`)) return;
    setBusy(true);
    const { error } = await supabase.from("bets").delete().eq("id", bet.id);
    setBusy(false);
    if (error) onToast(describeError(error), "error");
    else reload();
  }

  const GRADES = [
    { key: "win", label: "WIN", tone: "emerald" },
    { key: "loss", label: "LOSS", tone: "rose" },
    { key: "void", label: "VOID", tone: "slate" },
  ];

  const toneClass = {
    emerald: "border-emerald-400/40 text-emerald-300 hover:bg-emerald-400 hover:text-emerald-950",
    rose: "border-rose-400/40 text-rose-300 hover:bg-rose-400 hover:text-rose-950",
    slate: "border-slate-400/30 text-slate-300 hover:bg-slate-300 hover:text-slate-900",
  };
  const activeClass = {
    emerald: "bg-emerald-400 text-emerald-950 border-emerald-400",
    rose: "bg-rose-400 text-rose-950 border-rose-400",
    slate: "bg-slate-300 text-slate-900 border-slate-300",
  };

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/30 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="h-5 w-5 shrink-0 rounded text-center font-mono text-[9px] font-bold leading-5 text-black"
          style={{ backgroundColor: meta.accent }}
        >
          {meta.code}
        </span>
        <span className="text-sm text-slate-200">{bet.pick}</span>
        <span className="font-mono text-xs text-slate-500">@ {Number(bet.odds).toFixed(2)}</span>
        <span className="font-mono text-xs text-slate-500">{money(bet.stake)}</span>
        <Pill>{marketLabel(bet.sport ?? "", bet.market) || bet.market}</Pill>

        {bet.result ? (
          <Pill tone={bet.result === "win" ? "green" : bet.result === "loss" ? "red" : "slate"}>
            {bet.result} {signedMoney(bet.profit ?? 0)}
          </Pill>
        ) : (
          <Pill tone="amber">pending</Pill>
        )}

        <div className="ml-auto flex gap-1">
          {GRADES.map((g) => {
            const active = bet.result === g.key;
            const preview = payoutFor(bet, g.key);
            return (
              <button
                key={g.key}
                type="button"
                disabled={busy}
                onClick={() => grade(g.key)}
                title={`${g.label}: pays ${money(preview.payout ?? 0)} (${signedMoney(preview.profit)})`}
                className={`rounded border px-2 py-1 font-mono text-[10px] font-bold tracking-wider transition disabled:opacity-40 ${
                  active ? activeClass[g.tone] : toneClass[g.tone]
                }`}
              >
                {g.label}
                <span className="ml-1 font-normal opacity-70">{signedMoney(preview.profit)}</span>
              </button>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="rounded border border-white/10 px-2 py-1 font-mono text-[10px] text-slate-500 transition hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-40"
          >
            DEL
          </button>
        </div>
      </div>

      {bet.reasoning ? (
        <p className="mt-2 border-l-2 border-white/10 pl-2.5 text-xs leading-relaxed text-slate-500">
          {bet.reasoning}
        </p>
      ) : null}
    </div>
  );
}

function Dispatcher({ events, betsByEvent, fighters, onToast, reload }) {
  const [showClosed, setShowClosed] = useState(false);

  const visible = events.filter((e) => showClosed || e.status === "open");
  const byModel = Object.fromEntries(fighters.map((f) => [f.model, f]));

  return (
    <section className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-mono text-xs uppercase tracking-[0.22em] text-sky-400">
            AI Dispatcher &amp; Settler
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Log all five fighters against a fixture, then grade every pick inline.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-sky-400"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          show closed
        </label>
      </header>

      {visible.length === 0 ? (
        <div className={`${CARD} p-8 text-center`}>
          <p className="text-sm text-slate-400">No fixtures on the board.</p>
          <p className="mt-1 text-xs text-slate-600">
            Publish one from the match board on the left.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((event) => {
            const eventBets = betsByEvent.get(event.id) ?? [];
            const pending = eventBets.filter((b) => !b.result).length;
            const accent = getSport(event.sport)?.accent ?? "#94a3b8";

            return (
              <article key={event.id} className={`${CARD} overflow-hidden`}>
                <header
                  className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3"
                  style={{ borderLeft: `3px solid ${accent}` }}
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-slate-100">
                      {event.event_name}
                    </h3>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
                      {sportLabel(event.sport)}
                      {event.competition ? ` · ${event.competition}` : ""} &middot; R{event.round}
                      {event.starts_at
                        ? ` · ${new Date(event.starts_at).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : ""}
                    </p>
                  </div>
                  {event.status !== "open" ? <Pill tone="slate">closed</Pill> : null}
                  {pending > 0 ? <Pill tone="amber">{pending} to grade</Pill> : null}
                  <Pill tone="blue">{eventBets.length} picks</Pill>
                </header>

                <div className="space-y-1.5 p-3">
                  {MODELS.map((model) => (
                    <FighterRow
                      key={model}
                      model={model}
                      event={event}
                      standing={byModel[model]}
                      existingBets={eventBets}
                      onToast={onToast}
                      reload={reload}
                    />
                  ))}
                </div>

                {eventBets.length > 0 ? (
                  <div className="space-y-1.5 border-t border-white/10 bg-black/20 p-3">
                    <p className={LABEL}>Settlement</p>
                    {eventBets.map((bet) => (
                      <LedgerRow
                        key={bet.id}
                        bet={{ ...bet, sport: event.sport }}
                        onToast={onToast}
                        reload={reload}
                      />
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- */
/* Standings strip                                                      */
/* -------------------------------------------------------------------- */

function StandingsStrip({ fighters }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {fighters.map((f) => (
        <div
          key={f.model}
          className={`${CARD} relative overflow-hidden p-3 ${f.liquidated ? "opacity-60" : ""}`}
        >
          <div className="flex items-center gap-2">
            <span
              className="h-5 w-5 rounded text-center font-mono text-[9px] font-bold leading-5 text-black"
              style={{ backgroundColor: f.accent }}
            >
              {f.code}
            </span>
            <span className="text-xs font-medium text-slate-300">{f.model}</span>
            <span className="ml-auto font-mono text-[10px] text-slate-600">#{f.rank}</span>
          </div>

          <p
            className={`mt-2 font-mono text-lg font-bold ${
              f.liquidated ? "text-rose-400" : "text-slate-50"
            }`}
          >
            {money(f.bankroll)}
          </p>
          <p
            className={`font-mono text-[11px] ${
              f.profit > 0 ? "text-emerald-400" : f.profit < 0 ? "text-rose-400" : "text-slate-500"
            }`}
          >
            {signedMoney(f.profit)} &middot; ROI {percent(f.roi)}
          </p>

          {/* Daily budget meter */}
          <div className="mt-2">
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, f.dailyUsedPct)}%`,
                  backgroundColor: f.dailyUsedPct >= 100 ? "#f43f5e" : f.accent,
                }}
              />
            </div>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-slate-600">
              {money(f.stakedToday)} / {money(DAILY_LIMIT)} today
            </p>
          </div>

          {f.liquidated ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 px-2">
              {/* whitespace-nowrap plus a size that fits the narrowest card:
                  a stamp that wraps or overflows reads as a layout bug. */}
              <span className="whitespace-nowrap rotate-[-8deg] rounded border-2 border-rose-500 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-rose-400">
                Liquidated{f.liquidatedRound ? ` R${f.liquidatedRound}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* The panel                                                            */
/* -------------------------------------------------------------------- */

export default function AdminPanel() {
  const { session, checking } = useAuthSession();
  const arena = useArena();
  const [toast, setToast] = useState({ message: "", tone: "ok" });

  const notify = (message, tone = "ok") => setToast({ message, tone });
  const dismiss = () => setToast({ message: "", tone: "ok" });

  if (!isSupabaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050508] px-4">
        <div className={`${CARD} max-w-md p-6`}>
          <h1 className="mb-2 text-lg font-semibold text-rose-300">Supabase is not configured</h1>
          <p className="text-sm leading-relaxed text-slate-400">
            The build has no <code className="text-slate-200">VITE_SUPABASE_URL</code> or{" "}
            <code className="text-slate-200">VITE_SUPABASE_ANON_KEY</code>. Add both in Vercel
            under Settings &rarr; Environment Variables, then redeploy &mdash; Vite reads them at
            build time, so an existing deployment will not pick them up.
          </p>
        </div>
      </div>
    );
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050508]">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate-600">Checking session</p>
      </div>
    );
  }

  if (!session) return <SignIn />;

  return (
    <div className="min-h-screen bg-[#050508] text-slate-200">
      <div className="mx-auto max-w-[1800px] px-4 py-6 lg:px-8">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-400">
              AiFight Control
            </p>
            <h1 className="text-xl font-semibold text-slate-50">Command Console</h1>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  arena.error ? "bg-rose-400" : "bg-emerald-400 animate-pulse"
                }`}
              />
              {arena.error ? "sync error" : "live"}
              {arena.lastSync ? ` · ${arena.lastSync.toLocaleTimeString("en-GB")}` : ""}
            </span>
            <a
              href="/"
              className="rounded border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition hover:border-white/30 hover:text-slate-100"
            >
              View arena
            </a>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="rounded border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition hover:border-white/30 hover:text-slate-100"
            >
              Sign out
            </button>
          </div>
        </header>

        {arena.error ? (
          <p className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
            {arena.error}
          </p>
        ) : null}

        <div className="mb-5">
          <StandingsStrip fighters={arena.fighters} />
        </div>

        {/* The two columns. Stacked below xl so the panel stays usable on a
            laptop rather than compressing both halves into uselessness. */}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <MatchBoard events={arena.events} onToast={notify} reload={arena.reload} />
          <Dispatcher
            events={arena.events}
            betsByEvent={arena.betsByEvent}
            fighters={arena.fighters}
            onToast={notify}
            reload={arena.reload}
          />
        </div>
      </div>

      <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />
    </div>
  );
}
