/* Drawing grid labels and explicitly generated auxiliary names. No snapping. */
(function(root){
  'use strict';
  const EPS=1e-5;
  const finite=g=>g&&['x1','y1','x2','y2'].every(k=>Number.isFinite(g[k]));
  const decode=s=>String(s||'').replace(/\\U\+([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))).normalize('NFKC');
  const labelOf=s=>decode(s).replace(/\\[AHWQTCF][^;]*;/gi,'').replace(/[{}]/g,'').trim().toUpperCase().match(/^([XY])\s*(\d{1,3})([A-Z]*)$/);
  const direction=g=>Math.abs(g.x2-g.x1)<=EPS&&Math.abs(g.y2-g.y1)>EPS?'vertical'
    :Math.abs(g.y2-g.y1)<=EPS&&Math.abs(g.x2-g.x1)>EPS?'horizontal':null;
  const offset=(g,d)=>d==='vertical'?(g.x1+g.x2)/2:(g.y1+g.y2)/2;
  const span=(g,d)=>(d==='vertical'?[g.y1,g.y2]:[g.x1,g.x2]).sort((a,b)=>a-b);
  const inside=(p,b,pad=0)=>p.x>=b.minx-pad&&p.x<=b.maxx+pad&&p.y>=b.miny-pad&&p.y<=b.maxy+pad;
  const asLine=a=>({x1:a.start.x,y1:a.start.y,x2:a.end.x,y2:a.end.y});
  const alpha=i=>{let s='';do{s=String.fromCharCode(65+i%26)+s;i=Math.floor(i/26)-1;}while(i>=0);return s;};

  function build(axes,entities=[],regions=[]) {
    const scopes=regions.filter(r=>r.id&&r.extents&&['minx','miny','maxx','maxy'].every(k=>Number.isFinite(r.extents[k])))
      .map(r=>({id:r.id,bounds:r.extents,meaning:'drawing area, not a verified floor'}));
    if(!scopes.length&&axes.length){
      const bounds={minx:Infinity,maxx:-Infinity,miny:Infinity,maxy:-Infinity};
      for(const a of axes)for(const p of [a.start,a.end]){bounds.minx=Math.min(bounds.minx,p.x);bounds.maxx=Math.max(bounds.maxx,p.x);bounds.miny=Math.min(bounds.miny,p.y);bounds.maxy=Math.max(bounds.maxy,p.y);}
      scopes.push({id:'drawing-area',bounds,meaning:'unsegmented drawing area; not a verified floor'});
    }
    const labels=entities.flatMap((e,i)=>{
      if(!['TEXT','MTEXT'].includes(e.type))return [];
      const m=labelOf(e.text);if(!m)return [];
      const aligned=e.type==='TEXT'&&(e.horizontalAlignment||e.verticalAlignment);
      const x=aligned?e.x2:e.x1,y=aligned?e.y2:e.y1;
      if(!Number.isFinite(x)||!Number.isFinite(y))return [];
      return [{id:`entity-${i+1}`,name:m[1]+Number(m[2])+m[3],family:m[1],ordinal:Number(m[2]),suffix:m[3],
        rawText:String(e.text),layer:e.layer||'0',position:{x,y},height:Math.abs(e.r)||0}];
    });
    const lines=entities.flatMap((e,i)=>{
      if(e.type!=='LINE'||!finite(e)||!direction(e))return [];
      const qualified=/(通り[芯線]|通[芯心]|軸[芯線]|中心線|\bGRID\b|\bAXIS\b)/i.test(decode(e.layer))||/CENTER|CENTRE|CHAIN/i.test(e.lineType||'');
      return qualified?[{id:`entity-${i+1}`,layer:e.layer||'0',lineType:e.lineType||null,geometry:{x1:e.x1,y1:e.y1,x2:e.x2,y2:e.y2},orientation:direction(e)}]:[];
    });
    const matches=[],unmatchedLabels=[];
    for(const label of labels){
      const h=label.height;
      if(!h){unmatchedLabels.push({...label,reason:'text-height-unavailable'});continue;}
      const candidates=lines.filter(l=>{
        const g=l.geometry,d=l.orientation,s=span(g,d),p=d==='vertical'?label.position.y:label.position.x,n=d==='vertical'?label.position.x:label.position.y;
        return s[1]-s[0]>=6*h&&Math.abs(n-offset(g,d))<=h*1.5&&p>=s[0]-h*3&&p<=s[1]+h*3;
      });
      if(!candidates.length){unmatchedLabels.push({...label,reason:'no-nearby-qualified-grid-line'});continue;}
      const first=candidates[0];
      if(candidates.some(l=>l.orientation!==first.orientation||Math.abs(offset(l.geometry,l.orientation)-offset(first.geometry,first.orientation))>EPS)){
        unmatchedLabels.push({...label,reason:'ambiguous-nearby-lines'});continue;
      }
      // Do not unite separated pieces into a fictional continuous grid line.
      const intervals=candidates.map(l=>span(l.geometry,l.orientation)).sort((a,b)=>a[0]-b[0]);
      let end=intervals[0][1],continuous=true;
      for(const s of intervals.slice(1)){if(s[0]>end+EPS)continuous=false;end=Math.max(end,s[1]);}
      if(!continuous){unmatchedLabels.push({...label,reason:'disconnected-grid-line-pieces'});continue;}
      const d=first.orientation,c=offset(first.geometry,d),s=[intervals[0][0],end];
      const eligible=scopes.filter(area=>inside(label.position,area.bounds,h*3)
        &&(d==='vertical'?c>=area.bounds.minx&&c<=area.bounds.maxx&&s[1]>=area.bounds.miny&&s[0]<=area.bounds.maxy
          :c>=area.bounds.miny&&c<=area.bounds.maxy&&s[1]>=area.bounds.minx&&s[0]<=area.bounds.maxx));
      if(eligible.length!==1){unmatchedLabels.push({...label,reason:'drawing-area-ambiguous-or-outside'});continue;}
      matches.push({name:label.name,family:label.family,ordinal:label.ordinal,suffix:label.suffix,scopeId:eligible[0].id,
        orientation:d,coordinate:c,span:s,labelEvidence:[label],sourceGeometry:candidates});
    }
    const observed=[];
    for(const item of matches){
      const conflict=matches.some(other=>other!==item&&other.scopeId===item.scopeId&&(
        other.name===item.name&&(other.orientation!==item.orientation||Math.abs(other.coordinate-item.coordinate)>EPS)
        ||other.orientation===item.orientation&&Math.abs(other.coordinate-item.coordinate)<=EPS&&other.name!==item.name));
      if(conflict){unmatchedLabels.push(...item.labelEvidence.map(l=>({...l,reason:'conflicting-labels-or-coordinates'})));continue;}
      const existing=observed.find(g=>g.scopeId===item.scopeId&&g.name===item.name);
      if(existing){
        if(item.span[0]>existing.span[1]+EPS||existing.span[0]>item.span[1]+EPS){existing.ambiguous=true;existing.labelEvidence.push(...item.labelEvidence);continue;}
        existing.span=[Math.min(existing.span[0],item.span[0]),Math.max(existing.span[1],item.span[1])];
        existing.labelEvidence.push(...item.labelEvidence);
        existing.sourceGeometry=[...new Map([...existing.sourceGeometry,...item.sourceGeometry].map(s=>[s.id,s])).values()];
      }else observed.push({...item,id:`GRID-${observed.length+1}`,origin:'source-drawing',status:'label-line-geometric-match',officialGridVerified:false,
        evidence:['explicit X/Y label','nearby long cardinal line on a grid layer or center linetype','unambiguous drawing-area match']});
    }
    for(let i=observed.length-1;i>=0;i--)if(observed[i].ambiguous){unmatchedLabels.push(...observed[i].labelEvidence.map(l=>({...l,reason:'disconnected-repeated-label'})));observed.splice(i,1);}
    const groups=[];
    for(const a of axes){
      const g=asLine(a),d=direction(g),areas=scopes.filter(s=>inside(a.start,s.bounds)&&inside(a.end,s.bounds));
      const scopeId=areas.length===1?areas[0].id:`local-${a.id}`;
      if(!d){a.gridReference={kind:'unassigned',name:a.id,scopeId,referenceId:null,offsets:[],reason:'non-cardinal-axis'};continue;}
      const c=offset(g,d),s=span(g,d);
      // Name only walls that have the same finite source-grid coverage together.
      // A distant collinear segment must not invalidate an in-span reference.
      const gridIds=observed.filter(grid=>grid.scopeId===scopeId&&grid.orientation===d&&s[0]>=grid.span[0]-EPS&&s[1]<=grid.span[1]+EPS).map(grid=>grid.id).join('|');
      const same=groups.find(x=>x.scopeId===scopeId&&x.orientation===d&&x.gridIds===gridIds&&Math.abs(x.coordinate-c)<=EPS);
      if(same)same.axes.push(a);else groups.push({scopeId,orientation:d,coordinate:c,gridIds,axes:[a]});
    }
    const generated=[],pending=[];
    for(const group of groups){
      const spans=group.axes.map(a=>span(asLine(a),group.orientation));
      const nearby=observed.filter(g=>g.scopeId===group.scopeId&&g.orientation===group.orientation
        &&spans.every(s=>s[0]>=g.span[0]-EPS&&s[1]<=g.span[1]+EPS));
      const aligned=nearby.filter(g=>Math.abs(g.coordinate-group.coordinate)<=EPS);
      if(aligned.length===1){for(const a of group.axes)a.gridReference={kind:'existing-grid-alignment',name:aligned[0].name,scopeId:group.scopeId,
        referenceId:aligned[0].id,offsets:[{gridId:aligned[0].id,name:aligned[0].name,signedDistance:group.coordinate-aligned[0].coordinate}],reason:'same-coordinate-within-finite-grid-span'};continue;}
      const pairs=[];
      for(const family of ['X','Y']){
        const base=nearby.filter(g=>g.family===family&&!g.suffix).sort((a,b)=>a.coordinate-b.coordinate);
        const lo=base.filter(g=>g.coordinate<group.coordinate-EPS).at(-1),hi=base.find(g=>g.coordinate>group.coordinate+EPS);
        if(lo&&hi&&lo.ordinal!==hi.ordinal)pairs.push([lo,hi].sort((a,b)=>a.ordinal-b.ordinal));
      }
      pending.push({...group,pair:pairs.length===1?pairs[0]:null});
    }
    const reserved=new Map(scopes.map(s=>[s.id,new Set(labels.filter(l=>inside(l.position,s.bounds,l.height*3)).map(l=>l.name))]));
    const counters=new Map();
    pending.sort((a,b)=>a.scopeId.localeCompare(b.scopeId)||a.orientation.localeCompare(b.orientation)
      ||(a.pair?.[0].id||'').localeCompare(b.pair?.[0].id||'')
      ||(a.pair?Math.abs(a.coordinate-a.pair[0].coordinate):a.coordinate)-(b.pair?Math.abs(b.coordinate-b.pair[0].coordinate):b.coordinate));
    for(const group of pending){
      if(!reserved.has(group.scopeId))reserved.set(group.scopeId,new Set());const used=reserved.get(group.scopeId);
      let name,kind,reason;
      if(group.pair){let suffix=0;do{name=group.pair[0].name+alpha(suffix++);}while(used.has(name));kind='generated-between-grids';reason='between-two-observed-parallel-grid-lines';}
      else {const family=group.orientation==='vertical'?'X':'Y',key=`${group.scopeId}:${family}`;let n=counters.get(key)||0;do{name=`SYS-${family}${++n}`;}while(used.has(name));counters.set(key,n);kind='generated-no-grid';reason='no-unambiguous-original-grid-reference';}
      used.add(name);
      const offsets=(group.pair||[]).map(g=>({gridId:g.id,name:g.name,signedDistance:group.coordinate-g.coordinate}));
      const generatedAxis={id:`AUX-${generated.length+1}`,name,origin:'generated',officialGrid:false,scopeId:group.scopeId,
        orientation:group.orientation,coordinate:group.coordinate,wallAxisIds:group.axes.map(a=>a.id),
        finiteWallSegments:group.axes.map(a=>({axisId:a.id,start:{...a.start},end:{...a.end}})),offsets,reason};
      generated.push(generatedAxis);
      for(const a of group.axes)a.gridReference={kind,name,referenceId:generatedAxis.id,scopeId:group.scopeId,offsets,reason};
    }
    return {schema:'cad-grid-references/1.0',status:observed.length?'source-labels-matched':'no-source-labels-matched',
      method:'explicit-label-and-line-geometry',scopes,observed,generated,unmatchedLabels,
      numericalTolerance:EPS,offsetConvention:'wall coordinate minus grid coordinate: +X for vertical lines, +Y for horizontal lines; source drawing units',
      limitations:['Only top-level TEXT/MTEXT X/Y-number labels and cardinal LINE geometry are supported; blocks/rotated grids may remain unread.',
        'A label-line match is not proof of an official building grid. Drawing areas are not verified floors.',
        'SYS names and suffixed auxiliary names are generated, not source labels. Names are scoped to each drawing area.',
        'Wall endpoints are unchanged. Coincident names do not connect separate wall segments; gaps remain gaps.']};
  }
  function describe(reference){
    if(!reference)return {ja:'',en:''};
    const r=reference,n=r.name,scope=r.scopeId;
    if(r.kind==='existing-grid-alignment')return {ja:`通り芯参照：原図の符号「${n}」と同じ位置です（領域 ${scope}）。符号と線の幾何対応であり、正式な通り芯かは未確認です。`,en:`Grid reference: aligned with source label ${n} (${scope}). This label-line match is not verification of an official building grid.`};
    if(r.kind==='generated-between-grids')return {ja:`補助軸名「${n}」を生成しました（領域 ${scope}）。原図の${r.offsets.map(o=>o.name).join('と')}の間です。${r.offsets.map(o=>`${o.name}からの符号付き距離 ${Number(o.signedDistance.toFixed(4))}`).join('、')}（図面単位）。原図の軸号ではありません。`,en:`Generated auxiliary name ${n} (${scope}), between ${r.offsets.map(o=>o.name).join(' and ')}. Signed offsets: ${r.offsets.map(o=>`${o.name}: ${Number(o.signedDistance.toFixed(4))}`).join(', ')} drawing units. This name is not an original grid label.`};
    if(r.kind==='generated-no-grid')return {ja:`補助軸名「${n}」を生成しました（領域 ${scope}）。対応する原図の通り芯符号は未確認です。SYSはシステム生成名であり、原図の軸号ではありません。`,en:`Generated auxiliary name ${n} (${scope}). A corresponding original grid reference is unconfirmed; SYS denotes a system name, not an original label.`};
    return {ja:'斜めの壁線は元のAX番号を保持します。通り芯名の自動対応は未実装です。',en:'A diagonal wall keeps its AX identifier; automatic grid naming for rotated geometry is unsupported.'};
  }
  const api={build,describe};root.CADGRID=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
