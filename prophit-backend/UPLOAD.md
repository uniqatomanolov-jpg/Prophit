# Add your own events, markets & odds by CSV (daily spreadsheet)

For markets the API doesn't cover (corners, cards, player props, niche leagues), upload a spreadsheet each day. Keep your data in Excel/Google Sheets, then **File → Download → CSV** and upload it.

## 1) Events + odds  → `templates/events-template.csv`
Columns: `sport,kickoff,competition,home,away,market,option,line,odds`
- One **row per option**. Rows sharing sport+kickoff+home+away become one event.
- `line` optional — it's appended to the option (`Over` + `9.5` → `Over 9.5`).
- `market` is any label you like (`x12`, `btts`, `corners`, `player_shots`…). The AIs will predict every market you provide.

Upload it:
```
curl -X POST https://YOUR-BACKEND/api/upload/events \
     -H "Content-Type: text/csv" --data-binary @events.csv
```
Then run predictions (or wait for the cron): `npm run predict`.

## 2) Results  → `templates/results-template.csv`
So your manual markets count toward accuracy/ROI, upload outcomes after games finish:
Columns: `sport,kickoff,home,away,market,outcome,score`
- `outcome` must match the winning option text (e.g. `Over 9.5`, `Yes`, `Alcaraz`).
```
curl -X POST https://YOUR-BACKEND/api/upload/results \
     -H "Content-Type: text/csv" --data-binary @results.csv
```
This settles those picks and updates the per-market leaderboards.

## Notes
- Use the **same** sport/kickoff/home/away in results as in events (that's how they're matched).
- Uploaded events show up in `/api/fixtures` and the site alongside API events.
- Per-market leaderboards (`/api/leaderboard?market=corners`) fill in as you upload results.
