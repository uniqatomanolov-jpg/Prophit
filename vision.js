import { ingestEvents } from "./uploads.js";
const SYSTEM_PROMPT = [
  'You read betting/bookmaker screenshots and output ONLY strict JSON — no prose, no markdown.',
  'Return a JSON ARRAY; each element:',
  '{"sport":"soccer|basketball|tennis|darts|snooker","competition":string,"home":string,"away":string,"kickoff":"YYYY-MM-DD HH:MM","market":"x12|ml|goals_ou|total|spread","odds":{"home":number,"draw":number,"away":number}}',
  'RULES: x12=3-way football (include draw); ml=2-way winner (no draw). Decimal odds only; convert American to decimal.',
  'home=left/first team, away=right/second; map each side to its own price; never output identical odds for both unless shown equal.',
  'kickoff: use shown date/time; time-only=assume today; nothing="UNKNOWN" (do not invent).',
  'Only include matches where both names and the two main prices are clearly readable. Output [] if unsure. ONLY the JSON array.'
].join("\n");
const VISION_MODEL = process.env.VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
function stripToJSON(text){let t=String(text||"").trim();t=t.replace(/^```(?:json)?/i,"").replace(/```$/i,"").trim();const a=t.indexOf("["),b=t.lastIndexOf("]");if(a>=0&&b>a)t=t.slice(a,b+1);return t;}
function toCsvRows(items){
  const rows=[["sport","kickoff","competition","home","away","market","option","line","odds"]];
  const esc=(v)=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
  for(const it of items||[]){
    if(!it||!it.home||!it.away||!it.odds)continue;
    const ko=it.kickoff&&it.kickoff!=="UNKNOWN"?it.kickoff:"";
    const mk=it.market||(it.odds.draw!=null?"x12":"ml");
    const push=(option,odds)=>{if(odds==null||isNaN(Number(odds)))return;rows.push([it.sport||"soccer",ko,it.competition||"Screenshot",it.home,it.away,mk,option,"",Number(odds)].map(esc).join(","));};
    if(mk==="x12"){push("home",it.odds.home);push("draw",it.odds.draw);push("away",it.odds.away);}
    else{push(it.home,it.odds.home);push(it.away,it.odds.away);}
  }
  return rows.join("\n");
}
export { toCsvRows };  // exported for tests
export async function parseScreenshot(base64,mediaType){
  const key=process.env.ANTHROPIC_API_KEY; if(!key)throw new Error("ANTHROPIC_API_KEY not set");
  const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:VISION_MODEL,max_tokens:2000,system:SYSTEM_PROMPT,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType||"image/png",data:base64}},{type:"text",text:"extract"}]}]})});
  if(!res.ok)throw new Error(`vision API ${res.status}`);
  const data=await res.json();
  const text=(data.content||[]).filter((b)=>b.type==="text").map((b)=>b.text).join("");
  let items; try{items=JSON.parse(stripToJSON(text));}catch{throw new Error("bad json");}
  if(!Array.isArray(items))items=[items];
  return { parsed:items, ...ingestEvents(toCsvRows(items)) };
}
