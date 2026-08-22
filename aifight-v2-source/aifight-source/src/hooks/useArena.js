import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, isSupabaseConfigured, describeError } from "../lib/supabaseClient";
import { standings, challengeProgress } from "../lib/engine";

/**
 * The one data hook. Both the admin panel and the public arena use it.
 *
 * WHY BOTH SIDES SHARE THIS
 * -------------------------
 * The admin and the arena previously had separate fetch paths, and they
 * disagreed -- the admin showed picks the public site did not, which is the
 * bug that has been chased through three rewrites. One query, one shape, one
 * set of derived numbers means the operator is always looking at exactly
 * what a visitor sees.
 *
 * WHY THE QUERY IS FLAT
 * ---------------------
 * Two plain selects, joined in JavaScript on `event_id`. No PostgREST
 * embedding (`select=*,bets(*)`), because an embedded select silently
 * returns an empty array when RLS hides the child rows or the foreign key
 * hint is ambiguous -- and "silently empty" is indistinguishable from "no
 * bets yet". Two flat queries fail loudly and separately, and 100kB of rows
 * costs nothing to merge client-side.
 */
export function useArena({ realtime = true } = {}) {
  const [events, setEvents] = useState([]);
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  // Guards a state update after unmount, and lets a slow response from an
  // earlier fetch lose to a faster later one.
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setError(
        "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
      );
      setLoading(false);
      return;
    }

    const mine = ++generation.current;
    setError(null);

    const [eventsRes, betsRes] = await Promise.all([
      supabase
        .from("events")
        .select("*")
        .order("starts_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false }),
      supabase.from("bets").select("*").order("logged_at", { ascending: false }),
    ]);

    if (mine !== generation.current) return; // superseded

    if (eventsRes.error || betsRes.error) {
      setError(describeError(eventsRes.error ?? betsRes.error));
      setLoading(false);
      return;
    }

    setEvents(eventsRes.data ?? []);
    setBets(betsRes.data ?? []);
    setLastSync(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Live sync.
   *
   * Any change to either table triggers a full reload rather than a surgical
   * patch of local state. A few kilobytes of refetch is cheap; reconciling
   * INSERT / UPDATE / DELETE payloads by hand is where phantom rows and
   * stale bankrolls come from. Correct beats clever at this size.
   */
  useEffect(() => {
    if (!realtime || !isSupabaseConfigured) return;

    const channel = supabase
      .channel("aifight-arena")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "bets" }, load)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [realtime, load]);

  // Refresh when the tab comes back. Realtime drops its socket on a
  // backgrounded tab, so without this the board can be quietly hours stale.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const fighters = useMemo(() => standings(bets), [bets]);
  const challenge = useMemo(() => challengeProgress(bets), [bets]);

  const betsByEvent = useMemo(() => {
    const map = new Map();
    for (const bet of bets) {
      if (!map.has(bet.event_id)) map.set(bet.event_id, []);
      map.get(bet.event_id).push(bet);
    }
    return map;
  }, [bets]);

  return {
    events,
    bets,
    betsByEvent,
    fighters,
    challenge,
    loading,
    error,
    lastSync,
    reload: load,
    configured: isSupabaseConfigured,
  };
}

/**
 * Supabase Auth session, for the admin gate.
 *
 * `getSession()` first so a returning operator is not flashed the login form
 * while the stored token is being validated, then `onAuthStateChange` for
 * everything after -- including a token expiring mid-session, which
 * otherwise shows up as writes mysteriously failing.
 */
export function useAuthSession() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next ?? null);
      setChecking(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, checking };
}
