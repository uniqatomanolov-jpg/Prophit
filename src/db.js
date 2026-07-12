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

CREATE TABLE IF NOT EXISTS outcomes (
  fixture_id INTEGER, market TEXT, outcome TEXT,
  PRIMARY KEY (fixture_id, market)
);
`);

// safe migration — add value-betting columns if an older DB predates them
for (const col of ["probability REAL", "edge REAL"]) {
  try { db.exec(`ALTER TABLE picks ADD COLUMN ${col}`); } catch { /* already exists */ }
}

export const upsertFixture = db.prepare(`
  INSERT INTO fixtures (id, sport, comp, home, away, entrants, kickoff, status, score, raw)
  VALUES (@id, @sport, @comp, @home, @away, @entrants, @kickoff, @status, @score, @raw)
  ON CONFLICT(id) DO UPDATE SET status=@status, score=@score, raw=@raw, entrants=COALESCE(@entrants, entrants)
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

export const gradePick = db.prepare(`UPDATE picks SET correct=@correct WHERE fixture_id=@fixture_id AND model=@model AND market=@market`);
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
    WHERE (@sport = 'all' OR f.sport = @sport) ORDER BY p.market`),
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
  manualPending: db.prepare(`
    SELECT * FROM fixtures WHERE id LIKE 'manual:%' AND status='upcoming' AND kickoff IS NOT NULL`),
  claudeStats: db.prepare(`
    SELECT COUNT(*) total,
      SUM(p.correct) wins,
      ROUND(SUM(CASE WHEN p.correct=1 THEN COALESCE(p.price,1.9)-1 ELSE -1 END), 2) profit,
      ROUND(100.0*SUM(p.correct)/COUNT(*),1) accuracy,
      ROUND(100.0*SUM(CASE WHEN p.correct=1 THEN COALESCE(p.price,1.9)-1 ELSE -1 END)/COUNT(*),1) roi,
      ROUND(AVG(p.edge),1) avg_edge
    FROM picks p JOIN fixtures f ON f.id=p.fixture_id
    WHERE p.model='claude' AND p.correct IS NOT NULL AND (@sport='all' OR f.sport=@sport)`),
  // settled bet history ("receipts") — most recent first, with running profit computed in JS
  claudeHistory: db.prepare(`
    SELECT f.sport, f.comp, f.home, f.away, f.kickoff, f.score,
      p.market, p.pick, p.price, p.probability, p.edge, p.correct
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
