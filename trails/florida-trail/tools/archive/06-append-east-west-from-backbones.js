const fs=require('fs');
const turf=require('@turf/turf');
const base='trails/florida-trail/data/';
const master=JSON.parse(fs.readFileSync(base+'points_all_merged.json','utf8'));
master.points=master.points||[];
const existing=new Set(master.points.map(p=>p.id));
const pickLine=(gj)=>{if(!gj) throw new Error('empty geojson'); if(gj.type==='Feature') return gj; if(gj.type==='FeatureCollection') return gj.features[0]; if(gj.type==='LineString'||gj.type==='MultiLineString') return {type:'Feature',properties:{},geometry:gj}; if(gj.type==='GeometryCollection'){const geoms=gj.geometries||[];let best=null,bL=-1;for(const g of geoms){if(!g) continue; if(g.type==='LineString'){const f={type:'Feature',properties:{},geometry:g};const L=turf.length(f,{units:'miles'});if(L>bL){bL=L;best=f;}} else if(g.type==='MultiLineString'){for(const c of (g.coordinates||[])){const f={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:c}};const L=turf.length(f,{units:'miles'});if(L>bL){bL=L;best=f;}}}} if(!best) throw new Error('no LineString found'); return best;} throw new Error('unsupported geojson type '+gj.type);};
const addPoints=(route,abbr,corridor,backbonePath)=>{if(!fs.existsSync(backbonePath)) {console.log('SKIP missing',backbonePath); return {added:0,total:0,miles:0};} const gj=JSON.parse(fs.readFileSync(backbonePath,'utf8')); const line=pickLine(gj); const L=turf.length(line,{units:'miles'}); const step=1, idScale=1000; let added=0,total=0; for(let m=0;m<=L+1e-9;m+=step){const p=turf.along(line,m,{units:'miles'});const mi=Math.round(m*idScale)/idScale;const miInt=Math.round(mi*idScale);const id=`ft-${abbr}-mi${String(miInt).padStart(7,'0')}`;total++; if(existing.has(id)) continue; master.points.push({route,needs_review:true,axis_mile:Math.round(m),mile:Math.round(m),id,lat:p.geometry.coordinates[1],lon:p.geometry.coordinates[0],corridor,fnst_rank:',corridor_filled:false,segment_code:',section_code:',segment_name:',section_name:',include:true,notes:'}); existing.add(id); added++; } console.log('ADDED',route,'miles',L.toFixed(2),'points',total,'new',added); return {added,total,miles:L};};
const east=addPoints('alt3-east-corr','alt3-east','Eastern',base+'trail_east_backbone.geojson');
const west=addPoints('alt3-west-corr','alt3-west','Western',base+'trail_west_backbone.geojson');
master.meta=master.meta||{}; master.meta.plus_alts_on=new Date().toISOString().slice(0,10); master.meta.plus_alts_sources={east_backbone:'trail_east_backbone.geojson',west_backbone:'trail_west_backbone.geojson'}; master.meta.plus_alts_added={east:east.added,west:west.added};
// sort for review convenience
master.points.sort((a,b)=>String(a.route).localeCompare(String(b.route))||Number(a.mile)-Number(b.mile));
fs.writeFileSync(base+'points_all_plus_alts.json',JSON.stringify(master,null,2));
// export review TSV
const header=['route','needs_review','mile','id','lat','lon','corridor','segment_code','section_code','segment_name','section_name','include','notes'];
const esc=(v)=>{let s=String(v??'');s=s.split('\\r').join('');s=s.split('\\n').join(' ');s=s.split('\t').join(' ');return s;};
let out=header.join('\t')+'\n';for(const p of master.points){out+=header.map(h=>esc(h==='needs_review'?(p.needs_review?1:0):p[h])).join('\t')+'\n';}fs.writeFileSync(base+'points_all_plus_alts_review.tsv',out);
console.log('WROTE points_all_plus_alts.json points=',master.points.length);
console.log('WROTE points_all_plus_alts_review.tsv rows=',master.points.length,'(filter needs_review=1 for new)' );
