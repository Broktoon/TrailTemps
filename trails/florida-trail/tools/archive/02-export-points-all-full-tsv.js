const fs=require('fs');
const d=JSON.parse(fs.readFileSync('trails/florida-trail/data/points_all.json','utf8'));
const rows=d.points||[];
const outPath='trails/florida-trail/data/points_all_review_full.tsv';
const keySet=new Set();for(const r of rows){for(const k of Object.keys(r||{})) keySet.add(k);}const baseOrder=['route','axis_mile','mile','id','lat','lon','corridor','fnst_rank','corridor_filled','segment_code','section_code','segment_name','section_name','include','notes'];
const keys=[...baseOrder.filter(k=>keySet.has(k)),...([...keySet].filter(k=>!baseOrder.includes(k)).sort((a,b)=>a.localeCompare(b)))];
const typeOf=(v)=>v===null?'null':Array.isArray(v)?'array':typeof v;
const esc=(v)=>{if(v===undefined||v===null) return ''; if(typeof v==='object') return JSON.stringify(v); let s=String(v); s=s.split('\\r').join(''); s=s.split('\\n').join(' '); s=s.split('\t').join(' '); return s;};
const typeCols=keys.map(k=>'__type_'+k);
let out=[...keys,...typeCols].join('\t')+'\n';
for(const r of rows){out+=keys.map(k=>esc(r[k])).join('\t')+'\t'+keys.map(k=>typeOf(r[k])).join('\t')+'\n';}
fs.writeFileSync(outPath,out);
console.log('WROTE',outPath,'ROWS',rows.length,'COLS',(keys.length+typeCols.length),'FIELDS',keys.length);
