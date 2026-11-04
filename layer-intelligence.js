(function (root) {
  'use strict';
  const Topology=root.CADTOPOLOGY||(typeof require==='function'?require('./segment-topology.js'):null);

  const ANNOTATION_TYPES = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'ATTDEF', 'ATTRIB']);
  const BLOCK_TYPES = new Set(['INSERT']);
  const ALGORITHM_VERSION = 'layer-intelligence-1.1-project';

  const clamp = value => Math.max(0, Math.min(1, value));
  const clampScore = value => Math.max(0, Math.min(100, Math.round(value)));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function segmentsOf(entity) {
    const layer = entity.layer || '0';
    const make = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, layer, lineType:entity.lineType||'' });
    if (entity.type === 'LINE') {
      return [entity.x1, entity.y1, entity.x2, entity.y2].every(Number.isFinite)
        ? [make(entity.x1, entity.y1, entity.x2, entity.y2)]
        : [];
    }
    if (entity.type !== 'LWPOLYLINE' && entity.type !== 'POLYLINE') return [];
    const vertices = (entity.verts || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    const segments = [];
    for (let index = 0; index + 1 < vertices.length; index += 1) {
      segments.push(make(vertices[index].x, vertices[index].y, vertices[index + 1].x, vertices[index + 1].y));
    }
    if ((entity.flag & 1) && vertices.length > 2) {
      const first = vertices[0];
      const last = vertices[vertices.length - 1];
      segments.push(make(last.x, last.y, first.x, first.y));
    }
    return segments;
  }

  function extentOf(segments) {
    if (!segments.length) return { minx: 0, miny: 0, maxx: 1, maxy: 1, diag: 1 };
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const segment of segments) {
      minx = Math.min(minx, segment.x1, segment.x2);
      miny = Math.min(miny, segment.y1, segment.y2);
      maxx = Math.max(maxx, segment.x1, segment.x2);
      maxy = Math.max(maxy, segment.y1, segment.y2);
    }
    return { minx, miny, maxx, maxy, diag: Math.hypot(maxx - minx, maxy - miny) || 1 };
  }

  function normalizeSegment(segment) {
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const length = Math.hypot(dx, dy);
    return { ...segment, dx, dy, length, ux: length ? dx / length : 0, uy: length ? dy / length : 0 };
  }

  function parallelRelation(a, b, minSpacing, maxSpacing, minOverlap) {
    if (!a.length || !b.length) return null;
    const parallelError = Math.abs(a.ux * b.uy - a.uy * b.ux);
    if (parallelError > Math.sin(5 * Math.PI / 180)) return null;
    const nx = -a.uy;
    const ny = a.ux;
    const signedSpacing = nx * (b.x1 - a.x1) + ny * (b.y1 - a.y1);
    const spacing = Math.abs(signedSpacing);
    if (spacing < minSpacing || spacing > maxSpacing) return null;
    const project = point => a.ux * (point.x - a.x1) + a.uy * (point.y - a.y1);
    const b1 = project({ x: b.x1, y: b.y1 });
    const b2 = project({ x: b.x2, y: b.y2 });
    const overlap = Math.min(a.length, Math.max(b1, b2)) - Math.max(0, Math.min(b1, b2));
    if (overlap < minOverlap) return null;
    return { spacing, overlap };
  }

  function dominantValue(values, unitMode) {
    if (!values.length) return null;
    const step = unitMode === 'millimeters' ? 1 : Math.max(0.000001, Math.max(...values) / 100);
    const buckets = new Map();
    for (const value of values) {
      const key = Math.round(value / step) * step;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  }

  function endpointConnectionRatio(segments, tolerance) {
    if (!segments.length) return 0;
    const cells = new Map();
    const connected = new Set();
    const size = Math.max(tolerance, Number.EPSILON);
    segments.forEach((segment, index) => {
      for (const point of [{ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }]) {
        const cx = Math.floor(point.x / size), cy = Math.floor(point.y / size);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const neighbors = cells.get(`${cx + dx},${cy + dy}`) || [];
            for (const other of neighbors) {
              if (other.index !== index && distance(point, other) <= tolerance) {
                connected.add(index);
                connected.add(other.index);
              }
            }
          }
        }
        const key = `${cx},${cy}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ ...point, index });
      }
    });
    return connected.size / segments.length;
  }

  function lengthSummary(segments) {
    const lengths = segments.map(segment => segment.length).sort((a, b) => a - b);
    if (!lengths.length) return { min: 0, median: 0, max: 0 };
    const middle = Math.floor(lengths.length / 2);
    return {
      min: lengths[0],
      median: lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2,
      max: lengths[lengths.length - 1],
    };
  }

  function spacingBands(values, unitMode, diagonal) {
    const groups = [];
    for (const value of [...values].sort((a, b) => a - b)) {
      const previous = groups[groups.length - 1];
      const tolerance = Math.max(unitMode === 'millimeters' ? 10 : diagonal * 0.0005, value * 0.08);
      if (previous && Math.abs(value - previous.spacing) <= tolerance) {
        previous.spacing = (previous.spacing * previous.count + value) / (previous.count + 1);
        previous.count += 1;
      } else groups.push({ spacing: value, count: 1 });
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 4)
      .filter(group => group.count >= Math.max(2, values.length * 0.06))
      .map(group => ({ spacing: group.spacing, count: group.count, share: group.count / values.length }));
  }

  function summarizeOneLayer(name, entities, options) {
    const allSegments = entities.flatMap(segmentsOf).map(normalizeSegment).filter(segment => segment.length > 0);
    const ext = extentOf(allSegments);
    const unitMode = options.unitsCode === 4 ? 'millimeters' : 'relative';
    const minSpacing = options.pairMin != null ? options.pairMin : unitMode === 'millimeters' ? 60 : ext.diag * 0.003;
    const maxSpacing = options.pairMax != null ? options.pairMax : unitMode === 'millimeters' ? 450 : ext.diag * 0.05;
    const minOverlap = options.minWallLen != null ? options.minWallLen : unitMode === 'millimeters' ? 500 : ext.diag * 0.02;
    const connectionTolerance = unitMode === 'millimeters' ? 120 : ext.diag * 0.012;
    const eligibleAll = Topology.runs(allSegments).map(normalizeSegment).filter(segment => segment.length >= minOverlap);
    const sampleStep = Math.max(1, Math.ceil(eligibleAll.length / 400));
    const eligible = eligibleAll.filter((segment, index) => index % sampleStep === 0).slice(0, 400);
    const neighborCounts = Array(eligible.length).fill(0);
    const pairSpacings = [];
    const nearestSpacings = Array(eligible.length).fill(Infinity);
    const pairedIndexes = new Set();

    for (let first = 0; first < eligible.length; first += 1) {
      // Sample anchors only. Each anchor searches every eligible counterpart so
      // adjacent DXF wall edges cannot disappear together through stride sampling.
      for (let second = 0; second < eligibleAll.length; second += 1) {
        if (eligible[first] === eligibleAll[second]) continue;
        const relation = parallelRelation(eligible[first], eligibleAll[second], minSpacing, maxSpacing, minOverlap);
        if (!relation) continue;
        neighborCounts[first] += 1;
        pairedIndexes.add(first);
        pairSpacings.push(relation.spacing);
        nearestSpacings[first] = Math.min(nearestSpacings[first], relation.spacing);
      }
    }

    let horizontal = 0, vertical = 0, diagonal = 0;
    for (const segment of allSegments) {
      const ax = Math.abs(segment.dx);
      const ay = Math.abs(segment.dy);
      if (ay <= segment.length * 0.087) horizontal += 1;
      else if (ax <= segment.length * 0.087) vertical += 1;
      else diagonal += 1;
    }

    const entityCount = entities.length || 1;
    const segmentCount = allSegments.length;
    const orientationDenominator = segmentCount || 1;
    const horizontalRatio = horizontal / orientationDenominator;
    const verticalRatio = vertical / orientationDenominator;
    const diagonalRatio = diagonal / orientationDenominator;
    const connectionRatio = endpointConnectionRatio(allSegments, connectionTolerance);
    const horizontalLength = allSegments.filter(segment => Math.abs(segment.dy) <= segment.length * 0.087).reduce((sum, segment) => sum + segment.length, 0);
    const verticalLength = allSegments.filter(segment => Math.abs(segment.dx) <= segment.length * 0.087).reduce((sum, segment) => sum + segment.length, 0);
    const totalLength = allSegments.reduce((sum, segment) => sum + segment.length, 0) || 1;
    const orientationBalance = Math.min(1, Math.min(horizontalLength, verticalLength) / totalLength * 2);
    const roomBoundaryScore = clamp(orientationBalance * 0.65 + connectionRatio * 0.35);
    const typeCounts = {};
    for (const entity of entities) typeCounts[entity.type] = (typeCounts[entity.type] || 0) + 1;
    const nearest = nearestSpacings.filter(Number.isFinite);
    const mainSpacing = dominantValue(nearest, unitMode);
    const spacingTolerance = mainSpacing == null ? 0 : Math.max(mainSpacing * 0.15, unitMode === 'millimeters' ? 10 : ext.diag * 0.001);
    const spacingConsistency = nearest.length
      ? nearest.filter(value => Math.abs(value - mainSpacing) <= spacingTolerance).length / nearest.length : 0;
    const recurringSpacingBands = spacingBands(nearest, unitMode, ext.diag);

    return {
      name,
      entityCount: entities.length,
      segmentCount,
      typeCounts,
      horizontalRatio,
      verticalRatio,
      diagonalRatio,
      parallelPairRatio: eligible.length ? pairedIndexes.size / eligible.length : 0,
      parallelPairLengthRatio: eligible.length ? eligible.reduce((sum, segment, index) =>
        sum + (pairedIndexes.has(index) ? segment.length : 0), 0)
        / eligible.reduce((sum, segment) => sum + segment.length, 0) : 0,
      dominantPairSpacing: mainSpacing,
      spacingConsistency,
      recurringSpacingBands,
      recurringSpacingCoverage: recurringSpacingBands.reduce((sum, band) => sum + band.share, 0),
      horizontalLengthRatio: horizontalLength / totalLength,
      verticalLengthRatio: verticalLength / totalLength,
      lengthSummary: lengthSummary(allSegments),
      sampledSegmentCount: eligible.length,
      eligibleSegmentCount: eligibleAll.length,
      pairCount: pairSpacings.length,
      closedPolylineRatio: entities.filter(entity =>
        (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && (entity.flag & 1)).length / entityCount,
      connectionRatio,
      repetitionRatio: eligible.length ? neighborCounts.filter(count => count >= 5).length / eligible.length : 0,
      annotationRatio: entities.filter(entity => ANNOTATION_TYPES.has(entity.type)).length / entityCount,
      blockRatio: entities.filter(entity => BLOCK_TYPES.has(entity.type)).length / entityCount,
      roomBoundaryScore,
      unitMode,
    };
  }

  function summarizeLayerFeatures(entities, options) {
    const groups = new Map();
    for (const entity of entities || []) {
      const name = entity.layer || '0';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(entity);
    }
    return Array.from(groups.entries())
      .map(([name, layerEntities]) => summarizeOneLayer(name, layerEntities, options || {}))
      .sort((a, b) => b.entityCount - a.entityCount || a.name.localeCompare(b.name));
  }

  function nameSignals(name) {
    const normalized = String(name || '0').toUpperCase().replace(/[\s_-]+/g, ' ');
    return {
      wall: /(WALL|KABE|壁|間仕切|耐力壁)/.test(normalized),
      annotation: /(TEXT|DIM|ANNO|NOTE|文字|寸法|注記)/.test(normalized),
      furniture: /(FURN|EQUIP|FIXTURE|家具|什器|設備)/.test(normalized),
      column: /(^| )(COLUMN|COL|柱)( |$)/.test(` ${normalized} `),
      beam: /(BEAM|梁)/.test(normalized),
      brace: /(BRACE|筋違|筋交|斜材|K FRAME|KFRAME)/.test(normalized),
      doorWindow: /(DOOR|WINDOW|建具|扉|窓|サッシ)/.test(normalized),
      grid: /(GRID|AXIS|CENTER|通り|芯)/.test(normalized),
    };
  }

  function classifyOneLayer(feature) {
    const signals = nameSignals(feature.name);
    const evidence = [];
    const risks = [];
    // Edge counts alone over-weight tiny opening fragments. Balance count and
    // paired length so a long continuous outline contributes proportionately.
    const pairedGeometry = clamp((feature.parallelPairRatio + feature.parallelPairLengthRatio) / 2);
    const thicknessConsistency = Math.max(feature.spacingConsistency || 0, feature.recurringSpacingCoverage || 0);
    const orthogonalContinuity = clamp(feature.roomBoundaryScore);
    const roomBoundaryEvidence = clamp(feature.roomBoundaryScore);
    const repetitionRisk = clamp(feature.repetitionRatio);
    const annotationRisk = clamp(feature.annotationRatio);
    const blockRisk = clamp(feature.blockRatio);
    const otherContentRatio = feature.annotationRatio + feature.blockRatio;
    const lineEntityRatio = ((feature.typeCounts.LINE || 0) + (feature.typeCounts.POLYLINE || 0)
      + (feature.typeCounts.LWPOLYLINE || 0)) / Math.max(1, feature.entityCount);
    const mixedContent = pairedGeometry >= 0.2 && lineEntityRatio >= 0.3 && otherContentRatio >= 0.3;
    const orthogonalRatio = feature.horizontalRatio + feature.verticalRatio;
    const curveRatio = ((feature.typeCounts.ARC || 0) + (feature.typeCounts.CIRCLE || 0)) / Math.max(1, feature.entityCount);
    const lineEvidence = feature.segmentCount > 0 ? 1 : 0;

    let wallScore = signals.wall ? 30 : 0;
    wallScore += pairedGeometry * 28;
    wallScore += thicknessConsistency * 14;
    wallScore += orthogonalContinuity * 16;
    wallScore += roomBoundaryEvidence * 12;
    wallScore += feature.annotationRatio + feature.blockRatio < 0.1 ? 10 : 0;
    wallScore -= repetitionRisk * 45;
    wallScore -= annotationRisk * 35;
    wallScore -= blockRisk * 20;
    wallScore = clampScore(wallScore);

    const roleScores = {
      wall: wallScore,
      annotation: clampScore((signals.annotation ? 40 : 0) + feature.annotationRatio * 70),
      furniture: clampScore((signals.furniture ? 40 : 0) + feature.blockRatio * 70),
      column: clampScore((signals.column ? 45 : 0) + feature.closedPolylineRatio * 20 + orthogonalRatio * 15 * lineEvidence),
      beam: clampScore((signals.beam ? 45 : 0) + pairedGeometry * 20 + orthogonalRatio * 15 * lineEvidence),
      brace: clampScore((signals.brace ? 45 : 0) + feature.diagonalRatio * 45),
      'door-window': clampScore((signals.doorWindow ? 45 : 0) + curveRatio * 25 + feature.blockRatio * 15),
      grid: clampScore((signals.grid ? 45 : 0) + (orthogonalRatio > 0.8 && feature.connectionRatio < 0.2 ? 25 : 0)),
      mixed: mixedContent ? 92 : 0,
      unknown: 30,
    };

    if (signals.wall) evidence.push('layer name suggests wall');
    if (pairedGeometry >= 0.35) evidence.push('paired wall lines');
    if (pairedGeometry >= 0.35 && thicknessConsistency >= 0.5 && repetitionRisk < 0.7) evidence.push('consistent paired wall spacing');
    if (pairedGeometry >= 0.35 && feature.recurringSpacingBands.length > 1 && feature.recurringSpacingCoverage >= 0.6) evidence.push('multiple recurring wall spacings');
    if (feature.roomBoundaryScore >= 0.45) evidence.push('orthogonal connected boundary');
    if (feature.annotationRatio >= 0.6) evidence.push('annotation entities dominate');
    if (signals.annotation) evidence.push('layer name suggests annotation');
    if (feature.blockRatio >= 0.5) evidence.push('inserted blocks dominate');
    if (signals.furniture) evidence.push('layer name suggests furniture');
    if (signals.column) evidence.push('layer name suggests column');
    if (signals.beam) evidence.push('layer name suggests beam');
    if (signals.brace) evidence.push('layer name suggests brace');
    if (signals.doorWindow) evidence.push('layer name suggests door or window');
    if (signals.grid) evidence.push('layer name suggests grid');
    if (feature.diagonalRatio >= 0.6) evidence.push('diagonal geometry dominates');
    if (feature.closedPolylineRatio >= 0.5) evidence.push('closed polylines dominate');
    if (curveRatio >= 0.3) evidence.push('curved entities present');
    if (orthogonalRatio > 0.8 && feature.connectionRatio < 0.2) evidence.push('sparse orthogonal lines');

    if (repetitionRisk >= 0.5) risks.push('repeated product-detail pattern');
    if (feature.annotationRatio >= 0.3 && !signals.annotation) risks.push('annotation-heavy layer');
    if (feature.blockRatio >= 0.3 && !signals.furniture) risks.push('block-heavy layer');
    if (mixedContent) risks.push('mixed content');
    if (feature.segmentCount === 0 && feature.annotationRatio === 0 && feature.blockRatio === 0) risks.push('no analyzable geometry');
    if (feature.unitMode === 'relative') risks.push('unitless relative measurements');
    if (feature.sampledSegmentCount < feature.eligibleSegmentCount) risks.push('sampled pair geometry');

    const ranked = Object.entries(roleScores).sort((a, b) => b[1] - a[1]);
    let role = ranked[0][0];
    let confidence = ranked[0][1];
    if (mixedContent) {
      role = 'mixed';
      confidence = roleScores.mixed;
    }
    if (!evidence.length && !risks.length) risks.push('insufficient semantic evidence');

    return {
      name: feature.name,
      role,
      confidence,
      roleScores,
      evidence,
      risks,
      features: feature,
      selected: false,
    };
  }

  function classifyLayerSemantics(features) {
    const input = features || [];
    const totalEntities = input.reduce((sum, feature) => sum + feature.entityCount, 0);
    return input.map(feature => {
      const analysis = classifyOneLayer(feature);
      const tinyShareInDenseDrawing = totalEntities >= 100
        && feature.entityCount / totalEntities < 0.05
        && feature.eligibleSegmentCount <= 16
        && !nameSignals(feature.name).wall;
      if (tinyShareInDenseDrawing && analysis.role === 'wall') {
        analysis.risks.push('minor frame layer in dense drawing');
        analysis.roleScores.wall = Math.max(0, analysis.roleScores.wall - 35);
        analysis.confidence = Math.max(analysis.roleScores.unknown, analysis.roleScores.wall);
        analysis.role = analysis.roleScores.wall > analysis.roleScores.unknown ? 'wall' : 'unknown';
      }
      return analysis;
    });
  }

  function automaticLayerSelection(analyses, options) {
    const settings = {
      minimumWallConfidence: options && options.minimumWallConfidence != null ? options.minimumWallConfidence : 70,
      ambiguityMargin: options && options.ambiguityMargin != null ? options.ambiguityMargin : 8,
    };
    const list = analyses || [];
    const candidates = list
      .filter(item => item.role === 'wall')
      .filter(item => item.confidence >= settings.minimumWallConfidence)
      .filter(item => !item.risks.includes('mixed content'))
      .filter(item => !item.risks.includes('repeated product-detail pattern'))
      .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

    if (!candidates.length) {
      const mixedOnly = list.length === 1 && list[0].role === 'mixed';
      return {
        status: 'unsupported',
        selectedWallLayers: [],
        reasonCode: mixedOnly ? 'mixed-layer-only' : 'no-reliable-wall-layer',
        explanation: mixedOnly
          ? 'The only Layer mixes wall-like geometry with other content.'
          : 'No Layer has enough independent wall evidence.',
      };
    }

    if (candidates.length > 1) {
      const explicit = candidates.filter(candidate => nameSignals(candidate.name).wall && candidate.confidence >= 80);
      if (explicit.length === candidates.length) {
        return {
          status: 'selected',
          selectedWallLayers: explicit.map(item => item.name),
          reasonCode: 'multiple-explicit-wall-layers',
          explanation: 'Multiple independently strong architectural wall Layers were selected.',
        };
      }
      if (candidates[0].confidence - candidates[1].confidence < settings.ambiguityMargin) {
        return {
          status: 'ambiguous',
          selectedWallLayers: [],
          reasonCode: 'ambiguous-wall-layers',
          explanation: 'The leading wall Layers are too close in confidence to choose safely.',
        };
      }
    }

    return {
      status: 'selected',
      selectedWallLayers: [candidates[0].name],
      reasonCode: 'reliable-wall-layer-selected',
      explanation: `Layer ${candidates[0].name} has the strongest independent wall evidence.`,
    };
  }

  function analyzeLayers(entities, options) {
    const features = summarizeLayerFeatures(entities, options || {});
    const layers = classifyLayerSemantics(features, options || {});
    const selection = automaticLayerSelection(layers, options || {});
    const selected = new Set(selection.selectedWallLayers);
    const threshold = options && options.minimumWallConfidence != null ? options.minimumWallConfidence : 70;
    for (const layer of layers) {
      layer.selected = selected.has(layer.name);
      layer.selectionReasonCode = layer.selected ? 'selected-wall-layer'
        : layer.risks.includes('mixed content') ? 'excluded-mixed-content'
        : layer.risks.includes('repeated product-detail pattern') ? 'excluded-repeated-pattern'
        : layer.role !== 'wall' ? 'excluded-other-role'
        : layer.confidence < threshold ? 'below-wall-threshold'
        : selection.status === 'ambiguous' ? 'ambiguous-wall-layers'
        : 'lower-ranked-wall-layer';
    }
    return {
      ...selection, layers,
      algorithmVersion: ALGORITHM_VERSION,
      method: 'explainable-rule-scoring',
      confidenceMeaning: 'Uncalibrated evidence score (0–100), not probability or measured accuracy.',
      minimumWallConfidence: threshold,
      ambiguityMargin: options && options.ambiguityMargin != null ? options.ambiguityMargin : 8,
    };
  }

  const api = { summarizeLayerFeatures, classifyLayerSemantics, automaticLayerSelection, analyzeLayers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LAYERINTELLIGENCE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
