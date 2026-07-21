import { ingestEvents } from "./uploads.js";
const SYSTEM_PROMPT = [
  'You read betting/bookmaker screenshots and output ONLY strict JSON — no prose, no markdown.',
  'Return a JSON ARRAY; each element:',
  '{"sport":"soccer|basketball|tennis|darts|snooker","competition":string,"home":string,"away":string,"kickoff":"YYYY-MM-DD HH:MM","market":"x12|ml|goals_ou|total|spread","odds":{"home":number,"draw":number,"away":number}}',
  'RULES: x12=3-way football (include draw); ml=2-way winner (no draw). Decimal odds only; convert American to decimal.',
  'home=left/first team, away=right/second; map each side to its own price; never output identical odds for both unless shown equal.',
  'kickoff: use shown date/time; time-only=assume today; nothing="UNKNOWN" (do not invent).',
  '',
  'OVER/UNDER LISTS (one row per match, two prices):',
  '{"sport":"soccer","competition":string,"home":string,"away":string,"kickoff":"YYYY-MM-DD HH:MM","market":"goals_ou","line":2.5,"odds":{"over":2.05,"under":1.72}}',
  'READ THE LINE OFF EACH ROW SEPARATELY — a list often mixes Over/Under 2.5 and Over/Under 3.5. Never copy one row\'s line onto another.',
  'Dates like "21/07 21:00" are day/month; a "Tomorrow"/"Today" section header applies to every row beneath it until the next header.',
  '',
  'OUTRIGHT / FIELD MARKETS (Formula 1, MotoGP, golf, cycling, NASCAR):',
  'A screenshot headed "Winner", "Podium Finish", "Top 6 Finish", "Top 10 Finish", "Outright" or "To Win" that lists MANY runners each with one price is NOT a series of head-to-heads.',
  'Never pair runners against each other. Emit ONE element for the whole race:',
  '{"sport":"f1|motogp|golf|nascar|cycling","competition":string,"home":"<race name, e.g. Hungarian Grand Prix>","market":"winner|podium|top6|top10","kickoff":"YYYY-MM-DD HH:MM","selections":[{"name":"<driver>","odds":number}, ...]}',
  'Omit "away" entirely for these. Include EVERY runner shown, including 500.00 outsiders.',
  'The runners in an outright are COMPETITORS IN ONE EVENT, not opponents. Charles Leclerc and George Russell in a Podium Finish list are two selections in the same race \u2014 never "Leclerc v Russell".',
  'Infer the sport from the runners, not from other screenshots: F1 drivers -> "f1", MotoGP riders -> "motogp", golfers -> "golf". Never label a driver list as darts/tennis.',
  'A single "Yes" or "Odds" column beside a list of people is an outright: one row per person, that price is theirs.',
  'The event name is usually the page heading (e.g. "Hungarian Grand Prix") \u2014 put it in "home", and put the market heading in "market", NOT in "competition".',
  'Map the heading to the market: Winner/To Win Race->winner; Podium/Top 3->podium; Top 6->top6; Top 10->top10.',
  'If a "Closes: dd/mm HH:MM" or similar is shown, use it as the kickoff (assume the current year).',
  '',
  'Only include matches where both names and the two main prices are clearly readable. Output [] if unsure. ONLY the JSON array.'
].join("\n");
const VISION_MODEL = process.env.VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const FALLBACK_MODEL = process.env.VISION_FALLBACK_MODEL || "claude-3-5-sonnet-20241022";
function stripToJSON(text){let t=String(text||"").trim();t=t.replace(/^```(?:json)?/i,"").replace(/```$/i,"").trim();const a=t.indexOf("["),b=t.lastIndexOf("]");if(a>=0&&b>a)t=t.slice(a,b+1);return t;}
function toCsvRows(items){
  const rows=[["sport","kickoff","competition","home","away","market","option","line","odds"]];
  const esc=(v)=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
  for(const it of items||[]){
    if(!it||!it.home||(!it.away&&!Array.isArray(it.selections)))continue;
    if(Array.isArray(it.selections))it.away="";        // outright field: one fixture, no opponent
    if(!it.odds&&!Array.isArray(it.selections))continue;
    it.odds=it.odds||{};
    const ko=it.kickoff&&it.kickoff!=="UNKNOWN"?it.kickoff:"";
    const mk=it.market||(it.odds.draw!=null?"x12":"ml");
    const push=(option,odds)=>{if(odds==null||isNaN(Number(odds)))return;rows.push([it.sport||"soccer",ko,it.competition||"Screenshot",it.home,it.away,mk,option,"",Number(odds)].map(esc).join(","));};
    if(mk==="x12"||mk==="corners_3way"){push("home",it.odds.home);push("draw",it.odds.draw);push("away",it.odds.away);}
    else if(it.odds.over!=null||it.odds.under!=null){var ln=it.line!=null?" "+it.line:"";push("Over"+ln,it.odds.over);push("Under"+ln,it.odds.under);}
    else if(Array.isArray(it.selections)){it.selections.forEach(function(sel){push(sel.name,sel.odds);});}
    else{push(it.home,it.odds.home);push(it.away,it.odds.away);}
  }
  return rows.join("\n");
}
export { toCsvRows };  // exported for tests
// The API only accepts these four. A paste often arrives as "image/jpg", which is
// NOT a valid media type and is rejected with a bare 400.
const MEDIA_OK=new Set(["image/png","image/jpeg","image/gif","image/webp"]);
function canonMedia(m){
  const v=String(m||"").toLowerCase().split(";")[0].trim();
  if(v==="image/jpg"||v==="image/jpe")return "image/jpeg";
  return MEDIA_OK.has(v)?v:"image/png";
}

