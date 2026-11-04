import { LibreDwg, createModule, Dwg_Error, Dwg_Object_Type, dwgCodePageToEncoding,
  decodeUnicodeEscapes } from './vendor/libredwg/dist/libredwg-web.js';

const CONVERTER = 'libredwg-web 0.7.14';

function decodeDxfText(value) {
  return decodeUnicodeEscapes(value).replace(/\^([@A-Z\[\]\\^_ ])/g,
    (_, character) => character === ' ' ? '^' : String.fromCharCode(character.charCodeAt(0) ^ 64));
}

function encodeDxfText(value, asciiOnly) {
  return value.replace(/[\x00-\x1f^]|[^\x00-\x7f]/g, character => {
    const code = character.charCodeAt(0);
    if (character === '^') return '^ ';
    if (code < 32) return '^' + String.fromCharCode(code + 64);
    return asciiOnly ? '\\U+' + code.toString(16).toUpperCase().padStart(4, '0') : character;
  });
}

// Match an original DWG object by handle. Only the TEXT value (DXF group 1) is
// eligible; geometry, layers, other strings and unmatched records stay intact.
export function restoreDwgText(dxf, originals, sourceVersion = 'AC1032') {
  const newline = dxf.includes('\r\n') ? '\r\n' : '\n';
  const lines = dxf.split(newline);
  const repairedHandles = [];
  let type, handle, checkedCount = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    if (code === 0) { type = lines[i + 1]; handle = undefined; }
    if (code === 5) handle = lines[i + 1].trim().toUpperCase();
    if (type !== 'TEXT' || code !== 1 || !originals.has(handle)) continue;
    const original = originals.get(handle);
    checkedCount += 1;
    if (decodeDxfText(lines[i + 1]) === original) continue;
    lines[i + 1] = encodeDxfText(original, sourceVersion < 'AC1021');
    repairedHandles.push(handle);
  }
  return { text: lines.join(newline), textRecovery: {
    status: repairedHandles.length ? 'recovered' : 'verified',
    scope: 'TEXT', checkedCount, repairedCount: repairedHandles.length, repairedHandles,
  } };
}

function readOriginalText(instance, library, buffer) {
  const filename = 'text-source.dwg';
  let pointer;
  try {
    instance.FS.writeFile(filename, new Uint8Array(buffer));
    const result = instance.dwg_read_file(filename);
    pointer = result.data;
    if (result.error & Dwg_Error.OUTOFMEM) {
      instance.dwg_abandon(pointer);
      pointer = undefined;
    }
    if (result.error || !pointer) throw new Error(`DWG source read failed (${result.error}).`);
    const sourceVersion = library.dwg_get_version_type(pointer).hdr;
    const codepage = library.dwg_get_codepage(pointer);
    const originals = new Map();
    let skippedCount = 0;
    const count = instance.dwg_get_num_objects(pointer);
    for (let i = 0; i < count; i += 1) {
      const object = instance.dwg_get_object(pointer, i);
      if (instance.dwg_object_get_fixedtype(object) !== Dwg_Object_Type.DWG_TYPE_TEXT) continue;
      const entity = instance.dwg_object_to_entity_tio(object);
      const value = instance.dwg_dynapi_entity_value(entity, 'text_value');
      let text = value.data;
      if (value.bin) {
        try { text = new TextDecoder(dwgCodePageToEncoding(codepage), { fatal: true }).decode(value.bin); }
        catch { text = undefined; }
      }
      const handle = library.dwg_obj_get_handle_value(object)?.toString(16).toUpperCase();
      // Never infer a replacement from an undecodable or unavailable source value.
      if (!value.success || typeof text !== 'string' || !handle || text.includes('\uFFFD')
          || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
        skippedCount += 1;
        continue;
      }
      originals.set(handle, decodeUnicodeEscapes(text));
    }
    return { originals, sourceVersion, codepage, skippedCount };
  } finally {
    // Release the source read before invoking the native DXF writer.
    if (pointer) library.dwg_free(pointer);
    if (instance.FS.analyzePath(filename, false).exists) instance.FS.unlink(filename);
  }
}

export async function convertDwgToDxf(buffer, moduleOptions = {}) {
  let warningCount = 0;
  let stage = 'initialize';
  const warnings = [];
  const warningDetails = [];
  const log = value => {
    const message = String(value);
    if (!/warn|error|invalid|unsupported|bad_/i.test(message)) return;
    warningCount += 1;
    if (warnings.length < 12 && !warnings.includes(message)) warnings.push(message.slice(0, 400));
    const code = message.match(/\b(?:BAD_[A-Z_]+|INVALID_UTF8_OUTPUT|TEXT_SOURCE_UNAVAILABLE)\b/)?.[0] || 'CONVERTER_WARNING';
    let detail = warningDetails.find(item => item.code === code && item.stage === stage);
    if (!detail) { detail = { code, stage, count: 0, samples: [] }; warningDetails.push(detail); }
    detail.count += 1;
    if (detail.samples.length < 12 && !detail.samples.includes(message)) detail.samples.push(message.slice(0, 400));
  };
  const diagnostics = () => ({ warningCount, warnings, warningDetails, converter: CONVERTER });
  try {
    const instance = await createModule({ ...moduleOptions, print: log, printErr: log });
    const library = LibreDwg.createByWasmInstance(instance);
    let source;
    stage = 'source-text';
    try { source = readOriginalText(instance, library, buffer); }
    catch (error) { log(`Warning: TEXT_SOURCE_UNAVAILABLE ${error.message || error}`); }
    stage = 'dwg-to-dxf';
    const bytes = library.dwg_write_dxf(buffer);
    if (!bytes?.length) throw new Error('The DWG converter returned no DXF data.');
    stage = 'decode-dxf';
    let text, valid = true;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      valid = false;
      text = new TextDecoder('utf-8').decode(bytes);
      log('Warning: INVALID_UTF8_OUTPUT Converted DXF contains undecodable UTF-8 bytes.');
    }
    const encoding = { name: 'utf-8', valid, sourceVersion: source?.sourceVersion, sourceCodepage: source?.codepage };
    const recovered = source && valid ? restoreDwgText(text, source.originals, source.sourceVersion)
      : { text, textRecovery: { status: 'unavailable', scope: 'TEXT', checkedCount: 0, repairedCount: 0, repairedHandles: [] } };
    if (source?.skippedCount) {
      recovered.textRecovery.skippedCount = source.skippedCount;
      recovered.textRecovery.status = 'partial';
    }
    return { ...recovered, encoding, ...diagnostics() };
  } catch (error) {
    return { error: error.message || String(error), ...diagnostics() };
  }
}
