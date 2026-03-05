const fs=require('fs');
const d=JSON.parse(fs.readFileSync('trails/florida-trail/data/points_all.json','utf8'));
const rows=d.points||[];
const outPath='trails/florida-trail/data/points_all_review.tsv';
const header=['route','axis_mile','mile','id','lat','lon','segment_code','section_code','segment_name','section_name','include','notes'];
const esc=(v)=>{let s=String(v??'');s=s.split('\\r').join('');s=s.split('\\n').join(' ');s=s.split('\t').join(' ');return s;};
let out=header.join('\t')+'\n';
for(const r of rows){out+=header.map(h=>esc(r[h])).join('\t')+'\n';}
fs.writeFileSync(outPath,out);
console.log('WROTE',outPath,'ROWS',rows.length,'COLS',header.length);
