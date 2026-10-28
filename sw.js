// Service worker: caches the app shell and streams + decrypts MEGA files on the fly,
// so videos can start playing (and seek) without downloading the whole file first.

const SHELL_CACHE = 'shell-v1';
const SHELL = ['./', './index.html', './app.js', './mega.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];
const MAX_CHUNK = 8 * 1024 * 1024; // answer open-ended range requests in 8 MB pieces

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/stream/') && url.searchParams.has('u')) {
    e.respondWith(stream(e.request, url));
    return;
  }
  // App shell: network first (so updates arrive), cache as fallback for offline launch.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && e.request.method === 'GET') {
        const c = await caches.open(SHELL_CACHE);
        c.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// MEGA file key (32 bytes) -> AES-128 key (first half XOR second half) + 8-byte CTR nonce.
async function keyParts(keyHex) {
  const k = hexToBytes(keyHex);
  const aes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) aes[i] = k[i] ^ k[16 + i];
  const cryptoKey = await crypto.subtle.importKey('raw', aes, 'AES-CTR', false, ['decrypt']);
  return { cryptoKey, nonce: k.slice(16, 24) };
}

function counterFor(nonce, blockIndex) {
  const ctr = new Uint8Array(16);
  ctr.set(nonce, 0);
  let n = BigInt(blockIndex);
  for (let i = 15; i >= 8; i--) { ctr[i] = Number(n & 0xffn); n >>= 8n; }
  return ctr;
}

async function stream(request, url) {
  const src = url.searchParams.get('u');
  const keyHex = url.searchParams.get('k');
  const size = Number(url.searchParams.get('s'));
  const mime = url.searchParams.get('m') || 'application/octet-stream';

  let start = 0, end = size - 1, partial = false;
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      partial = true;
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else {
        start = Number(m[1] || 0);
        end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : Math.min(size - 1, start + MAX_CHUNK - 1);
      }
    }
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const { cryptoKey, nonce } = await keyParts(keyHex);
  const aligned = start - (start % 16);
  let res;
  try {
    res = await fetch(`${src}/${aligned}-${end}`, { signal: request.signal });
  } catch (err) {
    return new Response('Network error', { status: 502 });
  }
  if (res.status === 509) return new Response('MEGA transfer quota exceeded', { status: 509 });
  if (!res.ok || !res.body) return new Response('MEGA error ' + res.status, { status: 502 });

  let block = aligned / 16;      // CTR block index of the next byte we will decrypt
  let skip = start - aligned;    // decrypted bytes to drop at the very start
  let carry = new Uint8Array(0); // leftover bytes that don't fill a 16-byte block yet
  const reader = res.body.getReader();

  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      let data;
      if (done) {
        data = carry; carry = new Uint8Array(0);
      } else {
        data = new Uint8Array(carry.length + value.length);
        data.set(carry); data.set(value, carry.length);
        const usable = data.length - (data.length % 16);
        carry = data.slice(usable);
        data = data.subarray(0, usable);
      }
      if (data.length) {
        const plain = new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter: counterFor(nonce, block), length: 64 }, cryptoKey, data));
        block += Math.ceil(data.length / 16);
        let out = plain;
        if (skip) { out = plain.subarray(Math.min(skip, plain.length)); skip -= plain.length - out.length; }
        if (out.length) controller.enqueue(out);
      }
      if (done) controller.close();
    },
    cancel() { reader.cancel().catch(() => {}); }
  });

  const headers = {
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: partial ? 206 : 200, headers });
}
