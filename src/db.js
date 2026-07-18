import Database from "better-sqlite3";

export const db = new Database(process.env.DB_PATH || "prophit.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,             -- provider fixture/event id (prefixed with sport to stay unique)
  sport TEXT,                      -- soccer | tennis | nba | ... | f1 | motogp
  comp TEXT,                       -- competition + round/venue
  home TEXT, away TEXT,            -- h2h only
  entrants JSON,                   -- race only: ordered grid/field of names
  kickoff TEXT,
  status TEXT DEFAULT 'upcoming',  -- upcoming | live | final
  score TEXT,
  raw JSON
);

CREATE TABLE IF NOT EXISTS odds (
  fixture_id INTEGER, market TEXT, option TEXT, price REAL,
  PRIMARY KEY (fixture_id, market, option)
);

CREATE TABLE IF NOT EXISTS picks (
  fixture_id INTEGER, model TEXT, market TEXT,
  pick TEXT, confidence INTEGER, price REAL,   -- price = closing odds of the pick, for ROI
  reasoning TEXT, created_at TEXT DEFAULT (datetime('now')),
  correct INTEGER,                              -- null until graded; 1/0 after
  PRIMARY KEY (fixture_id, model, market)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'none',
  subscription_tier TEXT DEFAULT 'free',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS showdown_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  starting_bankroll REAL DEFAULT 100.0,
  current_bankroll REAL DEFAULT 100.0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS showdown_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS showdown_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER,
  round_id INTEGER,
  event TEXT,
  market TEXT,
  pick TEXT,
  odds REAL,
  stake REAL,
  result TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS compounding_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT 'Run to a Million',
  starting_bankroll REAL DEFAULT 100.0,
  current_bankroll REAL DEFAULT 100.0,
  peak_bankroll REAL DEFAULT 100.0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS compounding_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  fixture_id TEXT,
  market TEXT,
  option TEXT,
  odds REAL,
  stake REAL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS outcomes (
  fixture_id INTEGER, market TEXT, outcome TEXT,
  PRIMARY KEY (fixture_id, market)
);
`);

// safe migration — add value-betting columns if an older DB predates them
for (const col of ["probability REAL", "edge REAL", "settled_odds REAL", "settled_fair_price REAL", "edge_at_placement REAL", "settled_at TEXT"]) {
  try { db.exec(`ALTER TABLE picks ADD COLUMN ${col}`); } catch { /* already exists */ }
}

export const upsertFixture = db.prepare(`
  INSERT INTO fixtures (id, sport, comp, home, away, entrants, kickoff, status, score, raw)
  VALUES (@id, @sport, @comp, @home, @away, @entrants, @kickoff, @status, @score, @raw)
  ON CONFLICT(id) DO UPDATE SET status=@status, score=@score, raw=@raw, entrants=COALESCE(@entrants, entrants), kickoff=COALESCE(@kickoff, kickoff), comp=@comp
`);

export const upsertOdd = db.prepare(`
  INSERT INTO odds VALUES (@fixture_id, @market, @option, @price)
  ON CONFLICT(fixture_id, market, option) DO UPDATE SET price=@price
`);

export const insertPick = db.prepare(`
  INSERT OR IGNORE INTO picks (fixture_id, model, market, pick, confidence, price, reasoning, probability, edge)
  VALUES (@fixture_id, @model, @market, @pick, @confidence, @price, @reasoning, @probability, @edge)
`);

export const setOutcome = db.prepare(`
  INSERT INTO outcomes VALUES (@fixture_id, @market, @outcome)
  ON CONFLICT(fixture_id, market) DO UPDATE SET outcome=@outcome
`);

export const gradePick = db.prepare(`
  UPDATE picks SET correct=@correct,
    settled_odds=COALESCE(settled_odds, price),
    settled_fair_price=COALESCE(settled_fair_price, CASE WHEN probability>0 THEN ROUND(100.0/probability,3) ELSE NULL END),
    edge_at_placement=COALESCE(edge_at_placement, edge),
    settled_at=COALESCE(settled_at, datetime('now'))
  WHERE fixture_id=@fixture_id AND model=@model AND market=@market`);
export const markFinal = db.prepare(`UPDATE fixtures SET status='final', score=@score WHERE id=@id`);

export const q = {
  upcoming: db.prepare(`SELECT * FROM fixtures WHERE status='upcoming' ORDER BY kickoff`),
  finishedUngraded: db.prepare(`
    SELECT DISTINCT f.* FROM fixtures f JOIN picks p ON p.fixture_id=f.id
    WHERE f.status='final' AND p.correct IS NULL`),
  fixturesAll: db.prepare(`SELECT * FROM fixtures ORDER BY kickoff DESC LIMIT 200`),
  fixturesBySport: db.prepare(`SELECT * FROM fixtures WHERE sport=@sport ORDER BY kickoff DESC LIMIT 100`),
  oddsFor: db.prepare(`SELECT market, option, price FROM odds WHERE fixture_id=?`),
  picksFor: db.prepare(`SELECT model, market, pick, confidence, price, correct, reasoning, probability, edge FROM picks WHERE fixture_id=?`),
  hasPicks: db.prepare(`SELECT COUNT(*) n FROM picks WHERE fixture_id=? AND model=?`),
  distinctMarkets: db.prepare(`
    SELECT DISTINCT p.market FROM picks p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.correct IS NOT NULL AND (@sport = 'all' OR f.sport = @sport) ORDER BY p.market`),
  picksList: db.prepare(`
    SELECT p.fixture_id, f.sport, f.comp, f.home, f.away, f.kickoff, f.status, f.score,
           p.model, p.market, p.pick, p.confidence, p.price, p.reasoning, p.created_at,
           p.correct, p.probability, p.edge, o.outcome
    FROM picks p
    JOIN fixtures f ON f.id = p.fixture_id
    LEFT JOIN outcomes o ON o.fixture_id = p.fixture_id AND o.market = p.market
    WHERE (@sport  = 'all' OR f.sport  = @sport)
      AND (@model  = 'all' OR p.model  = @model)
      AND (@status = 'all' OR (@status = 'settled' AND p.correct IS NOT NULL)
                          OR (@status = 'open'    AND p.correct IS NULL))
    ORDER BY f.kickoff DESC, p.model
    LIMIT @limit`),
  recentResults: db.prepare(`
    SELECT p.model, p.correct, f.kickoff
    FROM picks p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.correct IS NOT NULL AND (@sport = 'all' OR f.sport = @sport)
    ORDER BY f.kickoff DESC LIMIT 400`),
  // headline P&L stats (settled Claude picks only — honest record)
  distinctSports: db.prepare(`SELECT DISTINCT sport FROM fixtures ORDER BY sport`),
  bySport: db.prepare(`
    SELECT f.sport AS sport,
      COUNT(*) AS settled,
      ROUND(100.0*SUM(CASE WHEN p.correct=1 THEN 1 ELSE 0 END)/COUNT(*),1) AS winRate,
      ROUND(100.0*SUM(CASE WHEN p.correct=1 THEN COALESCE(p.settled_odds,p.price,1.9)-1 ELSE -1 END)/COUNT(*),1) AS roi
    FROM picks p JOIN fixtures f ON f.id=p.fixture_id
    WHERE p.model='claude' AND p.correct IS NOT NULL
    GROUP BY f.sport HAVING COUNT(*) >= 1 ORDER BY roi DESC`),
  cmpActiveRun: db.prepare(`SELECT * FROM compounding_runs WHERE status='active' ORDER BY id DESC LIMIT 1`),
  sdModels: db.prepare(`SELECT * FROM showdown_models ORDER BY current_bankroll DESC, name ASC`),
  sdModelByName: db.prepare(`SELECT * FROM showdown_models WHERE name=@name`),
  sdSeed: db.prepare(`INSERT OR IGNORE INTO showdown_models (name) VALUES (@name)`),
  sdSetBank: db.prepare(`UPDATE showdown_models SET current_bankroll=@bank WHERE id=@id`),
  sdResetAll: db.prepare(`UPDATE showdown_models SET current_bankroll=100.0`),
  sdRounds: db.prepare(`SELECT * FROM showdown_rounds ORDER BY id DESC`),
  sdNewRound: db.prepare(`INSERT INTO showdown_rounds (label) VALUES (@label)`),
  sdAddBet: db.prepare(`INSERT INTO showdown_bets (model_id, round_id, event, market, pick, odds, stake) VALUES (@model_id,@round_id,@event,@market,@pick,@odds,@stake)`),
  sdBets: db.prepare(`SELECT b.*, m.name AS model FROM showdown_bets b JOIN showdown_models m ON m.id=b.model_id ORDER BY b.id DESC`),
  sdBetById: db.prepare(`SELECT * FROM showdown_bets WHERE id=@id`),
  sdSetBet: db.prepare(`UPDATE showdown_bets SET result=@result WHERE id=@id`),
  sdBetsForRound: db.prepare(`SELECT * FROM showdown_bets WHERE round_id=@round AND result='pending'`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email=@email`),
  userByCustomer: db.prepare(`SELECT * FROM users WHERE stripe_customer_id=@cid`),
  userUpsert: db.prepare(`INSERT INTO users (email, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_tier)
    VALUES (@email,@cid,@sid,@status,@tier)
    ON CONFLICT(email) DO UPDATE SET stripe_customer_id=COALESCE(@cid,stripe_customer_id),
      stripe_subscription_id=COALESCE(@sid,stripe_subscription_id), subscription_status=@status, subscription_tier=@tier`),
  userSetStatusByCustomer: db.prepare(`UPDATE users SET subscription_status=@status, subscription_tier=@tier, stripe_subscription_id=COALESCE(@sid,stripe_subscription_id) WHERE stripe_customer_id=@cid`),
  cmpArchiveAll: db.prepare(`UPDATE compounding_runs SET status='archived' WHERE status='active'`),
  cmpNewRun: db.prepare(`INSERT INTO compounding_runs (name, starting_bankroll, current_bankroll, peak_bankroll) VALUES (@name, @bank, @bank, @bank)`),
  cmpBets: db.prepare(`SELECT b.*, f.home, f.away, f.sport, f.comp, f.kickoff FROM compounding_bets b LEFT JOIN fixtures f ON f.id=b.fixture_id WHERE b.run_id=@run ORDER BY b.id ASC`),
  cmpPendingForFixture: db.prepare(`SELECT b.* FROM compounding_bets b JOIN compounding_runs r ON r.id=b.run_id WHERE r.status='active' AND b.status='pending' AND b.fixture_id=@fid`),
  cmpAddBet: db.prepare(`INSERT INTO compounding_bets (run_id, fixture_id, market, option, odds, stake) VALUES (@run, @fid, @market, @option, @odds, @stake)`),
  cmpSetBet: db.prepare(`UPDATE compounding_bets SET status=@status WHERE id=@id`),
  cmpSetBank: db.prepare(`UPDATE compounding_runs SET current_bankroll=@bank, peak_bankroll=MAX(peak_bankroll,@bank), status=@status WHERE id=@id`),
  unsettledPast: db.prepare(`
    SELECT f.id, f.sport, f.comp, f.home, f.away, f.kickoff,
      (SELECT COUNT(*) FROM picks p WHERE p.fixture_id=f.id) npicks
    FROM fixtures f
    WHERE f.status='upcoming' AND f.kickoff IS NOT NULL
      AND datetime(replace(f.kickoff,' ','T')) < datetime('now','-2 hours')
    ORDER BY f.kickoff DESC LIMIT 100`),
  manualPending: db.prepare(`
    SELECT * FROM fixtures WHERE id LIKE 'manual:%' AND status='upcoming' AND kickoff IS NOT NULL`),
  claudeStats: db.prepare(`
    SELECT COUNT(*) total,
      SUM(p.correct) wins,
      ROUND(SUM(CASE WHEN p.correct=1 THEN COALESCE(p.settled_odds,p.price,1.9)-1 ELSE -1 END), 2) profit,
      ROUND(100.0*SUM(p.correct)/COUNT(*),1) accuracy,
      ROUND(100.0*SUM(CASE WHEN p.correct=1 THEN COALESCE(p.settled_odds,p.price,1.9)-1 ELSE -1 END)/COUNT(*),1) roi,
      ROUND(AVG(p.edge),1) avg_edge
    FROM picks p JOIN fixtures f ON f.id=p.fixture_id
    WHERE p.model='claude' AND p.correct IS NOT NULL AND (@sport='all' OR f.sport=@sport)`),
  // settled bet history ("receipts") — most recent first, with running profit computed in JS
  claudeHistory: db.prepare(`
    SELECT f.sport, f.comp, f.home, f.away, f.kickoff, f.score,
      p.market, p.pick,
      COALESCE(p.settled_odds, p.price) AS price,
      p.probability,
      COALESCE(p.edge_at_placement, p.edge) AS edge,
      p.correct, p.settled_at
    FROM picks p JOIN fixtures f ON f.id=p.fixture_id
    WHERE p.model='claude' AND p.correct IS NOT NULL AND (@sport='all' OR f.sport=@sport)
    ORDER BY f.kickoff DESC LIMIT 200`),
  leaderboard: db.prepare(`
    SELECT p.model,
      COUNT(*) total,
      SUM(p.correct) wins,
      ROUND(100.0 * SUM(p.correct) / COUNT(*), 1) accuracy,
      ROUND(100.0 * SUM(CASE WHEN p.correct=1 THEN COALESCE(p.price,1.9) - 1 ELSE -1 END) / COUNT(*), 1) roi
    FROM picks p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.correct IS NOT NULL
      AND (@sport  = 'all' OR f.sport  = @sport)
      AND (@market = 'all' OR p.market = @market)
    GROUP BY p.model ORDER BY accuracy DESC`),
};

// seed the 4 AI competitors once
["Grok","ChatGPT","Gemini","Claude"].forEach((name)=>{ try { q.sdSeed.run({ name }); } catch {} });
