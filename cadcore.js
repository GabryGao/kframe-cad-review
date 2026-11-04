/* cadcore.js —— CAD(DXF) 墙体提取核心逻辑（无 DOM，可在浏览器和 Node 复用）
 * 流程: inspectDXF -> parseDXF -> classify -> buildDXF
 * v2 规则版: 保留原图上下文，结合图层、双线墙几何与 K 型斜撑拓扑做候选识别。
 */
(function (root) {
  "use strict";

  const LayerAI = root.LAYERINTELLIGENCE
    || (typeof require === "function" ? require("./layer-intelligence.js") : null);
  const Topology = root.CADTOPOLOGY
    || (typeof require === "function" ? require("./segment-topology.js") : null);

  const UNIT_LABELS = {
    0: "unitless", 1: "inches", 2: "feet", 4: "millimeters",
    5: "centimeters", 6: "meters",
  };

  function dxfPairs(text) {
    const lines = String(text || "").split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (Number.isNaN(code)) { i -= 1; continue; }
      pairs.push([code, lines[i + 1]]);
    }
    return pairs;
  }

  function inspectDXF(text) {
    const source = String(text || "");
    if (/^AutoCAD Binary DXF/i.test(source)) {
      return { format: "binary", unitsCode: 0, unitsLabel: UNIT_LABELS[0] };
    }
    const pairs = dxfPairs(source);
    let unitsCode = 0;
    for (let i = 0; i + 1 < pairs.length; i++) {
      if (pairs[i][0] === 9 && String(pairs[i][1]).trim() === "$INSUNITS") {
        for (let j = i + 1; j < Math.min(i + 5, pairs.length); j++) {
          if (pairs[j][0] === 70) { unitsCode = parseInt(pairs[j][1], 10) || 0; break; }
        }
        break;
      }
    }
    const hasEntities = pairs.some((pair, i) => pair[0] === 2 && String(pair[1]).trim() === "ENTITIES" && i > 0);
    return {
      format: hasEntities ? "ascii" : "unknown",
      unitsCode,
      unitsLabel: UNIT_LABELS[unitsCode] || `code-${unitsCode}`,
    };
  }

  // ---------- 1. DXF 解析 ----------
  // 返回 ENTITIES 段里的实体数组: {type, layer, x1,y1,x2,y2, verts:[{x,y}], closed, name, cx,cy,r}
  function parseDXF(text) {
    const pairs = dxfPairs(text);
    // 只取 ENTITIES 段
    let start = -1, end = pairs.length;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i][0] === 2 && (pairs[i][1] || "").trim() === "ENTITIES") { start = i + 1; break; }
    }
    if (start === -1) return []; // 没有 ENTITIES 段
    for (let i = start; i < pairs.length; i++) {
      if (pairs[i][0] === 0 && (pairs[i][1] || "").trim() === "ENDSEC") { end = i; break; }
    }

    const ents = [];
    let cur = null, curVertex = null;
    for (let i = start; i < end; i++) {
      const code = pairs[i][0];
      const val = (pairs[i][1] || "").trim();
      if (code === 0) {
        if (val === "VERTEX") { curVertex = { x: 0, y: 0 }; if (cur && cur.verts) cur.verts.push(curVertex); continue; }
        if (val === "SEQEND") { curVertex = null; continue; }
        curVertex = null;
        cur = { type: val, layer: "0", verts: [] };
        ents.push(cur);
        continue;
      }
      if (!cur) continue;
      if (curVertex) { // POLYLINE 的顶点
        if (code === 10) curVertex.x = parseFloat(val);
        else if (code === 20) curVertex.y = parseFloat(val);
        continue;
      }
      switch (code) {
        case 8: cur.layer = val; break;
        case 6: cur.lineType = val; break;
        case 72: cur.horizontalAlignment = parseInt(val, 10) || 0; break;
        case 73: cur.verticalAlignment = parseInt(val, 10) || 0; break;
        case 2: cur.name = val; break;
        case 1: cur.text = cur.type === 'MTEXT' ? (cur.text || '') + pairs[i][1] : val; break;
        case 3: if (cur.type === 'MTEXT') cur.text = (cur.text || '') + pairs[i][1]; break;
        case 70: cur.flag = parseInt(val, 10) || 0; break;
        case 40: cur.r = parseFloat(val); break;
        case 10:
          if (cur.type === "LWPOLYLINE") cur.verts.push({ x: parseFloat(val), y: 0 });
          else { cur.x1 = parseFloat(val); cur.cx = parseFloat(val); }
          break;
        case 20:
          if (cur.type === "LWPOLYLINE") { const v = cur.verts[cur.verts.length - 1]; if (v) v.y = parseFloat(val); }
          else { cur.y1 = parseFloat(val); cur.cy = parseFloat(val); }
          break;
        case 11: cur.x2 = parseFloat(val); break;
        case 21: cur.y2 = parseFloat(val); break;
        default: break;
      }
    }
    return ents;
  }

  // ---------- 2. 把实体拆成线段 ----------
  function segsOf(ent) {
    const out = [];
    const segment = (x1, y1, x2, y2) => ({
      x1, y1, x2, y2,
      layer: ent.layer || "0",
      entityType: ent.type,
      lineType: ent.lineType || '',
    });
    if (ent.type === "LINE") {
      if ([ent.x1, ent.y1, ent.x2, ent.y2].every(Number.isFinite))
        out.push(segment(ent.x1, ent.y1, ent.x2, ent.y2));
    } else if (ent.type === "LWPOLYLINE" || ent.type === "POLYLINE") {
      const v = ent.verts.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      for (let i = 0; i + 1 < v.length; i++) out.push(segment(v[i].x, v[i].y, v[i + 1].x, v[i + 1].y));
      if ((ent.flag & 1) && v.length > 2) out.push(segment(v[v.length - 1].x, v[v.length - 1].y, v[0].x, v[0].y));
    }
    return out;
  }
  const segLen = s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

  function meetsMinimumSpan(length, options) {
    const opts = options || {};
    const minimum = Number(opts.minWallLen);
    if (!Number.isFinite(minimum)) return true;
    return opts.excludeAtOrBelowMinWallLen
      ? length > minimum + 1e-6
      : length + 1e-6 >= minimum;
  }

  function normalizedSegment(segment, index) {
    const firstComesBefore = segment.x1 < segment.x2 || (segment.x1 === segment.x2 && segment.y1 <= segment.y2);
    const x1 = firstComesBefore ? segment.x1 : segment.x2;
    const y1 = firstComesBefore ? segment.y1 : segment.y2;
    const x2 = firstComesBefore ? segment.x2 : segment.x1;
    const y2 = firstComesBefore ? segment.y2 : segment.y1;
    const length = Math.hypot(x2 - x1, y2 - y1);
    return {
      ...segment,
      id: segment.id || `source-${index + 1}`,
      x1, y1, x2, y2, length,
      angle: Math.atan2(y2 - y1, x2 - x1),
    };
  }

  function pairGeometry(a, b, opts) {
    const ax = a.x2 - a.x1, ay = a.y2 - a.y1;
    const alen = Math.hypot(ax, ay);
    const bx = b.x2 - b.x1, by = b.y2 - b.y1;
    const blen = Math.hypot(bx, by);
    if (alen < 1e-6 || blen < 1e-6) return null;
    const ux = ax / alen, uy = ay / alen;
    const parallelError = Math.abs(ux * by - uy * bx) / blen;
    if (parallelError > Math.sin((opts.angleTolerance || 5) * Math.PI / 180)) return null;
    const nx = -uy, ny = ux;
    const signedDistance = nx * (b.x1 - a.x1) + ny * (b.y1 - a.y1);
    const thickness = Math.abs(signedDistance);
    if (thickness < opts.pairMin || thickness > opts.pairMax) return null;
    const p1 = ux * (b.x1 - a.x1) + uy * (b.y1 - a.y1);
    const p2 = ux * (b.x2 - a.x1) + uy * (b.y2 - a.y1);
    const overlapStart = Math.max(0, Math.min(p1, p2));
    const overlapEnd = Math.min(alen, Math.max(p1, p2));
    const overlap = overlapEnd - overlapStart;
    if (!meetsMinimumSpan(overlap, opts)) return null;
    const offsetX = nx * signedDistance / 2;
    const offsetY = ny * signedDistance / 2;
    return {
      overlap,
      thickness,
      aInterval: [overlapStart, overlapEnd],
      bInterval: [
        (overlapStart - p1) * blen / (p2 - p1),
        (overlapEnd - p1) * blen / (p2 - p1),
      ].sort((a, b) => a - b),
      x1: a.x1 + ux * overlapStart + offsetX,
      y1: a.y1 + uy * overlapStart + offsetY,
      x2: a.x1 + ux * overlapEnd + offsetX,
      y2: a.y1 + uy * overlapEnd + offsetY,
    };
  }

  function looksLikeRepeatedPattern(segment, all, opts) {
    if (layerRole(segment.layer) === "wall") return false;
    let parallelNeighbours = 0;
    for (const other of all) {
      if (other === segment) continue;
      const relaxed = pairGeometry(segment, other, { ...opts, minWallLen: Math.min(opts.minWallLen, segLen(segment) * 0.7) });
      if (relaxed) parallelNeighbours += 1;
      if (parallelNeighbours >= 5) return true;
    }
    return false;
  }

  function extractWallCenterlines(segments, options) {
    const runs=Topology.runs(segments),byId=new Map(runs.map(s=>[s.id,s]));
    return extractWallRuns(runs,options).map(w=>{
      const sourceIntervals=(w.sourceIntervals||[]).flatMap(i=>Topology.sourceIntervals(byId.get(i.id),i.span));
      return {...w,sourceIntervals,sourceSegmentIds:[...new Set(sourceIntervals.map(i=>i.id))]};
    });
  }

  function extractWallRuns(segments, options) {
    const opts = options || {};
    const ext = extentsOf(segments || []);
    const millimeterDrawing = opts.unitsCode === 4;
    const settings = {
      minWallLen: opts.minWallLen != null ? opts.minWallLen : (millimeterDrawing ? 500 : ext.diag * 0.02),
      pairMin: opts.pairMin != null ? opts.pairMin : (millimeterDrawing ? 60 : ext.diag * 0.003),
      pairMax: opts.pairMax != null ? opts.pairMax : (millimeterDrawing ? 450 : ext.diag * 0.035),
      angleTolerance: opts.angleTolerance != null ? opts.angleTolerance : 5,
      excludeAtOrBelowMinWallLen: !!opts.excludeAtOrBelowMinWallLen,
    };
    const normalized = (segments || [])
      .filter(segment => [segment.x1, segment.y1, segment.x2, segment.y2].every(Number.isFinite))
      .map(normalizedSegment)
      .filter(segment => meetsMinimumSpan(segment.length, settings))
      .filter(segment => opts.selectedWallLayer || !["excluded", "brace", "column", "beam"].includes(layerRole(segment.layer)));
    const noisy = new Set(normalized.filter(segment => looksLikeRepeatedPattern(segment, normalized, settings)));
    const possiblePairs = [];
    for (let i = 0; i < normalized.length; i++) {
      if (noisy.has(normalized[i])) continue;
      for (let j = i + 1; j < normalized.length; j++) {
        if (noisy.has(normalized[j])) continue;
        const geometry = pairGeometry(normalized[i], normalized[j], settings);
        if (!geometry) continue;
        possiblePairs.push({ i, j, geometry, score: geometry.overlap - geometry.thickness * 0.01 });
      }
    }
    possiblePairs.sort((a, b) => b.score - a.score);
    // A long edge can face several separate fragments. Reserve only the paired
    // interval, retaining every source gap and rejecting competing overlaps.
    const used = new Map();
    const overlapsUsed = (index, interval) => (used.get(index) || []).some(previous =>
      Math.min(previous[1], interval[1]) - Math.max(previous[0], interval[0]) > 1e-6);
    const reserve = (index, interval) => {
      if (!used.has(index)) used.set(index, []);
      used.get(index).push(interval);
    };
    const walls = [];
    for (const pair of possiblePairs) {
      if (overlapsUsed(pair.i, pair.geometry.aInterval) || overlapsUsed(pair.j, pair.geometry.bInterval)) continue;
      const a = normalized[pair.i], b = normalized[pair.j];
      reserve(pair.i, pair.geometry.aInterval); reserve(pair.j, pair.geometry.bInterval);
      const hasWallLayer = layerRole(a.layer) === "wall" || layerRole(b.layer) === "wall";
      walls.push({
        id: `wall-${walls.length + 1}`,
        x1: pair.geometry.x1, y1: pair.geometry.y1,
        x2: pair.geometry.x2, y2: pair.geometry.y2,
        length: pair.geometry.overlap,
        angle: Math.atan2(pair.geometry.y2 - pair.geometry.y1, pair.geometry.x2 - pair.geometry.x1),
        thickness: pair.geometry.thickness,
        sourceSegmentIds: [a.id, b.id],
        sourceIntervals: [{id:a.id,span:pair.geometry.aInterval},{id:b.id,span:pair.geometry.bInterval}],
        layer: hasWallLayer ? (layerRole(a.layer) === "wall" ? a.layer : b.layer) : (a.layer || "0"),
        confidence: hasWallLayer ? 0.96 : 0.82,
        evidence: opts.selectedWallLayer ? ["paired wall edges", "automatically selected wall layer"]
          : hasWallLayer ? ["paired wall edges", "wall layer"] : ["paired wall edges"],
        warnings: [],
      });
    }
    for (let i = 0; i < normalized.length; i++) {
      const segment = normalized[i];
      if (used.has(i) || noisy.has(segment) || (!opts.selectedWallLayer && layerRole(segment.layer) !== "wall")) continue;
      if (opts.requirePair) continue;
      walls.push({
        id: `wall-${walls.length + 1}`,
        x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2,
        length: segment.length, angle: segment.angle, thickness: null,
        sourceSegmentIds: [segment.id], layer: segment.layer,
        sourceIntervals: [{id:segment.id,span:[0,segment.length]}],
        centerlineBasis: 'single-edge-hypothesis', confidence: 0.45,
        evidence: [opts.selectedWallLayer ? "automatically selected wall layer" : "wall layer", "unpaired continuous source edge"],
        warnings: ["single-edge wall", "center-position-unverified", "wall thickness and wall identity require validation"],
      });
    }
    // Recover short paired returns only when they touch an already established
    // long wall. Do not chain guesses, snap endpoints, or bridge an opening.
    if (opts.recoverConnectedShorts && walls.length && !settings.excludeAtOrBelowMinWallLen) {
      const anchors = walls.filter(w=>w.thickness>0);
      const shortMin = Math.max(settings.pairMin, settings.minWallLen * 0.2);
      const all = (segments || []).filter(s => [s.x1,s.y1,s.x2,s.y2].every(Number.isFinite))
        .map(normalizedSegment).filter(s => s.length >= shortMin);
      const occupied = coveredSourceIntervals(all, walls);
      const candidates = [];
      for (let i=0;i<all.length;i++) for (let j=i+1;j<all.length;j++) {
        const a=all[i], b=all[j];
        if (a.layer !== b.layer) continue;
        const g=pairGeometry(a,b,{...settings,minWallLen:shortMin});
        if (!g || g.overlap >= settings.minWallLen || g.overlap < g.thickness * 0.75) continue;
        const compact=g.overlap<g.thickness*1.25;
        if(compact) {
          const ux=(g.x2-g.x1)/g.overlap,uy=(g.y2-g.y1)/g.overlap;
          const capAt=(x,y)=>all.some(s=>s!==a&&s!==b&&s.layer===a.layer
            &&Math.abs(s.length-g.thickness)<=1e-6
            &&[[-1,1],[1,-1]].some(([p,q])=>
              Math.hypot(s.x1-(x+p*uy*g.thickness/2),s.y1-(y-p*ux*g.thickness/2))<=1e-6
              &&Math.hypot(s.x2-(x+q*uy*g.thickness/2),s.y2-(y-q*ux*g.thickness/2))<=1e-6));
          if(!capAt(g.x1,g.y1)&&!capAt(g.x2,g.y2))continue;
        }
        if (!anchors.some(w => Math.min(pointSegmentDistance({x:g.x1,y:g.y1},w),pointSegmentDistance({x:g.x2,y:g.y2},w))
          <= Math.max(1, Math.max(g.thickness,w.thickness || 0)*0.55))) continue;
        candidates.push({a,b,g,compact});
      }
      candidates.sort((a,b)=>b.g.overlap-a.g.overlap);
      for (const {a,b,g,compact} of candidates) {
        const ranges = [[a.id,g.aInterval],[b.id,g.bInterval]];
        if (ranges.some(([id,span]) => (occupied.get(id)||[]).some(p=>Math.min(p[1],span[1])-Math.max(p[0],span[0])>1e-6))) continue;
        const wall={id:`wall-${walls.length+1}`,x1:g.x1,y1:g.y1,x2:g.x2,y2:g.y2,
          length:g.overlap,angle:Math.atan2(g.y2-g.y1,g.x2-g.x1),thickness:g.thickness,
          sourceSegmentIds:[a.id,b.id],layer:a.layer,confidence:0.7,
          sourceIntervals:[{id:a.id,span:g.aInterval},{id:b.id,span:g.bInterval}],
          evidence:['paired wall edges','short return connected to a longer paired wall',...(compact?['closed end cap across both source edges']:[])],warnings:['short-span geometric recovery']};
        walls.push(wall);
        for(const [id,span] of ranges) {
          if(!occupied.has(id))occupied.set(id,[]);
          occupied.get(id).push(span);
        }
      }
    }
    return walls;
  }

  function pointSegmentDistance(point, segment) {
    const dx=segment.x2-segment.x1,dy=segment.y2-segment.y1;
    const t=Math.max(0,Math.min(1,((point.x-segment.x1)*dx+(point.y-segment.y1)*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(point.x-segment.x1-t*dx,point.y-segment.y1-t*dy);
  }

  // A finish boundary and its opposing edge can live on different Layers.
  // Only primary-layer intervals become output walls. Other-layer geometry is
  // separately recorded as evidence, never copied wholesale into the output.
  function recoverContextWallPairs(segments, walls, selectedLayers, options) {
    const opts={minWallLen:500,pairMin:60,pairMax:450,...options};
    const selected=new Set(selectedLayers), all=segments.map(normalizedSegment).filter(s=>Number.isFinite(s.length)&&s.length>1e-6);
    const target=all.filter(s=>selected.has(s.layer)), result=[...walls];
    const thicknesses=walls.filter(w=>w.sourceSegmentIds?.length>=2&&w.thickness>0).map(w=>w.thickness);
    if(!thicknesses.length)return result;
    const allowed=new Set((opts.layerAssessments||[]).filter(l=>l.role==='wall'
      &&(l.features?.annotationRatio||0)<0.05&&(l.features?.repetitionRatio||0)<0.2
      &&!selected.has(l.name)&&!/(寸法|文字|補助|家具|建具|通り芯|ハッチ|hatch|grid|dim|furn)/i.test(l.name)).map(l=>l.name));
    const context=all.filter(s=>allowed.has(s.layer)&&meetsMinimumSpan(s.length,opts));
    const candidates=[], groups=new Map();
    for(const s of all.filter(s=>allowed.has(s.layer))) {
      if(!groups.has(s.layer))groups.set(s.layer,{total:0,matches:new Map(),sources:new Set()});
      groups.get(s.layer).total+=s.length;
    }
    const unionLength=spans=>{
      let end=-Infinity,total=0;
      for(const [lo,hi] of [...spans].sort((a,b)=>a[0]-b[0])){total+=Math.max(0,hi-Math.max(lo,end));end=Math.max(end,hi);}
      return total;
    };
    for(const b of context) {
      const group=groups.get(b.layer);
      for(const a of target) {
        if(Math.max(a.x1,a.x2)+opts.pairMax<Math.min(b.x1,b.x2)||Math.max(b.x1,b.x2)+opts.pairMax<Math.min(a.x1,a.x2)
          ||Math.max(a.y1,a.y2)+opts.pairMax<Math.min(b.y1,b.y2)||Math.max(b.y1,b.y2)+opts.pairMax<Math.min(a.y1,a.y2))continue;
        const g=pairGeometry(a,b,{...opts,angleTolerance:0.5});
        if(!g||!thicknesses.some(t=>Math.abs(t-g.thickness)<=Math.max(1e-6,t*0.12)))continue;
        // Check spacing at both ends, not just the first point of a skewed line.
        const d2=Math.abs((a.x2-a.x1)*(b.y2-a.y1)-(a.y2-a.y1)*(b.x2-a.x1))/a.length;
        if(Math.abs(d2-g.thickness)>Math.max(1e-6,g.thickness*0.02))continue;
        candidates.push({a,b,g});group.sources.add(a.id);
        if(!group.matches.has(b.id))group.matches.set(b.id,[]);
        group.matches.get(b.id).push(g.bInterval);
      }
    }
    const accepted=new Set([...groups].filter(([,g])=>g.sources.size>=3&&g.matches.size>=3
      &&[...g.matches.values()].reduce((sum,spans)=>sum+unionLength(spans),0)/g.total>=0.65).map(([layer])=>layer));
    const eligible=candidates.filter(p=>accepted.has(p.b.layer));
    const occupied=coveredSourceIntervals(target,walls), supportUsed=new Map();
    for(const p of eligible.sort((a,b)=>b.g.overlap-a.g.overlap)) {
      const {a,b,g}=p;
      // Two plausible offsets for the same source interval are ambiguous.
      if(eligible.some(q=>q!==p&&q.a.id===a.id
        &&Math.min(q.g.aInterval[1],g.aInterval[1])-Math.max(q.g.aInterval[0],g.aInterval[0])>1e-6
        &&Math.abs((g.x1-q.g.x1)*(a.y2-a.y1)-(g.y1-q.g.y1)*(a.x2-a.x1))/a.length>1e-5))continue;
      if(eligible.some(q=>q!==p&&q.b.id===b.id
        &&Math.min(q.g.bInterval[1],g.bInterval[1])-Math.max(q.g.bInterval[0],g.bInterval[0])>1e-6
        &&Math.abs((g.x1-q.g.x1)*(b.y2-b.y1)-(g.y1-q.g.y1)*(b.x2-b.x1))/b.length>1e-5))continue;
      let spans=[g.aInterval];
      const remove=blocked=>{for(const [lo,hi] of blocked){spans=spans.flatMap(([s,e])=>hi<=s||lo>=e?[[s,e]]:[[s,Math.min(e,lo)],[Math.max(s,hi),e]].filter(([x,y])=>y-x>1e-6));}};
      remove(occupied.get(a.id)||[]);
      const as=g.aInterval[0],ae=g.aInterval[1],ux=(a.x2-a.x1)/a.length,uy=(a.y2-a.y1)/a.length;
      const bStart=(b.x1-a.x1)*ux+(b.y1-a.y1)*uy,bEnd=(b.x2-a.x1)*ux+(b.y2-a.y1)*uy;
      const toSupport=s=>(s-bStart)*b.length/(bEnd-bStart);
      const toPrimary=s=>bStart+s*(bEnd-bStart)/b.length;
      remove((supportUsed.get(b.id)||[]).map(span=>span.map(toPrimary).sort((a,b)=>a-b)));
      for(const [lo,hi] of spans) {
        if(!meetsMinimumSpan(hi-lo,opts))continue;
        const start=(lo-as)/(ae-as),end=(hi-as)/(ae-as),supportSpan=[toSupport(lo),toSupport(hi)].sort((a,b)=>a-b);
        result.push({id:`wall-${result.length+1}`,x1:g.x1+start*(g.x2-g.x1),y1:g.y1+start*(g.y2-g.y1),
          x2:g.x1+end*(g.x2-g.x1),y2:g.y1+end*(g.y2-g.y1),length:hi-lo,angle:a.angle,thickness:g.thickness,
          layer:a.layer,sourceLayers:[a.layer],sourceSegmentIds:[a.id],sourceIntervals:[{id:a.id,span:[lo,hi]}],
          supportingSourceSegmentIds:[b.id],supportingSourceLayers:[b.layer],supportingSourceIntervals:[{id:b.id,span:supportSpan}],
          centerlineBasis:'context-paired-edges',confidence:0.72,
          evidence:['primary-layer wall edge','opposing edge on a geometrically matching companion layer','recurring wall thickness across at least three primary edges'],
          warnings:['cross-layer correspondence is a geometric hypothesis; not structurally verified']});
        if(!occupied.has(a.id))occupied.set(a.id,[]);occupied.get(a.id).push([lo,hi]);
        if(!supportUsed.has(b.id))supportUsed.set(b.id,[]);supportUsed.get(b.id).push(supportSpan);
      }
    }
    return result;
  }

  function recoverCompanionWallLayerPairs(segments,walls,selectedLayers,options) {
    const opts={minWallLen:500,pairMin:60,pairMax:450,...options};
    if(!opts.extractCompanionWallLayers)return [...walls];
    const selected=new Set(selectedLayers),assessments=new Map((opts.layerAssessments||[]).map(layer=>[layer.name,layer]));
    const layers=new Set(walls.flatMap(w=>w.supportingSourceLayers||[]).filter(layer=>{
      const assessment=assessments.get(layer);
      return !selected.has(layer)&&assessment&&assessment.role==='wall'
        &&!(assessment.risks||[]).includes('mixed content')
        &&(assessment.features?.annotationRatio||0)<0.05&&(assessment.features?.repetitionRatio||0)<0.2;
    }));
    if(!layers.size)return [...walls];
    const reserved=new Set(walls.flatMap(w=>[...(w.sourceSegmentIds||[]),...(w.supportingSourceSegmentIds||[])]));
    const result=[...walls];
    for(const layer of layers) {
      const candidates=extractWallCenterlines(segments.filter(segment=>(segment.layer||'0')===layer),{
        ...opts,requirePair:true,selectedWallLayer:true,recoverConnectedShorts:true,
      });
      for(const candidate of candidates) {
        if((candidate.sourceSegmentIds||[]).some(id=>reserved.has(id)))continue;
        const sourceSegmentIds=[...(candidate.sourceSegmentIds||[])];
        result.push({...candidate,id:`wall-${result.length+1}`,layer,sourceLayers:[layer],sourceSegmentIds,
          centerlineBasis:'companion-layer-paired-edges',confidence:Math.min(candidate.confidence||0.82,0.82),
          evidence:['paired wall edges','geometrically verified companion wall layer','recurring cross-layer wall correspondence'],
          warnings:['companion wall layer was promoted after repeated geometric correspondence; structural role not verified']});
        sourceSegmentIds.forEach(id=>reserved.add(id));
      }
    }
    return result;
  }

  function recoverResidualWallPairs(segments,walls,selectedLayers,options) {
    const opts={minWallLen:500,pairMin:60,pairMax:450,...options},selected=new Set(selectedLayers);
    const source=segments.filter(s=>selected.has(s.layer)).map(normalizedSegment).filter(s=>s.length>1e-6);
    const occupied=coveredSourceIntervals(source,walls),pieces=[],result=[...walls];
    // A small closed outline may be a column/equipment symbol, not a wall.
    // Keep it unresolved even when it is near a plausible opposing edge.
    const compactLoops=new Set(),adjacency=new Map(),keys=s=>[`${s.layer}:${Math.round(s.x1*1e4)}:${Math.round(s.y1*1e4)}`,`${s.layer}:${Math.round(s.x2*1e4)}:${Math.round(s.y2*1e4)}`];
    const unused=source.filter(s=>!occupied.has(s.id)),visited=new Set();
    for(const s of unused)for(const k of keys(s)){if(!adjacency.has(k))adjacency.set(k,[]);adjacency.get(k).push(s);}
    for(const seed of unused) {
      if(visited.has(seed.id))continue;const todo=[seed],group=[];visited.add(seed.id);
      while(todo.length){const s=todo.pop();group.push(s);for(const k of keys(s))for(const t of adjacency.get(k)||[])if(!visited.has(t.id)){visited.add(t.id);todo.push(t);}}
      if(group.length<3||group.length>8||group.some(s=>keys(s).some(k=>adjacency.get(k).length!==2)))continue;
      const xs=group.flatMap(s=>[s.x1,s.x2]),ys=group.flatMap(s=>[s.y1,s.y2]);
      if(Math.max(...xs)-Math.min(...xs)<=opts.pairMax&&Math.max(...ys)-Math.min(...ys)<=opts.pairMax)group.forEach(s=>compactLoops.add(s.id));
    }
    const minimum=opts.excludeAtOrBelowMinWallLen?opts.minWallLen:Math.max(opts.pairMin,opts.minWallLen*0.2);
    const minimumOptions={...opts,minWallLen:minimum};
    for(const s of source) {
      let cursor=0;const gaps=[];
      for(const [lo,hi] of (occupied.get(s.id)||[]).sort((a,b)=>a[0]-b[0])){if(lo>cursor+1e-6)gaps.push([cursor,lo]);cursor=Math.max(cursor,hi);}
      if(s.length-cursor>1e-6)gaps.push([cursor,s.length]);
      for(const [lo,hi] of gaps)if(meetsMinimumSpan(hi-lo,minimumOptions))pieces.push({...s,offset:lo,
        x1:s.x1+(s.x2-s.x1)*lo/s.length,y1:s.y1+(s.y2-s.y1)*lo/s.length,
        x2:s.x1+(s.x2-s.x1)*hi/s.length,y2:s.y1+(s.y2-s.y1)*hi/s.length,length:hi-lo});
    }
    const candidates=[];
    for(let i=0;i<pieces.length;i++)for(let j=i+1;j<pieces.length;j++) {
      const a=pieces[i],b=pieces[j];if(a.layer!==b.layer||a.id===b.id||compactLoops.has(a.id)||compactLoops.has(b.id))continue;
      const g=pairGeometry(a,b,{...minimumOptions,angleTolerance:0.1});
      if(!g||g.overlap<g.thickness*0.75||!walls.some(w=>w.layer===a.layer&&Math.abs(w.thickness-g.thickness)<=Math.max(1,w.thickness*0.02)))continue;
      const ux=(g.x2-g.x1)/g.overlap,uy=(g.y2-g.y1)/g.overlap;
      const capAt=(x,y)=>{
        // A cap is continuous geometry, not necessarily one CAD entity.
        // Union collinear strokes without bridging even small source gaps.
        const spans=source.filter(s=>s.layer===a.layer&&s.id!==a.id&&s.id!==b.id
          &&Math.abs((s.x1-x)*ux+(s.y1-y)*uy)<1e-5&&Math.abs((s.x2-x)*ux+(s.y2-y)*uy)<1e-5)
          .map(s=>[-(s.x1-x)*uy+(s.y1-y)*ux,-(s.x2-x)*uy+(s.y2-y)*ux].sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
        let cursor=-g.thickness/2;
        for(const [lo,hi] of spans){if(hi<cursor-1e-5)continue;if(lo>cursor+1e-5)return false;cursor=Math.max(cursor,hi);if(cursor>=g.thickness/2-1e-5)return true;}
        return false;
      };
      const capStart=capAt(g.x1,g.y1),capEnd=capAt(g.x2,g.y2);
      if(g.overlap<g.thickness*1.5&&(!capStart&&!capEnd||capStart&&capEnd))continue;
      const anchored=walls.some(w=>w.layer===a.layer&&[0,1].some(end=>{
        // An anchor must be at the uncapped end. The diagonal allowance
        // accounts for two finite paired axes stopping at a real L corner.
        if(end?capEnd:capStart)return false;
        const p={x:end?g.x2:g.x1,y:end?g.y2:g.y1};
        return pointSegmentDistance(p,w)<=Math.hypot(g.thickness,w.thickness||0)/2+1e-5;
      }));
      if(!anchored)continue;
      candidates.push({a,b,g});
    }
    const reservations=new Map();
    for(const p of candidates.sort((a,b)=>b.g.overlap-a.g.overlap)) {
      const {a,b,g}=p,spans=[{id:a.id,span:g.aInterval.map(t=>t+a.offset)},{id:b.id,span:g.bInterval.map(t=>t+b.offset)}];
      const overlap=(a,b)=>Math.min(a[1],b[1])-Math.max(a[0],b[0])>1e-5;
      // Competing offsets on either source are not resolved by input order.
      if(candidates.some(q=>q!==p&&spans.some(s=>[{id:q.a.id,span:q.g.aInterval.map(t=>t+q.a.offset)},{id:q.b.id,span:q.g.bInterval.map(t=>t+q.b.offset)}].some(t=>t.id===s.id&&overlap(t.span,s.span)))
        &&pointSegmentDistance({x:(g.x1+g.x2)/2,y:(g.y1+g.y2)/2},q.g)>1e-5))continue;
      if(spans.some(s=>(reservations.get(s.id)||[]).some(t=>overlap(s.span,t))))continue;
      result.push({id:`wall-${result.length+1}`,x1:g.x1,y1:g.y1,x2:g.x2,y2:g.y2,length:g.overlap,thickness:g.thickness,
        angle:Math.atan2(g.y2-g.y1,g.x2-g.x1),layer:a.layer,sourceSegmentIds:[a.id,b.id],sourceIntervals:spans,
        confidence:0.7,evidence:['paired wall edges','unused source intervals','connected to an established wall; recurring thickness'],warnings:['residual paired recovery']});
      for(const s of spans){if(!reservations.has(s.id))reservations.set(s.id,[]);reservations.get(s.id).push(s.span);}
    }
    return result;
  }

  // Reference-line simplification, separate from raw paired-edge diagnostics.
  // Never bridge by distance alone: two established portions must share the
  // SAME continuous source edge and have a connected opposing contour. Caps
  // which return to the shared edge cannot supply that opposing path.
  function deriveWallReferences(segments, walls) {
    const eps=1e-4, sources=segments.filter(s=>[s.x1,s.y1,s.x2,s.y2].every(Number.isFinite))
      .map(normalizedSegment).filter(s=>s.length>eps), sourceMap=new Map(sources.map(s=>[s.id,s]));
    const bySource=new Map(), connections=[];
    for(const [index,w] of walls.entries()) if(w.thickness>0) for(const id of w.sourceSegmentIds||[]) {
      if(!bySource.has(id))bySource.set(id,[]);bySource.get(id).push(index);
    }
    function opposingPath(spine, a, b, lo, hi, width) {
      const ux=(spine.x2-spine.x1)/spine.length,uy=(spine.y2-spine.y1)/spine.length;
      const along=p=>(p.x-spine.x1)*ux+(p.y-spine.y1)*uy;
      const normal=p=>-(p.x-spine.x1)*uy+(p.y-spine.y1)*ux;
      const na=normal({x:a.x1,y:a.y1}),nb=normal({x:b.x1,y:b.y1}),sign=Math.sign(na);
      if(!sign||na*nb<=0||Math.abs(na-nb)>width*.25+eps)return null;
      const at=(s,n)=>({x:spine.x1+s*ux-n*uy,y:spine.y1+s*uy+n*ux});
      const start=at(lo,na*2),end=at(hi,nb*2);
      const allowed=new Set([a.layer,...(a.supportingSourceLayers||[]),...(b.supportingSourceLayers||[])]);
      const key=p=>`${Math.round(p.x/eps)},${Math.round(p.y/eps)}`,graph=new Map();
      const add=(p,q,s,span)=>{const k=key(p);if(!graph.has(k))graph.set(k,[]);graph.get(k).push({to:key(q),id:s.id,span,length:Math.hypot(q.x-p.x,q.y-p.y)});};
      for(const s of sources) {
        if(s.id===spine.id||!allowed.has(s.layer))continue;
        const p={x:s.x1,y:s.y1},q={x:s.x2,y:s.y2};
        if([p,q].some(v=>normal(v)*sign<=eps||normal(v)*sign>width*6+eps
          ||along(v)<lo-width*8-eps||along(v)>hi+width*8+eps))continue;
        const cuts=[{p,t:0},{p:q,t:s.length}];
        for(const v of [start,end])if(pointSegmentDistance(v,s)<=eps) {
          const t=((v.x-s.x1)*(s.x2-s.x1)+(v.y-s.y1)*(s.y2-s.y1))/s.length;
          if(t>eps&&t<s.length-eps)cuts.push({p:v,t});
        }
        cuts.sort((a,b)=>a.t-b.t);
        for(let i=1;i<cuts.length;i++) {
          const u=cuts[i-1],v=cuts[i];if(v.t-u.t<=eps)continue;
          add(u.p,v.p,s,[u.t,v.t]);add(v.p,u.p,s,[u.t,v.t]);
        }
      }
      const first=key(start),last=key(end),pending=[{key:first,length:0,path:[]}],best=new Map([[first,0]]);
      const simplePath=path=>{
        const edges=path.map(item=>{
          const s=sourceMap.get(item.id),ux=(s.x2-s.x1)/s.length,uy=(s.y2-s.y1)/s.length;
          return {x1:s.x1+item.span[0]*ux,y1:s.y1+item.span[0]*uy,
            x2:s.x1+item.span[1]*ux,y2:s.y1+item.span[1]*uy};
        });
        for(let i=0;i<edges.length;i++)for(let j=i+2;j<edges.length;j++) {
          const a=edges[i],b=edges[j],ux=a.x2-a.x1,uy=a.y2-a.y1,vx=b.x2-b.x1,vy=b.y2-b.y1;
          const dx=b.x1-a.x1,dy=b.y1-a.y1,den=ux*vy-uy*vx;
          if(Math.abs(den)>1e-12) {
            const t=(dx*vy-dy*vx)/den,u=(dx*uy-dy*ux)/den;
            if(t>=0&&t<=1&&u>=0&&u<=1)return false;
          }
          if([{x:a.x1,y:a.y1},{x:a.x2,y:a.y2}].some(p=>pointSegmentDistance(p,b)<=eps)
            ||[{x:b.x1,y:b.y1},{x:b.x2,y:b.y2}].some(p=>pointSegmentDistance(p,a)<=eps))return false;
        }
        return true;
      };
      while(pending.length) {
        pending.sort((a,b)=>b.length-a.length);const item=pending.pop();
        if(item.length>hi-lo+width*24)continue;
        if(item.key===last)return simplePath(item.path)?item.path:null;
        if(item.path.length>=24)continue;
        for(const edge of graph.get(item.key)||[]) {
          const length=item.length+edge.length;
          if(length>=(best.get(edge.to)??Infinity)-eps)continue;
          best.set(edge.to,length);pending.push({key:edge.to,length,path:[...item.path,{id:edge.id,span:edge.span}]});
        }
      }
      return null;
    }
    for(const [id,indexes] of bySource) {
      const spine=sourceMap.get(id);if(!spine||indexes.length<2)continue;
      const ux=(spine.x2-spine.x1)/spine.length,uy=(spine.y2-spine.y1)/spine.length;
      const entries=indexes.filter(i=>{
        const w=walls[i];return w.layer===spine.layer&&Math.abs((w.x2-w.x1)*uy-(w.y2-w.y1)*ux)<=eps;
      }).map(i=>({i,span:projectedInterval(spine,walls[i])})).sort((a,b)=>a.span[0]-b.span[0]);
      for(let i=1;i<entries.length;i++) {
        const left=entries[i-1],right=entries[i],a=walls[left.i],b=walls[right.i];
        const lo=left.span[1],hi=right.span[0],width=Math.max(a.thickness,b.thickness);
        if(hi-lo<=eps||hi-lo>width*2.5+eps)continue;
        const path=opposingPath(spine,a,b,lo,hi,width);if(!path?.length)continue;
        connections.push({a:left.i,b:right.i,source:id,span:[lo,hi],length:hi-lo,opposingPath:path});
      }
    }
    const parent=walls.map((_,i)=>i),root=i=>parent[i]===i?i:(parent[i]=root(parent[i]));
    for(const c of connections)parent[root(c.b)]=root(c.a);
    const groups=new Map();walls.forEach((_,i)=>{const k=root(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);});
    const replacement=new Map();
    for(const indexes of groups.values()) {
      if(indexes.length<2)continue;
      const members=indexes.map(i=>walls[i]),anchor=[...members].sort((a,b)=>b.length-a.length||String(a.id).localeCompare(String(b.id)))[0];
      const length=segLen(anchor),ux=(anchor.x2-anchor.x1)/length,uy=(anchor.y2-anchor.y1)/length;
      const points=members.flatMap(w=>[{x:w.x1,y:w.y1},{x:w.x2,y:w.y2}]);
      const offsets=points.map(p=>Math.abs(-(p.x-anchor.x1)*uy+(p.y-anchor.y1)*ux)),shift=Math.max(...offsets);
      if(shift>Math.max(...members.map(w=>w.thickness))*.25+eps)continue;
      const positions=points.map(p=>(p.x-anchor.x1)*ux+(p.y-anchor.y1)*uy),lo=Math.min(...positions),hi=Math.max(...positions);
      const gaps=connections.filter(c=>indexes.includes(c.a)&&indexes.includes(c.b));
      const primary=[],support=[];
      for(const w of members){primary.push(...(w.sourceIntervals||[]));support.push(...(w.supportingSourceIntervals||[]));}
      for(const g of gaps)for(const interval of [{id:g.source,span:g.span},...g.opposingPath]) {
        (sourceMap.get(interval.id)?.layer===anchor.layer?primary:support).push(interval);
      }
      const union=items=>{
        const buckets=new Map();for(const item of items){if(!buckets.has(item.id))buckets.set(item.id,[]);buckets.get(item.id).push([...item.span]);}
        const out=[];for(const [id,spans] of buckets)for(const span of spans.sort((a,b)=>a[0]-b[0])) {
          const prev=out.at(-1);if(prev?.id===id&&span[0]<=prev.span[1]+eps)prev.span[1]=Math.max(prev.span[1],span[1]);else out.push({id,span});
        }return out;
      };
      const sourceIntervals=union(primary),supportingSourceIntervals=union(support);
      const ref={...walls[indexes[0]],x1:anchor.x1+lo*ux,y1:anchor.y1+lo*uy,x2:anchor.x1+hi*ux,y2:anchor.y1+hi*uy,
        length:hi-lo,angle:Math.atan2(uy,ux),thickness:null,centerlineBasis:'boundary-continuity-reference',confidence:0.65,
        sourceSegmentIds:[...new Set(sourceIntervals.map(s=>s.id))],sourceIntervals,
        supportingSourceSegmentIds:[...new Set(supportingSourceIntervals.map(s=>s.id))],supportingSourceIntervals,
        supportingSourceLayers:[...new Set(supportingSourceIntervals.map(s=>sourceMap.get(s.id).layer))],
        evidence:['established paired wall portions','continuous shared source boundary','connected opposing contour','single reference aligned to the longest supported portion'],
        warnings:['simplified reference, not an exact wall centerline; openings and wall identity require validation'],
        continuity:{method:'source-boundary-path/1',anchorWallId:anchor.id,componentWallIds:members.map(w=>w.id),maxAxisShift:shift,
          originalGeometries:members.map(w=>({id:w.id,x1:w.x1,y1:w.y1,x2:w.x2,y2:w.y2,thickness:w.thickness})),
          gaps:gaps.map(({source,span,length,opposingPath})=>({source,span,length,opposingPath}))}};
      replacement.set(indexes[0],ref);for(const i of indexes.slice(1))replacement.set(i,null);
    }
    return walls.flatMap((w,i)=>replacement.has(i)?(replacement.get(i)?[replacement.get(i)]:[]):[w]);
  }

  function deriveWallOutputSegments(segments, references) {
    const eps=1e-4, angleTolerance=Math.sin(Math.PI/36);
    const sourceMap=new Map(segments.filter(s=>s&&s.id).map(s=>[s.id,normalizedSegment(s)]));
    const walls=(references||[]).filter(w=>w&&segLen(w)>eps), endpointCandidates=walls.map(()=>[[],[]]);
    const thickness=wall=>Math.max(0,Number(wall.thickness)||0,
      ...(wall.continuity?.originalGeometries||[]).map(item=>Number(item.thickness)||0));
    const sourceIds=wall=>[...new Set([...(wall.sourceSegmentIds||[]),...(wall.supportingSourceSegmentIds||[])])];
    const endpoints=segment=>[{x:segment.x1,y:segment.y1},{x:segment.x2,y:segment.y2}];
    const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    const sourceJunctionSupported=(a,b,point,radius)=>{
      const first=sourceIds(a).map(id=>sourceMap.get(id)).filter(Boolean);
      const second=sourceIds(b).map(id=>sourceMap.get(id)).filter(Boolean);
      for(const left of first)for(const right of second) {
        for(const p of endpoints(left))if(pointSegmentDistance(p,right)<=eps&&distance(p,point)<=radius)return true;
        for(const p of endpoints(right))if(pointSegmentDistance(p,left)<=eps&&distance(p,point)<=radius)return true;
      }
      return false;
    };
    const addCandidate=(wallIndex,endIndex,point,otherIndex,kind)=>{
      const wall=walls[wallIndex],start=endIndex===0?{x:wall.x1,y:wall.y1}:{x:wall.x2,y:wall.y2};
      const gap=distance(start,point);if(gap<=eps)return;
      endpointCandidates[wallIndex][endIndex].push({point,otherIndex,kind,gap});
    };
    for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++) {
      const a=walls[i],b=walls[j],lengthA=segLen(a),lengthB=segLen(b);
      const ua={x:(a.x2-a.x1)/lengthA,y:(a.y2-a.y1)/lengthA};
      const ub={x:(b.x2-b.x1)/lengthB,y:(b.y2-b.y1)/lengthB};
      const cross=ua.x*ub.y-ua.y*ub.x,dot=ua.x*ub.x+ua.y*ub.y;
      const widthA=thickness(a),widthB=thickness(b),largest=Math.max(widthA,widthB);
      if(Math.abs(cross)>=1-angleTolerance) {
        if(!widthA&&!widthB)continue;
        const dx=b.x1-a.x1,dy=b.y1-a.y1;
        const alongA=(dx*ub.y-dy*ub.x)/cross,alongB=(dx*ua.y-dy*ua.x)/cross;
        const point={x:a.x1+alongA*ua.x,y:a.y1+alongA*ua.y};
        const tolerance=Math.max(2,largest*.01),reachA=widthB/2+tolerance,reachB=widthA/2+tolerance;
        if(alongA<-reachA||alongA>lengthA+reachA||alongB<-reachB||alongB>lengthB+reachB)continue;
        const candidates=[];
        for(const [endIndex,position] of [[0,0],[1,lengthA]])if(Math.abs(alongA-position)<=reachA)candidates.push([i,endIndex]);
        for(const [endIndex,position] of [[0,0],[1,lengthB]])if(Math.abs(alongB-position)<=reachB)candidates.push([j,endIndex]);
        if(!candidates.length||!sourceJunctionSupported(a,b,point,largest*2+tolerance))continue;
        for(const [wallIndex,endIndex] of candidates)addCandidate(wallIndex,endIndex,point,wallIndex===i?j:i,'orthogonal-junction');
        continue;
      }
      if(Math.abs(cross)>angleTolerance||Math.abs(dot)<1-angleTolerance||!largest)continue;
      let nearest=null;
      for(const [endA,pointA] of endpoints(a).entries())for(const [endB,pointB] of endpoints(b).entries()) {
        const gap=distance(pointA,pointB);if(!nearest||gap<nearest.gap)nearest={endA,endB,pointA,pointB,gap};
      }
      const tolerance=Math.max(2,largest*.01),limit=largest*.25+tolerance;
      if(!nearest||nearest.gap>limit)continue;
      const point={x:(nearest.pointA.x+nearest.pointB.x)/2,y:(nearest.pointA.y+nearest.pointB.y)/2};
      if(!sourceJunctionSupported(a,b,point,largest*2+tolerance))continue;
      addCandidate(i,nearest.endA,point,j,'aligned-junction');
      addCandidate(j,nearest.endB,point,i,'aligned-junction');
    }
    const connectors=[],seen=new Set(),coord=value=>Math.round(value/eps);
    for(let wallIndex=0;wallIndex<walls.length;wallIndex++)for(let endIndex=0;endIndex<2;endIndex++) {
      const choices=endpointCandidates[wallIndex][endIndex].sort((a,b)=>a.gap-b.gap);
      if(!choices.length)continue;
      const chosen=choices[0];
      if(choices.some(item=>Math.abs(item.gap-chosen.gap)<=eps
        &&distance(item.point,chosen.point)>eps))continue;
      const wall=walls[wallIndex],other=walls[chosen.otherIndex];
      const start=endIndex===0?{x:wall.x1,y:wall.y1}:{x:wall.x2,y:wall.y2};
      const key=[coord(start.x),coord(start.y),coord(chosen.point.x),coord(chosen.point.y)].join(':');
      const reverse=[coord(chosen.point.x),coord(chosen.point.y),coord(start.x),coord(start.y)].join(':');
      if(seen.has(key)||seen.has(reverse))continue;seen.add(key);
      connectors.push({id:`wall-junction-${connectors.length+1}`,layer:wall.layer||'0',x1:start.x,y1:start.y,
        x2:chosen.point.x,y2:chosen.point.y,length:chosen.gap,angle:Math.atan2(chosen.point.y-start.y,chosen.point.x-start.x),
        thickness:null,confidence:Math.min(Number(wall.confidence)||0,Number(other.confidence)||0),
        centerlineBasis:'source-supported-junction-connector',outputRole:'junction-connector',connectorKind:chosen.kind,
        connectedWallIds:[wall.id,other.id].filter(Boolean),sourceSegmentIds:[...new Set([...sourceIds(wall),...sourceIds(other)])],
        evidence:['nearby wall references meet within their source wall thickness','their original wall boundaries connect at the same junction'],
        warnings:['output connector only; original reference intervals remain unchanged']});
    }
    const referenceOutput=walls.map(wall=>({...wall,outputRole:'wall-reference'}));
    const outputSoFar=[...referenceOutput,...connectors];
    const lineDistance=(point,origin,ux,uy)=>Math.abs(-(point.x-origin.x)*uy+(point.y-origin.y)*ux);
    const gapCovered=(a,b,start,end,width)=>{
      const length=distance(start,end);if(length<=eps)return true;
      const ux=(end.x-start.x)/length,uy=(end.y-start.y)/length,tolerance=Math.max(1,width*.03);
      const spans=[];
      for(const segment of outputSoFar) {
        if(segment.id===a.id||segment.id===b.id)continue;
        const points=endpoints(segment);
        if(points.some(point=>lineDistance(point,start,ux,uy)>tolerance))continue;
        const span=points.map(point=>(point.x-start.x)*ux+(point.y-start.y)*uy).sort((left,right)=>left-right);
        if(span[1]<-eps||span[0]>length+eps)continue;
        spans.push([Math.max(0,span[0]),Math.min(length,span[1])]);
      }
      let cursor=0;
      for(const [lo,hi] of spans.sort((left,right)=>left[0]-right[0])) {
        if(hi<=cursor+tolerance)continue;
        if(lo>cursor+tolerance)return false;
        cursor=Math.max(cursor,hi);if(cursor>=length-tolerance)return true;
      }
      return false;
    };
    const continuityCandidates=[];
    for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++) {
      const a=walls[i],b=walls[j],lengthA=segLen(a),lengthB=segLen(b);
      const ua={x:(a.x2-a.x1)/lengthA,y:(a.y2-a.y1)/lengthA};
      const ub={x:(b.x2-b.x1)/lengthB,y:(b.y2-b.y1)/lengthB};
      const cross=ua.x*ub.y-ua.y*ub.x,dot=ua.x*ub.x+ua.y*ub.y;
      if(Math.abs(cross)>angleTolerance||Math.abs(dot)<1-angleTolerance)continue;
      const projected=endpoints(b).map(point=>(point.x-a.x1)*ua.x+(point.y-a.y1)*ua.y).sort((left,right)=>left-right);
      const sharedSources=(a.sourceSegmentIds||[]).filter(id=>(b.sourceSegmentIds||[]).includes(id))
        .filter(id=>{
          const source=sourceMap.get(id);if(!source||source.length<=eps)return false;
          const sx=(source.x2-source.x1)/source.length,sy=(source.y2-source.y1)/source.length;
          return Math.abs(ua.x*sy-ua.y*sx)<=angleTolerance;
        });
      if(!sharedSources.length)continue;
      let nearest=null;
      for(const [endA,pointA] of endpoints(a).entries())for(const [endB,pointB] of endpoints(b).entries()) {
        const gap=distance(pointA,pointB);if(!nearest||gap<nearest.gap)nearest={endA,endB,pointA,pointB,gap};
      }
      const widthA=thickness(a),widthB=thickness(b),width=Math.max(widthA,widthB),tolerance=Math.max(2,width*.01);
      const overlap=Math.min(lengthA,projected[1])-Math.max(0,projected[0]);
      const longitudinalGap=Math.max(0,projected[0]-lengthA,-projected[1]);
      const along=nearest?Math.abs((nearest.pointB.x-nearest.pointA.x)*ua.x+(nearest.pointB.y-nearest.pointA.y)*ua.y):Infinity;
      const lateral=nearest?lineDistance(nearest.pointB,nearest.pointA,ua.x,ua.y):Infinity;
      const expectedShift=Math.abs(widthA-widthB)/2;
      const transitionSources=sharedSources.filter(id=>{
        const source=sourceMap.get(id),sx=(source.x2-source.x1)/source.length,sy=(source.y2-source.y1)/source.length;
        const signedOffset=point=>-(point.x-source.x1)*sy+(point.y-source.y1)*sx;
        const offsetA=signedOffset(nearest.pointA),offsetB=signedOffset(nearest.pointB);
        return offsetA*offsetB>0
          &&Math.abs(pointSegmentDistance(nearest.pointA,source)-widthA/2)<=tolerance
          &&Math.abs(pointSegmentDistance(nearest.pointB,source)-widthB/2)<=tolerance;
      });
      if(widthA&&widthB&&nearest&&expectedShift>tolerance&&overlap<=tolerance
        &&longitudinalGap<=width*.25+tolerance&&along<=width*.25+tolerance
        &&Math.abs(lateral-expectedShift)<=tolerance&&transitionSources.length
        &&!gapCovered(a,b,nearest.pointA,nearest.pointB,width)) {
        continuityCandidates.push({a,b,endA:nearest.endA,endB:nearest.endB,start:nearest.pointA,end:nearest.pointB,
          gap:nearest.gap,sharedSources:transitionSources,kind:'shared-source-axis-transition',
          evidence:['both wall references use the same uninterrupted source boundary','the centerline shift equals half of the supported wall-thickness change']});
        continue;
      }
      if(projected[0]<=lengthA+eps&&projected[1]>=-eps)continue;
      if(!width||!nearest||nearest.gap>width*1.05+tolerance)continue;
      if(along<=eps||lateral>Math.max(tolerance,width*.08))continue;
      if(gapCovered(a,b,nearest.pointA,nearest.pointB,width))continue;
      continuityCandidates.push({a,b,endA:nearest.endA,endB:nearest.endB,start:nearest.pointA,end:nearest.pointB,
        gap:nearest.gap,sharedSources,kind:'shared-source-continuity',
        evidence:['both wall references use the same uninterrupted source boundary','the remaining reference gap is no wider than the supported wall thickness']});
    }
    const usedEndpoints=new Set(),continuityConnectors=[];
    for(const candidate of continuityCandidates.sort((a,b)=>a.gap-b.gap)) {
      const first=`${candidate.a.id}:${candidate.endA}`,second=`${candidate.b.id}:${candidate.endB}`;
      if(usedEndpoints.has(first)||usedEndpoints.has(second))continue;
      usedEndpoints.add(first);usedEndpoints.add(second);
      continuityConnectors.push({id:`wall-junction-${connectors.length+continuityConnectors.length+1}`,
        layer:candidate.a.layer||candidate.b.layer||'0',x1:candidate.start.x,y1:candidate.start.y,x2:candidate.end.x,y2:candidate.end.y,
        length:candidate.gap,angle:Math.atan2(candidate.end.y-candidate.start.y,candidate.end.x-candidate.start.x),
        thickness:null,confidence:Math.min(Number(candidate.a.confidence)||0,Number(candidate.b.confidence)||0),
        centerlineBasis:`${candidate.kind}-connector`,outputRole:'junction-connector',connectorKind:candidate.kind,
        connectedWallIds:[candidate.a.id,candidate.b.id].filter(Boolean),sourceSegmentIds:candidate.sharedSources,
        evidence:candidate.evidence,
        warnings:['output connector only; source wall outlines and opening geometry remain unchanged']});
    }
    return [...outputSoFar,...continuityConnectors];
  }

  function projectedInterval(source, wall) {
    const len=segLen(source),ux=(source.x2-source.x1)/len,uy=(source.y2-source.y1)/len;
    return [ux*(wall.x1-source.x1)+uy*(wall.y1-source.y1),ux*(wall.x2-source.x1)+uy*(wall.y2-source.y1)]
      .map(v=>Math.max(0,Math.min(len,v))).sort((a,b)=>a-b);
  }

  function coveredSourceIntervals(segments,walls) {
    const sources=new Map(segments.map(s=>[s.id,s])), covered=new Map();
    for(const wall of walls) for(const id of wall.sourceSegmentIds || []) {
      const source=sources.get(id);
      if(!source || segLen(source)<1e-6)continue;
      if(!covered.has(id))covered.set(id,[]);
      // Pair intervals are measured from canonical (normalized) source start.
      // Do not re-project the centerline: near-parallel pairs can have different
      // lengths and projecting creates false unpaired tails.
      const exact=wall.sourceIntervals?.find(interval=>interval.id===id)?.span;
      const forward=source.x1<source.x2 || (source.x1===source.x2 && source.y1<=source.y2);
      const length=segLen(source);
      covered.get(id).push(exact ? (forward ? [...exact] : [length-exact[1],length-exact[0]]) : projectedInterval(source,wall));
    }
    return covered;
  }

  function segmentsInBounds(segments,bounds) {
    if(!bounds)return segments;
    return segments.filter(s=>{
      let start=0,end=1;
      const dx=s.x2-s.x1,dy=s.y2-s.y1;
      for(const [p,q] of [[-dx,s.x1-bounds.minx],[dx,bounds.maxx-s.x1],[-dy,s.y1-bounds.miny],[dy,bounds.maxy-s.y1]]) {
        if(Math.abs(p)<1e-12){if(q<0)return false;continue;}
        const t=q/p;
        if(p<0)start=Math.max(start,t);else end=Math.min(end,t);
        if(start>end)return false;
      }
      return true;
    });
  }

  // Account for every unused source interval, including partial pairs. These
  // are review geometry, NOT additional walls and never enter the WALL export.
  function reviewWallCoverage(segments,walls,selectedLayers,options) {
    const opts={minWallLen:500,pairMin:60,pairMax:450,...options};
    const selected=new Set(selectedLayers), target=segments.filter(s=>selected.has(s.layer));
    const covered=coveredSourceIntervals(target,walls);
    const context=segments.filter(s=>!selected.has(s.layer)&&meetsMinimumSpan(segLen(s),opts)
      && !['excluded','brace','column','beam'].includes(layerRole(s.layer))
      && !/(寸法|文字|補助|家具|建具|通り芯)/.test(s.layer));
    const unresolved=[],omitted=[],boundaryDetails=[];
    let intervalId=0;
    for(const source of target) {
      const length=segLen(source);if(length<1e-6)continue;
      let cursor=0;
      const gaps=[];
      for(const [lo,hi] of (covered.get(source.id)||[]).sort((a,b)=>a[0]-b[0])) {
        if(lo>cursor+1e-6)gaps.push([cursor,lo]);
        cursor=Math.max(cursor,hi);
      }
      if(cursor<length-1e-6)gaps.push([cursor,length]);
      // Duplicated CAD strokes need not become duplicate walls. Account for
      // their exact overlap with a known wall boundary, preserving every tail.
      const duplicateSpans=walls.filter(w=>w.layer===source.layer&&w.thickness>0).flatMap(w=>{
        const len=segLen(w),ux=(w.x2-w.x1)/len,uy=(w.y2-w.y1)/len;
        const offset=(x,y)=>(x-w.x1)*uy-(y-w.y1)*ux;
        const a=offset(source.x1,source.y1),b=offset(source.x2,source.y2);
        if(Math.abs(a-b)>1e-6||Math.abs(Math.abs(a)-w.thickness/2)>1e-6)return [];
        const span=projectedInterval(source,w);
        return span[1]-span[0]>1e-6?[{span,wallId:w.id}]:[];
      });
      const pieces=gaps.flatMap(([lo,hi])=>{
        const cuts=[lo,hi,...duplicateSpans.flatMap(d=>d.span).filter(t=>t>lo+1e-6&&t<hi-1e-6)].sort((a,b)=>a-b);
        return cuts.slice(1).map((end,i)=>[cuts[i],end]).filter(([a,b])=>b-a>1e-6);
      });
      for(const [lo,hi] of pieces) {
        const part={...source,x1:source.x1+(source.x2-source.x1)*lo/length,y1:source.y1+(source.y2-source.y1)*lo/length,
          x2:source.x1+(source.x2-source.x1)*hi/length,y2:source.y1+(source.y2-source.y1)*hi/length,
          id:`interval-${++intervalId}`,sourceSegmentId:source.id,length:hi-lo,
          reasonCode:meetsMinimumSpan(hi-lo,opts)?'no-compatible-pair'
            :opts.excludeAtOrBelowMinWallLen?'at-or-below-case-minimum':'below-main-span',context:[]};
        if(meetsMinimumSpan(part.length,opts)) {
          const nearby=context.filter(t=>Math.max(t.x1,t.x2)>=Math.min(part.x1,part.x2)-opts.pairMax
            &&Math.min(t.x1,t.x2)<=Math.max(part.x1,part.x2)+opts.pairMax
            &&Math.max(t.y1,t.y2)>=Math.min(part.y1,part.y2)-opts.pairMax
            &&Math.min(t.y1,t.y2)<=Math.max(part.y1,part.y2)+opts.pairMax);
          const matches=nearby.map(t=>({t,g:pairGeometry(part,t,{...opts,minWallLen:Math.max(opts.minWallLen,part.length*0.5)})}))
            .filter(p=>p.g).sort((a,b)=>a.g.thickness-b.g.thickness);
          const seen=new Set();
          for(const {t,g} of matches) {
            if(seen.has(t.layer))continue;
            seen.add(t.layer);part.context.push({sourceSegmentId:t.id,layer:t.layer,spacing:g.thickness,overlap:g.overlap});
            if(part.context.length===3)break;
          }
          if(part.context.length)part.reasonCode='cross-layer-only';
        }
        const represented=walls.filter(w=>w.thickness>0&&part.layer===w.layer&&part.length<=w.thickness*1.05+1e-6
          &&(()=>{
            const len=segLen(w),ux=(w.x2-w.x1)/len,uy=(w.y2-w.y1)/len;
            const along=(part.x1-w.x1)*ux+(part.y1-w.y1)*uy;
            return Math.abs((part.x2-part.x1)*ux+(part.y2-part.y1)*uy)<=1e-6
              &&(Math.abs(along)<=1e-6||Math.abs(along-len)<=1e-6);
          })()&&[0,1].every(end=>{
            const x=end?part.x2:part.x1,y=end?part.y2:part.y1,len=segLen(w);
            const ux=(w.x2-w.x1)/len,uy=(w.y2-w.y1)/len;
            const along=(x-w.x1)*ux+(y-w.y1)*uy,across=Math.abs((x-w.x1)*uy-(y-w.y1)*ux);
            return along>=-1e-6&&along<=len+1e-6&&across<=w.thickness/2+1e-6;
          }));
        const duplicateIds=duplicateSpans.filter(d=>d.span[0]<=lo+1e-6&&d.span[1]>=hi-1e-6).map(d=>d.wallId);
        if(represented.length||duplicateIds.length)boundaryDetails.push({...part,reasonCode:'represented-wall-boundary',wallIds:[...new Set([...represented.map(w=>w.id),...duplicateIds])]});
        else if(opts.excludeAtOrBelowMinWallLen&&!meetsMinimumSpan(part.length,opts))omitted.push({...part,
          omissionReason:`wall-source interval is ${opts.minWallLen} drawing units or shorter under the case-specific rule`});
        else unresolved.push(part);
      }
    }
    const paths=explainBoundaryPaths(unresolved,target,walls);
    const remaining=unresolved.filter(s=>!paths.has(s.id));
    for(const part of unresolved)if(paths.has(part.id))boundaryDetails.push({...part,...paths.get(part.id),reasonCode:'represented-wall-boundary'});
    return {complete:remaining.length===0&&omitted.length===0,accounted:remaining.length===0,
      sourceSegmentCount:target.length,unresolved:remaining,omitted,boundaryDetails,
      meaning:'Unresolved intervals remain uncertain. Case-specific short omissions are recorded with coordinates and length. Boundary details match wall caps, duplicate boundaries, or bounded corner/return paths anchored to paired wall edges; they are not separate axes. Companion-layer edges may provide recorded geometric evidence; only primary-layer walls are output.'};
  }

  // Both path tips must meet actual paired-source interval endpoints. Account
  // for small L corners/U returns without inventing axes or snapping gaps.
  function explainBoundaryPaths(parts,sources,walls) {
    const result=new Map(),eps=1e-5,nodes=[],edges=[],buckets=new Map();
    const nodeFor=(x,y,layer)=>{
      const ix=Math.floor(x/eps),iy=Math.floor(y/eps);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const n of buckets.get(`${layer}:${ix+dx}:${iy+dy}`)||[])
        if(Math.hypot(n.x-x,n.y-y)<=eps)return n;
      const n={x,y,layer,id:nodes.length,edges:[],anchors:[]};nodes.push(n);
      const key=`${layer}:${ix}:${iy}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(n);return n;
    };
    for(const part of parts) {
      const a=nodeFor(part.x1,part.y1,part.layer),b=nodeFor(part.x2,part.y2,part.layer);
      const e={part,a,b,id:edges.length};edges.push(e);a.edges.push(e);b.edges.push(e);
    }
    const sourceMap=new Map(sources.map(s=>[s.id,s]));
    for(const wall of walls.filter(w=>w.thickness>0))for(const item of wall.sourceIntervals||[]) {
      const source=sourceMap.get(item.id);if(!source)continue;
      const s=normalizedSegment(source),ux=(s.x2-s.x1)/s.length,uy=(s.y2-s.y1)/s.length;
      for(const t of item.span)nodeFor(s.x1+t*ux,s.y1+t*uy,s.layer).anchors.push(wall);
    }
    const local=(p,w)=>{const len=segLen(w),ux=(w.x2-w.x1)/len,uy=(w.y2-w.y1)/len;
      return {s:(p.x-w.x1)*ux+(p.y-w.y1)*uy,n:-(p.x-w.x1)*uy+(p.y-w.y1)*ux,len,ux,uy};};
    const atEnd=(p,w)=>{const q=local(p,w);return Math.min(Math.abs(q.s),Math.abs(q.s-q.len))<=eps;};
    const seen=new Set();
    for(const seed of edges) {
      if(seen.has(seed.id))continue;
      const stack=[seed],group=[],vertices=new Set();seen.add(seed.id);
      while(stack.length){const e=stack.pop();group.push(e);for(const n of [e.a,e.b]){vertices.add(n);for(const next of n.edges)if(!seen.has(next.id)){seen.add(next.id);stack.push(next);}}}
      const points=[...vertices],tips=points.filter(n=>n.edges.length===1);
      if(group.length>8||tips.length!==2||points.some(n=>n.edges.length>2))continue;
      // Walk in order and collapse only forward collinear strokes. Exact L/U
      // outlines are allowed; bounded but crossing/meandering paths are not.
      const path=[tips[0]];let previous=null,current=tips[0];
      while(current!==tips[1]){const edge=current.edges.find(e=>e!==previous);current=edge.a===current?edge.b:edge.a;path.push(current);previous=edge;}
      const bends=[];
      for(const p of path){
        while(bends.length>=2){const a=bends[bends.length-2],b=bends[bends.length-1],dx=b.x-a.x,dy=b.y-a.y,ex=p.x-b.x,ey=p.y-b.y;
          if(Math.abs(dx*ey-dy*ex)>eps*Math.hypot(dx,dy)||dx*ex+dy*ey<=0)break;bends.pop();}
        bends.push(p);
      }
      let explanation=null;
      for(const a of tips[0].anchors)for(const b of tips[1].anchors) {
        if(a.layer!==b.layer||!atEnd(tips[0],a)||!atEnd(tips[1],b))continue;
        const pa=local(tips[0],a),pb=local(tips[1],a),limit=Math.max(a.thickness,b.thickness);
        const shape=bends.map(p=>local(p,a));
        if(shape.slice(1).some((p,i)=>Math.abs(p.s-shape[i].s)>eps&&Math.abs(p.n-shape[i].n)>eps))continue;
        if(a.id===b.id) {
          const end=pa.s<a.length/2?0:a.length,direction=end===0?-1:1;
          if(shape.length!==4||Math.abs(shape[1].n-pa.n)>eps||Math.abs(shape[2].n-pb.n)>eps||Math.abs(shape[1].s-shape[2].s)>eps
            ||Math.abs(pa.s-pb.s)>eps||Math.abs(pa.n+pb.n)>eps
            ||Math.abs(Math.abs(pa.n)-a.thickness/2)>eps)continue;
          if(!points.every(p=>{const q=local(p,a);return Math.abs(q.n)<=a.thickness/2+eps
            &&(q.s-end)*direction>=-eps&&(q.s-end)*direction<=a.thickness*1.5+eps;}))continue;
          explanation={detailKind:'end-return-path',wallIds:[a.id],evidence:['continuous source path between both paired edges at the same wall end','bounded return within 1.5 wall thicknesses; no additional axis']};
        } else {
          if(shape.length!==3)continue;
          const qb=local(tips[1],b),den=pa.ux*qb.uy-pa.uy*qb.ux;
          if(Math.abs(pa.ux*qb.ux+pa.uy*qb.uy)>1e-6||Math.abs(den)<1e-6)continue;
          const dx=b.x1-a.x1,dy=b.y1-a.y1,t=(dx*qb.uy-dy*qb.ux)/den;
          const p={x:a.x1+t*pa.ux,y:a.y1+t*pa.uy},q=local(p,b);
          if(Math.min(Math.abs(t),Math.abs(t-a.length))>limit+eps||Math.min(Math.abs(q.s),Math.abs(q.s-b.length))>limit+eps)continue;
          if(!points.every(v=>Math.abs(local(v,a).n)<=a.thickness/2+eps&&Math.abs(local(v,b).n)<=b.thickness/2+eps))continue;
          explanation={detailKind:'corner-path',wallIds:[a.id,b.id],evidence:['continuous source path joining two paired wall-boundary endpoints','path lies inside the crossing wall strips; axes and openings unchanged']};
        }
      }
      if(explanation)for(const edge of group)result.set(edge.part.id,explanation);
    }
    return result;
  }

  // 平行配对: 两段近似平行且垂距在 [pmin,pmax]、投影有重叠 => 认定为“墙的两条边”
  function hasParallelPartner(seg, all, pmin, pmax) {
    const ax = seg.x2 - seg.x1, ay = seg.y2 - seg.y1;
    const alen = Math.hypot(ax, ay); if (alen < 1e-6) return false;
    const ux = ax / alen, uy = ay / alen;
    for (const t of all) {
      if (t === seg) continue;
      const bx = t.x2 - t.x1, by = t.y2 - t.y1;
      const blen = Math.hypot(bx, by); if (blen < 1e-6) continue;
      const cross = Math.abs(ux * by - uy * bx) / blen; // sin(夹角)
      if (cross > 0.09) continue; // >~5° 不算平行
      // t 起点相对 seg 的垂直距离
      const dx = t.x1 - seg.x1, dy = t.y1 - seg.y1;
      const perp = Math.abs(-uy * dx + ux * dy);
      if (perp < pmin || perp > pmax) continue;
      // 投影重叠
      const p1 = ux * dx + uy * dy;
      const dx2 = t.x2 - seg.x1, dy2 = t.y2 - seg.y1;
      const p2 = ux * dx2 + uy * dy2;
      const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
      if (hi < 0 || lo > alen) continue;
      return true;
    }
    return false;
  }

  // ---------- 3. 分类 ----------
  const REMOVE_TYPES = new Set(["INSERT", "TEXT", "MTEXT", "DIMENSION", "HATCH", "SOLID", "CIRCLE", "ARC", "ELLIPSE", "ATTDEF", "ATTRIB", "SPLINE", "POINT"]);

  function layerRole(layer) {
    const name = String(layer || "0").toUpperCase().replace(/[\s_-]+/g, " ");
    if (/(TEXT|DIM|ANNO|NOTE|家具|FURN|EQUIP|FIXTURE|什器)/.test(name)) return "excluded";
    if (/(BRACE|筋違|筋交|斜材|K FRAME|KFRAME)/.test(name)) return "brace";
    if (/(COLUMN| COL |柱)/.test(` ${name} `)) return "column";
    if (/(BEAM|梁)/.test(name)) return "beam";
    if (/(WALL|壁|KABE)/.test(name)) return "wall";
    return "unknown";
  }

  function summarizeLayers(ents) {
    const byName = new Map();
    for (const ent of ents || []) {
      const name = ent.layer || "0";
      if (!byName.has(name)) byName.set(name, { name, entities: 0, segments: 0, role: layerRole(name) });
      const row = byName.get(name);
      row.entities += 1;
      row.segments += segsOf(ent).length;
    }
    return Array.from(byName.values()).sort((a, b) => b.entities - a.entities || a.name.localeCompare(b.name));
  }

  const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const endsOf = s => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];

  function detectKFrames(segs, opts) {
    opts = opts || {};
    const unitsCode = opts.unitsCode || 0;
    const ext = extentsOf(segs);
    const millimeterDrawing = unitsCode === 4;
    const storyMin = millimeterDrawing ? 2500 : ext.diag * 0.12;
    const storyMax = millimeterDrawing ? 3300 : ext.diag * 0.55;
    const joinTolerance = millimeterDrawing ? 120 : ext.diag * 0.012;
    const levelTolerance = millimeterDrawing ? 220 : ext.diag * 0.025;
    const bayMin = millimeterDrawing ? 550 : ext.diag * 0.025;
    const bayMax = millimeterDrawing ? 1300 : ext.diag * 0.25;
    const verticals = segs.filter(s => {
      const length = segLen(s);
      return length >= storyMin && length <= storyMax && Math.abs(s.x2 - s.x1) <= length * 0.04;
    });
    const diagonals = segs.filter(s => {
      const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
      const role = layerRole(s.layer);
      return dx > joinTolerance && dy > joinTolerance && (role === "brace" || role === "unknown");
    });
    const frames = [];
    for (const column of verticals) {
      const bottom = column.y1 <= column.y2 ? { x: column.x1, y: column.y1 } : { x: column.x2, y: column.y2 };
      const top = column.y1 <= column.y2 ? { x: column.x2, y: column.y2 } : { x: column.x1, y: column.y1 };
      const mid = { x: (bottom.x + top.x) / 2, y: (bottom.y + top.y) / 2 };
      const touching = [];
      for (const diagonal of diagonals) {
        const ends = endsOf(diagonal);
        const atMid = pointDistance(ends[0], mid) <= joinTolerance ? 0 : pointDistance(ends[1], mid) <= joinTolerance ? 1 : -1;
        if (atMid < 0) continue;
        touching.push({ diagonal, far: ends[1 - atMid] });
      }
      let match = null;
      for (let i = 0; i < touching.length && !match; i++) {
        for (let j = i + 1; j < touching.length && !match; j++) {
          const a = touching[i], b = touching[j];
          const lower = a.far.y <= b.far.y ? a : b;
          const upper = lower === a ? b : a;
          const sameSide = (lower.far.x - mid.x) * (upper.far.x - mid.x) > 0;
          const bayA = Math.abs(lower.far.x - mid.x), bayB = Math.abs(upper.far.x - mid.x);
          if (!sameSide || bayA < bayMin || bayA > bayMax || bayB < bayMin || bayB > bayMax) continue;
          if (Math.abs(lower.far.y - bottom.y) > levelTolerance || Math.abs(upper.far.y - top.y) > levelTolerance) continue;
          if (Math.abs(lower.far.x - upper.far.x) > levelTolerance) continue;
          match = [lower.diagonal, upper.diagonal];
        }
      }
      if (match) {
        frames.push({
          columnSegment: column,
          braceSegments: match,
          storyHeight: Math.round(segLen(column)),
          bayWidth: Math.round((Math.abs(match[0].x1 - match[0].x2) + Math.abs(match[1].x1 - match[1].x2)) / 2),
          confidence: match.every(s => layerRole(s.layer) === "brace") ? 0.98 : 0.78,
        });
      }
    }
    return frames;
  }

  function wallsTouch(a, b, tolerance) {
    const aEnds = endsOf(a), bEnds = endsOf(b);
    return aEnds.some(aPoint => bEnds.some(bPoint => pointDistance(aPoint, bPoint) <= tolerance));
  }

  function detectPlacementCandidates(walls, options) {
    const opts = options || {};
    const wallList = walls || [];
    const ext = extentsOf(wallList);
    const millimeterDrawing = opts.unitsCode === 4;
    const kLen = opts.kLen != null ? opts.kLen : (millimeterDrawing ? 1400 : ext.diag * 0.08);
    const joinTolerance = opts.joinTolerance != null ? opts.joinTolerance : (millimeterDrawing ? 120 : ext.diag * 0.012);
    const candidates = [];
    for (const wall of wallList) {
      const clearSpan = Number.isFinite(wall.length) ? wall.length : segLen(wall);
      if (!Number.isFinite(clearSpan) || clearSpan < kLen) continue;
      const evidence = wall.evidence || [];
      const warnings = [...(wall.warnings || [])];
      const reasons = [];
      let score = 0;
      const lengthScore = 20 + Math.min(10, Math.max(0, (clearSpan / kLen - 1) * 10));
      score += lengthScore;
      reasons.push(`clear span ${Math.round(clearSpan)}${millimeterDrawing ? " mm" : " drawing units"}`);
      if (evidence.includes("paired wall edges")) {
        score += 25;
        reasons.push("paired wall edges");
      }
      if (!warnings.includes("single-edge wall")) {
        score += 20;
        reasons.push("continuous wall");
      }
      if (wallList.some(other => other !== wall && wallsTouch(wall, other, joinTolerance))) {
        score += 15;
        reasons.push("connected wall endpoint");
      }
      if (evidence.includes("wall layer") || evidence.includes("automatically selected wall layer") || layerRole(wall.layer) === "wall") {
        score += 10;
        reasons.push("wall layer evidence");
      }
      let deduction = 0;
      if (warnings.includes("single-edge wall")) deduction += 12;
      if (!millimeterDrawing) {
        warnings.push("unitless-relative-thresholds");
        deduction += 10;
      }
      score = Math.max(0, Math.min(100, Math.round(score - Math.min(30, deduction))));
      const level = score >= 80 ? "high" : score >= 60 ? "medium" : score >= 40 ? "low" : "diagnostic";
      if (score < 40) continue;
      candidates.push({
        id: `candidate-${candidates.length + 1}`,
        wallId: wall.id,
        x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2,
        layer: wall.layer || "0",
        sourceLayers: wall.sourceLayers || [wall.layer || "0"],
        clearSpan,
        score,
        confidence: score / 100,
        level,
        reasons,
        warnings,
        decision: "unreviewed",
      });
    }
    return candidates;
  }

  function extentsOf(segs) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const s of segs) {
      minx = Math.min(minx, s.x1, s.x2); maxx = Math.max(maxx, s.x1, s.x2);
      miny = Math.min(miny, s.y1, s.y2); maxy = Math.max(maxy, s.y1, s.y2);
    }
    if (!Number.isFinite(minx)) return { minx: 0, miny: 0, maxx: 1, maxy: 1, w: 1, h: 1, diag: 1 };
    const w = maxx - minx, h = maxy - miny;
    return { minx, miny, maxx, maxy, w, h, diag: Math.hypot(w, h) };
  }

  function assessView(segs) {
    const fullExtents = extentsOf(segs);
    if (segs.length < 100) return { fullExtents, extents: fullExtents, remoteSegmentCount: 0 };
    const xs = segs.map(s => (s.x1 + s.x2) / 2).sort((a, b) => a - b);
    const ys = segs.map(s => (s.y1 + s.y2) / 2).sort((a, b) => a - b);
    const lo = Math.floor(segs.length * 0.01), hi = Math.floor((segs.length - 1) * 0.99);
    const dx = Math.max(1, xs[hi] - xs[lo]), dy = Math.max(1, ys[hi] - ys[lo]);
    const core = segs.filter(s => [s.x1, s.x2].every(x => x >= xs[lo] - 2 * dx && x <= xs[hi] + 2 * dx)
      && [s.y1, s.y2].every(y => y >= ys[lo] - 2 * dy && y <= ys[hi] + 2 * dy));
    const extents = extentsOf(core);
    const trim = core.length >= segs.length * 0.97 && fullExtents.diag > extents.diag * 20;
    // This affects viewport fitting only: no geometry is deleted or excluded from analysis.
    return { fullExtents, extents: trim ? extents : fullExtents,
      remoteSegmentCount: trim ? segs.length - core.length : 0 };
  }

  function drawingRegions(walls, gap) {
    const lengths = walls.map(segLen).sort((a, b) => a - b);
    gap = Math.max(gap, (lengths[Math.floor(lengths.length * 0.9)] || 0) * 1.5);
    const regions = [];
    const remaining = new Set(walls.map((_, index) => index));
    const boxes = walls.map(w => extentsOf([w]));
    while (remaining.size) {
      const first = remaining.values().next().value;
      remaining.delete(first);
      const indexes = [first];
      for (let cursor = 0; cursor < indexes.length; cursor += 1) {
        const a = boxes[indexes[cursor]];
        for (const index of remaining) {
          const b = boxes[index];
          const dx = Math.max(0, a.minx - b.maxx, b.minx - a.maxx);
          const dy = Math.max(0, a.miny - b.maxy, b.miny - a.maxy);
          if (Math.hypot(dx, dy) <= gap) { indexes.push(index); remaining.delete(index); }
        }
      }
      if (indexes.length < 3) continue;
      const extents = extentsOf(indexes.map(index => walls[index]));
      const pad = Math.max(extents.w, extents.h) * 0.05;
      regions.push({ wallCount: indexes.length, extents: extentsOf([
        { x1: extents.minx - pad, y1: extents.miny - pad, x2: extents.maxx + pad, y2: extents.maxy + pad },
      ]) });
    }
    return regions.sort((a, b) => a.extents.minx - b.extents.minx || b.extents.maxy - a.extents.maxy)
      .map((region, index) => ({ ...region, id: `region-${index + 1}` }));
  }

  function detectPsReview(entities) {
    const markerTypes=new Set(['TEXT','MTEXT','ATTRIB','ATTDEF']);
    const markers=(entities||[]).filter(entity=>markerTypes.has(entity.type)&&entity.text).flatMap((entity,index)=>{
      const normalized=String(entity.text).replace(/[Ｐｐ]/g,'P').replace(/[Ｓｓ]/g,'S').toUpperCase();
      if(!/(^|[^A-Z0-9])P\s*\.?\s*S([^A-Z0-9]|$)/.test(normalized))return [];
      const x=Number.isFinite(entity.x1)?entity.x1:entity.cx;
      const y=Number.isFinite(entity.y1)?entity.y1:entity.cy;
      return [{id:`ps-marker-${index+1}`,text:String(entity.text),layer:entity.layer||'0',
        point:Number.isFinite(x)&&Number.isFinite(y)?{x,y}:null}];
    });
    return {status:markers.length?'manual-review-required':'not-found',markers,
      reviewUnit:'each enclosure side',automaticThinWallExceptionApplied:false,
      note:markers.length
        ?'PS labels were found. Each enclosure side, endpoint, connection and opening requires manual review before any wall thinner than the normal minimum can be accepted.'
        :'No explicit PS label was found. No automatic thin-wall exception was applied.'};
  }

  // opts: {minWallLen, kLen, requirePair, pairMin, pairMax, excludeAtOrBelowMinWallLen}
  function classify(ents, opts) {
    opts = opts || {};
    const removedSegs = [];  // 家具/标注等被删的可视化
    const originalSegs = []; // 原始可绘制线段，作为灰色上下文
    const excludedSegs = [];
    for (const e of ents) {
      if (REMOVE_TYPES.has(e.type)) {
        // 仅为预览生成一点可视化(圆用外接框近似)
        if (e.type === "CIRCLE" && Number.isFinite(e.cx)) {
          const r = e.r || 0;
          removedSegs.push({ x1: e.cx - r, y1: e.cy, x2: e.cx + r, y2: e.cy });
          removedSegs.push({ x1: e.cx, y1: e.cy - r, x2: e.cx, y2: e.cy + r });
        } else if (Number.isFinite(e.cx)) {
          removedSegs.push({ x1: e.cx - 200, y1: e.cy, x2: e.cx + 200, y2: e.cy });
        }
        continue;
      }
      for (const s of segsOf(e)) {
        originalSegs.push({ ...s, id: `source-${originalSegs.length + 1}` });
        if (layerRole(s.layer) === "excluded") excludedSegs.push(s);
      }
    }
    const viewAssessment = assessView(originalSegs);
    const ext = viewAssessment.extents;
    const millimeterDrawing = opts.unitsCode === 4;
    const minWallLen = opts.minWallLen != null ? opts.minWallLen : (millimeterDrawing ? 500 : ext.diag * 0.02);
    const kLen = opts.kLen != null ? opts.kLen : (millimeterDrawing ? 1400 : ext.diag * 0.08);
    const requirePair = !!opts.requirePair;
    const pairMin = opts.pairMin != null ? opts.pairMin : (millimeterDrawing ? 60 : ext.diag * 0.003);
    const pairMax = opts.pairMax != null ? opts.pairMax : (millimeterDrawing ? 450 : ext.diag * 0.035);
    const excludeAtOrBelowMinWallLen=!!opts.excludeAtOrBelowMinWallLen;
    const extractionOptions={minWallLen,pairMin,pairMax,excludeAtOrBelowMinWallLen};

    // All-layer geometry is optional diagnostics; the browser only extracts selected Layers.
    const rawWallCandidates = opts.includeDiagnostics === false ? [] : extractWallCenterlines(originalSegs, {
      ...extractionOptions, requirePair, unitsCode: opts.unitsCode || 0,
    });
    const rawPlacementCandidates = detectPlacementCandidates(rawWallCandidates, { ...opts, kLen, unitsCode: opts.unitsCode || 0 });
    const layerAnalysis = LayerAI
      ? LayerAI.analyzeLayers(ents, { ...opts, unitsCode: opts.unitsCode || 0 })
      : {
          status: "unsupported",
          selectedWallLayers: [],
          reasonCode: "layer-intelligence-unavailable",
          explanation: "Layer intelligence module is unavailable.",
          layers: [],
        };
    const selectedWallLayers = layerAnalysis.selectedWallLayers || [];
    let selectedWallCandidates = selectedWallLayers.flatMap(layer => extractWallCenterlines(
      originalSegs.filter(segment => (segment.layer || "0") === layer), {
        ...extractionOptions, requirePair: true, unitsCode: opts.unitsCode || 0, selectedWallLayer: true, recoverConnectedShorts: true,
      }).map(wall => ({ ...wall, sourceLayers: [layer] }))
    ).map((wall, index) => ({ ...wall, id: `wall-${index + 1}` }));
    const recoveryOptions={...extractionOptions,layerAssessments:layerAnalysis.layers,
      extractCompanionWallLayers:!!opts.extractCompanionWallLayers};
    selectedWallCandidates=recoverContextWallPairs(originalSegs,selectedWallCandidates,selectedWallLayers,recoveryOptions);
    selectedWallCandidates=recoverCompanionWallLayerPairs(originalSegs,selectedWallCandidates,selectedWallLayers,recoveryOptions);
    const extractedWallLayers=[...new Set([...selectedWallLayers,...selectedWallCandidates.flatMap(w=>w.sourceLayers||[w.layer]).filter(Boolean)])];
    selectedWallCandidates=recoverResidualWallPairs(originalSegs,selectedWallCandidates,extractedWallLayers,extractionOptions);
    // Pair/context recovery has priority. Unpaired references must never reserve
    // source edges before their opposing boundary has been examined.
    const wallCoverage=reviewWallCoverage(originalSegs,selectedWallCandidates,extractedWallLayers,extractionOptions);
    const represented=new Set([
      ...selectedWallCandidates.flatMap(w=>w.sourceSegmentIds||[]),
      ...wallCoverage.boundaryDetails.map(s=>s.sourceSegmentId),
    ]);
    const singleReferences=requirePair?[]:extractedWallLayers.flatMap(layer=>extractWallCenterlines(
      originalSegs.filter(s=>s.layer===layer),{...extractionOptions,requirePair:false,selectedWallLayer:true,unitsCode:opts.unitsCode||0}
    ).filter(w=>w.centerlineBasis==='single-edge-hypothesis'&&!w.sourceSegmentIds.some(id=>represented.has(id))))
      .map((w,i)=>({...w,id:`reference-single-${i+1}`,sourceLayers:[w.layer]}));
    const supported = layerAnalysis.status === "selected" && selectedWallCandidates.length > 0;
    const wallReferences = [...deriveWallReferences(originalSegs,selectedWallCandidates),...(supported?singleReferences:[])];
    const wallOutputSegments = deriveWallOutputSegments(originalSegs,wallReferences);
    const wallLayerAssessments = new Map((layerAnalysis.layers || []).map(layer => [layer.name, layer]));
    const wallBoundaryLayers = [...new Set([
      ...extractedWallLayers,
      ...wallReferences.flatMap(wall => wall.supportingSourceLayers || []).filter(layer => {
        const assessment = wallLayerAssessments.get(layer);
        return assessment && assessment.role === 'wall' && !assessment.risks.includes('mixed content');
      }),
    ])];
    const wallBoundaryLayerSet = new Set(wallBoundaryLayers);
    const wallBoundarySegments = originalSegs.filter(segment => wallBoundaryLayerSet.has(segment.layer));
    const selectedPlacementCandidates = detectPlacementCandidates(selectedWallCandidates, {
      ...opts, kLen, unitsCode: opts.unitsCode || 0,
    });
    const drawingAssessment = supported
      ? {
          supported: true,
          kind: "architectural-wall-analysis",
          reason: layerAnalysis.explanation,
          reasonCode: layerAnalysis.reasonCode,
          evidence: {
            selectedWallLayers,
            rawWallCandidates: rawWallCandidates.length,
            selectedWallCandidates: selectedWallCandidates.length,
          },
        }
      : {
          supported: false,
          kind: "insufficient-architectural-wall-network",
          reason: layerAnalysis.status === "selected"
            ? "The selected wall Layer contains no reliable wall centerlines."
            : layerAnalysis.explanation,
          reasonCode: layerAnalysis.status === "selected"
            ? "selected-layer-has-no-wall-centerlines"
            : layerAnalysis.reasonCode,
          evidence: {
            selectedWallLayers,
            rawWallCandidates: rawWallCandidates.length,
            selectedWallCandidates: selectedWallCandidates.length,
          },
        };
    const wallCandidates = drawingAssessment.supported ? selectedWallCandidates : [];
    const placementCandidates = drawingAssessment.supported ? selectedPlacementCandidates : [];
    const existingKBraces = drawingAssessment.supported
      ? detectKFrames(originalSegs, opts).map((frame, index) => ({ ...frame, id: `existing-kbrace-${index + 1}` })) : [];
    const kframeCandidates = placementCandidates;
    const kframe = placementCandidates;
    const plainWalls = wallCandidates;
    const psReview=detectPsReview(ents);
    const casePolicy=opts.casePolicyId?{
      id:opts.casePolicyId,scope:'case-specific',measurementStatus:opts.casePolicyMeasurementStatus||'unknown',
      wallThickness:{minimum:pairMin,inclusive:true,units:millimeterDrawing?'mm':'drawing-units',
        psException:{allowedOnlyWithExplicitEvidence:true,automaticAcceptance:false,reviewStatus:psReview.status}},
      wallLength:{omitAtOrBelow:minWallLen,inclusive:true,mergeContinuousSourceEntitiesBeforeFiltering:true},
      openings:{bridgeRealOpenings:false,sourceGapsPreserved:true},
      centerline:{basis:'wall-centerline',preserveOpeningSideEndpoints:true,axisMovementMustRemainInsideSourceWall:true},
      universalDesignStandard:false,
    }:null;
    const structuralModelVerification={status:'not-performed',saveReload:'not-performed',
      wallPlacementComparison:'not-performed',floorRoofMemberIntegrity:'not-performed',
      wallLoadSettings:'separate-not-performed',loadTransfer:'separate-not-performed'};
    const completionReview={status:'review-required',reasons:[
      ...(wallCoverage.unresolved.length?['unresolved-source-intervals']:[]),
      ...(wallCoverage.omitted.length?['case-specific-short-intervals-omitted']:[]),
      ...(psReview.status==='manual-review-required'?['ps-enclosure-sides-require-manual-review']:[]),
      'structural-model-save-reload-not-verified','floor-roof-member-integrity-not-verified',
      'wall-load-and-load-transfer-not-verified',
    ]};

    return {
      removedSegs, excludedSegs, originalSegs, keptSegs: originalSegs,
      walls: wallCandidates, wallCenterlines: wallCandidates, wallCandidates, plainWalls,
      wallReferences, wallOutputSegments, wallBoundaryLayers, wallBoundarySegments,
      rawWallCandidates, rawPlacementCandidates, drawingAssessment,
      layerAnalysis, selectedWallLayers,extractedWallLayers,
      wallCoverage,casePolicy,psReview,structuralModelVerification,completionReview,
      placementCandidates, existingKBraces,
      kframe, kframeCandidates, extents: ext, viewAssessment,
      regions: drawingRegions(wallCandidates, Math.max(pairMax * 4, minWallLen * 3)),
      used: { minWallLen, kLen, requirePair, pairMin, pairMax,excludeAtOrBelowMinWallLen,
        extractCompanionWallLayers:!!opts.extractCompanionWallLayers,
        casePolicyId:opts.casePolicyId||null,unitsCode: opts.unitsCode || 0 },
      stats: {
        entities: ents.length,
        removedEntities: ents.filter(e => REMOVE_TYPES.has(e.type)).length,
        candidateSegs: wallCandidates.length,
        originalSegs: originalSegs.length,
        wallSegs: wallCandidates.length,
        wallOutputSegs: wallOutputSegments.length,
        wallJunctionSegs: wallOutputSegments.filter(segment=>segment.outputRole==='junction-connector').length,
        wallBoundarySegs: wallBoundarySegments.length,
        kframeSegs: placementCandidates.length,
        kframeAssemblies: existingKBraces.length,
        placementCandidates: placementCandidates.length,
        existingKBraces: existingKBraces.length,
        selectedWallLayers: selectedWallLayers.length,
      },
    };
  }

  function buildAnnotationData(fileName, inspection, result, decisions) {
    const choices = decisions || {};
    const analysis = result && result.layerAnalysis;
    return {
      schema: "kframe-cad-review/3.0",
      algorithmVersion: analysis && analysis.algorithmVersion || "layer-intelligence-1.0-preview",
      casePolicy: result && result.casePolicy || null,
      psReview: result && result.psReview || null,
      structuralModelVerification: result && result.structuralModelVerification || {status:'not-performed'},
      completionReview: result && result.completionReview || {status:'review-required',reasons:['structural-model-verification-not-performed']},
      selectedWallLayers: [...(result && result.selectedWallLayers || [])],
      extractedWallLayers: [...(result && result.extractedWallLayers || result && result.selectedWallLayers || [])],
      layerAnalysis: analysis ? {
        status: analysis.status,
        reasonCode: analysis.reasonCode,
        explanation: analysis.explanation,
        selectedWallLayers: [...(analysis.selectedWallLayers || [])],
        algorithmVersion: analysis.algorithmVersion,
        method: analysis.method,
        confidenceMeaning: analysis.confidenceMeaning,
        minimumWallConfidence: analysis.minimumWallConfidence,
        ambiguityMargin: analysis.ambiguityMargin,
        layers: analysis.layers.map(layer => ({
          name: layer.name,
          role: layer.role,
          confidence: layer.confidence,
          roleScores: { ...layer.roleScores },
          selected: layer.selected,
          selectionReasonCode: layer.selectionReasonCode,
          evidence: [...layer.evidence],
          risks: [...layer.risks],
          features: JSON.parse(JSON.stringify(layer.features)),
        })),
      } : null,
      drawingAssessment: result && result.drawingAssessment || null,
      viewAssessment: result && result.viewAssessment || null,
      regions: result && result.regions || [],
      wallCoverage: result && result.wallCoverage || null,
      wallBoundaryLayers: [...(result && result.wallBoundaryLayers || [])],
      wallBoundarySegments: (result && result.wallBoundarySegments || []).map(segment => ({
        id: segment.id,
        layer: segment.layer || '0',
        meaning: 'source-wall-boundary',
        geometry: { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 },
      })),
      wallOutputSegments: (result && result.wallOutputSegments || []).map(segment => ({
        id: segment.id,
        layer: segment.layer || '0',
        outputRole: segment.outputRole || 'wall-reference',
        centerlineBasis: segment.centerlineBasis || null,
        connectedWallIds: segment.connectedWallIds || [],
        sourceSegmentIds: segment.sourceSegmentIds || [],
        geometry: { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 },
      })),
      source: {
        fileName: fileName || "drawing.dxf",
        format: inspection && inspection.format || "unknown",
        unitsCode: inspection && inspection.unitsCode || 0,
        unitsLabel: inspection && inspection.unitsLabel || "unitless",
        importDetails: inspection && inspection.importDetails || null,
        physicalScaleVerified: false,
      },
      parameters: result && result.used || {},
      shortOmissions: result && result.wallCoverage && result.wallCoverage.omitted || [],
      centerlineAdjustments: (result && (result.wallReferences || result.wallCenterlines) || [])
        .filter(wall=>wall.continuity&&Number.isFinite(wall.continuity.maxAxisShift))
        .map(wall=>({wallId:wall.id,maxAxisShift:wall.continuity.maxAxisShift,
          basis:wall.centerlineBasis||'boundary-continuity-reference',withinSourceWall:'requires-source-review'})),
      wallCenterlines: (result && (result.wallReferences || result.wallCenterlines) || []).map((wall, index) => ({
        id: wall.id || `wall-${index + 1}`,
        layer: wall.layer || "0",
        sourceLayers: wall.sourceLayers || [wall.layer || "0"],
        confidence: wall.confidence,
        thickness: wall.thickness,
        evidence: wall.evidence || [],
        warnings: wall.warnings || [],
        sourceSegmentIds: wall.sourceSegmentIds || [],
        sourceIntervals: wall.sourceIntervals || [],
        centerlineBasis: wall.centerlineBasis || null,
        continuity: wall.continuity || null,
        supportingSourceSegmentIds: wall.supportingSourceSegmentIds || [],
        supportingSourceLayers: wall.supportingSourceLayers || [],
        supportingSourceIntervals: wall.supportingSourceIntervals || [],
        geometry: { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2 },
      })),
      placementCandidates: (result && result.placementCandidates || []).map((candidate, index) => ({
        ...candidate,
        id: candidate.id || `candidate-${index + 1}`,
        decision: choices[candidate.id || `candidate-${index + 1}`] || candidate.decision || "unreviewed",
      })),
      existingKBraces: (result && result.existingKBraces || []).map(frame => ({
        id: frame.id,
        confidence: frame.confidence,
        storyHeight: frame.storyHeight,
        bayWidth: frame.bayWidth,
        columnSegment: frame.columnSegment,
        braceSegments: frame.braceSegments,
      })),
      privacy: "Generated locally in the browser; no drawing upload is performed.",
      note: "Wall placement is geometric review data only. Structural-model persistence, wall loads and load transfer were not verified.",
    };
  }

  // ---------- 4. 导出 DXF (给输出加回图层: WALL / KFRAME) ----------
  function buildCoverageDXF(result, unitsCode) {
    const selected=new Set(result.selectedWallLayers || []);
    const originalSegs=[...(result.wallOutputSegments || result.wallReferences || result.wallCenterlines || []).map(s=>({...s,layer:'WALL'})),
      ...(result.wallBoundarySegments || []).map(s=>({...s,layer:'WALL_SOURCE'})),
      ...(result.wallCoverage?.boundaryDetails || []).filter(s=>selected.has(s.layer)).map(s=>({...s,layer:'WALL_DETAIL'})),
      ...(result.wallCoverage?.omitted || []).filter(s=>selected.has(s.layer)).map(s=>({...s,layer:'OMITTED_SHORT'})),
      ...(result.wallCoverage?.unresolved || []).filter(s=>selected.has(s.layer)).map(s=>({...s,layer:'UNRESOLVED'}))];
    return buildSelectedLayerDXF({selectedWallLayers:['WALL','WALL_SOURCE','WALL_DETAIL','UNRESOLVED'],originalSegs},unitsCode);
  }

  function buildSelectedLayerDXF(result, unitsCode) {
    const layers = result.selectedWallLayers || [];
    const selected = new Set(layers);
    const exportedSegments = (result.originalSegs || []).filter(segment => selected.has(segment.layer));
    const tableLayers = [...new Set(['0', ...layers])];
    const records = [];
    const put = (code, value) => records.push(String(code), String(value));
    const safeName = name => String(name).replace(/[\r\n]/g, ' ');
    put(0, 'SECTION'); put(2, 'HEADER');
    put(9, '$ACADVER'); put(1, 'AC1021');
    put(9, '$HANDSEED'); put(5, (0x100 + tableLayers.length + exportedSegments.length).toString(16));
    put(9, '$INSUNITS'); put(70, Number(unitsCode) || 0); put(0, 'ENDSEC');
    put(0, 'SECTION'); put(2, 'CLASSES'); put(0, 'ENDSEC');
    put(0, 'SECTION'); put(2, 'TABLES');
    const table = (name, handle, count) => {
      put(0, 'TABLE'); put(2, name); put(5, handle); put(330, '0'); put(100, 'AcDbSymbolTable'); put(70, count);
    };
    table('LTYPE', '1', 1);
    put(0, 'LTYPE'); put(5, '2'); put(330, '1'); put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbLinetypeTableRecord');
    put(2, 'CONTINUOUS'); put(70, 0); put(3, 'Solid line'); put(72, 65); put(73, 0); put(40, 0); put(0, 'ENDTAB');
    table('LAYER', '3', tableLayers.length);
    let handle = 0x100;
    for (const layer of tableLayers) {
      put(0, 'LAYER'); put(5, (handle++).toString(16)); put(330, '3');
      put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbLayerTableRecord');
      put(2, safeName(layer)); put(70, 0); put(62, layer === '0' ? 7 : layer === 'UNRESOLVED' ? 30 : 5); put(6, 'CONTINUOUS');
    }
    put(0, 'ENDTAB'); table('BLOCK_RECORD', '4', 1);
    put(0, 'BLOCK_RECORD'); put(5, '5'); put(330, '4');
    put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbBlockTableRecord');
    put(2, '*Model_Space'); put(70, 0); put(280, 1); put(281, 0); put(0, 'ENDTAB'); put(0, 'ENDSEC');
    put(0, 'SECTION'); put(2, 'BLOCKS');
    put(0, 'BLOCK'); put(5, '6'); put(330, '5'); put(100, 'AcDbEntity'); put(8, '0');
    put(100, 'AcDbBlockBegin'); put(2, '*Model_Space'); put(70, 0); put(10, 0); put(20, 0); put(30, 0);
    put(3, '*Model_Space'); put(1, '');
    put(0, 'ENDBLK'); put(5, '7'); put(330, '5'); put(100, 'AcDbEntity'); put(8, '0'); put(100, 'AcDbBlockEnd'); put(0, 'ENDSEC');
    put(0, 'SECTION'); put(2, 'ENTITIES');
    for (const segment of exportedSegments) {
      put(0, 'LINE'); put(5, (handle++).toString(16)); put(330, '5');
      put(100, 'AcDbEntity'); put(8, safeName(segment.layer)); put(100, 'AcDbLine');
      put(10, segment.x1); put(20, segment.y1); put(30, 0);
      put(11, segment.x2); put(21, segment.y2); put(31, 0);
    }
    put(0, 'ENDSEC'); put(0, 'EOF');
    return records.join('\n') + '\n';
  }

  function buildDXF(plainWalls, kframe, unitsCode) {
    const L = [];
    const put = (c, v) => { L.push(String(c)); L.push(String(v)); };
    put(0, "SECTION"); put(2, "HEADER");
    put(9, "$INSUNITS"); put(70, Number.isFinite(Number(unitsCode)) ? Number(unitsCode) : 0);
    put(0, "ENDSEC");
    // 图层表
    put(0, "SECTION"); put(2, "TABLES");
    put(0, "TABLE"); put(2, "LAYER"); put(70, 2);
    const layer = (name, color) => { put(0, "LAYER"); put(2, name); put(70, 0); put(62, color); put(6, "CONTINUOUS"); };
    layer("WALL", 5);    // 蓝
    layer("KFRAME", 1);  // 红
    put(0, "ENDTAB"); put(0, "ENDSEC");
    // 实体
    put(0, "SECTION"); put(2, "ENTITIES");
    const line = (s, lay) => {
      put(0, "LINE"); put(8, lay);
      put(10, s.x1); put(20, s.y1); put(30, 0);
      put(11, s.x2); put(21, s.y2); put(31, 0);
    };
    (plainWalls || []).forEach(s => line(s, "WALL"));
    (kframe || []).forEach(s => line(s, "KFRAME"));
    put(0, "ENDSEC"); put(0, "EOF");
    return L.join("\n") + "\n";
  }

  // ---------- 5. 演示用示例 DXF ----------
  function makeSampleDXF() {
    const L = [];
    const put = (c, v) => { L.push(String(c)); L.push(String(v)); };
    const line = (x1, y1, x2, y2, layerName) => { put(0, "LINE"); put(8, layerName || "0"); put(10, x1); put(20, y1); put(30, 0); put(11, x2); put(21, y2); put(31, 0); };
    const polyline = (points, layerName, closed) => {
      put(0, "LWPOLYLINE"); put(8, layerName || "0"); put(90, points.length); put(70, closed ? 1 : 0);
      points.forEach(point => { put(10, point[0]); put(20, point[1]); });
    };
    const furnitureRect = (x, y, width, height) => {
      line(x, y, x + width, y, "A-FURN");
      line(x + width, y, x + width, y + height, "A-FURN");
      line(x + width, y + height, x, y + height, "A-FURN");
      line(x, y + height, x, y, "A-FURN");
    };
    const text = (label, x, y) => {
      put(0, "TEXT"); put(8, "A-ANNO"); put(10, x); put(20, y); put(30, 0); put(40, 240); put(1, label);
    };
    const dimension = (x, y) => {
      put(0, "DIMENSION"); put(8, "A-DIM"); put(10, x); put(20, y); put(30, 0);
    };
    const insert = (name, x, y) => {
      put(0, "INSERT"); put(8, "A-FURN"); put(2, name); put(10, x); put(20, y); put(30, 0);
    };
    // 单位: millimeters
    put(0, "SECTION"); put(2, "HEADER"); put(9, "$INSUNITS"); put(70, 4); put(0, "ENDSEC");
    // 家具块定义（浏览器解析时作为可清理的非结构要素）
    put(0, "SECTION"); put(2, "BLOCKS");
    put(0, "BLOCK"); put(2, "SOFA"); put(70, 0); put(10, 0); put(20, 0); put(30, 0);
    line(0, 0, 900, 0); line(900, 0, 900, 400); line(900, 400, 0, 400); line(0, 400, 0, 0);
    put(0, "ENDBLK");
    put(0, "ENDSEC");
    // 实体
    put(0, "SECTION"); put(2, "ENTITIES");
    // 12 m × 8 m 住宅平面：外墙双线。
    polyline([[0, 0], [12000, 0], [12000, 8000], [0, 8000]], "A-WALL", true);
    line(180, 180, 11820, 180, "A-WALL");
    line(11820, 180, 11820, 7820, "A-WALL");
    line(11820, 7820, 180, 7820, "A-WALL");
    line(180, 7820, 180, 180, "A-WALL");

    // 中央走廊墙，保留 900 mm 门洞；旧版回归测试仍可检查 2,500 / 2,600 mm 净墙段。
    line(0, 3500, 2500, 3500, "A-WALL"); line(0, 3600, 2500, 3600, "A-WALL");
    line(3400, 3500, 6000, 3500, "A-WALL"); line(3400, 3600, 6000, 3600, "A-WALL");
    line(6900, 3500, 11820, 3500, "A-WALL"); line(6900, 3600, 11820, 3600, "A-WALL");

    // 左右分区墙，门洞将连续墙切成可审核的净墙段。
    line(3900, 180, 3900, 2500, "A-WALL"); line(4080, 180, 4080, 2500, "A-WALL");
    line(3900, 3250, 3900, 3500, "A-WALL"); line(4080, 3250, 4080, 3500, "A-WALL");
    line(3900, 3600, 3900, 7820, "A-WALL"); line(4080, 3600, 4080, 7820, "A-WALL");
    line(7800, 180, 7800, 2850, "A-WALL"); line(7980, 180, 7980, 2850, "A-WALL");
    line(7800, 3500, 7800, 7820, "A-WALL"); line(7980, 3500, 7980, 7820, "A-WALL");

    // 卧室、厨房、卫生间隔墙。
    line(180, 6100, 3900, 6100, "A-WALL"); line(180, 6280, 3900, 6280, "A-WALL");
    line(7980, 2150, 11820, 2150, "A-WALL"); line(7980, 2330, 11820, 2330, "A-WALL");
    line(9800, 3600, 9800, 7820, "A-WALL"); line(9980, 3600, 9980, 7820, "A-WALL");
    line(2150, 3600, 2150, 6100, "A-WALL"); line(2330, 3600, 2330, 6100, "A-WALL");

    // 家具和设备线：原图中保留为灰色上下文，清理输出中移除。
    furnitureRect(450, 450, 2500, 900);   // sofa
    furnitureRect(4650, 550, 2200, 1100); // dining table
    furnitureRect(8500, 450, 2800, 650);  // kitchen counter
    furnitureRect(450, 6550, 2700, 950);  // bed
    furnitureRect(4600, 5200, 2200, 1300);// second bed
    furnitureRect(8350, 4700, 1100, 1900);// storage
    line(520, 1500, 2750, 1500, "A-FURN");
    line(4720, 1750, 6780, 1750, "A-FURN");
    line(8600, 1250, 11200, 1250, "A-FURN");

    // 圆桌和洗面器。
    [[6100, 2650, 520], [10800, 2850, 360]].forEach(item => {
      put(0, "CIRCLE"); put(8, "A-FURN"); put(10, item[0]); put(20, item[1]); put(30, 0); put(40, item[2]);
    });

    // 家具块、房间名称与尺寸标注。
    [[900, 900], [5200, 900], [8950, 650], [900, 6850], [5100, 5600], [8700, 5200]].forEach(point => insert("SOFA", point[0], point[1]));
    [
      ["LIVING", 1200, 2500], ["DINING", 5100, 2450], ["KITCHEN", 9000, 1650],
      ["BEDROOM 1", 900, 7200], ["BEDROOM 2", 4900, 7000], ["UTILITY", 10300, 5200],
    ].forEach(item => text(item[0], item[1], item[2]));
    [[0, -650], [4000, -650], [8000, -650], [12000, -650]].forEach(point => dimension(point[0], point[1]));

    // K 型框架示例: 3000 mm 层高、910 mm 跨，斜撑在柱中点汇交
    const layerLine = (layer, x1, y1, x2, y2) => { put(0, "LINE"); put(8, layer); put(10, x1); put(20, y1); put(30, 0); put(11, x2); put(21, y2); put(31, 0); };
    layerLine("S-COLUMN", 12910, 0, 12910, 3000);
    layerLine("S-BRACE", 12000, 0, 12910, 1500);
    layerLine("S-BRACE", 12000, 3000, 12910, 1500);
    put(0, "ENDSEC"); put(0, "EOF");
    return L.join("\n") + "\n";
  }

  const api = { inspectDXF, parseDXF, segsOf, segLen, classify, extractWallCenterlines, recoverContextWallPairs, recoverCompanionWallLayerPairs, recoverResidualWallPairs, deriveWallReferences, deriveWallOutputSegments, reviewWallCoverage, segmentsInBounds, detectPsReview, detectPlacementCandidates, detectKFrames, layerRole, summarizeLayers, buildAnnotationData, buildDXF, buildSelectedLayerDXF, buildCoverageDXF, makeSampleDXF, extentsOf, REMOVE_TYPES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CADCORE = api;
})(typeof window !== "undefined" ? window : globalThis);
