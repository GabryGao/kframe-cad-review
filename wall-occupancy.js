(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WALLOCCUPANCY = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const cleanZero = n => Object.is(n, -0) ? 0 : n;
  const serial = (prefix, n) => prefix + String(n).padStart(4, '0');
  const fmt = n => Number(n.toFixed(6)).toString();
  const singleLine = s => String(s).replace(/[\r\n\t]/g, ' ');
  const finiteSegment = s => s && ['x1','y1','x2','y2'].every(key => Number.isFinite(s[key]));

  // Whitelist the exchange schema: source outlines and wall thickness never enter it.
  // s is a signed distance from the axis origin, not a wall-boundary coordinate.
  function build(model = {}, assessment = {}, links = {}, wallOutputSegments) {
    const axes = [], walls = [], groups = new Map();
    let omitted = (model.omittedWalls || []).length;
    const omittedSourceIntervals=(model.omittedSourceIntervals||[]).length;
    for (const a of model.axes || []) {
      if (!point(a.start) || !point(a.end)) { omitted++; continue; }
      let dx = a.end.x - a.start.x, dy = a.end.y - a.start.y;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length <= 0) { omitted++; continue; }
      if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
      const direction = {x: cleanZero(dx / length), y: cleanZero(dy / length)};
      const dot = p => p.x * direction.x + p.y * direction.y;
      const s0 = dot(a.start), s1 = dot(a.end);
      const origin = {
        x: cleanZero(a.start.x - direction.x * s0),
        y: cleanZero(a.start.y - direction.y * s0),
      };
      if (![origin.x, origin.y, s0, s1].every(Number.isFinite)) { omitted++; continue; }
      const ref = a.gridReference || {};
      const name = String(ref.name || a.id || serial('SYS-', axes.length + 1));
      const areaId = String(ref.scopeId || 'drawing');
      const nameSource = ref.kind === 'existing-grid-alignment' ? 'drawing' : 'generated';
      // Exact collinearity only. A shared grid label must never snap nearby walls
      // onto one line or collapse repeated labels from different drawing areas.
      const key = JSON.stringify([areaId, name, nameSource, origin, direction]);
      let axisId = groups.get(key);
      if (!axisId) {
        axisId = serial('A-', axes.length + 1);
        groups.set(key, axisId);
        axes.push({id: axisId, name, areaId, nameSource, origin, direction});
      }
      walls.push({id: serial('W-', walls.length + 1), axisId,
        from: cleanZero(Math.min(s0, s1)), to: cleanZero(Math.max(s0, s1))});
      links[walls.at(-1).id] = a.id;
    }
    const wallLines = buildWallLines(wallOutputSegments, {axes, walls});
    const recognitionStatus = assessment.supported === false ? 'unsupported'
      : walls.length ? 'candidates-extracted' : 'no-walls-extracted';
    const unresolved = recognitionStatus === 'candidates-extracted' && model.readiness?.coverage !== 'unknown' && Array.isArray(model.unresolvedSourceIntervals)
      ? model.unresolvedSourceIntervals.length : null;
    return {
      schema: 'wall-occupancy/1.0',
      units: {code: model.coordinateSystem?.unitsCode || 0,
        label: model.coordinateSystem?.unitsLabel || 'drawing units (unknown)',
        physicalScaleVerified: model.coordinateSystem?.physicalScaleVerified === true},
      convention: 'point(s) = axis.origin + s * axis.direction; from/to are signed distances in drawing units. Only source-supported wall-boundary continuity may join paired-edge omissions; other gaps are preserved.',
      wallLineConvention: 'wallLines contains only the displayed blue wall output. start/end are direct source-drawing XY coordinates; junction connectors are explicit records.',
      axes, walls, wallLines,
      quality: {method: 'deterministic-geometry-baseline', interpretation: 'wall-candidates',
        recognitionStatus, reason: assessment.supported === false ? String(assessment.reasonCode || 'wall-extraction-failed') : null,
        coverage: omitted || omittedSourceIntervals || unresolved > 0 ? 'partial' : unresolved === null ? 'unknown' : 'accounted-not-validated',
        unresolvedIntervalCount: unresolved, omittedWallCount: omitted,omittedSourceIntervalCount:omittedSourceIntervals,
        ...continuityCounts(model.axes || [], new Set(Object.values(links))),
        ...wallLineCounts(wallLines),
        singleEdgeReferenceIds:singleEdgeIds(model,links),
        unresolvedCountBasis: 'raw paired-edge diagnostics before reference reconstruction; not missing-wall count'},
      limitations: [
        'Not a trained AI result, verified wall inventory, or structural approval.',
        'Drawing labels are detected candidates; generated axis names are not original grid labels.',
        'Some references simplify continuous source boundaries and local width changes; they are not exact centerlines. Unsupported gaps are not filled. No completeness claim.',
      ],
    };
  }

  function continuityCounts(axes, ids) {
    const reconstructed=axes.filter(a=>ids.has(a.id)&&a.centerlineBasis==='boundary-continuity-reference');
    return {reconstructedReferenceCount:reconstructed.length,
      continuityJoinCount:reconstructed.reduce((n,a)=>n+(a.continuity?.gaps?.length||0),0)};
  }

  function singleEdgeIds(model,links){
    const ids=new Set((model.axes||[]).filter(a=>a.centerlineBasis==='single-edge-hypothesis').map(a=>a.id));
    return Object.keys(links).filter(id=>ids.has(links[id]));
  }

  function intersects(s, b) {
    let from=0,to=1;
    for(const [p,q] of [[s.x1-s.x2,s.x1-b.minx],[s.x2-s.x1,b.maxx-s.x1],
      [s.y1-s.y2,s.y1-b.miny],[s.y2-s.y1,b.maxy-s.y1]]) {
      if(Math.abs(p)<1e-12){if(q<0)return false;continue;}
      if(p<0)from=Math.max(from,q/p);else to=Math.min(to,q/p);
      if(from>to)return false;
    }
    return true;
  }

  function axisSegments(data) {
    const axes=new Map(data.axes.map(a=>[a.id,a]));
    return data.walls.map(w=>{
      const a=axes.get(w.axisId);
      return {id:w.id,x1:a.origin.x+a.direction.x*w.from,y1:a.origin.y+a.direction.y*w.from,
        x2:a.origin.x+a.direction.x*w.to,y2:a.origin.y+a.direction.y*w.to};
    });
  }

  function buildWallLines(wallOutputSegments, axisData) {
    const provided=Array.isArray(wallOutputSegments);
    const source=provided ? wallOutputSegments : axisSegments(axisData).map(segment=>({...segment,outputRole:'wall-reference'}));
    return source.filter(finiteSegment).map((segment,index)=>{
      const role=segment.outputRole==='junction-connector'?'junction-connector':'wall-reference';
      const line={id:String(segment.id||serial('L-',index+1)),role,
        start:{x:cleanZero(segment.x1),y:cleanZero(segment.y1)},
        end:{x:cleanZero(segment.x2),y:cleanZero(segment.y2)},
        length:Math.hypot(segment.x2-segment.x1,segment.y2-segment.y1)};
      if(role==='junction-connector') {
        line.connectorKind=String(segment.connectorKind||'source-supported-junction');
        line.connectedWallIds=[...new Set((segment.connectedWallIds||[]).map(String))];
      }
      return line;
    });
  }

  function wallLineCounts(lines) {
    const connectors=lines.filter(line=>line.role==='junction-connector').length;
    return {wallLineCount:lines.length,wallReferenceLineCount:lines.length-connectors,junctionConnectorCount:connectors};
  }

  function segments(data) {
    return axisSegments(data);
  }

  function outputSegments(data) {
    if(!Array.isArray(data.wallLines))return axisSegments(data);
    return data.wallLines.map(line=>({id:line.id,x1:line.start.x,y1:line.start.y,x2:line.end.x,y2:line.end.y,
      role:line.role,connectorKind:line.connectorKind,connectedWallIds:line.connectedWallIds}));
  }

  // Filter AFTER assigning IDs. Source links stay outside the clean exchange data.
  // Crossing walls retain their complete source-backed interval; never invent a crop endpoint.
  function select(model={}, assessment={}, scope={id:'all',bounds:null}, wallOutputSegments) {
    const links={}, data=build(model,assessment,links,wallOutputSegments), b=scope.bounds;
    data.scope={id:scope.id||'all',intervalPolicy:'whole-intersecting-intervals',
      wallLinePolicy:'whole-intersecting-blue-lines',omittedCountScope:'full-drawing'};
    if(b) {
      const keep=new Set(segments(data).filter(s=>intersects(s,b)).map(s=>s.id));
      data.walls=data.walls.filter(w=>keep.has(w.id));
      const used=new Set(data.walls.map(w=>w.axisId));
      data.axes=data.axes.filter(a=>used.has(a.id));
      data.wallLines=data.wallLines.filter(line=>intersects({x1:line.start.x,y1:line.start.y,x2:line.end.x,y2:line.end.y},b));
      for(const id of Object.keys(links))if(!keep.has(id))delete links[id];
      Object.assign(data.quality,continuityCounts(model.axes || [],new Set(Object.values(links))));
      Object.assign(data.quality,wallLineCounts(data.wallLines));
      data.quality.singleEdgeReferenceIds=singleEdgeIds(model,links);
      if(data.quality.unresolvedIntervalCount!==null) {
        const unresolved=model.unresolvedSourceIntervals;
        data.quality.unresolvedIntervalCount=unresolved.every(s=>[s.x1,s.y1,s.x2,s.y2].every(Number.isFinite))
          ? unresolved.filter(s=>intersects(s,b)).length : null;
      }
      if(Array.isArray(model.omittedSourceIntervals))data.quality.omittedSourceIntervalCount=
        model.omittedSourceIntervals.every(s=>[s.x1,s.y1,s.x2,s.y2].every(Number.isFinite))
          ?model.omittedSourceIntervals.filter(s=>intersects(s,b)).length:model.omittedSourceIntervals.length;
      const q=data.quality;
      q.coverage=q.omittedWallCount || q.omittedSourceIntervalCount || q.unresolvedIntervalCount>0 ? 'partial'
        : q.unresolvedIntervalCount===null ? 'unknown' : 'accounted-not-validated';
      if(q.recognitionStatus==='candidates-extracted'&&!data.walls.length)q.recognitionStatus='no-walls-in-area';
    }
    return {data,links};
  }

  function hitTest(lines, p, tolerance=8) {
    let id=null,best=tolerance;
    for(const s of lines) {
      const dx=s.x2-s.x1,dy=s.y2-s.y1,length2=dx*dx+dy*dy;
      const t=length2?Math.max(0,Math.min(1,((p.x-s.x1)*dx+(p.y-s.y1)*dy)/length2)):0;
      const d=Math.hypot(p.x-s.x1-t*dx,p.y-s.y1-t*dy);
      if(d<=best){best=d;id=s.id;}
    }
    return id;
  }

  function toText(data) {
    const lines = [
      '壁配置 — 軸と区間 / Wall positions — axes and intervals',
      `Schema: ${data.schema}`,
      `Units: ${singleLine(data.units.label)} (code ${data.units.code})`,
      `実寸倍率 / Physical scale verified: ${data.units.physicalScaleVerified ? 'yes' : 'no'}`,
      `青い壁線 / Blue wall lines: ${data.wallLines?.length ?? data.walls.length} · 接続線 / Junction connectors: ${data.quality.junctionConnectorCount || 0}`,
      `壁区間 / Wall intervals: ${data.walls.length} · 軸 / Axes: ${data.axes.length}`,
      `出力範囲 / Output scope: ${singleLine(data.scope?.id || 'all')}`,
      '境界を横切る壁は全区間を保持します。出力できなかった壁の件数は全図の値です。',
      'Crossing wall intervals are kept whole. Omitted-wall count refers to the full drawing.',
      '',
      '各壁は軸上の from〜to に存在します。壁厚・外面・輪郭の座標は含みません。',
      'Each wall occupies from–to along its axis. No wall thickness or boundary coordinates.',
      's は軸の原点からの符号付き距離です。点(s) = 原点 + s × 方向。',
      's is signed distance from the axis origin: point(s) = origin + s × direction.',
      `原線に基づく接続 / Source-supported reconnections: ${data.quality.continuityJoinCount||0} · 簡略基準線 / Simplified references: ${data.quality.reconstructedReferenceCount||0}`,
      `片側原線の暫定基準 / Provisional source-edge references: ${(data.quality.singleEdgeReferenceIds||[]).join(', ')||'none / なし'}`,
      'これらは元の片側線の位置です。壁芯・壁厚は未確認で、確定した壁として扱わないでください。',
      'These references follow an original edge, not a verified wall center. Do not treat them as confirmed walls.',
      '連続する両側の原線を確認できた部分のみ統合します。局所的な壁厚変化は単一基準線に簡略化します。根拠のない隙間は埋めません。',
      'Only omissions supported by continuous boundaries on both sides are joined. Local thickness changes may use one simplified reference; unsupported gaps remain.',
      '',
    ];
    if (data.quality.recognitionStatus !== 'candidates-extracted') {
      lines.push('壁の抽出を完了できませんでした。空の結果は「壁がない」という意味ではありません。',
        'Wall extraction did not produce a usable result; an empty result does not mean there are no walls.',
        `理由コード / Reason: ${singleLine(data.quality.reason || data.quality.recognitionStatus)}`, '');
    }
    const byAxis = new Map(data.axes.map(a => [a.id, []]));
    for (const wall of data.walls) byAxis.get(wall.axisId)?.push(wall);
    for (const a of data.axes) {
      lines.push(`[${a.id}] ${singleLine(a.name)} · ${singleLine(a.areaId)}`,
        a.nameSource === 'drawing' ? '名前：図面から検出 / Name: detected from drawing'
          : '名前：自動生成（原図の通り名ではない） / Name: generated, not an original grid label',
        `原点 / origin = (${a.origin.x}, ${a.origin.y}); 方向 / direction = (${a.direction.x}, ${a.direction.y})`);
      for (const w of byAxis.get(a.id)) lines.push(`  ${w.id} 壁 / wall: ${w.from} → ${w.to}`);
      lines.push('');
    }
    lines.push('注意 / Limitations',
      `統合前の未確定原線（配対未成立） / Unresolved source intervals (before reference reconstruction): ${data.quality.unresolvedIntervalCount ?? 'unknown'}`,
      'これは原線の診断値であり、未検出の壁の本数ではありません。一部は基準線統合の根拠にも使われます。',
      'Raw source diagnostics, not a missing-wall count. Some intervals also support reference reconstruction.',
      `出力できなかった壁 / Omitted walls: ${data.quality.omittedWallCount}`,
      '形状ルールによる壁候補です。完全性・耐力・構造安全性は未確認です。学習済みAIの結果ではありません。',
      'Geometric wall candidates only. Completeness and structural safety are not verified; not a trained AI result.',
      '図面から検出した軸名も未検証です。自動生成名は原図の通り名ではありません。',
      'Detected grid labels are unverified. Generated names are not original grid labels.',
      '');
    return lines.join('\n');
  }

  function imageLayout(data, width = 1600, height = 1600) {
    const lines = outputSegments(data);
    if (!lines.length) return {width, height, lines: []};
    let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
    for (const s of lines) {
      minx=Math.min(minx,s.x1,s.x2);maxx=Math.max(maxx,s.x1,s.x2);
      miny=Math.min(miny,s.y1,s.y2);maxy=Math.max(maxy,s.y1,s.y2);
    }
    const pad=40, spanx=maxx-minx, spany=maxy-miny;
    const scale=Math.min(spanx ? (width-2*pad)/spanx : Infinity, spany ? (height-2*pad)/spany : Infinity);
    const x=n=>(n-minx)*scale+(width-spanx*scale)/2;
    const y=n=>height-((n-miny)*scale+(height-spany*scale)/2);
    return {width, height, lines:lines.map(s=>({x1:x(s.x1),y1:y(s.y1),x2:x(s.x2),y2:y(s.y2)}))};
  }

  function toSVG(data) {
    const layout=imageLayout(data);
    const lines=layout.lines.map(s=>`<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"/>`).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
<title>${lines ? 'Wall candidates — solid single lines' : 'No extracted walls'}</title>
<desc>Geometric candidates only. Unresolved walls are omitted. Not a complete or structurally verified plan.</desc>
<rect width="100%" height="100%" fill="white"/>
<g stroke="#176fe6" stroke-width="3" stroke-linecap="butt" fill="none">
${lines}
</g></svg>`;
  }
  return {build, select, segments, outputSegments, hitTest, toText, imageLayout, toSVG};
});
