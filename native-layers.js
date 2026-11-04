/* Original DXF layer viewer. Independent of wall classification: no pairing,
 * length filtering, snapping or inferred wall geometry. Curves are sampled only
 * for display. Unsupported objects stay in the layer's omission inventory. */
(function(root){
  'use strict';
  const TAU=Math.PI*2, ID=[1,0,0,1,0,0];
  const value=(r,c,d='')=>r.pairs.find(p=>p[0]===c)?.[1]??d;
  const num=(r,c,d=NaN)=>Number(value(r,c,d));
  const xy=(r,c=10)=>({x:num(r,c),y:num(r,c+10)});
  const valid=p=>Number.isFinite(p.x)&&Number.isFinite(p.y);
  const point=(p,m)=>({x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]});
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const decode=s=>String(s).replace(/\\U\+([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
  function color(name){
    // Named examples use familiar drawing colors; all grouping still uses exact names.
    const colors={'仕上線':'#c13b35','建具':'#186aa8','住宅設備':'#16836d','寸法':'#68737f','中心線':'#924f98'};
    let h=0;for(const c of name)h=(h*31+c.codePointAt(0))>>>0;
    return Object.hasOwn(colors,name)?colors[name]:`hsl(${h%360} 56% 36%)`;
  }
  function records(text){
    const lines=String(text).split(/\r\n|\n|\r/),out=[];let r;
    for(let i=0;i+1<lines.length;i+=2){
      const c=parseInt(lines[i].trim(),10);if(!Number.isFinite(c)){i--;continue;}
      const v=lines[i+1];
      if(c===0){r={type:v.trim(),pairs:[]};out.push(r);}else if(r)r.pairs.push([c,v.trim()]);
    }
    return out;
  }
  function polyVertices(r){
    if(r.vertices)return r.vertices;
    const out=[];let p;
    for(const [c,v]of r.pairs){if(c===10){p={x:Number(v),y:NaN,bulge:0};out.push(p);}else if(p&&c===20)p.y=Number(v);else if(p&&c===42)p.bulge=Number(v);}
    return out;
  }
  function arcPoints(center,rx,ry,start,sweep,rotation=0){
    const n=Math.max(2,Math.ceil(Math.abs(sweep)/(Math.PI/36))),out=[];
    for(let i=0;i<=n;i++){const t=start+sweep*i/n,x=rx*Math.cos(t),y=ry*Math.sin(t);out.push({x:center.x+x*Math.cos(rotation)-y*Math.sin(rotation),y:center.y+x*Math.sin(rotation)+y*Math.cos(rotation)});}
    return out;
  }
  function polyPoints(vertices,closed){
    const out=[];
    for(let i=0;i<vertices.length;i++){
      const a=vertices[i],b=vertices[(i+1)%vertices.length];out.push({x:a.x,y:a.y});
      if(!b||(!closed&&i===vertices.length-1)||!a.bulge)continue;
      const dx=b.x-a.x,dy=b.y-a.y,chord=Math.hypot(dx,dy),k=(1-a.bulge*a.bulge)/(4*a.bulge);
      if(!chord)continue;
      const center={x:(a.x+b.x)/2-dy*k,y:(a.y+b.y)/2+dx*k};
      out.push(...arcPoints(center,Math.hypot(a.x-center.x,a.y-center.y),Math.hypot(a.x-center.x,a.y-center.y),Math.atan2(a.y-center.y,a.x-center.x),4*Math.atan(a.bulge)).slice(1,-1));
    }
    return out;
  }
  function read(text,options={}){
    const maxPoints=Number.isFinite(options.maxPoints)?Math.max(1,Math.min(500000,options.maxPoints)):500000;
    let displayedPoints=0;
    const layers=new Map(),blocks=new Map(),entities=[];
    const layer=name=>{name=decode(name||'0');if(!layers.has(name))layers.set(name,{name,color:color(name),entityCount:0,types:Object.create(null),primitives:[],omitted:Object.create(null)});return layers.get(name);};
    let section='',block=null,poly=null;
    for(const r of records(text)){
      if(r.type==='SECTION'){section=value(r,2);continue;}
      if(r.type==='ENDSEC'){section='';block=null;poly=null;continue;}
      if(section==='TABLES'&&r.type==='LAYER'){layer(value(r,2));continue;}
      if(section!=='BLOCKS'&&section!=='ENTITIES')continue;
      if(r.type==='BLOCK'){block={base:xy(r),records:[]};if(!valid(block.base))block.base={x:0,y:0};blocks.set(value(r,2),block);continue;}
      if(r.type==='ENDBLK'){block=null;poly=null;continue;}
      if(r.type==='VERTEX'){if(poly)poly.vertices.push({...xy(r),bulge:num(r,42,0)});continue;}
      if(r.type==='SEQEND'){poly=null;continue;}
      if(section==='BLOCKS'&&!block)continue;
      (section==='BLOCKS'?block.records:entities).push(r);
      poly=r.type==='POLYLINE'?r:null;if(poly)poly.vertices=[];
    }
    // Root entity counts remain faithful to ENTITIES, not expanded block leaves.
    for(const r of entities){const g=layer(value(r,8,'0'));g.entityCount++;g.types[r.type]=(g.types[r.type]||0)+1;}
    let expanded=0;
    function render(r,m=ID,inherited='0',stack=[]){
      const own=value(r,8,'0'),g=layer(own==='0'?inherited:own);
      const omit=reason=>{g.omitted[reason]=(g.omitted[reason]||0)+1;};
      if(++expanded>250000){omit('display limit');return;}
      if(num(r,210,0)!==0||num(r,220,0)!==0||num(r,230,1)!==1){omit(`${r.type} (non-planar)`);return;}
      const path=(points,closed=false,fill=false)=>{
        if(!points.length||!points.every(valid)){omit(`${r.type} (invalid coordinates)`);return;}
        if(displayedPoints+points.length>maxPoints){omit('display point limit');return;}
        const transformed=points.map(p=>point(p,m));
        if(!transformed.every(valid)){omit(`${r.type} (invalid transform)`);return;}
        g.primitives.push({kind:'path',layer:g.name,points:transformed,closed,fill});
        displayedPoints+=points.length;
      };
      if(r.type==='INSERT'||r.type==='DIMENSION'){
        const name=value(r,2),b=blocks.get(name);
        if(!b||stack.includes(name)||stack.length>=12){omit(`${r.type} (missing/recursive block)`);return;}
        // DIMENSION group 70 is a type flag (often 32), 41 is text spacing,
        // 42 is the measurement; its generated block already carries geometry.
        if(r.type==='DIMENSION'){
          for(const child of b.records){if(expanded>250000){omit('display limit');break;}render(child,m,g.name,[...stack,name]);}
          return;
        }
        if(num(r,70,1)>1||num(r,71,1)>1){omit('INSERT array');return;}
        const p=xy(r),sx=num(r,41,1),sy=num(r,42,1),angle=num(r,50,0)*Math.PI/180;
        if(!valid(p)||![sx,sy,angle].every(Number.isFinite)){omit('INSERT (invalid transform)');return;}
        const c=Math.cos(angle),s=Math.sin(angle),matrix=[sx*c,sx*s,-sy*s,sy*c,0,0];
        const base=b.base;
        matrix[4]=p.x-matrix[0]*base.x-matrix[2]*base.y;matrix[5]=p.y-matrix[1]*base.x-matrix[3]*base.y;
        for(const child of b.records){if(expanded>250000){omit('display limit');break;}render(child,multiply(m,matrix),g.name,[...stack,name]);}
      }else if(r.type==='LINE')path([xy(r),xy(r,11)]);
      else if(['LWPOLYLINE','POLYLINE'].includes(r.type)){
        const vs=polyVertices(r);if(vs.length<2||!vs.every(p=>valid(p)&&Number.isFinite(p.bulge))){omit(`${r.type} (invalid vertices)`);return;}
        if(r.type==='POLYLINE'&&(num(r,70,0)&(8|16|64))){omit('POLYLINE (3D/mesh)');return;}
        const closed=!!(num(r,70,0)&1);path(polyPoints(vs,closed),closed);
      }else if(['CIRCLE','ARC','ELLIPSE'].includes(r.type)){
        const p=xy(r);let rx=num(r,40),ry=rx,a=0,b=TAU,rot=0;
        if(r.type==='ARC'){a=num(r,50)*Math.PI/180;b=num(r,51)*Math.PI/180;}
        if(r.type==='ELLIPSE'){const major=xy(r,11);rx=Math.hypot(major.x,major.y);ry=rx*num(r,40);rot=Math.atan2(major.y,major.x);a=num(r,41,0);b=num(r,42,TAU);}
        if(!valid(p)||![rx,ry,a,b,rot].every(Number.isFinite)||rx<=0||ry<=0){omit(`${r.type} (invalid curve)`);return;}
        const sweep=((b-a)%TAU+TAU)%TAU||TAU;
        path(arcPoints(p,rx,ry,a,sweep,rot),r.type==='CIRCLE');
      }else if(['SOLID','TRACE','3DFACE'].includes(r.type)){
        const p=[xy(r),xy(r,11),xy(r,12),xy(r,13)];if(!valid(p[3]))p[3]=p[2];
        path(r.type==='3DFACE'?p:[p[0],p[1],p[3],p[2]],true,r.type!=='3DFACE');
      }else if(['TEXT','MTEXT','ATTRIB','ATTDEF'].includes(r.type)){
        let p=xy(r);const h=num(r,40,1),a=num(r,50,0)*Math.PI/180;
        if(r.type==='TEXT'&&(num(r,72,0)||num(r,73,0))&&valid(xy(r,11)))p=xy(r,11);
        const text=decode(r.pairs.filter(x=>x[0]===1||x[0]===3).map(x=>x[1]).join('')).replace(/\\P/g,'\n').replace(/\\[A-Za-z][^;]*;/g,'').replace(/[{}]/g,'');
        if(!valid(p)||!Number.isFinite(h)||!Number.isFinite(a)||!text){omit(`${r.type} (invalid text)`);return;}
        const origin=point(p,m),direction=point({x:p.x+h*Math.cos(a),y:p.y+h*Math.sin(a)},m);
        if(!valid(origin)||!valid(direction)){omit(`${r.type} (invalid transform)`);return;}
        g.primitives.push({kind:'text',layer:g.name,point:origin,text,height:Math.hypot(direction.x-origin.x,direction.y-origin.y),rotation:Math.atan2(direction.y-origin.y,direction.x-origin.x),align:num(r,72,0)===1?'center':num(r,72,0)===2?'right':'left'});
      }else if(r.type==='POINT'){const p=xy(r);if(valid(p))g.primitives.push({kind:'point',layer:g.name,point:point(p,m)});else omit('POINT (invalid coordinates)');}
      else omit(r.type);
    }
    for(const r of entities)render(r);
    const result={layers:[...layers.values()],sourceEntityCount:entities.length};
    result.bounds=bounds(visible(result,new Set(layers.keys())));
    return result;
  }
  function visible(scene,names){return scene.layers.filter(l=>names.has(l.name)).flatMap(l=>l.primitives);}
  function bounds(primitives){
    let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    const add=p=>{if(valid(p)){minx=Math.min(minx,p.x);maxx=Math.max(maxx,p.x);miny=Math.min(miny,p.y);maxy=Math.max(maxy,p.y);}};
    for(const p of primitives){if(p.kind==='path')p.points.forEach(add);else {add(p.point);if(p.kind==='text')add({x:p.point.x+p.height*Math.min(40,p.text.length)*.6,y:p.point.y+p.height});}}
    return Number.isFinite(minx)?{minx,miny,maxx,maxy,w:maxx-minx||1,h:maxy-miny||1}:null;
  }
  const hasContent=l=>!!(l.entityCount||l.primitives.length||Object.keys(l.omitted).length);
  const api={read,visible,bounds,hasContent};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DXFLAYERS=api;
})(typeof globalThis!=='undefined'?globalThis:this);
