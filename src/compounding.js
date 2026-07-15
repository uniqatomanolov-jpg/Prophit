import { db, q } from "./db.js";
export function settleCompoundingBet(betId, result, run) {
  const bet = db.prepare("SELECT * FROM compounding_bets WHERE id=?").get(betId);
  if (!bet || bet.status !== "pending") return;
  let bank = run.current_bankroll, status = run.status;
  if (result === "win") { bank = Math.round((bank + bet.stake * (bet.odds - 1)) * 100) / 100; q.cmpSetBet.run({ id: betId, status: "win" }); }
  else { bank = Math.round((bank - bet.stake) * 100) / 100; q.cmpSetBet.run({ id: betId, status: "loss" }); }
  if (bank >= 1000000) status = "completed";
  if (bank < 1) { bank = 100; status = "active"; db.prepare("UPDATE compounding_runs SET starting_bankroll=100 WHERE id=?").run(run.id); }
  q.cmpSetBank.run({ id: run.id, bank, status });
}
