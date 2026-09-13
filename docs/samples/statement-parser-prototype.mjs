// Prototype of the importer rules, to validate against the real sample.
import { readFileSync } from 'fs';

const unwrap = s => { const m = /^="?(.*?)"?$/.exec(s.trim()); return m ? m[1] : s.trim(); };

function parseTs(raw) {
  const s = unwrap(raw);
  let m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2})-(\d{2})-(\d{2})$/.exec(s);   // DD-MM-YYYY
  if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]);
  m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/.exec(s);        // YYYY-MM-DD
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  throw new Error(`unparseable timestamp: ${s}`);
}

// minimal RFC4180 reader (handles "" escapes)
function parseCsv(text) {
  const rows=[]; let row=[], f='', q=false;
  for (let i=0;i<text.length;i++){ const c=text[i];
    if (q) { if (c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if (c==='"') q=true;
    else if (c===','){ row.push(f); f=''; }
    else if (c==='\n'){ row.push(f); if(row.some(x=>x!=='')) rows.push(row); row=[]; f=''; }
    else if (c!=='\r') f+=c;
  }
  if (f||row.length){ row.push(f); if(row.some(x=>x!=='')) rows.push(row); }
  return rows;
}

const rows = parseCsv(readFileSync('stmt.csv','utf8'));
const txns = rows.map((r,i) => ({
  i, postDate:r[0], type:r[2], txnId:unwrap(r[3]), bankRef:unwrap(r[4]),
  ts:parseTs(r[5]), payer:unwrap(r[6]),
  debit:r[8]?parseFloat(r[8]):0, credit:r[9]?parseFloat(r[9]):0,
  balance:parseFloat(r[10]),
}));

// balance guard
let bad=0;
for (let n=1;n<txns.length;n++){
  const exp = txns[n-1].balance + txns[n].credit - txns[n].debit;
  if (Math.abs(exp - txns[n].balance) > 0.005) { bad++; console.log(`  MISMATCH row ${n}`); }
}
console.log(`balance guard: ${bad===0?'PASS':'FAIL'} (${txns.length} rows)`);

const credits = txns.filter(t => t.type==='Transfer Credit' && t.credit>0);
console.log(`credit-only filter: ${credits.length} of ${txns.length} rows are candidates`);
for (const c of credits) console.log(`  ${c.ts.toISOString().slice(0,16)}  ${c.credit}  ${c.payer}  ${c.txnId}`);

// the dangerous case: would MM-DD misparsing shift anything?
const t = parseTs('08-09-2026 10-00-00');
console.log(`ambiguous-date check: 08-09-2026 -> ${t.toDateString()} (must be September 8, not August 9)`);
