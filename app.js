(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const CASE_POLICY_ID = 'architectural-wall-placement-2026-11-04-no-length-limit';
  const WALL_SOURCE_COLOR = '#d92d20';
  const canvas = $('drawing-canvas');
  const ctx = canvas.getContext('2d');
  const stageCanvases = {
    original: $('stage-original'),
    walls: $('stage-walls'),
    candidates: $('stage-candidates'),
    clean: $('stage-clean'),
  };
  const state = {
    fileName: '', inspection: null, entities: null, result: null, layers: [],
    decisions: {}, selectedId: null, inspectedLayer: null, paramsDirty: false,
    zoom: 1, panX: 0, panY: 0, dragging: false, dragStart: null, viewLayer: null,
    viewScope: 'main', importWorker: null, loadVersion: 0, convertedText: null,
    screen: 0, loading: false, importAbort: null, rejectImport: null,
    exportUrl: null, exportText: '', semanticModel: null, axisId: null, positionPage: 0,
    nativeScene: null, nativeVisible: new Set(), nativeZoom: 1, nativePanX: 0, nativePanY: 0, nativeDrag: null,
  };

  function setMessage(html, kind) {
    const element = $('message');
    element.hidden = !html;
    element.className = `message${kind === 'info' ? ' info' : ''}`;
    element.innerHTML = html || '';
  }

  function updateFlowAvailability() {
    document.querySelectorAll('[data-go]').forEach(button => {
      button.disabled = state.loading || (button.hasAttribute('data-needs-result') && !state.result);
    });
    document.querySelectorAll('[data-import-control]').forEach(button => { button.disabled = state.loading; });
    $('file-input').disabled = state.loading;
    $('upload-drop-zone').setAttribute('aria-busy', String(state.loading));
    if (!state.result) {
      ['detect-button', 'export-json', 'export-text', 'export-handoff', 'export-walls', 'export-dxf', 'export-layer', 'export-converted', 'export-coverage', 'export-png', 'export-svg', 'export-diagnostic-text'].forEach(id => { $(id).disabled = true; });
    }
  }

  function setImportBusy(busy) {
    state.loading = busy;
    $('cancel-import').hidden = !busy;
    $('open-file-button').innerHTML = busy
      ? 'Reading your drawing… <span>図面を読み込んでいます…</span>'
      : 'Choose a file <span>ファイルを選択</span>';
    updateFlowAvailability();
  }

  function setStep(current, moveFocus = true) {
    if (![0, 1, 2, 3].includes(current) || (current >= 2 && !state.result) || (state.loading && current !== 1)) return;
    state.screen = current;
    document.querySelectorAll('[data-page]').forEach(page => { page.hidden = Number(page.dataset.page) !== current; });
    $('flow-progress').hidden = current === 0;
    $('flow-heading').hidden = current === 0;
    $('message').hidden = current === 0 || !$('message').innerHTML;
    document.querySelectorAll('[data-flow-step]').forEach(button => {
      const step = Number(button.dataset.flowStep);
      button.classList.toggle('active', step === current);
      button.classList.toggle('complete', step < current);
      if (step === current) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    const content = {
      1: ['Step 1 of 3 / 全3ステップ中1', 'Choose a drawing', 'Open a file. Layer selection and wall extraction will run automatically. / 図面を選ぶと、レイヤー選択・壁抽出を自動で行います。'],
      2: ['Step 2 of 3 / 全3ステップ中2', 'Walls, axes and intervals', 'Compare each wall with the source drawing. See its axis, span and evidence. / 壁線を元図と照合し、軸・区間・判断理由を確認します。'],
      3: ['Step 3 of 3 / 全3ステップ中3', 'Export wall positions', 'Save direct coordinates for every blue wall line, or the axis/interval view. / 青い壁線すべての直接座標、または軸・区間形式を保存します。'],
    }[current];
    if (content) {
      $('step-label').textContent = content[0];
      $('page-title').textContent = content[1];
      $('page-subtitle').textContent = content[2];
    }
    updateFlowAvailability();
    if (moveFocus) {
      (current === 0 ? $('welcome-title') : $('page-title')).focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    requestAnimationFrame(draw);
  }

  function numberValue(id) {
    return Number($(id).value);
  }

  function analysisOptions() {
    const unitsCode = state.inspection ? state.inspection.unitsCode : 0;
    const millimeterCase = unitsCode === 4;
    const options = {
      unitsCode,
      requirePair: $('require-pair').checked,
      includeDiagnostics: false,
      casePolicyId: CASE_POLICY_ID,
      casePolicyMeasurementStatus: millimeterCase ? 'applied-in-millimeters' : 'pending-drawing-unit-verification',
      minWallLen: 0,
      minPairAspect: 0.01,
      layerEvidenceMinOverlap: millimeterCase ? 200 : undefined,
      excludeAtOrBelowMinWallLen: false,
      extractCompanionWallLayers: true,
    };
    if (options.unitsCode === 4 || state.paramsDirty) {
      options.kLen = numberValue('kframe-length');
      options.pairMin = numberValue('pair-min');
      options.pairMax = numberValue('pair-max');
    }
    return options;
  }

  function validateParameters() {
    const values = ['kframe-length', 'pair-min', 'pair-max'].map(numberValue);
    if (values.some(value => !Number.isFinite(value) || value <= 0)) {
      setMessage('<strong>Every geometry parameter must be greater than zero.</strong><br>すべての形状パラメータには0より大きい値を入力してください。');
      return false;
    }
    if (numberValue('pair-min') >= numberValue('pair-max')) {
      setMessage('<strong>Minimum wall thickness must be smaller than the maximum.</strong><br>最小壁厚は最大壁厚より小さくしてください。');
      return false;
    }
    if (state.inspection?.unitsCode === 4 && numberValue('pair-min') < 100) {
      setMessage('<strong>This case uses a 100 mm inclusive wall-thickness minimum.</strong><br>本案件の通常壁は100mm以上です。100mm未満のPS囲いは自動採用せず、各辺を個別確認します。');
      return false;
    }
    return true;
  }

  function analyze(advance) {
    if (!state.entities || !validateParameters()) return;
    const previous = state.decisions;
    state.result = CADCORE.classify(state.entities, analysisOptions());
    if (state.nativeScene) renderNativeLayerList();
    updateAxisModel();
    clearPreparedDownload();
    updateViewOptions();
    if (state.inspection.unitsCode !== 4 && !state.paramsDirty) {
      const controls = { 'kframe-length': 'kLen', 'pair-min': 'pairMin', 'pair-max': 'pairMax' };
      Object.entries(controls).forEach(([id, field]) => { $(id).value = Number(state.result.used[field].toPrecision(6)); });
    }
    const currentIds = new Set(state.result.placementCandidates.map(candidate => candidate.id));
    state.decisions = Object.fromEntries(Object.entries(previous).filter(([id]) => currentIds.has(id)));
    if (state.selectedId && !currentIds.has(state.selectedId)) state.selectedId = null;
    updateInfo();
    renderReview();
    renderAxisDetail();
    draw();
    $('detect-button').disabled = false;
    $('export-dxf').disabled = !state.result.wallCenterlines.length;
    $('export-walls').disabled = !state.result.wallCenterlines.length;
    $('export-layer').disabled = !(state.result.wallBoundaryLayers || state.result.selectedWallLayers || []).length;
    $('export-coverage').disabled = !state.result.selectedWallLayers.length;
    $('export-json').disabled = false;
    $('export-handoff').disabled = false;
    $('export-text').disabled = false;
    $('export-diagnostic-text').disabled = false;
    $('export-png').disabled = !state.result.wallCenterlines.length;
    $('export-svg').disabled = !state.result.wallCenterlines.length;
    updateFlowAvailability();
    if (advance) setStep(2);
    if (state.result.drawingAssessment && !state.result.drawingAssessment.supported) {
      const reason = selectionReasonCopy(state.result.drawingAssessment.reasonCode);
      setMessage(`<strong>Wall extraction could not be completed.</strong><br>${escapeHtml(reason.en)} See each Layer's evidence below; the original drawing remains available.<br>壁の抽出を完了できませんでした。${escapeHtml(reason.ja)} 下のレイヤー別根拠と原図をご確認ください。`);
    } else if (!state.result.wallCenterlines.length) {
      setMessage('<strong>No reliable wall centerlines were found.</strong><br>信頼できる壁中心線が見つかりません。壁厚や最小壁長を調整してください。');
    } else if (!state.result.placementCandidates.length) {
      setMessage('<strong>Walls were found, but none meet the placement threshold.</strong><br>壁は検出されましたが、配置条件を満たす候補はありません。K-frame clear spanを確認してください。', 'info');
    } else if (state.inspection.unitsCode !== 4 && !state.paramsDirty) {
      setMessage('<strong>Relative-threshold mode is active for this drawing.</strong><br>Absolute wall-thickness rules currently use millimeters; other units use drawing-relative thresholds.<br>絶対壁厚ルールは現在mmに対応しています。他の単位・単位不明の図面では相対しきい値を使用します。', 'info');
    } else {
      setMessage('', 'info');
    }
  }

  function loadText(text, fileName, importDetails) {
    const inspection = CADCORE.inspectDXF(text);
    inspection.importDetails = importDetails || { sourceFormat: 'DXF' };
    if (inspection.format === 'binary') {
      setMessage('<strong>Binary DXF is not supported in the browser.</strong><br>バイナリDXFはブラウザで解析できません。CADで「ASCII DXF」として保存し直してください。');
      return;
    }
    if (inspection.format !== 'ascii') {
      setMessage('<strong>No ASCII DXF ENTITIES section was found.</strong><br>ASCII DXFのENTITIESセクションが見つかりません。DWGの場合はASCII DXFへ変換してください。');
      return;
    }
    let entities;
    try {
      entities = CADCORE.parseDXF(text);
    } catch (error) {
      setMessage(`<strong>DXF parse error.</strong><br>DXF解析エラー: ${escapeHtml(error.message)}`);
      return;
    }
    if (!entities.length) {
      setMessage('<strong>The drawing contains no entities.</strong><br>図面のENTITIESセクションに要素がありません。');
      return;
    }
    state.fileName = fileName || 'drawing.dxf';
    state.convertedText = importDetails && importDetails.sourceFormat === 'DWG' ? text : null;
    state.inspection = inspection;
    state.entities = entities;
    state.nativeScene = DXFLAYERS.read(text);
    state.nativeVisible = new Set(state.nativeScene.layers.filter(DXFLAYERS.hasContent).map(l => l.name));
    $('native-search').value = '';
    $('native-fit-mode').value = 'area';
    $('native-show-text').checked = true;
    resetNativeView();
    renderNativeLayerList();
    state.result = null;
    clearPreparedDownload();
    state.layers = CADCORE.summarizeLayers(entities);
    state.decisions = {};
    state.selectedId = null;
    state.inspectedLayer = null;
    state.paramsDirty = false;
    state.viewScope = 'main';
    ['kframe-length', 'pair-min', 'pair-max'].forEach(id => {
      $(id).value = $(id).defaultValue;
      $(id).closest('label').querySelector('em').textContent = inspection.unitsCode === 4 ? 'mm' : 'units / 図面単位';
    });
    $('require-pair').checked = $('require-pair').defaultChecked;
    resetView();
    $('step-file').innerHTML = `${escapeHtml(state.fileName)}<br><span>アップロード済み</span>`;
    $('empty-state').hidden = true;
    $('detect-button').disabled = false;
    $('export-json').disabled = false;
    $('export-dxf').disabled = false;
    analyze(false);
    if (state.result.regions.length) {
      changeScope([...state.result.regions].sort((a, b) => b.wallCount - a.wallCount)[0].id);
    }
    $('export-converted').disabled = !state.convertedText;
    setImportBusy(false);
    setStep(2);
  }

  function drawingFileKind(fileName) {
    const name = String(fileName || '');
    if (/\.dwg$/i.test(name)) return 'dwg';
    if (/\.dxf$/i.test(name)) return 'dxf';
    return '';
  }

  async function handleFile(file) {
    if (!file || state.loading) return;
    setStep(1);
    setImportBusy(true);
    const version = ++state.loadVersion;
    if (state.importWorker) state.importWorker.terminate();
    state.importWorker = null;
    setMessage('<strong>Reading drawing locally…</strong><br>図面をローカルで読み込んでいます…', 'info');
    try {
      const fileKind = drawingFileKind(file.name);
      if (/\.pdf$/i.test(file.name)) throw new Error('PDF wall recognition is not implemented yet. Use the original CAD DXF or DWG; renaming a PDF does not convert it. / PDFの壁認識は未実装です。元のCADのDXF・DWGを使用してください。拡張子の変更では変換できません。');
      if (!fileKind) throw new Error('Choose a DXF or DWG file. Other file types are not supported. / DXFまたはDWGファイルを選択してください。その他の形式には対応していません。');
      if (fileKind === 'dwg') {
        if (location.protocol === 'file:') throw new Error('DWG needs the local HTTP website, not a file:// page.');
        const buffer = await file.arrayBuffer();
        if (version !== state.loadVersion) return;
        const header = new TextDecoder('ascii').decode(buffer.slice(0, 6));
        if (!/^AC\d{4}$/.test(header)) throw new Error('The file does not have a recognized DWG header.');
        setMessage('<strong>Converting DWG on this device…</strong><br>DWGをこの端末内で変換しています。ファイルは外部へ送信されません。', 'info');
        const worker = new Worker('./dwg-worker.js?v=20260925-release-1', { type: 'module' });
        state.importWorker = worker;
        const converted = await new Promise((resolve, reject) => {
          state.rejectImport = reject;
          worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
          worker.onerror = event => reject(new Error(event.message || 'Local DWG converter could not start.'));
          worker.postMessage({ buffer }, [buffer]);
        });
        worker.terminate();
        if (version !== state.loadVersion) return;
        state.importWorker = null;
        loadText(converted.text, file.name, { sourceFormat: 'DWG', version: header,
          converter: converted.converter, warningCount: converted.warningCount, warnings: converted.warnings,
          textRecovery: converted.textRecovery, encoding: converted.encoding, warningDetails: converted.warningDetails });
      } else {
        const text = await file.text();
        if (version === state.loadVersion) loadText(text, file.name);
      }
    } catch (error) {
      if (version !== state.loadVersion) return;
      if (state.importWorker) state.importWorker.terminate();
      state.importWorker = null;
      setMessage(`<strong>Could not import this drawing.</strong><br>${escapeHtml(error.message)}<br>読み込みに失敗しました。DWGの場合はCADからASCII DXFとして保存して再度開いてください。`);
    } finally {
      if (version === state.loadVersion) { state.rejectImport = null; setImportBusy(false); }
    }
  }

  async function loadProvidedDrawing(key) {
    const sources = window.CAD_LOCAL_EXAMPLES || {};
    if (state.loading || !Object.prototype.hasOwnProperty.call(sources, key)) return;
    const source = sources[key];
    setStep(1);
    setImportBusy(true);
    const version = ++state.loadVersion;
    const abort = new AbortController();
    state.importAbort = abort;
    setMessage('<strong>Opening your provided drawing from this local website…</strong><br>提供された図面をこのローカルサイトから読み込んでいます。', 'info');
    try {
      const response = await fetch(source[0], { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('Local drawing copy is unavailable; use Open DWG / DXF.');
      const blob = await response.blob();
      if (version === state.loadVersion) {
        state.importAbort = null;
        setImportBusy(false);
        await handleFile(new File([blob], source[1]));
      }
    } catch (error) {
      if (version === state.loadVersion) setMessage(`${escapeHtml(error.message)}<br>「図面を開く」から元ファイルを選んでください。`);
    } finally {
      if (version === state.loadVersion) { state.importAbort = null; setImportBusy(false); }
    }
  }

  function textRecoveryNote(recovery) {
    if (!recovery || recovery.status === 'unavailable') return 'Original TEXT verification unavailable. / 元のTEXTとの照合はできませんでした。';
    const checked = Number(recovery.checkedCount) || 0;
    const repaired = Number(recovery.repairedCount) || 0;
    const skipped = Number(recovery.skippedCount) || 0;
    const summary = checked
      ? `${checked} TEXT values checked against the DWG; ${repaired} TEXT values restored from the original. / DWG原本とTEXT ${checked}件を照合し、${repaired}件を復元しました。`
      : 'No TEXT values could be checked. / 照合できるTEXTがありませんでした。';
    return `${summary}${skipped ? ` ${skipped} source TEXT value(s) not checked. / 原本のTEXT ${skipped}件は未照合です。` : ''} Other text types and advanced entities are not verified. Converter warnings are retained. / 他の文字種・高度な要素は未検証です。変換警告は保持しています。`;
  }

  function updateViewOptions() {
    const regions = state.result.regions || [];
    $('drawing-scope').hidden = false;
    $('view-scope').innerHTML = '<option value="main">Main drawing / 主図面</option>'
      + regions.map((region, index) => `<option value="${region.id}">Area ${index + 1} / 領域 ${index + 1} · ${coverageSummary(state.result,region.extents).visibleWalls} wall references</option>`).join('')
      + '<option value="all">Whole drawing — all walls / 全図の壁</option>';
    if (!['main', 'all', ...regions.map(region => region.id)].includes(state.viewScope)) state.viewScope = 'main';
    $('view-scope').value = state.viewScope;
    const remote = state.result.viewAssessment.remoteSegmentCount;
    $('export-scope').innerHTML=$('view-scope').innerHTML;
    $('export-scope').value=state.viewScope;
    $('view-note').textContent = `${regions.length} geometric area(s), not verified floors. The wall table, TXT, JSON and images follow this area. ${remote} remote source line(s) excluded from main fit. / 形状領域 ${regions.length}件（階名は未判定）。壁一覧・TXT・JSON・画像はこの範囲に連動します。主図面の表示から遠方の原線${remote}本を除外しています。`;
    const details = state.inspection.importDetails;
    $('import-summary').textContent = details && details.sourceFormat === 'DWG'
      ? `DWG converted locally · ${details.warningCount} warning(s) · scale unverified / ローカル変換・警告 ${details.warningCount}件・実寸倍率未確認`
      : 'Physical scale unverified — import notes / 実寸倍率未確認・読込の注意';
    const importNote = details && details.sourceFormat === 'DWG'
      ? `DWG converted locally with ${escapeHtml(details.converter)}. ${Number(details.warningCount) || 0} converter warning(s); advanced entities and text may differ.<br>DWGを端末内で変換しました。警告 ${Number(details.warningCount) || 0}件。文字や高度な要素が欠落・変化する場合があります。<p>${escapeHtml(textRecoveryNote(details.textRecovery))}</p>` : '';
    $('import-note').innerHTML = `${importNote}<p>Coordinates are preserved. Header units do not prove physical scale: dimension text may use a different scale. Wall scores do not establish load-bearing capacity or approve K-frame installation.<br>座標は変更していません。ヘッダー単位だけでは実寸倍率を保証できません。寸法文字との倍率に注意してください。壁の判定は耐力・K型フレーム設置可否の判定ではありません。</p>${details && details.warnings && details.warnings.length ? `<details><summary>Conversion warnings / 変換の警告</summary><pre>${escapeHtml(details.warnings.join('\n'))}</pre></details>` : ''}`;
  }

  function activeBounds() {
    if (state.viewLayer) return layerExtents(state.viewLayer);
    return scopeBounds();
  }

  function scopeBounds() {
    if (state.viewScope === 'all') return state.result.viewAssessment.fullExtents;
    const region = state.result.regions.find(item => item.id === state.viewScope);
    return region ? region.extents : state.result.extents;
  }

  function cleanWallSegments(result) {
    const value=result || state.result;
    return value?.wallOutputSegments || value?.wallReferences || value?.wallCenterlines || [];
  }

  function recognizedWallLayerNames(result) {
    const value=result || state.result;
    return [...new Set(value?.wallBoundaryLayers || value?.selectedWallLayers || [])];
  }

  function isRecognizedWallLayer(layerName,result) {
    return recognizedWallLayerNames(result).includes(layerName);
  }

  function nativeLayerDisplayColor(layer) {
    return isRecognizedWallLayer(layer.name) ? WALL_SOURCE_COLOR : layer.color;
  }

  function recognizedWallSegments(result) {
    const value=result || state.result;
    if(!value)return [];
    if(value.wallBoundarySegments)return value.wallBoundarySegments;
    const layers=new Set(recognizedWallLayerNames(value));
    return (value.originalSegs || []).filter(segment=>layers.has(segment.layer));
  }

  function updateInfo() {
    if (!state.result) return;
    const ext = state.result.extents;
    $('drawing-info').innerHTML = `
      <div><dt>File / ファイル</dt><dd>${escapeHtml(state.fileName)}</dd></div>
      <div><dt>Format / 形式</dt><dd>${state.convertedText ? 'DWG → local ASCII DXF' : 'ASCII DXF'}</dd></div>
      <div><dt>Units / 単位</dt><dd>${escapeHtml(state.inspection.unitsLabel)}${state.inspection.unitsCode !== 4 ? ' (relative mode / 相対)' : ''}</dd></div>
      <div><dt>Range / 図面範囲</dt><dd>${formatNumber(ext.w)} × ${formatNumber(ext.h)}</dd></div>
      <div><dt>Wall outlines / 壁輪郭線</dt><dd>${(state.result.wallBoundarySegments || []).length}</dd></div>
      <div><dt>Wall centerlines / 壁中心線</dt><dd>${state.result.wallCenterlines.length}</dd></div>
      <div><dt>Short omissions / 短壁省略</dt><dd>${state.result.wallCoverage?.omitted?.length || 0}</dd></div>
      <div><dt>PS review / PS確認</dt><dd>${state.result.psReview?.markers?.length || 0} marker(s) · ${escapeHtml(state.result.psReview?.status || 'not-found')}</dd></div>
      <div><dt>Structural model / 構造モデル</dt><dd>Not verified / 未確認</dd></div>`;
    const layers = state.result.layerAnalysis ? state.result.layerAnalysis.layers : [];
    if (!state.inspectedLayer || !layers.some(layer => layer.name === state.inspectedLayer)) {
      state.inspectedLayer = (layers.find(layer => layer.selected) || layers[0] || {}).name || null;
    }
    renderLayerAnalysis();
  }

  function renderLayerAnalysis() {
    if (!state.result || !state.result.layerAnalysis) return;
    const analysis = state.result.layerAnalysis;
    const layers = [...(analysis.layers || [])].sort((a, b) => Number(b.selected) - Number(a.selected) || b.confidence - a.confidence);
    const selected = layers.filter(layer => layer.selected);
    const recognizedNames=recognizedWallLayerNames();
    const recognizedSet=new Set(recognizedNames);
    const report = $('layer-ai-report');
    if (selected.length) {
      const names = selected.map(layer => layer.name).join(', ');
      const confidence = Math.min(...selected.map(layer => layer.confidence));
      const evidence = [...new Set(selected.flatMap(layer => layer.evidence))].map(reasonCopy);
      const relative = selected.some(layer => layer.features.unitMode === 'relative');
      const walls = state.result.wallReferences || state.result.wallCenterlines;
      const wallBoundaries = state.result.wallBoundarySegments || [];
      const wallBoundaryNames = recognizedNames;
      const horizontal = walls.filter(wall => Math.abs(wall.y2 - wall.y1) <= wall.length * 0.087).length;
      const vertical = walls.filter(wall => Math.abs(wall.x2 - wall.x1) <= wall.length * 0.087).length;
      const counts = `${wallBoundaries.length} source wall-outline segments across ${wallBoundaryNames.length} Layers · ${walls.length} wall references · ${horizontal} horizontal · ${vertical} vertical / 壁輪郭線 ${wallBoundaries.length}本（${wallBoundaryNames.length}レイヤー）・壁基準線 ${walls.length}本・水平 ${horizontal}本・垂直 ${vertical}本`;
      report.classList.remove('unsupported');
      report.innerHTML = `<strong>Automatically selected for centerline extraction: ${escapeHtml(names)} · ${confidence}/100</strong><span>壁芯抽出の自動選択レイヤー：${escapeHtml(names)} · 根拠スコア ${confidence}/100${relative ? ' · Relative scale / 相対尺度' : ''}</span><p>Why: ${evidence.map(item => escapeHtml(item.en)).join('; ')}.<br>選択理由：${evidence.map(item => escapeHtml(item.ja)).join('・')}。</p><span>${counts} · Wall threshold / 壁判定しきい値 ${analysis.minimumWallConfidence}/100</span><span>Red wall outlines include the primary Layer and geometrically verified companion wall Layers: ${escapeHtml(wallBoundaryNames.join(', '))}. Blue references remain distinct from source outlines.<br>赤い壁輪郭線には主レイヤーと形状で確認した補助壁レイヤー（${escapeHtml(wallBoundaryNames.join(', '))}）を含みます。青の壁基準線とは区別して表示します。</span>`;
    } else {
      const reason = selectionReasonCopy(analysis.reasonCode);
      report.classList.add('unsupported');
      report.innerHTML = `<strong>No reliable wall layer · ${escapeHtml(reason.en)}</strong><span>信頼できる壁レイヤーなし · ${escapeHtml(reason.ja)}</span>`;
    }

    $('show-selected-layer').disabled = !selected.length;
    $('layer-list-count').textContent = `${layers.length} Layers described · ${recognizedNames.length} recognized wall sources (${selected.length} primary) / ${layers.length} レイヤーを説明・有効な壁源${recognizedNames.length}層（主抽出${selected.length}層）`;
    renderWallCoverage();
    $('layer-table').innerHTML = layers.map(layer => {
      const evidence = [...layer.evidence.slice(0, 2), ...layer.risks.slice(0, 1)].map(reasonCopy);
      const description = LAYEREXPLANATIONS.explain(layer, analysis);
      const decision = selectionReasonCopy(layer.selectionReasonCode);
      const confidenceClass = layer.confidence >= 80 ? 'high' : layer.confidence >= 60 ? 'medium' : '';
      const recognized=recognizedSet.has(layer.name);
      const decisionText=layer.selected
        ? '<strong>Primary wall extraction Layer / 主壁抽出レイヤー</strong>'
        : recognized
          ? '<strong>Recognized companion wall source / 形状確認済みの補助壁源レイヤー</strong>'
          : `${escapeHtml(decision.en)}<br>${escapeHtml(decision.ja)}`;
      return `<tr data-layer="${escapeHtml(layer.name)}" data-selected="${layer.selected}" data-wall-source="${recognized}" class="${state.inspectedLayer === layer.name ? 'active' : ''}"><td><strong>${escapeHtml(layer.name)}</strong><br><small>${layer.features.entityCount} entities / 要素</small><button class="layer-view-button" type="button" aria-label="View Layer ${escapeHtml(layer.name)} / レイヤーを表示">View / 表示</button></td><td><strong class="layer-role-text">${escapeHtml(description.role.en)}<br>${escapeHtml(description.role.ja)}</strong><p class="layer-contents">${escapeHtml(description.contents.en)}<br>${escapeHtml(description.contents.ja)}</p><p class="layer-interpretation">${escapeHtml(description.interpretation.en)}<br>${escapeHtml(description.interpretation.ja)}</p></td><td><span class="layer-confidence ${confidenceClass}">${layer.confidence}/100</span><small class="wall-score">Wall score ${layer.roleScores.wall}/100<br>壁の根拠スコア</small></td><td><p class="layer-reason">${evidence.map(item => `${escapeHtml(item.en)}<br><small>${escapeHtml(item.ja)}</small>`).join('<br>') || escapeHtml(description.why.en)}</p><p class="layer-decision">${decisionText}</p></td></tr>`;
    }).join('') || '<tr><td colspan="4">No data / データなし</td></tr>';

    $('layer-table').querySelectorAll('tr[data-layer]').forEach(row => {
      const inspect = () => {
        state.inspectedLayer = row.dataset.layer;
        if (state.viewLayer) { resetView(); state.viewLayer = state.inspectedLayer; }
        renderLayerAnalysis();
        draw();
        $('inspected-layer-label').scrollIntoView({ block: 'start' });
      };
      row.addEventListener('click', inspect);
    });
    renderLayerDetail(layers.find(layer => layer.name === state.inspectedLayer));
  }

  function renderLayerDetail(layer) {
    const detail = $('layer-detail');
    if (!layer) {
      detail.dataset.activeLayer = '';
      detail.innerHTML = '<strong>No Layer selected.</strong><span>レイヤー未選択</span>';
      return;
    }
    const description = LAYEREXPLANATIONS.explain(layer, state.result.layerAnalysis);
    detail.dataset.activeLayer = layer.name;
    const decision = selectionReasonCopy(layer.selectionReasonCode);
    const recognized=isRecognizedWallLayer(layer.name);
    const layerStatus=layer.selected
      ? 'primary wall extraction Layer / 主壁抽出レイヤー'
      : recognized
        ? 'recognized companion wall source / 形状確認済みの補助壁源レイヤー'
        : 'inspection only — excluded from wall output / 確認表示のみ・壁出力対象外';
    const decisionText=recognized&&!layer.selected
      ? 'Its geometry directly supports wall pairs from the primary Layer, so it is included in every red wall-source view and wall-source export.<br>主レイヤーの壁対を直接支える形状のため、赤い壁源表示と壁源出力に含めます。'
      : `${escapeHtml(decision.en)}<br>${escapeHtml(decision.ja)}`;
    $('inspected-layer-label').textContent = `Now highlighted: ${layer.name} · ${layerStatus}`;
    detail.innerHTML = `<h3>Why ${escapeHtml(layer.name)}? / このレイヤーをどう判断した？</h3><p><strong>${escapeHtml(description.role.en)} / ${escapeHtml(description.role.ja)}</strong></p><p>${escapeHtml(description.contents.en)}<br>${escapeHtml(description.contents.ja)}</p><p>${escapeHtml(description.interpretation.en)}<br>${escapeHtml(description.interpretation.ja)}</p><p class="layer-decision">${decisionText}</p><dl class="explanation-factors">${description.evidence.map(item => `<div><dt>${escapeHtml(item.label[0])}<br>${escapeHtml(item.label[1])}</dt><dd>${escapeHtml(item.en)}<br>${escapeHtml(item.ja)}</dd></div>`).join('')}</dl><p class="layer-preview-note">Red shows every recognized wall-source Layer. Cyan is reserved for an inspected non-wall Layer; gray is other geometry.<br>赤＝認識済みの全壁源レイヤー、水色＝確認中の非壁レイヤー、灰色＝その他です。</p><button id="focus-layer" type="button">Open large Layer view / レイヤーを大きく表示</button>`;
    $('focus-layer').addEventListener('click', () => {
      $('viewer-details').open = true;
      resetView(); state.viewLayer = layer.name; draw();
      $('canvas-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function renderReview() {
    if (!state.result) return;
    const walls = state.result.wallReferences || state.result.wallCenterlines;
    const cleanWalls = cleanWallSegments();
    const junctions = cleanWalls.filter(segment => segment.outputRole === 'junction-connector').length;
    const candidates = state.result.placementCandidates;
    const high = candidates.filter(candidate => candidate.level === 'high').length;
    const output=occupancyData(), outputCount=output.wallLines.length, intervalCount=output.walls.length;
    const connectorCount=output.quality.junctionConnectorCount || 0;
    const sourceLayers=recognizedWallLayerNames();
    $('review-count').textContent = String(outputCount);
    $('export-file-name').textContent = `${baseName(state.fileName)} — wall positions / 壁配置`;
    $('export-summary').textContent = outputCount
      ? `${scopeLabel()} · ${outputCount} blue wall lines (${intervalCount} reference intervals + ${connectorCount} source-supported connectors). JSON keeps their direct start/end coordinates and excludes red source outlines. / 青い壁線 ${outputCount}本（基準区間 ${intervalCount}・原線根拠の接続 ${connectorCount}）。JSONは各線の始点・終点座標を保持し、赤い元輪郭線を含みません。`
      : 'No reliable walls were extracted. You can still export the explanation JSON. / 信頼できる壁を抽出できませんでした。説明JSONは出力できます。';
    const unresolved=output.quality.unresolvedIntervalCount;
    $('export-coverage-note').textContent = !outputCount
      ? 'Wall extraction did not produce a usable result. An empty export does not mean there are no walls. / 壁の抽出を完了できませんでした。空の出力は「壁がない」という意味ではありません。'
      : unresolved
      ? `${output.quality.continuityJoinCount} source-supported reconnections. Raw paired-edge diagnostics retain ${unresolved} unmatched fragments before reconstruction; some support the simplified references. This is not a missing-wall count or a complete wall inventory. / 原線に基づく接続${output.quality.continuityJoinCount}か所。統合前の配対未成立の原線は${unresolved}区間で、一部は基準線統合の根拠です。未検出の壁の数ではなく、網羅性も未確認です。`
      : unresolved===null ? 'Coverage is unknown; this is not a verified wall inventory. / 網羅性は不明です。確認済みの壁一覧ではありません。'
      : 'No unmatched source intervals in this area. Semantic or structural accuracy is not verified. / この範囲に未対応の原線区間はありませんが、意味・構造上の正確性は未確認です。';
    renderOccupancySummary();
    renderPositionTable();
    const wallBoundaries=state.result.wallBoundarySegments || [];
    const unresolvedCount=state.result.wallCoverage?.unresolved?.length||0;
    const equipmentOutlineCount=state.result.equipmentReview?.outlines?.length||0;
    $('review-summary').innerHTML = `<strong>${candidates.length} placement candidates · review required</strong><span>配置候補 ${candidates.length}件 · 高評価 ${high}件 · 壁輪郭線 ${wallBoundaries.length}本 · 壁中心線 ${walls.length}件 · 未確定 ${unresolvedCount}区間 · 設備外形の除外 ${equipmentOutlineCount}件 · 構造モデル未検証</span>`;
    $('existing-brace-count').textContent = state.result.existingKBraces.length
      ? `${state.result.existingKBraces.length} existing K-shaped brace assembly detected. / 既存K型筋違 ${state.result.existingKBraces.length}件を補助検出。`
      : 'No existing K-shaped brace detected. / 既存K型筋違は未検出です。';
    $('stage-original-meta').textContent = `${state.result.stats.entities} source entities / 原図要素 ${state.result.stats.entities}`;
    $('stage-walls-meta').textContent = `${wallBoundaries.length} wall-outline segments · ${walls.length} wall references / 壁輪郭線 ${wallBoundaries.length}・壁基準線 ${walls.length}`;
    $('stage-candidates-meta').textContent = `${candidates.length} candidates · ${high} high / 候補 ${candidates.length}件`;
    $('stage-clean-meta').textContent = `WALL ${cleanWalls.length} · ${junctions} source-supported joins / 壁線 ${cleanWalls.length}・原線根拠の接続 ${junctions}`;
    $('candidate-list').innerHTML = candidates.map(candidateCard).join('') || '<p>No placement candidates / 配置候補なし</p>';
    $('candidate-list').querySelectorAll('.candidate').forEach(card => card.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      state.selectedId = card.dataset.id;
      const selected = state.result.placementCandidates.find(item => item.id === state.selectedId);
      if (selected) {
        const region = state.result.regions.find(item => inBounds(selected, item.extents));
        if (region) changeScope(region.id);
      }
      $('viewer-details').open = true;
      renderReview();
      draw();
      $('canvas-wrap').scrollIntoView({ block: 'center' });
    }));
  }

  function candidateCard(candidate) {
    const reasons = candidate.reasons.map(reason => `<span>✓ ${escapeHtml(reason)}</span>`).join('');
    const warnings = candidate.warnings.map(warning => `<span class="warning">△ ${escapeHtml(warning)}</span>`).join('');
    return `<article class="candidate${state.selectedId === candidate.id ? ' selected' : ''}" data-id="${candidate.id}">
      <div class="candidate-top"><div class="candidate-title"><strong>K-frame placement candidate</strong><span>K型フレーム配置候補</span></div><span class="confidence">${candidate.score}/100</span></div>
      <div class="candidate-meta"><span>Clear span ${formatNumber(candidate.clearSpan)}</span><span class="level ${candidate.level}">${candidate.level}</span></div>
      <div class="candidate-reasons">${reasons}${warnings}</div>
    </article>`;
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function resizeCanvasElement(target) {
    const rect = target.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
    }
  }

  function fittedTransform(target, padding, bounds) {
    const ratio = window.devicePixelRatio || 1;
    const ext = bounds || activeBounds();
    const pad = (padding || 18) * ratio;
    const scale = Math.min((target.width - pad * 2) / (ext.w || 1), (target.height - pad * 2) / (ext.h || 1));
    const ox = (target.width - ext.w * scale) / 2;
    const oy = (target.height - ext.h * scale) / 2;
    return {
      x: value => ox + (value - ext.minx) * scale,
      y: value => target.height - (oy + (value - ext.miny) * scale),
    };
  }

  function drawSegmentsOn(target, context, segments, color, width, alpha, dash, bounds) {
    if (!segments || !segments.length || !target.clientWidth || !target.clientHeight) return;
    const transform = fittedTransform(target, 15, bounds);
    const ratio = window.devicePixelRatio || 1;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = width * ratio;
    context.globalAlpha = alpha == null ? 1 : alpha;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.setLineDash((dash || []).map(value => value * ratio));
    context.beginPath();
    for (const segment of segments) {
      context.moveTo(transform.x(segment.x1), transform.y(segment.y1));
      context.lineTo(transform.x(segment.x2), transform.y(segment.y2));
    }
    context.stroke();
    context.restore();
  }

  function drawPipeline() {
    const section = document.querySelector('.pipeline-section');
    if (!section.getClientRects().length) return;
    section.classList.toggle('has-drawing', !!state.result);
    section.classList.toggle('unsupported-drawing', !!(state.result && state.result.drawingAssessment && !state.result.drawingAssessment.supported));
    Object.values(stageCanvases).forEach(target => {
      resizeCanvasElement(target);
      target.getContext('2d').clearRect(0, 0, target.width, target.height);
    });
    if (!state.result) return;
    const visibleCandidates = state.result.placementCandidates.filter(candidate => inBounds(candidate, activeBounds()));
    const featuredCandidates = visibleCandidates
      .filter(candidate => candidate.level === 'high' && candidate.clearSpan <= 6000)
      .slice(0, 6);
    const highlightedCandidates = featuredCandidates.length
      ? featuredCandidates
      : visibleCandidates.slice(0, 6);

    const originalCtx = stageCanvases.original.getContext('2d');
    drawSegmentsOn(stageCanvases.original, originalCtx, state.result.originalSegs, '#6f7a8e', 1.15, 0.72);
    drawSegmentsOn(stageCanvases.original, originalCtx, state.result.removedSegs, '#9ca6b6', 1, 0.56);

    const wallsCtx = stageCanvases.walls.getContext('2d');
    drawSegmentsOn(stageCanvases.walls, wallsCtx, state.result.originalSegs, '#cbd3df', 0.85, 0.38);
    drawSegmentsOn(stageCanvases.walls, wallsCtx, recognizedWallSegments(), '#ffb3ad', 5.6, 0.42);
    drawSegmentsOn(stageCanvases.walls, wallsCtx, recognizedWallSegments(), '#d92d20', 1.35, 0.96);
    drawSegmentsOn(stageCanvases.walls, wallsCtx, cleanWallSegments(), '#176fe6', 2.35, 0.98);

    const candidatesCtx = stageCanvases.candidates.getContext('2d');
    drawSegmentsOn(stageCanvases.candidates, candidatesCtx, state.result.originalSegs, '#d7dee8', 0.7, 0.26);
    drawSegmentsOn(stageCanvases.candidates, candidatesCtx, recognizedWallSegments(), '#d92d20', 3.5, 0.24);
    drawSegmentsOn(stageCanvases.candidates, candidatesCtx, cleanWallSegments(), '#176fe6', 1.9, 0.95);
    highlightedCandidates.forEach(candidate => {
      const decision = state.decisions[candidate.id] || 'unreviewed';
      const color = decision === 'accepted' ? '#13a77b' : decision === 'rejected' ? '#8b94a3' : '#ee4d5a';
      const dash = decision === 'rejected' || candidate.level === 'low' ? [4, 3] : [];
      drawSegmentsOn(stageCanvases.candidates, candidatesCtx, [candidate], color, 3.2, decision === 'rejected' ? 0.45 : 1, dash);
    });

    const cleanCtx = stageCanvases.clean.getContext('2d');
    drawSegmentsOn(stageCanvases.clean, cleanCtx, cleanWallSegments(), '#176fe6', 2.2, 0.96);
  }

  function drawingTransform() {
    const ratio = window.devicePixelRatio || 1;
    const ext = activeBounds();
    const pad = 36 * ratio;
    const base = Math.min((canvas.width - pad * 2) / (ext.w || 1), (canvas.height - pad * 2) / (ext.h || 1));
    const scale = base * state.zoom;
    const ox = (canvas.width - ext.w * scale) / 2 + state.panX * ratio;
    const oy = (canvas.height - ext.h * scale) / 2 + state.panY * ratio;
    return { x: value => ox + (value - ext.minx) * scale, y: value => canvas.height - (oy + (value - ext.miny) * scale) };
  }

  function inBounds(segment, bounds) {
    const x = (segment.x1 + segment.x2) / 2, y = (segment.y1 + segment.y2) / 2;
    return x >= bounds.minx && x <= bounds.maxx && y >= bounds.miny && y <= bounds.maxy;
  }

  function drawSegments(segments, color, width, alpha, dash) {
    if (!segments || !segments.length) return;
    const transform = drawingTransform();
    const ratio = window.devicePixelRatio || 1;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width * ratio;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.lineCap = 'round';
    ctx.setLineDash((dash || []).map(value => value * ratio));
    ctx.beginPath();
    for (const segment of segments) {
      ctx.moveTo(transform.x(segment.x1), transform.y(segment.y1));
      ctx.lineTo(transform.x(segment.x2), transform.y(segment.y2));
    }
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    if (state.screen < 2) return;
    drawAxisPreview();
    if (state.screen === 3) {
      const target = $('export-preview');
      resizeCanvasElement(target);
      target.getContext('2d').clearRect(0, 0, target.width, target.height);
      if (state.result) drawSegmentsOn(target, target.getContext('2d'), WALLOCCUPANCY.outputSegments(occupancyData()), '#176fe6', 2.2, 1, [], resultBounds());
      return;
    }
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPipeline();
    if (!state.result) return;
    drawNativeLayers();
    drawLayerPreview();
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    if ($('show-original').checked) drawSegments(state.result.originalSegs, '#aeb8c7', 1, 0.62);
    if (state.inspectedLayer && $('show-layer').checked) {
      const inspected = state.result.originalSegs.filter(segment => segment.layer === state.inspectedLayer);
      drawSegments(inspected, '#00a6c8', 3.2, 0.9);
      drawLayerSymbols(ctx, canvas, drawingTransform(), state.inspectedLayer);
    }
    if ($('show-wall').checked) {
      drawSegments(recognizedWallSegments(), '#ffb3ad', 6, 0.42);
      drawSegments(recognizedWallSegments(), '#d92d20', 1.35, 0.96);
      drawSegments(cleanWallSegments(), '#2979ff', 2.2, 0.94);
    }
    if ($('show-kframe').checked) {
      state.result.placementCandidates.forEach(candidate => {
        const decision = state.decisions[candidate.id] || 'unreviewed';
        if (decision === 'accepted') drawSegments([candidate], '#13a77b', 4.2, 1);
        else if (decision === 'rejected') drawSegments([candidate], '#7b8495', 2.4, 0.55, [6, 5]);
        else if (candidate.level === 'low') drawSegments([candidate], '#f55745', 2.2, 0.48, [6, 5]);
        else drawSegments([candidate], '#f55745', 3.5, 0.98);
      });
    }
    if ($('show-existing-braces').checked) {
      state.result.existingKBraces.forEach(frame => {
        drawSegments([frame.columnSegment], '#7a50d6', 2.2, 0.85);
        drawSegments(frame.braceSegments, '#7a50d6', 3, 0.9, [5, 4]);
      });
    }
    if (state.selectedId) {
      const selected = state.result.placementCandidates.find(item => item.id === state.selectedId);
      if (selected) drawSegments([selected], '#071d4a', 5.5, 1);
    }
  }

  function resetView() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.viewLayer = null;
  }

  function layerExtents(name) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const include = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minx = Math.min(minx, x); miny = Math.min(miny, y);
      maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
    };
    for (const segment of state.result.originalSegs) {
      if (segment.layer !== name) continue;
      include(segment.x1, segment.y1); include(segment.x2, segment.y2);
    }
    for (const entity of state.entities) {
      if ((entity.layer || '0') !== name) continue;
      include(entity.cx, entity.cy);
      if (entity.type === 'CIRCLE' && Number.isFinite(entity.r)) {
        include(entity.cx - entity.r, entity.cy - entity.r);
        include(entity.cx + entity.r, entity.cy + entity.r);
      }
    }
    if (!Number.isFinite(minx)) return state.result.extents;
    return { minx, miny, maxx, maxy, w: maxx - minx || 1, h: maxy - miny || 1 };
  }

  function resetNativeView() {
    state.nativeZoom = 1; state.nativePanX = 0; state.nativePanY = 0;
  }

  function renderNativeLayerList() {
    const scene = state.nativeScene;
    if (!scene) return;
    const populated = scene.layers.filter(DXFLAYERS.hasContent).length;
    $('native-layer-count').textContent = `${populated} populated layers · ${scene.layers.length - populated} empty · ${scene.sourceEntityCount.toLocaleString()} source objects / 有効 ${populated}層・空 ${scene.layers.length - populated}層・原図 ${scene.sourceEntityCount.toLocaleString()}要素`;
    const query = $('native-search').value.trim().toLocaleLowerCase();
    $('native-layer-list').innerHTML = scene.layers.filter(l => l.name.toLocaleLowerCase().includes(query)).map(l => {
      const enabled = DXFLAYERS.hasContent(l), checked = state.nativeVisible.has(l.name);
      const omitted = Object.values(l.omitted).reduce((a,b) => a+b,0);
      const recognized = isRecognizedWallLayer(l.name), color = nativeLayerDisplayColor(l);
      return `<div class="native-layer-row" data-native-layer="${escapeHtml(l.name)}" data-visible="${checked}" data-wall-source="${recognized}"><label><input type="checkbox" ${checked ? 'checked' : ''} ${enabled ? '' : 'disabled'} aria-label="Show layer ${escapeHtml(l.name)} / レイヤー表示"><span class="native-swatch" style="--layer-color:${color}" aria-hidden="true"></span><span><strong>${escapeHtml(l.name)}</strong><small>${l.entityCount.toLocaleString()} objects / 原図要素<br>${l.primitives.length.toLocaleString()} display shapes / 表示形状${omitted ? `<br>${omitted} omitted / 未対応` : ''}</small></span></label><button type="button" ${enabled ? '' : 'disabled'} aria-label="Only layer ${escapeHtml(l.name)} / この層だけ">Only / 単独</button></div>`;
    }).join('') || '<p>No matching layer. Clear the search to see all layers.<br>一致するレイヤーがありません。検索を消すと全層を表示します。</p>';
  }

  function updateNativeVisibility() {
    document.querySelectorAll('[data-native-layer]').forEach(row => {
      const checked = state.nativeVisible.has(row.dataset.nativeLayer);
      row.dataset.visible = String(checked);
      row.querySelector('input').checked = checked;
    });
    resetNativeView();
    drawNativeLayers();
  }

  function drawNativeLayers() {
    if (!state.nativeScene || state.screen !== 2) return;
    const target = $('native-layer-canvas');
    if (!target.clientWidth || !target.clientHeight) return;
    resizeCanvasElement(target);
    const context = target.getContext('2d'), ratio = window.devicePixelRatio || 1;
    context.clearRect(0,0,target.width,target.height);
    const layers = state.nativeScene.layers.filter(l => state.nativeVisible.has(l.name));
    const shapes = layers.flatMap(l => l.primitives), mode = $('native-fit-mode').value;
    const bounds = (mode === 'area' && state.result ? scopeBounds() : mode === 'all' ? state.nativeScene.bounds : DXFLAYERS.bounds(shapes)) || state.nativeScene.bounds;
    const omitted = layers.flatMap(l => Object.entries(l.omitted).map(([type,count]) => `${l.name}: ${type} × ${count}`));
    $('native-omissions').textContent = omitted.length ? `Not drawn in the selected layers / 表示中レイヤーの未描画要素: ${omitted.join(' · ')}` : 'No unsupported objects in the visible layers. / 表示中のレイヤーに未対応要素はありません。';
    const names = layers.map(l => l.name);
    $('native-visible-summary').textContent = `${names.length} layers visible / 表示 ${names.length}層: ${names.slice(0,6).join(' · ')}${names.length > 6 ? ` … (+${names.length-6})` : ''}`;
    let drawn = 0;
    if (bounds) {
      const fit = fittedTransform(target,24,bounds), zoom = state.nativeZoom;
      const x = v => (fit.x(v)-target.width/2)*zoom+target.width/2+state.nativePanX*ratio;
      const y = v => (fit.y(v)-target.height/2)*zoom+target.height/2+state.nativePanY*ratio;
      const scale = Math.abs(x(bounds.minx+1)-x(bounds.minx));
      context.lineWidth = 1.1*ratio; context.lineJoin = 'round'; context.lineCap = 'round';
      for (const l of layers) {
        const color = nativeLayerDisplayColor(l);
        context.strokeStyle = color; context.fillStyle = color;
        for (const p of l.primitives) {
          if (p.kind === 'path') {
            // Skip offscreen objects without truncating their stored geometry.
            const pts = p.points.map(q => ({x:x(q.x),y:y(q.y)}));
            if (pts.every(q=>q.x<0)||pts.every(q=>q.x>target.width)||pts.every(q=>q.y<0)||pts.every(q=>q.y>target.height)) continue;
            context.beginPath();context.moveTo(pts[0].x,pts[0].y);
            for(let i=1;i<pts.length;i++) context.lineTo(pts[i].x,pts[i].y);
            if(p.closed)context.closePath();if(p.fill)context.fill();else context.stroke();drawn++;
          } else {
            const px=x(p.point.x),py=y(p.point.y);
            if(px<0||py<0||px>target.width||py>target.height)continue;
            if(p.kind==='text') {
              if(!$('native-show-text').checked || p.height*scale<3*ratio)continue;
              context.save();context.translate(px,py);context.rotate(-p.rotation);
              context.font=`${Math.min(150*ratio,p.height*scale)}px sans-serif`;context.textAlign=p.align;
              p.text.split('\n').slice(0,100).forEach((line,i)=>context.fillText(line,0,i*p.height*scale*1.25));context.restore();drawn++;
            } else {context.beginPath();context.arc(px,py,1.5*ratio,0,Math.PI*2);context.fill();drawn++;}
          }
        }
      }
    }
    $('native-empty').hidden = drawn > 0;
    target.dataset.visibleLayers=String(names.length);target.dataset.drawnShapes=String(drawn);
  }

  function drawLayerSymbols(context, target, transform, name) {
    const ratio = window.devicePixelRatio || 1;
    context.save();
    context.strokeStyle = '#008ca9'; context.fillStyle = '#00778f';
    context.lineWidth = 1.5 * ratio;
    context.font = `${11 * ratio}px sans-serif`;
    let textCount = 0;
    for (const entity of state.entities) {
      if ((entity.layer || '0') !== name || !Number.isFinite(entity.cx) || !Number.isFinite(entity.cy)) continue;
      if (['LINE', 'LWPOLYLINE', 'POLYLINE'].includes(entity.type)) continue;
      const x = transform.x(entity.cx), y = transform.y(entity.cy);
      if (x < 0 || y < 0 || x > target.width || y > target.height) continue;
      if (entity.type === 'CIRCLE' && Number.isFinite(entity.r) && entity.r > 0) {
        const radius = Math.abs(transform.x(entity.cx + entity.r) - x);
        context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke();
      } else if (['TEXT', 'MTEXT', 'ATTDEF', 'ATTRIB'].includes(entity.type) && entity.text && textCount < 200) {
        context.fillText(String(entity.text).slice(0, 120), x, y);
        textCount += 1;
      } else {
        context.beginPath();
        context.moveTo(x - 3 * ratio, y); context.lineTo(x + 3 * ratio, y);
        context.moveTo(x, y - 3 * ratio); context.lineTo(x, y + 3 * ratio); context.stroke();
      }
    }
    context.restore();
  }

  function updateAxisModel() {
    const payload=CADCORE.buildAnnotationData(state.fileName,state.inspection,state.result,state.decisions);
    state.semanticModel=CADSEMANTICS.build(payload,state.result.originalSegs,state.entities);
    state.axisId=state.semanticModel.axes[0]?.id || null;
    $('axis-select').innerHTML=state.semanticModel.axes.map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.gridReference?.name||a.id)} · ${escapeHtml(a.id)} · ${formatMeasurement(a.length)} · ${escapeHtml(a.sourceLayers.join(', '))}</option>`).join('');
    $('axis-select').disabled=!state.semanticModel.axes.length;
    $('axis-count').textContent=`${state.semanticModel.axes.length} candidate reference axes / 基準軸候補 ${state.semanticModel.axes.length}本`;
    const grids=state.semanticModel.gridReferences;
    $('grid-summary').textContent=grids
      ? `Source grid matches: ${grids.observed.length} · Generated auxiliary names: ${grids.generated.length} · Unmatched labels: ${grids.unmatchedLabels.length}. Names are local to each drawing area. SYS names are generated; zero matches does not mean the original drawing has no grids. / 原図の通り芯符号と線の対応：${grids.observed.length}件・生成した補助軸名：${grids.generated.length}件・未対応の符号：${grids.unmatchedLabels.length}件。名称は図面領域ごとに管理します。SYSは生成名です。対応0件でも、原図に通り芯がないとは限りません。`
      : 'Grid-reference data unavailable / 通り芯参照データなし';
    renderAxisDetail();
  }

  function renderAxisDetail() {
    const model=state.semanticModel,axis=model?.axes.find(a=>a.id===state.axisId);
    const visibleIds=new Set(Object.values(occupancySelection().links));
    const visibleAxes=(model?.axes||[]).filter(a=>visibleIds.has(a.id));
    const index=visibleAxes.indexOf(axis);
    $('axis-select').innerHTML=visibleAxes.map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.gridReference?.name||a.id)} · ${escapeHtml(a.id)}</option>`).join('');
    $('axis-select').disabled=!visibleAxes.length;
    $('axis-prev').disabled=!axis||index===0;
    $('axis-next').disabled=!axis||index===visibleAxes.length-1;
    $('axis-select').value=axis?.id || '';
    $('axis-detail').replaceChildren();$('axis-relations').replaceChildren();
    const add=(target,tag,copy)=>{const node=document.createElement(tag);node.textContent=copy;target.append(node);};
    if(!axis) {
      add($('axis-detail'),'p','No reference axes could be derived from the current extraction. This does not prove that walls are absent. / 現在の抽出結果から基準軸を作成できません。壁がないという意味ではありません。');
    } else {
      const description=CADSEMANTICS.describeAxis(axis,model);
      add($('axis-detail'),'h3',`${axis.gridReference?.name||axis.id} · ${axis.id} · ${axis.wallId}`);
      add($('axis-detail'),'p',description.ja);add($('axis-detail'),'p',description.en);
      add($('axis-detail'),'p',`Evidence score / 根拠スコア: ${axis.confidence.value===null?'Unknown / 不明':Math.round(axis.confidence.value*100)+'/100'} · Uncalibrated, not accuracy / 未校正・正解率ではありません`);
      if(axis.warnings.length) add($('axis-detail'),'p',`Cautions / 注意: ${axis.warnings.join('; ')}`);
      const relations=CADSEMANTICS.relationsForAxis(model,axis);
      const names={'near-endpoint':'Nearby only, not connected / 近接のみ・接続未確定','endpoint-touch':'2D contact / 2D上の接触',intersection:'2D intersection / 2D上の交差',overlap:'Overlapping axes / 軸の重複'};
      for(const r of relations.slice(0,20)) add($('axis-relations'),'li',`${r.axisIds.find(id=>id!==axis.id)}: ${names[r.type]}${r.type==='near-endpoint'?` · gap / 距離 ${formatMeasurement(r.distance)}`:''}`);
      if(!relations.length) add($('axis-relations'),'li',model.relationAnalysis.status==='complete'?'No geometric relationship found within the reported tolerance. / 記録した許容値内の幾何関係は未検出です。':'Relations not evaluated for this large drawing. / 大きな図面のため関係評価を省略しました。');
      if(relations.length>20)add($('axis-relations'),'li','Showing 20 relations; all are in JSON. / 20件表示。全件はJSONに含まれます。');
    }
    $('axis-limit-note').textContent=model?.relationAnalysis.status!=='complete'
      ? 'Drawing-size or relation-count limit reached (2,000 axes / 20,000 relations): some pairs were not evaluated. Every valid axis is exported. / 軸2,000本または関係20,000件の上限により、未評価の組み合わせがあります。全ての有効な軸は出力します。'
      : `Coordinates stay in drawing units; no physical scale or installation span is verified. Proximity tolerance: ${formatMeasurement(model?.relationAnalysis.proximityTolerance)}. / 元の図面座標を保持。実寸・設置可能長は未確認です。近接判定の許容値：${formatMeasurement(model?.relationAnalysis.proximityTolerance)}。`;
    drawAxisPreview();
  }

  function drawAxisPreview() {
    const target=$('axis-canvas');if(!target?.getClientRects().length)return;
    resizeCanvasElement(target);const context=target.getContext('2d');context.clearRect(0,0,target.width,target.height);
    const a=state.semanticModel?.axes.find(axis=>axis.id===state.axisId);if(!a)return;
    const margin=Math.max(a.length*0.2,(a.thickness||0)*3,1);
    const bounds={minx:Math.min(a.start.x,a.end.x)-margin,miny:Math.min(a.start.y,a.end.y)-margin,
      maxx:Math.max(a.start.x,a.end.x)+margin,maxy:Math.max(a.start.y,a.end.y)+margin};
    const referenceIds=new Set((a.gridReference?.offsets||[]).map(o=>o.gridId));
    const grids=(state.semanticModel.gridReferences?.observed||[]).filter(g=>referenceIds.has(g.id));
    for(const g of grids) {
      if(g.orientation==='vertical'){bounds.minx=Math.min(bounds.minx,g.coordinate-margin);bounds.maxx=Math.max(bounds.maxx,g.coordinate+margin);}
      else {bounds.miny=Math.min(bounds.miny,g.coordinate-margin);bounds.maxy=Math.max(bounds.maxy,g.coordinate+margin);}
    }
    bounds.w=bounds.maxx-bounds.minx;bounds.h=bounds.maxy-bounds.miny;
    drawSegmentsOn(target,context,state.result.wallReferences || state.result.wallCenterlines,'#b7c0ce',1.1,0.65,[],bounds);
    for(const g of grids)drawSegmentsOn(target,context,g.sourceGeometry.map(s=>s.geometry),'#75608a',1.3,1,[3,6],bounds);
    const sources=state.result.originalSegs.filter(s=>a.sourceSegmentIds.includes(s.id)||(a.supportingSourceSegmentIds||[]).includes(s.id));
    drawSegmentsOn(target,context,sources,'#008ca9',1.6,0.95,[],bounds);
    drawSegmentsOn(target,context,[{x1:a.start.x,y1:a.start.y,x2:a.end.x,y2:a.end.y}],'#176fe6',3.5,1,[],bounds);
    drawSegmentsOn(target,context,[{x1:a.start.x,y1:a.start.y,x2:a.end.x,y2:a.end.y}],'#242422',1.4,1,[7,5],bounds);
    const transform=fittedTransform(target,15,bounds),ratio=window.devicePixelRatio||1;
    context.save();context.fillStyle='#242422';context.font=`${14*ratio}px sans-serif`;
    context.fillText(`${a.gridReference?.name||a.id} · ${a.id} · 壁候補 / Wall candidate`,15*ratio,24*ratio);
    for(const [label,p] of [['A',a.start],['B',a.end]]) context.fillText(label,transform.x(p.x)+7*ratio,transform.y(p.y)-8*ratio);
    context.fillStyle='#75608a';
    for(const g of grids) {
      const along=g.orientation==='vertical'?(a.start.y+a.end.y)/2:(a.start.x+a.end.x)/2;
      const x=g.orientation==='vertical'?g.coordinate:along,y=g.orientation==='vertical'?along:g.coordinate;
      const labelY=transform.y(y);
      context.fillText(g.name,transform.x(x)+8*ratio,labelY+(labelY<60*ratio?18:-10)*ratio);
    }
    context.restore();
  }

  function coverageSummary(result,bounds) {
    const walls=result.wallReferences || result.wallCenterlines || [], unresolved=result.wallCoverage?.unresolved || [];
    const omitted=result.wallCoverage?.omitted || [];
    const boundaries=result.wallBoundarySegments || [];
    const visible=CADCORE.segmentsInBounds(walls,bounds),visibleWalls=visible.length;
    const visibleBoundaries=CADCORE.segmentsInBounds(boundaries,bounds).length;
    const visibleJoins=visible.reduce((n,w)=>n+(w.continuity?.gaps?.length||0),0);
    const visibleSingle=visible.filter(w=>w.centerlineBasis==='single-edge-hypothesis').length;
    const visibleUnresolved=CADCORE.segmentsInBounds(unresolved,bounds).length;
    const visibleOmitted=CADCORE.segmentsInBounds(omitted,bounds).length;
    return {visibleWalls,totalWalls:walls.length,visibleBoundaries,totalBoundaries:boundaries.length,visibleJoins,visibleSingle,visibleUnresolved,totalUnresolved:unresolved.length,visibleOmitted,totalOmitted:omitted.length,
      text:`Current area: ${visibleBoundaries} wall-outline segments · ${visibleWalls} wall references · ${visibleJoins} source-supported reconnections. Full drawing: ${boundaries.length} wall-outline segments · ${walls.length} wall references. / 表示領域：壁輪郭線${visibleBoundaries}本・壁基準線${visibleWalls}区間・原線に基づく接続${visibleJoins}か所。全図：壁輪郭線${boundaries.length}本・壁基準線${walls.length}区間。`};
  }

  function renderWallCoverage() {
    if(!state.result)return;
    const unresolved=state.result.wallCoverage?.unresolved || [];
    const omitted=state.result.wallCoverage?.omitted || [];
    const summary=coverageSummary(state.result,scopeBounds());
    $('wall-output-caption').textContent=`Red: ${summary.visibleBoundaries} recognized source wall-outline segments. Blue: ${summary.visibleWalls} wall references, including ${summary.visibleSingle} provisional source-edge references (not verified centers) · ${summary.visibleJoins} source-supported reconnections. / 赤：認識済み壁輪郭線${summary.visibleBoundaries}本。青：壁基準線${summary.visibleWalls}区間（片側原線の暫定基準${summary.visibleSingle}区間・壁芯未確認）・原線に基づく接続${summary.visibleJoins}か所。`;
    const coverageView=$('result-view').value==='coverage';
    $('show-unresolved').disabled=!coverageView;
    $('coverage-status').textContent=summary.visibleUnresolved||summary.visibleOmitted
      ? `Raw paired-edge diagnostics: ${summary.visibleUnresolved} fragments remain without paired-edge confirmation, not ${summary.visibleUnresolved} missing walls. Some support continuous references or provisional source-edge references; they remain uncertain in Source coverage and detailed exports. Completeness is not verified. / 配対診断：原線${summary.visibleUnresolved}区間は両側線の確認が未成立で、未検出の壁の本数ではありません。一部は連続基準線または片側原線の暫定基準として表示します。原線確認・詳細出力にも未確定として保持し、網羅性は未確認です。`
      : 'All selected-layer line intervals are accounted for geometrically; correctness is not certified. / 選択レイヤーの全線区間を形状として処理済みですが、正確性を保証するものではありません。';
    const visible=[...CADCORE.segmentsInBounds(unresolved,scopeBounds()),...CADCORE.segmentsInBounds(omitted,scopeBounds())];
    const reason = line => {
      const detail = LAYEREXPLANATIONS.unresolvedExplanation(line);
      return `${detail.cause.ja} ${detail.remedy.ja} / ${detail.cause.en} ${detail.remedy.en}`;
    };
    $('coverage-reasons').innerHTML=['cross-layer-only','no-compatible-pair','below-main-span'].map(code=>{
      const group=visible.filter(s=>s.reasonCode===code);
      const label=code==='cross-layer-only'?'Parallel lines on other Layers / 他レイヤーに平行線':code==='below-main-span'?'Short/detail intervals requiring evidence / 根拠確認が必要な短線・詳細区間':'Unpaired intervals / 配対未成立';
      return `<li>${label}: <strong>${group.length}</strong></li>`;
    }).join('');
    const examples=[...visible].sort((a,b)=>b.length-a.length).slice(0,12);
    $('coverage-examples').innerHTML=examples.map(line=>`<tr><td>${escapeHtml(line.sourceSegmentId)}<br>${Math.round(line.length)} drawing units / 図面単位</td><td>${escapeHtml(reason(line))}</td></tr>`).join('') || '<tr><td colspan="2">No unresolved intervals in this area. / この領域の未確定区間はありません。</td></tr>';
  }

  function drawLayerPreview() {
    if (!state.inspectedLayer) return;
    const original = $('layer-context-canvas'), clean = $('wall-result-canvas');
    const isTarget = isRecognizedWallLayer(state.inspectedLayer);
    const outputBounds=state.semanticModel ? resultBounds() : scopeBounds();
    const bounds = isTarget ? outputBounds : layerExtents(state.inspectedLayer);
    for (const target of [original, clean]) {
      resizeCanvasElement(target);
      target.getContext('2d').clearRect(0, 0, target.width, target.height);
    }
    const sourceContext = original.getContext('2d');
    drawSegmentsOn(original, sourceContext, state.result.originalSegs, '#b7c0ce', 0.8, 0.5, [], bounds);
    drawSegmentsOn(original, sourceContext, recognizedWallSegments(), '#ffb3ad', 5.2, 0.42, [], bounds);
    drawSegmentsOn(original, sourceContext, recognizedWallSegments(), '#d92d20', 1.35, 0.98, [], bounds);
    if(isTarget)drawSegmentsOn(original,sourceContext,state.result.originalSegs.filter(segment=>segment.layer===state.inspectedLayer),'#9f2018',2.4,1,[],bounds);
    else drawSegmentsOn(original, sourceContext, state.result.originalSegs.filter(segment => segment.layer === state.inspectedLayer), '#008fae', 2.2, 1, [], bounds);
    drawLayerSymbols(sourceContext, original, fittedTransform(original, 15, bounds), state.inspectedLayer);
    // Inspecting annotation/equipment must never crop the independent wall output.
    const lines=state.result.wallOutputSegments || state.result.wallReferences || state.result.wallCenterlines || [];
    drawSegmentsOn(clean, clean.getContext('2d'), recognizedWallSegments(), '#ffb3ad', 5.2, 0.42, [], outputBounds);
    drawSegmentsOn(clean, clean.getContext('2d'), recognizedWallSegments(), '#d92d20', 1.35, 0.98, [], outputBounds);
    drawSegmentsOn(clean, clean.getContext('2d'), lines, '#176fe6', 2.2, 1, [], outputBounds);
    if($('result-view').value==='coverage') {
      drawSegmentsOn(clean, clean.getContext('2d'), state.result.wallCoverage?.boundaryDetails||[], '#176fe6', 0.9, 0.8, [], outputBounds);
      const unresolved=state.result.wallCoverage?.unresolved || [];
      if($('show-unresolved').checked) drawSegmentsOn(clean,clean.getContext('2d'),unresolved,'#986000',1.5,0.95,[5,3],outputBounds);
      const omitted=state.result.wallCoverage?.omitted || [];
      if($('show-unresolved').checked) drawSegmentsOn(clean,clean.getContext('2d'),omitted,'#8a4b00',1.5,0.95,[2,4],outputBounds);
    }
    if(state.semanticModel)drawPositionHighlight(original,clean,bounds,outputBounds);
    renderWallCoverage();
  }

  function download(text, fileName, type) {
    const previousUrl = state.exportUrl;
    const binary = text instanceof Blob;
    const blob = binary ? text : new Blob([text], { type: `${type};charset=utf-8` });
    state.exportUrl = URL.createObjectURL(blob);
    state.exportText = binary ? '' : text;
    const link = $('download-link');
    link.href = state.exportUrl;
    link.download = fileName;
    $('download-name').textContent = fileName;
    $('download-status').textContent = binary
      ? 'Image ready. Use Save file below if the download did not start. / 画像を生成しました。保存が始まらない場合は下の「保存」をご利用ください。'
      : 'File ready. If your browser did not start the download, use Save file below or copy the text. / ファイルを生成しました。保存が始まらない場合は下の「保存」、またはテキストのコピーをご利用ください。';
    $('download-text').value = '';
    $('download-alternative').open = false;
    $('download-alternative').hidden = binary;
    $('download-image').hidden = !binary;
    if(binary) $('download-image').src = state.exportUrl;
    else $('download-image').removeAttribute('src');
    $('download-panel').hidden = false;
    // Keep a real, visible link alive for embedded browsers and retry/copy recovery.
    link.click();
    if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 60000);
  }

  function clearPreparedDownload() {
    $('download-panel').hidden = true;
    $('download-text').value = '';
    $('download-link').removeAttribute('href');
    $('download-alternative').open = false;
    $('download-image').hidden = true;
    $('download-image').removeAttribute('src');
    state.exportText = '';
    const previousUrl = state.exportUrl;
    state.exportUrl = null;
    if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 60000);
  }

  function exportJSON() {
    if (!state.result) return;
    download(JSON.stringify(reviewData(), null, 2), `${baseName(state.fileName)}-review.json`, 'application/json');
  }

  function reviewData() {
    const payload = CADCORE.buildAnnotationData(state.fileName, state.inspection, state.result, state.decisions);
    payload.layerExplanations = state.result.layerAnalysis.layers.map(layer => LAYEREXPLANATIONS.explain(layer, state.result.layerAnalysis));
    payload.workflow = 'Automatic layer selection and geometric wall extraction; manual drawing review and separate structural-model verification are required.';
    payload.semanticModel = state.semanticModel || CADSEMANTICS.build(payload, state.result.originalSegs, state.entities);
    return payload;
  }

  function exportHandoff() {
    if (!state.result) return;
    download(JSON.stringify(occupancyData(), null, 2), `${baseName(state.fileName)}-wall-positions.json`, 'application/json');
  }

  function occupancyData() {
    return occupancySelection().data;
  }

  function occupancySelection() {
    const scope=state.viewScope||'all',region=(state.result.regions||[]).find(r=>r.id===scope);
    const bounds=scope==='all'?null:region?.extents||state.result.extents;
    return WALLOCCUPANCY.select(state.semanticModel || reviewData().semanticModel,
      state.result.drawingAssessment,{id:scope,bounds},state.result.wallOutputSegments);
  }

  function scopeLabel() {
    return $('view-scope').selectedOptions[0]?.textContent || 'Full drawing / 全図';
  }

  function resultBounds() {
    const bounds={...(state.viewScope==='all'?state.result.extents:scopeBounds())};
    for(const s of WALLOCCUPANCY.outputSegments(occupancyData())) {
      bounds.minx=Math.min(bounds.minx,s.x1,s.x2);bounds.maxx=Math.max(bounds.maxx,s.x1,s.x2);
      bounds.miny=Math.min(bounds.miny,s.y1,s.y2);bounds.maxy=Math.max(bounds.maxy,s.y1,s.y2);
    }
    bounds.w=bounds.maxx-bounds.minx||1;bounds.h=bounds.maxy-bounds.miny||1;
    return bounds;
  }

  function renderPositionTable() {
    const {data,links}=occupancySelection(), axes=new Map(data.axes.map(a=>[a.id,a]));
    if(!Object.values(links).includes(state.axisId))state.axisId=links[data.walls[0]?.id]||null;
    const size=12,pages=Math.max(1,Math.ceil(data.walls.length/size));
    state.positionPage=Math.max(0,Math.min(state.positionPage||0,pages-1));
    const start=state.positionPage*size;
    $('position-summary').textContent=`${scopeLabel()} · ${data.walls.length} intervals / 壁区間 · ${data.units.label}`;
    $('position-rows').innerHTML=data.walls.slice(start,start+size).map(w=>{
      const a=axes.get(w.axisId),selected=links[w.id]===state.axisId;
      return `<tr data-wall="${w.id}" data-active="${selected}"><td><button type="button" data-wall="${w.id}" aria-pressed="${selected}" aria-label="${w.id} · ${escapeHtml(a.name)} · Select wall / 壁を選択">${w.id}</button></td><td>${escapeHtml(a.name)}<small>${a.nameSource==='drawing'?'Detected / 図面符号':'Generated / 生成名'}</small></td><td title="${w.from} → ${w.to}">${formatMeasurement(w.from)} → ${formatMeasurement(w.to)}</td></tr>`;
    }).join('')||'<tr><td colspan="3">No wall intervals in this area. / この範囲では壁区間を抽出できませんでした。</td></tr>';
    $('position-page').textContent=`${state.positionPage+1} / ${pages}`;
    $('position-prev').disabled=state.positionPage===0;
    $('position-next').disabled=state.positionPage===pages-1;
    const wall=data.walls.find(w=>links[w.id]===state.axisId),axis=state.semanticModel?.axes.find(a=>a.id===state.axisId);
    const detail=$('position-selection');
    if(!wall||!axis){detail.textContent='No selected wall. An empty result does not prove there are no walls. / 壁の選択なし。空の結果は、壁がないことを示すものではありません。';return;}
    const a=axes.get(wall.axisId),description=CADSEMANTICS.describeAxis(axis,state.semanticModel);
    detail.innerHTML=`<h4>${wall.id} · ${escapeHtml(a.name)}</h4><p><strong>Wall candidate / 壁候補</strong><br>${formatMeasurement(wall.from)} → ${formatMeasurement(wall.to)} ${escapeHtml(data.units.label)}</p><p class="selected-evidence">${escapeHtml(description.ja)}</p><details><summary>English explanation / 英語の説明</summary><p>${escapeHtml(description.en)}</p></details><p>Axis origin / 軸原点: (${formatMeasurement(a.origin.x)}, ${formatMeasurement(a.origin.y)})<br>Direction / 方向: (${formatMeasurement(a.direction.x)}, ${formatMeasurement(a.direction.y)})</p><p>Evidence score / 根拠スコア: ${axis.confidence?.value==null?'Unknown / 不明':Math.round(axis.confidence.value*100)+'/100'}<br>Uncalibrated, not accuracy. / 未校正・正解率ではありません。</p>`;
  }

  function selectPosition(wallId) {
    const {data,links}=occupancySelection(),index=data.walls.findIndex(w=>w.id===wallId);
    if(index<0)return;
    state.axisId=links[wallId];state.positionPage=Math.floor(index/12);
    state.inspectedLayer=state.result.selectedWallLayers[0]||state.inspectedLayer;
    state.viewLayer=null;
    renderLayerAnalysis();renderPositionTable();renderAxisDetail();draw();
    const row=$('position-rows').querySelector('[data-active="true"]'),container=$('position-rows').closest('.table-scroll');
    if(row&&container)container.scrollTop+=row.getBoundingClientRect().top-container.getBoundingClientRect().top-50;
  }

  function positionSources(axis,sources) {
    const map=new Map(sources.map(s=>[s.id,s]));
    return [...(axis.sourceIntervals||[]),...(axis.supportingSourceIntervals||[])].flatMap(interval=>{
      const s=map.get(interval.id);if(!s)return [];
      const length=Math.hypot(s.x2-s.x1,s.y2-s.y1);if(!length)return [];
      const [from,to]=interval.span,ux=(s.x2-s.x1)/length,uy=(s.y2-s.y1)/length;
      return [{id:s.id,x1:s.x1+ux*from,y1:s.y1+uy*from,x2:s.x1+ux*to,y2:s.y1+uy*to}];
    });
  }

  function drawPositionHighlight(original,clean,sourceBounds,outputBounds) {
    const {data,links}=occupancySelection(),wall=data.walls.find(w=>links[w.id]===state.axisId);
    if(!wall)return;
    const axis=state.semanticModel.axes.find(a=>a.id===state.axisId);
    if(!axis)return;
    const source=positionSources(axis,state.result.originalSegs);
    drawSegmentsOn(original,original.getContext('2d'),source,'#102e5c',4,1,[],sourceBounds);
    const line=WALLOCCUPANCY.segments(data).find(s=>s.id===wall.id);
    for(const [target,bounds] of [[original,sourceBounds],[clean,outputBounds]]) {
      const context=target.getContext('2d'),t=fittedTransform(target,15,bounds),ratio=window.devicePixelRatio||1;
      drawSegmentsOn(target,context,[line],'#102e5c',4,1,[],bounds);
      context.save();context.fillStyle='#102e5c';context.font=`${12*ratio}px sans-serif`;
      context.fillText(wall.id,t.x((line.x1+line.x2)/2)+8*ratio,t.y((line.y1+line.y2)/2)-8*ratio);context.restore();
    }
  }

  function changeScope(value) {
    if(!state.result)return;
    resetView();state.viewScope=value;state.positionPage=0;
    resetNativeView();
    $('view-scope').value=value;$('export-scope').value=value;
    clearPreparedDownload();renderReview();renderAxisDetail();draw();
  }

  function renderOccupancySummary() {
    const data=occupancyData(), axes=new Map(data.axes.map(a=>[a.id,a]));
    $('occupancy-summary').textContent = `${scopeLabel()} · ${data.wallLines.length} blue lines (${data.quality.junctionConnectorCount || 0} connectors) · ${data.walls.length} wall intervals · ${data.axes.length} axes · units: ${data.units.label} / 青い壁線 ${data.wallLines.length}本（接続 ${data.quality.junctionConnectorCount || 0}本）・壁区間 ${data.walls.length}・軸 ${data.axes.length}本・単位 ${data.units.label}`;
    $('occupancy-rows').innerHTML = data.walls.map(w=>{
      const a=axes.get(w.axisId);
      return `<tr><td>${escapeHtml(a.name)}<br><small>${a.nameSource==='drawing'?'Detected / 図面から検出':'Generated / 自動生成'} · ${escapeHtml(a.id)}</small></td><td>${escapeHtml(a.areaId)}</td><td>${escapeHtml(String(w.from))}</td><td>${escapeHtml(String(w.to))}</td></tr>`;
    }).join('') || '<tr><td colspan="4">No extracted wall intervals / 抽出した壁区間なし</td></tr>';
  }

  function exportOccupancyText() {
    if (!state.result) return;
    download('\uFEFF' + WALLOCCUPANCY.toText(occupancyData()), `${baseName(state.fileName)}-wall-positions.txt`, 'text/plain');
  }

  function exportSVG() {
    if (!state.result) return;
    download(WALLOCCUPANCY.toSVG(occupancyData()), `${baseName(state.fileName)}-wall-lines.svg`, 'image/svg+xml');
  }

  function exportPNG() {
    if (!state.result) return;
    const result=state.result, version=state.loadVersion, scope=state.viewScope, filename=baseName(state.fileName);
    const layout=WALLOCCUPANCY.imageLayout(occupancyData());
    const image=document.createElement('canvas');
    image.width=layout.width;image.height=layout.height;
    const context=image.getContext('2d');
    context.fillStyle='#ffffff';context.fillRect(0,0,image.width,image.height);
    context.strokeStyle='#176fe6';context.lineWidth=3;context.lineCap='butt';
    context.beginPath();
    for(const line of layout.lines){context.moveTo(line.x1,line.y1);context.lineTo(line.x2,line.y2);}
    context.stroke();
    image.toBlob(blob=>{
      if(state.result!==result || state.loadVersion!==version || state.viewScope!==scope)return;
      if(blob)download(blob,`${filename}-wall-lines.png`,'image/png');
      else setMessage('Could not create PNG. Use the SVG image export below. / PNGの生成に失敗しました。下のSVG画像出力をご利用ください。');
    },'image/png');
  }

  function exportTextReport() {
    if (!state.result) return;
    const text = LAYEREXPLANATIONS.buildTextReport(reviewData());
    download('\uFEFF' + text, `${baseName(state.fileName)}-analysis-report.txt`, 'text/plain');
  }

  function exportDXF() {
    const candidates = state.result.placementCandidates.filter(candidate => candidate.level === 'high');
    setMessage(`<strong>Exporting ${candidates.length} automatic geometry candidates with the walls.</strong><br>These are not approved installation locations.<br>壁と形状候補 ${candidates.length}件を自動出力します。設置が承認された位置ではありません。`, 'info');
    download(CADCORE.buildDXF(cleanWallSegments(), candidates, state.inspection.unitsCode), `${baseName(state.fileName)}-candidates.dxf`, 'application/dxf');
  }

  function baseName(name) {
    return String(name || 'drawing').replace(/\.[^.]+$/, '');
  }
  function formatNumber(value) {
    return Math.round(Number(value) || 0).toLocaleString('en-US');
  }
  function formatMeasurement(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  function roleLabel(role) {
    return ({ wall: 'Wall / 壁', brace: 'Brace / 筋違', column: 'Column / 柱', beam: 'Beam / 梁', annotation: 'Annotation / 寸法・注記', furniture: 'Furniture / 家具', 'door-window': 'Door & Window / 建具', grid: 'Grid / 通り芯', mixed: 'Mixed / 混在', excluded: 'Excluded / 除外', unknown: 'Unknown / 不明' })[role] || role;
  }
  function reasonCopy(code) {
    return ({
      'layer name suggests wall': { en: 'Layer name supports wall semantics', ja: 'レイヤー名が壁を示します' },
      'consistent paired wall spacing': { en: 'Consistent paired wall lines', ja: '安定した平行双線があります' },
      'multiple recurring wall spacings': { en: 'Several recurring paired-line spacings, not just one thickness', ja: '単一厚さではなく、複数の平行双線間隔が繰り返し現れます' },
      'paired wall lines': { en: 'Parallel line pairs at plausible wall spacing', ja: '壁厚候補の範囲に平行双線があります' },
      'orthogonal connected boundary': { en: 'Orthogonal lines and connections suggest room boundaries', ja: '直交線と接続形状が室境界に似ています' },
      'annotation entities dominate': { en: 'Text and dimensions dominate', ja: '文字・寸法要素が中心です' },
      'inserted blocks dominate': { en: 'Inserted blocks dominate', ja: 'ブロック要素が中心です' },
      'layer name suggests annotation': { en: 'Layer name suggests annotations', ja: 'レイヤー名が注記を示します' },
      'layer name suggests furniture': { en: 'Layer name suggests furniture or equipment', ja: 'レイヤー名が家具・設備を示します' },
      'layer name suggests column': { en: 'Layer name supports column semantics', ja: 'レイヤー名が柱を示します' },
      'layer name suggests beam': { en: 'Layer name supports beam semantics', ja: 'レイヤー名が梁を示します' },
      'layer name suggests brace': { en: 'Layer name supports brace semantics', ja: 'レイヤー名が筋違を示します' },
      'layer name suggests door or window': { en: 'Layer name supports opening semantics', ja: 'レイヤー名が建具を示します' },
      'layer name suggests grid': { en: 'Layer name supports grid semantics', ja: 'レイヤー名が通り芯を示します' },
      'diagonal geometry dominates': { en: 'Most segments are diagonal', ja: '斜めの線分が中心です' },
      'closed polylines dominate': { en: 'Closed polylines dominate', ja: '閉じたポリラインが中心です' },
      'curved entities present': { en: 'Circles or arcs form a substantial share', ja: '円・円弧の割合が高いレイヤーです' },
      'sparse orthogonal lines': { en: 'Orthogonal lines with few endpoint connections', ja: '端点の接続が少ない直交線があります' },
      'repeated product-detail pattern': { en: 'Repeated product-detail pattern', ja: '製品詳細の反復パターンがあります' },
      'annotation-heavy layer': { en: 'Annotation-heavy Layer', ja: '注記要素が多いレイヤーです' },
      'block-heavy layer': { en: 'Block-heavy Layer', ja: 'ブロック要素が多いレイヤーです' },
      'mixed content': { en: 'Mixed incompatible content', ja: '異なる内容が混在しています' },
      'minor frame layer in dense drawing': { en: 'Minor frame Layer inside a dense drawing', ja: '密な図面内の小規模な枠レイヤーです' },
      'unitless relative measurements': { en: 'Relative scale used for non-mm or unknown units', ja: 'mm以外または単位不明のため相対尺度を使用します' },
      'sampled pair geometry': { en: 'Parallel-pair features use a sample of long segments', ja: '長い線分をサンプリングして平行双線の特徴を集計しています' },
      'no analyzable geometry': { en: 'No analyzable geometry', ja: '解析可能な形状がありません' },
      'insufficient semantic evidence': { en: 'Insufficient semantic evidence', ja: '意味判定の根拠が不足しています' },
    })[code] || { en: String(code), ja: String(code) };
  }
  function selectionReasonCopy(code) {
    return ({
      'selected-wall-layer': { en: 'Selected automatically from wall evidence.', ja: '壁の根拠により自動選択しました。' },
      'excluded-mixed-content': { en: 'Not selected: mixed content.', ja: '内容が混在するため対象外です。' },
      'excluded-repeated-pattern': { en: 'Not selected: dense repeated lines.', ja: '密な反復線のため対象外です。' },
      'excluded-other-role': { en: 'Not selected: another role is more likely.', ja: '壁以外の役割と判定しました。' },
      'below-wall-threshold': { en: 'Not selected: wall evidence is below the threshold.', ja: '壁の根拠がしきい値未満です。' },
      'lower-ranked-wall-layer': { en: 'Not selected: another Layer has stronger wall evidence.', ja: '他のレイヤーの壁根拠がより強いため対象外です。' },
      'no-reliable-wall-layer': { en: 'No Layer has enough independent wall evidence.', ja: '壁として十分な独立根拠を持つレイヤーがありません。' },
      'mixed-layer-only': { en: 'The only Layer mixes wall-like geometry with other content.', ja: '唯一のレイヤーに壁形状と他の要素が混在しています。' },
      'ambiguous-wall-layers': { en: 'Multiple possible wall Layers are too close in confidence.', ja: '複数の壁候補レイヤーの信頼度が近すぎます。' },
      'selected-layer-has-no-wall-centerlines': { en: 'The selected Layer has no reliable wall centerlines.', ja: '選択したレイヤーに信頼できる壁中心線がありません。' },
      'layer-intelligence-unavailable': { en: 'The Layer intelligence module is unavailable.', ja: 'レイヤー解析モジュールを利用できません。' },
    })[code] || { en: 'Automatic Layer selection could not be completed.', ja: 'レイヤーの自動選択を完了できませんでした。' };
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => setStep(Number(button.dataset.go))));
  document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
    const target = $(button.dataset.reveal);
    target.open = true;
    requestAnimationFrame(() => { draw(); target.scrollIntoView({ block: 'start' }); });
  }));
  document.querySelectorAll('.flow-disclosure').forEach(details => details.addEventListener('toggle', () => {
    if (details.open) requestAnimationFrame(draw);
  }));
  $('open-file-button').addEventListener('click', () => $('file-input').click());
  $('cancel-import').addEventListener('click', () => {
    if (!state.loading) return;
    state.loadVersion += 1;
    if (state.importAbort) state.importAbort.abort();
    if (state.importWorker) state.importWorker.terminate();
    if (state.rejectImport) state.rejectImport(new Error('Import canceled.'));
    state.importAbort = null; state.importWorker = null; state.rejectImport = null;
    setImportBusy(false);
    setStep(1);
    setMessage('<strong>Import canceled. Choose a drawing when ready.</strong><br>読み込みを中止しました。別の図面を選択できます。', 'info');
  });
  $('file-input').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    handleFile(file);
  });
  $('provided-drawing-button').addEventListener('click', () => loadProvidedDrawing('drawing1'));
  $('provided-dwg-button').addEventListener('click', () => loadProvidedDrawing('nagai'));
  $('sample-button').addEventListener('click', async () => {
    if (state.loading) return;
    setStep(1);
    setImportBusy(true);
    const version = ++state.loadVersion;
    if (state.importWorker) state.importWorker.terminate();
    state.importWorker = null;
    setMessage('<strong>Preparing the built-in demonstration…</strong><br>説明用のサンプルを準備しています…', 'info');
    await new Promise(resolve => setTimeout(resolve, 0));
    if (version !== state.loadVersion) return;
    try {
      loadText(CADCORE.makeSampleDXF(), 'apartment-floorplan-demo.dxf');
    } catch (error) {
      setMessage(`<strong>Could not analyze the demonstration.</strong><br>サンプルの解析に失敗しました。${escapeHtml(error.message)}`);
    } finally { setImportBusy(false); }
  });
  $('view-scope').addEventListener('change', event => changeScope(event.target.value));
  $('export-scope').addEventListener('change', event => changeScope(event.target.value));
  $('position-rows').addEventListener('click',event=>{const row=event.target.closest('[data-wall]');if(row)selectPosition(row.dataset.wall);});
  for(const [id,step] of [['position-prev',-1],['position-next',1]])$(id).addEventListener('click',()=>{state.positionPage+=step;renderPositionTable();});
  for(const id of ['wall-result-canvas','layer-context-canvas'])$(id).addEventListener('click',event=>{
    if(!state.result||!state.semanticModel)return;
    const target=$(id),rect=target.getBoundingClientRect();
    const bounds=id==='layer-context-canvas'&&!isRecognizedWallLayer(state.inspectedLayer)?layerExtents(state.inspectedLayer):resultBounds();
    const t=fittedTransform(target,15,bounds),lines=WALLOCCUPANCY.segments(occupancyData()).map(s=>({id:s.id,x1:t.x(s.x1),y1:t.y(s.y1),x2:t.x(s.x2),y2:t.y(s.y2)}));
    const wall=WALLOCCUPANCY.hitTest(lines,{x:(event.clientX-rect.left)*target.width/rect.width,y:(event.clientY-rect.top)*target.height/rect.height},8*(window.devicePixelRatio||1));
    if(wall)selectPosition(wall);
  });
  $('export-converted').addEventListener('click', () => {
    if (state.convertedText) download(state.convertedText, `${baseName(state.fileName)}-converted.dxf`, 'application/dxf');
  });
  $('detect-button').addEventListener('click', () => analyze(true));
  $('export-json').addEventListener('click', exportJSON);
  $('export-text').addEventListener('click', exportOccupancyText);
  $('export-diagnostic-text').addEventListener('click', exportTextReport);
  $('export-handoff').addEventListener('click', exportHandoff);
  $('export-png').addEventListener('click', exportPNG);
  $('export-svg').addEventListener('click', exportSVG);
  $('axis-select').addEventListener('change',event=>{const {links}=occupancySelection();selectPosition(Object.keys(links).find(id=>links[id]===event.target.value));});
  for(const [id,step] of [['axis-prev',-1],['axis-next',1]]) $(id).addEventListener('click',()=>{
    const {data,links}=occupancySelection(),index=data.walls.findIndex(w=>links[w.id]===state.axisId);
    if(data.walls[index+step])selectPosition(data.walls[index+step].id);
  });
  $('show-unresolved').addEventListener('change', draw);
  $('result-view').addEventListener('change', draw);
  $('export-coverage').addEventListener('click', () => {
    if(!state.result || !state.result.selectedWallLayers.length)return;
    download(CADCORE.buildCoverageDXF(state.result,state.inspection.unitsCode),`${baseName(state.fileName)}-extraction-review.dxf`,'application/dxf');
  });
  $('download-alternative').addEventListener('toggle', () => {
    if ($('download-alternative').open) $('download-text').value = state.exportText;
  });
  $('copy-download').addEventListener('click', async () => {
    const field = $('download-text');
    field.value = state.exportText;
    try {
      await navigator.clipboard.writeText(state.exportText);
      $('download-status').textContent = 'File text copied. Save it as a UTF-8 plain-text file using the filename above. / コピーしました。上記のファイル名でUTF-8のプレーンテキストとして保存してください。';
    } catch {
      field.focus(); field.select();
      $('download-status').textContent = 'Automatic copy is unavailable. The text is selected; press ⌘C / Ctrl+C, then save as UTF-8 plain text. / 自動コピーできません。選択中のテキストを⌘C / Ctrl+Cでコピーし、UTF-8で保存してください。';
    }
  });
  $('export-dxf').addEventListener('click', exportDXF);
  $('export-walls').addEventListener('click', () => {
    if (!state.result || !cleanWallSegments().length) return;
    const output = { selectedWallLayers: ['WALL'], originalSegs: cleanWallSegments().map(wall => ({ ...wall, layer: 'WALL' })) };
    download(CADCORE.buildSelectedLayerDXF(output, state.inspection.unitsCode), `${baseName(state.fileName)}-walls-only.dxf`, 'application/dxf');
  });
  $('show-selected-layer').addEventListener('click', () => {
    if (!state.result || !state.result.selectedWallLayers.length) return;
    state.inspectedLayer = state.result.selectedWallLayers[0];
    resetView();
    renderLayerAnalysis();
    draw();
  });
  $('export-layer').addEventListener('click', () => {
    const output={selectedWallLayers:recognizedWallLayerNames(),originalSegs:recognizedWallSegments()};
    download(CADCORE.buildSelectedLayerDXF(output, state.inspection.unitsCode),
      `${baseName(state.fileName)}-recognized-wall-source-lines.dxf`, 'application/dxf');
    setMessage('<strong>Exported every recognized wall-source Layer, preserving original Layer names.</strong><br>The primary extraction Layer and geometrically verified companion wall Layers are included; dimensions and unrelated frame Layers remain excluded.<br>主抽出レイヤーと形状確認済みの補助壁源レイヤーを、元のレイヤー名のまま出力しました。寸法線と無関係な枠線は含みません。', 'info');
  });
  $('zoom-in').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.22); draw(); });
  $('zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.3, state.zoom / 1.22); draw(); });
  $('fit-view').addEventListener('click', () => { resetView(); draw(); });
  ['show-original', 'show-wall', 'show-kframe', 'show-existing-braces', 'show-layer'].forEach(id => $(id).addEventListener('change', draw));
  ['kframe-length', 'pair-min', 'pair-max', 'require-pair'].forEach(id => $(id).addEventListener('input', () => { state.paramsDirty = true; }));
  canvas.addEventListener('wheel', event => {
    if (!state.result) return;
    event.preventDefault();
    state.zoom = Math.min(8, Math.max(0.3, state.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
    draw();
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (!state.result) return;
    state.dragging = true;
    state.dragStart = { x: event.clientX - state.panX, y: event.clientY - state.panY };
    canvas.classList.add('dragging');
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!state.dragging) return;
    state.panX = event.clientX - state.dragStart.x;
    state.panY = event.clientY - state.dragStart.y;
    draw();
  });
  const stopDrag = () => {
    state.dragging = false;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);
  $('native-search').addEventListener('input', renderNativeLayerList);
  $('native-layer-list').addEventListener('change', event => {
    const row = event.target.closest('[data-native-layer]'); if(!row)return;
    if(event.target.checked)state.nativeVisible.add(row.dataset.nativeLayer);else state.nativeVisible.delete(row.dataset.nativeLayer);
    updateNativeVisibility();
  });
  $('native-layer-list').addEventListener('click', event => {
    const button=event.target.closest('button'),row=button?.closest('[data-native-layer]');if(!row)return;
    state.nativeVisible=new Set([row.dataset.nativeLayer]);updateNativeVisibility();
  });
  $('native-show-all').addEventListener('click', () => {
    if(!state.nativeScene)return;
    state.nativeVisible=new Set(state.nativeScene.layers.filter(DXFLAYERS.hasContent).map(l=>l.name));updateNativeVisibility();
  });
  $('native-hide-all').addEventListener('click', () => {state.nativeVisible.clear();updateNativeVisibility();});
  $('native-fit-mode').addEventListener('change', () => {resetNativeView();drawNativeLayers();});
  $('native-fit').addEventListener('click', () => {resetNativeView();drawNativeLayers();});
  $('native-zoom-in').addEventListener('click', () => {state.nativeZoom=Math.min(32,state.nativeZoom*1.5);drawNativeLayers();});
  $('native-zoom-out').addEventListener('click', () => {state.nativeZoom=Math.max(.25,state.nativeZoom/1.5);drawNativeLayers();});
  $('native-show-text').addEventListener('change', drawNativeLayers);
  const nativeCanvas=$('native-layer-canvas');
  nativeCanvas.addEventListener('pointerdown', event => {
    if(event.button!==0)return;state.nativeDrag={x:event.clientX-state.nativePanX,y:event.clientY-state.nativePanY};nativeCanvas.setPointerCapture(event.pointerId);
  });
  nativeCanvas.addEventListener('pointermove', event => {
    if(!state.nativeDrag)return;state.nativePanX=event.clientX-state.nativeDrag.x;state.nativePanY=event.clientY-state.nativeDrag.y;drawNativeLayers();
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(type => nativeCanvas.addEventListener(type, () => {state.nativeDrag=null;}));
  window.addEventListener('resize', draw);
  const wrap = $('upload-drop-zone');
  ['dragenter', 'dragover'].forEach(type => wrap.addEventListener(type, event => {
    event.preventDefault();
    wrap.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => wrap.addEventListener(type, event => {
    event.preventDefault();
    wrap.classList.remove('dragging');
  }));
  wrap.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));
  if (window.CAD_LOCAL_EXAMPLES) {
    [['drawing1', 'provided-drawing-button'], ['nagai', 'provided-dwg-button']].forEach(([key, id]) => {
      if (window.CAD_LOCAL_EXAMPLES[key]) $(id).hidden = false;
    });
  }
  // Every new page visit starts with the introduction. Legacy drawing query
  // parameters no longer skip the user's first step or import a file on arrival.
  setStep(0, false);
}());
