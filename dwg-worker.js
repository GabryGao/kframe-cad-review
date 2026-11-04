import { convertDwgToDxf } from './dwg-conversion.js';

// One conversion per worker; the caller terminates it to release the WASM heap.
self.onmessage = async event => {
  self.postMessage(await convertDwgToDxf(event.data.buffer, {
    locateFile: file => new URL(`./vendor/libredwg/wasm/${file}`, import.meta.url).href,
  }));
};