async function callVision(model,base64,mediaType){
  const key=process.env.ANTHROPIC_API_KEY;
  const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model,max_tokens:8000,system:SYSTEM_PROMPT,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:"extract"}]}]})});
  if(res.ok)return res.json();
  // surface WHY — a bare "vision API 400" is unactionable
  let detail="";
  try{const body=await res.json();detail=body?.error?.message||JSON.stringify(body).slice(0,200);}
  catch{detail=(await res.text().catch(()=>"")).slice(0,200);}
  const err=new Error(`vision API ${res.status}: ${detail||"no detail returned"}`);
  err.status=res.status; err.detail=detail;
  throw err;
}

export async function parseScreenshot(base64,mediaType){
  const key=process.env.ANTHROPIC_API_KEY; if(!key)throw new Error("ANTHROPIC_API_KEY not set");
  const media=canonMedia(mediaType);
  // base64 inflates by ~4/3; the API caps an image at 5MB decoded
  const bytes=Math.floor(String(base64).length*0.75);
  if(bytes>5*1024*1024)throw new Error(`screenshot is ${(bytes/1048576).toFixed(1)}MB — the vision API caps images at 5MB. Crop it, or screenshot a smaller region.`);
  let data;
  try{ data=await callVision(VISION_MODEL,base64,media); }
  catch(e){
    // a wrong/retired model id is the most common 400 — fall back once, loudly
    if(e.status===400&&/model/i.test(e.detail||"")&&VISION_MODEL!==FALLBACK_MODEL){
      console.warn(`[vision] ${VISION_MODEL} rejected (${e.detail}) — retrying with ${FALLBACK_MODEL}`);
      data=await callVision(FALLBACK_MODEL,base64,media);
    } else throw e;
  }
  const text=(data.content||[]).filter((b)=>b.type==="text").map((b)=>b.text).join("");
  let items;
  try{items=JSON.parse(stripToJSON(text));}
  catch{
    const stop=data.stop_reason;
    throw new Error(stop==="max_tokens"
      ? "the screenshot has more markets than fit in one reply — crop it into two and upload separately"
      : `Claude did not return usable JSON (${String(text).slice(0,120)||"empty reply"})`);
  }
  if(!Array.isArray(items))items=[items];
  return { parsed:items, ...ingestEvents(toCsvRows(items)) };
}
