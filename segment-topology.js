/* Join source strokes, not wall guesses. Only coincident collinear endpoints
 * on the same layer/style are joined. Epsilon handles floating-point noise;
 * it is NOT a configurable gap-closing or wall-center movement allowance. */
(function(root){
  'use strict';
  const EPS=1e-6;
  function runs(input){
    const src=(input||[]).filter(s=>['x1','y1','x2','y2'].every(k=>Number.isFinite(s[k])))
      .map((s,i)=>{
        const reverse=s.x1>s.x2||(s.x1===s.x2&&s.y1>s.y2);
        return {...s,id:s.id??`source-${i+1}`,x1:reverse?s.x2:s.x1,y1:reverse?s.y2:s.y1,
          x2:reverse?s.x1:s.x2,y2:reverse?s.y1:s.y2,length:Math.hypot(s.x2-s.x1,s.y2-s.y1)};
      }).filter(s=>s.length>EPS);
    const parent=src.map((_,i)=>i),find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const cells=new Map(),key=(s,x,y)=>JSON.stringify([s.layer||'0',s.lineType||'',x,y]);
    const collinear=(a,b)=>{
      const ux=(a.x2-a.x1)/a.length,uy=(a.y2-a.y1)/a.length;
      return Math.abs((b.x1-a.x1)*uy-(b.y1-a.y1)*ux)<=EPS
        &&Math.abs((b.x2-a.x1)*uy-(b.y2-a.y1)*ux)<=EPS;
    };
    src.forEach((s,i)=>{
      for(const p of [{x:s.x1,y:s.y1},{x:s.x2,y:s.y2}]){
        const cx=Math.floor(p.x/EPS),cy=Math.floor(p.y/EPS);
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(key(s,cx+dx,cy+dy))||[]){
          if(q.i!==i&&Math.hypot(p.x-q.x,p.y-q.y)<=EPS&&collinear(s,src[q.i])&&collinear(src[q.i],s))parent[find(i)]=find(q.i);
        }
        const k=key(s,cx,cy);if(!cells.has(k))cells.set(k,[]);cells.get(k).push({...p,i});
      }
    });
    const groups=new Map();src.forEach((s,i)=>{const r=find(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(s);});
    const single=s=>({...s,parts:[{id:s.id,start:0,end:s.length,length:s.length}]});
    return [...groups.values()].flatMap(group=>{
      if(group.length===1)return [single(group[0])];
      const a=[...group].sort((a,b)=>b.length-a.length||String(a.id).localeCompare(String(b.id)))[0];
      // Do not allow a chain of numerical near-collinear matches to drift.
      if(group.some(b=>!collinear(a,b)))return group.map(single);
      const ux=(a.x2-a.x1)/a.length,uy=(a.y2-a.y1)/a.length;
      const project=(x,y)=>(x-a.x1)*ux+(y-a.y1)*uy;
      const spans=group.map(s=>({id:s.id,start:project(s.x1,s.y1),end:project(s.x2,s.y2),length:s.length}));
      const lo=Math.min(...spans.flatMap(s=>[s.start,s.end])),hi=Math.max(...spans.flatMap(s=>[s.start,s.end]));
      return [{...a,id:`run:${group.map(s=>s.id).sort().join('|')}`,x1:a.x1+lo*ux,y1:a.y1+lo*uy,
        x2:a.x1+hi*ux,y2:a.y1+hi*uy,length:hi-lo,parts:spans.map(s=>({...s,start:s.start-lo,end:s.end-lo}))}];
    });
  }
  function sourceIntervals(run,span){
    return run.parts.flatMap(p=>{
      const lo=Math.max(span[0],Math.min(p.start,p.end)),hi=Math.min(span[1],Math.max(p.start,p.end));
      if(hi-lo<=EPS)return [];
      return [{id:p.id,span:[lo,hi].map(t=>Math.max(0,Math.min(p.length,(t-p.start)*p.length/(p.end-p.start))))
        .sort((a,b)=>a-b)}];
    });
  }
  const api={runs,sourceIntervals,numericalTolerance:EPS};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CADTOPOLOGY=api;
})(typeof globalThis==='object'?globalThis:this);
