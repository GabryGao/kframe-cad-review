(function (root) {
  'use strict';
  const pct = value => `${Math.round((value || 0) * 100)}%`;
  const number = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const roles = {
    wall: ['Wall-like outlines', '壁に似た輪郭線'],
    annotation: ['Dimensions / annotations', '寸法・注記'],
    furniture: ['Furniture / equipment', '家具・設備'],
    column: ['Possible column outlines', '柱輪郭の候補'],
    beam: ['Possible beam lines', '梁線の候補'],
    brace: ['Diagonal / brace-like lines', '斜線・筋違に似た線'],
    'door-window': ['Doors / windows', '扉・窓・建具'],
    grid: ['Grid / reference lines', '通り芯・基準線'],
    mixed: ['Mixed contents', '異なる内容が混在'],
    unknown: ['Purpose not determined', '用途を特定できません'],
  };

  function explain(layer, analysis) {
    const f = layer.features;
    const types = f.typeCounts || {};
    const items = [
      [types.LINE || 0, 'straight lines', '直線'],
      [(types.LWPOLYLINE || 0) + (types.POLYLINE || 0), 'polylines', 'ポリライン'],
      [(types.TEXT || 0) + (types.MTEXT || 0) + (types.ATTRIB || 0) + (types.ATTDEF || 0), 'text entities', '文字'],
      [types.DIMENSION || 0, 'dimension entities', '寸法要素'],
      [(types.ARC || 0) + (types.CIRCLE || 0) + (types.ELLIPSE || 0), 'curves / circles', '曲線・円'],
      [types.INSERT || 0, 'block references', 'ブロック参照'],
    ];
    const counted = items.reduce((sum, item) => sum + item[0], 0);
    if (counted < f.entityCount) items.push([f.entityCount - counted, 'other entities', 'その他']);
    const present = items.filter(item => item[0]);
    const role = layer.selected ? ['Wall-outline target', '壁輪郭の抽出対象']
      : layer.role === 'wall' && layer.confidence < analysis.minimumWallConfidence
        ? ['Uncertain: wall-like lines', '未確定：壁に似た線'] : roles[layer.role] || roles.unknown;
    const contents = {
      en: `${present.map(item => `${item[0]} ${item[1]}`).join(', ') || 'No parsed entities'}.`,
      ja: `${present.map(item => `${item[2]} ${item[0]}件`).join('、') || '解析済み要素なし'}。`,
    };
    const interpretation = {
      en: layer.selected ? 'This Layer is the automatic source for wall extraction. This does not establish load-bearing capacity.'
        : layer.role === 'mixed' ? 'Geometry and non-wall content are mixed; the whole Layer is not treated as a wall Layer.'
        : layer.role === 'unknown' || (layer.role === 'wall' && layer.confidence < analysis.minimumWallConfidence)
          ? 'The purpose is uncertain. These contents are not included in the wall output.'
          : `The most likely role is ${role[0].toLowerCase()}; this is an inference, not a confirmed label.`,
      ja: layer.selected ? '壁抽出の元レイヤーとして自動選択しました。耐力壁であることは示していません。'
        : layer.role === 'mixed' ? '形状と壁以外の内容が混在するため、レイヤー全体を壁として扱いません。'
        : layer.role === 'unknown' || (layer.role === 'wall' && layer.confidence < analysis.minimumWallConfidence)
          ? '用途の根拠が不足しています。この内容は壁の出力に含めません。'
          : `推定される役割は「${role[1]}」です。確定した分類ではありません。`,
    };
    const bands = (f.recurringSpacingBands || []).map(band => number(band.spacing)).join(', ');
    const nameHint = (layer.evidence || []).find(item => item.startsWith('layer name'));
    const evidence = [
      { key: 'name', label: ['Layer name', 'レイヤー名'], en: nameHint
        ? 'A name clue contributes to the role estimate; geometry is also evaluated.'
        : 'No recognized role-name clue. The estimate relies on the contents and geometry.',
        ja: nameHint ? '名前の手掛かりに加え、実際の形状を評価しています。' : '役割を示す名前の手掛かりなし。内容と形状を評価しています。' },
      { key: 'pairs', label: ['Parallel edges', '平行双線'],
        en: `${pct(f.parallelPairRatio)} of eligible sampled lines have a parallel partner; ${pct(f.parallelPairLengthRatio)} by length.`,
        ja: `対象線の双線比率 ${pct(f.parallelPairRatio)}、長さによる比率 ${pct(f.parallelPairLengthRatio)}。` },
      { key: 'spacing', label: ['Spacing / possible thickness', '間隔・壁厚の手掛かり'],
        en: bands ? `Recurring spacings: ${bands} drawing units. Physical wall thickness is not verified.` : 'No recurring wall-edge spacing was established.',
        ja: bands ? `反復間隔：${bands}（図面座標）。実寸壁厚は未確認です。` : '繰り返す壁双線の間隔を特定できません。' },
      { key: 'continuity', label: ['Connections', '連続性・接続'],
        en: `${pct(f.connectionRatio)} of line segments have a nearby endpoint connection.`,
        ja: `${pct(f.connectionRatio)} の線分に近接する端点接続があります。` },
      { key: 'rooms', label: ['Room-boundary clues', '室境界の手掛かり'],
        en: `Horizontal / vertical lines by length: ${pct(f.horizontalLengthRatio)} / ${pct(f.verticalLengthRatio)}. Boundary similarity ${pct(f.roomBoundaryScore)}; rooms are not verified.`,
        ja: `長さ比率：水平 ${pct(f.horizontalLengthRatio)}・垂直 ${pct(f.verticalLengthRatio)}。境界類似度 ${pct(f.roomBoundaryScore)}。部屋を確定した値ではありません。` },
      { key: 'other', label: ['Conflicting contents', '壁以外の根拠'],
        en: `Annotation share ${pct(f.annotationRatio)}, block share ${pct(f.blockRatio)}, dense repetition ${pct(f.repetitionRatio)}.`,
        ja: `注記 ${pct(f.annotationRatio)}、ブロック ${pct(f.blockRatio)}、密な反復線 ${pct(f.repetitionRatio)}。` },
    ];
    const why = {
      en: `${pct(f.parallelPairRatio)} paired lines; ${pct(f.connectionRatio)} connected segments; ${pct(f.roomBoundaryScore)} room-boundary similarity. ${bands ? `Recurring spacings ${bands}.` : 'No recurring wall spacing.'}`,
      ja: `双線 ${pct(f.parallelPairRatio)}・接続 ${pct(f.connectionRatio)}・室境界類似 ${pct(f.roomBoundaryScore)}。${bands ? `反復間隔 ${bands}。` : '反復する壁間隔なし。'}`,
    };
    return { layer: layer.name, role: { en: role[0], ja: role[1] }, contents, interpretation,
      why, evidence, selected: layer.selected, score: layer.confidence,
      wallScore: layer.roleScores.wall, threshold: analysis.minimumWallConfidence,
      method: 'Evidence-derived text templates; no language model or calibrated probability.' };
  }
  const reportText = value => String(value ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim();

  function unresolvedExplanation(line) {
    const layers = [...new Set((line.context || []).map(item => reportText(item.layer)))].filter(Boolean).join('・');
    if (line.reasonCode === 'cross-layer-only') return {
      cause: {ja:`同一レイヤー内では配対できず、他レイヤー（${layers || '名称不明'}）に近接する平行線があります。壁の対応・厚さは未確定です。`,
        en:`No same-layer pair was assigned; nearby parallel lines exist on ${layers || 'another layer'}. Their wall identity and thickness are unverified.`},
      remedy: {ja:'解決案：他レイヤーの線種・間隔・接続を照合し、対応する壁境界と確認できた場合だけ配対に利用します。',
        en:'Proposed remedy: check the other layer’s line types, spacing and connections; use it only if it represents the matching wall boundary.'},
    };
    if (line.reasonCode === 'below-main-span') return {
      cause: {ja:'残った短線区間が主壁長のしきい値未満です。端部や壁以外の細部も含むため、そのまま壁にはしていません。',
        en:'This remaining short interval is below the main-span threshold. It may be an end cap or non-wall detail, so it is not automatically a wall.'},
      remedy: {ja:'解決案：元線の分割と双線の対応を調べ、実際の開口を残したまま短壁・接続部の抽出条件を改善します。',
        en:'Proposed remedy: inspect source fragmentation and paired edges, then improve short-wall and junction extraction without closing real openings.'},
    };
    if (line.reasonCode === 'at-or-below-case-minimum') return {
      cause: {ja:'本案件の省略条件により、長さ200mm以下の元線区間として記録し、壁配置から除外しました。',
        en:'The case-specific rule omits source intervals 200 mm or shorter from wall placement while retaining their coordinates in the audit data.'},
      remedy: {ja:'確認事項：連続壁の分割片ではないこと、交差部からの短い突出部または独立した短壁であることを元図で確認します。',
        en:'Review: confirm that this is not a fragment of a longer continuous wall and identify whether it is a short projection at a junction or a separate short wall.'},
    };
    return {
      cause: {ja:line.reasonCode === 'no-compatible-pair' ? '同一レイヤー内で未使用の双線配対が成立しませんでした。単線・間隔・角度・重複配対などのどの条件が原因かは未特定です。' : '未確定の理由を特定できません。',
        en:line.reasonCode === 'no-compatible-pair' ? 'No available same-layer edge pair met the extraction rules. The exact failed condition—single edge, spacing, angle or overlapping pairing—is not established.' : 'The reason for this unresolved interval is unavailable.'},
      remedy: {ja:'解決案：元図で相手側の線、図面単位、壁厚候補、端点を照合します。距離だけで線を延長したり、開口を埋めたりしません。',
        en:'Proposed remedy: compare the opposing edge, drawing units, possible thickness and endpoints with the source. Do not extend lines or fill openings based on distance alone.'},
    };
  }

  function buildTextReport(payload) {
    const source = payload.source || {}, layers = payload.layerExplanations || [];
    const selected = payload.selectedWallLayers || [], walls = payload.wallCenterlines || [];
    const unresolved = payload.wallCoverage?.unresolved;
    const omitted = payload.wallCoverage?.omitted || [];
    const lengthRule = payload.casePolicy?.wallLength;
    const lengthOmission = lengthRule?.omissionByLength === true || Number.isFinite(lengthRule?.omitAtOrBelow);
    const lines = ['CAD図面 解析レポート / CAD drawing analysis report', ''];
    const add = (...values) => lines.push(...values.map(reportText));
    const paragraph = (ja, en) => add(ja, en, '');
    add(`ファイル / File: ${reportText(source.fileName || '名称不明 / unnamed')}`,
      `図面単位 / Drawing units: ${reportText(source.unitsLabel || '不明 / unknown')}（実寸倍率は未確認 / physical scale unverified）`,
      '集計範囲：全図。画面で拡大している領域だけの集計ではありません。',
      'Scope: the entire drawing, not only the area visible on screen.', '');
    const imported = source.importDetails || {};
    if (imported.sourceFormat === 'DWG') paragraph(
      `DWGを端末内で変換しました。変換警告：${Number.isFinite(imported.warningCount) ? imported.warningCount : '件数不明'}件。文字・高度な要素の変換精度は保証していません。`,
      `DWG was converted on this device. Converter warnings: ${Number.isFinite(imported.warningCount) ? imported.warningCount : 'unknown'}. Text and advanced-entity fidelity are not guaranteed.`);

    add('1. 解析結果の要約 / Summary', '');
    paragraph(selected.length ? `壁の抽出元として「${selected.map(reportText).join('」「')}」を自動選択しました。`
      : '壁レイヤーを確定できません。壁がないという意味ではありません。',
      selected.length ? `Automatically selected wall source: ${selected.map(reportText).join(', ')}.`
      : 'No wall layer could be determined. This does not mean there are no walls.');
    add(`評価したレイヤー：${layers.length}層 / Assessed layers: ${layers.length}`,
      `抽出した中心線：${walls.length}本 / Extracted centerline segments: ${walls.length}`,
      lengthOmission?`本案件ルールで省略：${omitted.length}区間 / Omitted by the case-specific length rule: ${omitted.length}`
        :'壁長だけによる自動省略：なし / No automatic omission based on wall length alone');
    if(payload.casePolicy)paragraph(lengthOmission
      ?`本案件の条件：壁厚100mm以上（100mmを含む）。指定された壁長以下は省略します。PSの薄壁例外は文字位置だけでは自動適用せず、囲い各辺の確認が必要です。`
      :'本案件の条件：壁厚100mm以上（100mmを含む）。壁長だけを理由に省略せず、短い区間も双線輪郭と接続根拠で判断します。PSの薄壁例外は文字位置だけでは自動適用しません。',
      lengthOmission
        ?'Case-specific conditions: wall thickness at least 100 mm (inclusive). Spans at or below the configured wall-length limit are omitted. A thin PS-wall exception is never applied from a label alone.'
        :'Case-specific conditions: wall thickness at least 100 mm (inclusive). Wall length alone does not exclude a span; short intervals still require paired-outline and connection evidence. A thin PS-wall exception is never applied from a label alone.');
    const equipmentOutlines=payload.equipmentReview?.outlines||[];
    if(equipmentOutlines.length)paragraph(
      `設備文字を内包する閉じた外形${equipmentOutlines.length}件を壁抽出から除外しました。元図には残し、JSONに外形座標と元線IDを記録します。`,
      `${equipmentOutlines.length} closed outlines containing equipment labels were excluded from wall extraction. They remain in the source drawing and their bounds and source IDs are retained in JSON.`);
    const reconstructed=walls.filter(w=>w.centerlineBasis==='boundary-continuity-reference');
    if(reconstructed.length)paragraph(`うち${reconstructed.length}本は連続する両側の原線に基づく簡略基準線です。局所的な壁厚変化を単線化しており、厳密な中心線ではありません。以下の未確定原線数は統合前の配対診断で、未検出の壁の数ではありません。`,
      `${reconstructed.length} are simplified references supported by continuous source boundaries on both sides, not exact centerlines. Unresolved source counts below are pre-reconstruction pair diagnostics, not missing-wall counts.`);
    const assisted=walls.filter(w=>w.centerlineBasis==='context-paired-edges');
    const supportLayers=[...new Set(assisted.flatMap(w=>w.supportingSourceLayers||[]))].map(reportText).join('・');
    if(assisted.length)paragraph(`他レイヤー「${supportLayers}」の反対側の境界を根拠に${assisted.length}本を補完しました。繰り返し現れる壁厚と複数の元線の対応を照合しています。対象レイヤーは変更せず、元線の開口も埋めていません。`,
      `Context-assisted centerlines: ${assisted.length}. Opposing-edge evidence on ${supportLayers} matches recurring wall thickness across multiple source edges. The primary source layer is unchanged; source openings are not filled.`);
    const detailCount=payload.wallCoverage?.boundaryDetails?.length||0;
    if(detailCount)paragraph(`壁端・角・重複線など${detailCount}区間を、抽出した壁に対応する境界細部として整理しました。元線の連続性と壁厚の範囲を照合し、独立した壁中心線としては数えていません。`,
      `Represented boundary details: ${detailCount}. Caps, connected corners and duplicate edges are accounted against paired wall geometry; they are not counted as separate centerlines.`);
    const pathDetails=(payload.wallCoverage?.boundaryDetails||[]).filter(s=>s.detailKind);
    if(pathDetails.length)paragraph(`うち${pathDetails.length}区間は、配対済みの元線端点をつなぐ連続した壁端・角の経路です。隙間を埋めたり、基準軸を延長したりしていません。`,
      `Connected boundary paths: ${pathDetails.length} intervals. Both path tips meet paired source endpoints; no gaps or axes were extended.`);
    if (Array.isArray(unresolved)) {
      add(`未確定：${unresolved.length}区間 / Unresolved source intervals: ${unresolved.length}`);
      if (unresolved.length) paragraph('茶色の破線は元図に存在する未確定の線です。壁がないという意味ではありません。青い線だけでは完全な壁図になっていない可能性があります。',
        'Brown dashed lines are unresolved source lines, not proof that a wall is absent. Blue lines alone may not form a complete wall plan.');
      else paragraph('未確定区間は記録されていません。ただし、実際の壁を全て正しく認識できたことの保証ではありません。',
        'No unresolved intervals were recorded; this does not certify complete or correct wall recognition.');
    } else paragraph('未確定区間の評価データがありません。完全な抽出かどうかは判断できません。',
      'Coverage data are unavailable; extraction completeness cannot be assessed.');
    add(`K型配置の形状候補：${(payload.placementCandidates || []).length}件（設置承認ではありません）`,
      `Geometric K-frame placement candidates: ${(payload.placementCandidates || []).length} (not approved installation locations).`, '');

    add('2. 各レイヤーの内容と選択理由 / Layer contents and reasons', '');
    for (const layer of layers) {
      const isSelected = selected.includes(layer.layer);
      add(`【${reportText(layer.layer)}】${isSelected ? '抽出対象 / Selected' : '対象外 / Not selected'}`,
        `${reportText(layer.role?.ja)} / ${reportText(layer.role?.en)}`,
        `根拠スコア / Evidence score: ${Number.isFinite(layer.score) ? Math.round(layer.score) + '/100' : '不明 / unavailable'}（正解率ではありません / not measured accuracy）`);
      for (const key of ['contents','interpretation','why']) {
        if (layer[key]?.ja) add(layer[key].ja);
        if (layer[key]?.en) add(layer[key].en);
      }
      add('');
    }
    if(omitted.length) {
      add('省略した短区間 / Omitted short intervals', '');
      for(const line of [...omitted].sort((a,b)=>b.length-a.length).slice(0,12)) {
        const detail=unresolvedExplanation(line);
        add(`${reportText(line.sourceSegmentId)}・${number(line.length)}図面単位：${detail.cause.ja}`,
          `${reportText(line.sourceSegmentId)} · ${number(line.length)} drawing units: ${detail.cause.en}`);
      }
      paragraph('全ての省略区間の座標・長さ・理由はJSONに保持します。','Every omitted interval retains coordinates, length and reason in JSON.');
    }
    if (!layers.length) add('レイヤー別の説明データがありません。 / Layer explanations are unavailable.', '');

    add('3. 茶色の線が残る理由と解決案 / Why brown lines remain and possible remedies', '');
    paragraph('茶色は「つながっていない線」という意味ではなく、現在の条件で壁中心線に変換できなかった区間です。以下は解決案であり、自動修復済みではありません。',
      'Brown does not necessarily mean disconnected. These intervals were not converted to wall centerlines under the current rules. The remedies below are proposals, not completed repairs.');
    const codes = [...new Set((unresolved || []).map(line => line.reasonCode))];
    for (const code of codes) {
      const group = unresolved.filter(line => line.reasonCode === code);
      const detail = unresolvedExplanation({...group[0],context:group.flatMap(line => line.context || [])});
      add(`${group.length}区間 / ${group.length} intervals`);
      paragraph(detail.cause.ja,detail.cause.en);
      paragraph(detail.remedy.ja,detail.remedy.en);
    }
    if (unresolved?.length) {
      add('長い未確定区間の例（最大12件） / Longest unresolved intervals (up to 12)', '');
      for (const line of [...unresolved].sort((a,b)=>b.length-a.length).slice(0,12)) {
        const detail = unresolvedExplanation(line);
        add(`${reportText(line.sourceSegmentId)} / ${reportText(line.layer)} / ${number(line.length)} 図面単位 / drawing units`,
          detail.cause.ja,detail.cause.en,'');
      }
    }
    paragraph('この文章は読みやすい要約です。全ての未確定区間・座標・元線IDは「その他の出力」のJSONに、線図は確認用DXFに保存できます。',
      'This is a readable summary. All unresolved intervals, coordinates and source IDs remain available in JSON under Other exports; review DXF preserves their linework.');

    add('4. 次のAIに渡す基準軸 / Reference axes for downstream AI', '');
    const semantic=payload.semanticModel;
    if(semantic) {
      const engine=root.CADSEMANTICS || (typeof require==='function'?require('./semantic-axes.js'):null);
      paragraph(`基準軸候補 ${semantic.axes.length}本。幾何関係 ${semantic.relations.length}件。図面を再出力するだけでなく、各軸の位置・方向・元線・不確実性を記録しています。`,
        `${semantic.axes.length} candidate reference axes and ${semantic.relations.length} geometric relations. Each records position, direction, source evidence and uncertainty, not just a filtered drawing.`);
      const grids=semantic.gridReferences;
      if(grids) {
        paragraph(`原図の通り芯符号と線の対応：${grids.observed.length}件。生成した補助軸名：${grids.generated.length}件。未対応の符号：${grids.unmatchedLabels.length}件。`,
          `Source grid matches: ${grids.observed.length}. Generated auxiliary names: ${grids.generated.length}. Unmatched labels: ${grids.unmatchedLabels.length}.`);
        paragraph('X・Yの符号と付近の水平・垂直の通り芯候補を対応付けます。SYSや補助の枝番は生成名で、原図の軸号ではありません。対応0件でも通り芯がないとは限りません。名称は図面領域ごとに管理し、壁の座標・隙間は変更しません。距離の符号は「壁の座標−参照線の座標」で、縦線はX方向、横線はY方向です。',
          'Explicit X/Y labels are matched to nearby cardinal grid-line candidates. SYS names and auxiliary suffixes are generated, not original labels. Zero matches does not prove grids are absent. Names are scoped by drawing area; wall coordinates and gaps are unchanged. Signed offsets equal wall coordinate minus reference coordinate: X for vertical lines, Y for horizontal lines.');
      }
      paragraph('軸上の候補座標は、始点＋軸方向の距離×接線＋横方向の距離×法線で表せます。ただし、軸の長さは設置可能な有効長ではありません。柱・梁・開口の物体認識、階の対応、既存Kフレームの確定は未実装または未検証です。通り芯符号の読取は限定的で、ブロック内・回転した通り芯には未対応です。',
        'Candidate coordinates can be expressed as start + distance along axis × tangent + lateral offset × normal. Axis length is not a verified installation span. Column/beam/opening objects, floor assignment and confirmed existing K-frames are not implemented or verified. Grid-label matching is limited; block-contained or rotated grids are unsupported.');
      if(semantic.relationAnalysis.status!=='complete')paragraph('図面の大きさまたは関係数の上限により、関係評価には未処理の組み合わせがあります。関係がないという意味ではありません。全ての有効な軸は保存されます。',
        'Some relation pairs were not evaluated because of drawing-size or relation-count limits, not because relationships are absent. Every valid axis is retained.');
      for(const axis of semantic.axes) {
        const description=engine.describeAxis(axis,semantic);paragraph(description.ja,description.en);
        add(`接線 / Tangent: (${number(axis.localFrame.tangent.x)}, ${number(axis.localFrame.tangent.y)})`,
          `法線 / Normal: (${number(axis.localFrame.normal.x)}, ${number(axis.localFrame.normal.y)})`,
          `根拠スコア / Evidence score: ${axis.confidence.value===null?'不明 / unknown':Math.round(axis.confidence.value*100)+'/100'}（未校正 / uncalibrated）`);
        for(const r of engine.relationsForAxis(semantic,axis)) {
          const label={'near-endpoint':'近接のみ・未接続 / near only, not connected','endpoint-touch':'2D接触 / 2D contact',intersection:'2D交差 / 2D intersection',overlap:'重複 / overlap'}[r.type];
          add(`${r.axisIds.find(id=>id!==axis.id)}: ${label}${r.type==='near-endpoint'?` / 距離・distance ${number(r.distance)}`:''}`);
        }
        if(axis.warnings.length)add(`注意 / Cautions: ${axis.warnings.map(reportText).join('; ')}`);
        add('');
      }
      paragraph('AI連携JSONには同じ軸番号・元線座標・関係・未確定区間・制限事項が含まれます。実寸と構造条件を確認するまでは配置承認に使用できません。',
        'AI handoff JSON contains the same axis IDs, source coordinates, relations, unresolved intervals and limitations. It cannot approve placement before physical scale and structural constraints are verified.');
    } else paragraph('基準軸データはありません。 / No reference-axis data available.','');

    add('5. この結果の限界 / Limitations', '');
    paragraph('本レポートは形状ルールの判定結果を文章化したものです。学習済みAIではありません。根拠スコアは正解率ではありません。',
      'This report describes geometry-rule results. It is not generated by a trained AI model, and evidence scores are not measured accuracy.');
    paragraph('耐力壁・実寸壁厚・階名・部屋名・開口・構造安全性は確定していません。線の色だけを変えても、認識精度や壁の連続性は改善しません。',
      'Load-bearing status, physical wall thickness, floor/room names, openings and structural safety are not established. Recoloring lines does not improve recognition or connectivity.');
    paragraph('構造モデルへの保存・再読込み、床・屋根・柱・梁・P1等の保持、壁荷重、荷重伝達は実行していません。これらは壁配置確認とは別の未確認項目です。',
      'Structural-model save/reload, preservation of floors, roofs, columns, beams and P1, wall loads, and load transfer were not performed. These remain separate from wall-placement review.');
    return lines.join('\r\n');
  }

  const api = { explain, unresolvedExplanation, buildTextReport };
  root.LAYEREXPLANATIONS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
