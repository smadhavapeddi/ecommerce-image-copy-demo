#!/usr/bin/env node
/**
 * "Build It Live" — E-commerce Image + Copy Generator Demo
 *
 * Type a one-line product idea and watch a product photo (DigitalOcean's
 * /v1/images/generations endpoint, GPT-IMAGE-2) and marketing copy (chat
 * completions) get generated side by side. Each side has its own
 * "Regenerate" button, backed by its own route, so regenerating the image
 * doesn't re-run the copy and vice versa.
 *
 * This is the one demo in this series that exercises DigitalOcean's image
 * generation endpoint — none of the others touch it.
 *
 * No external dependencies — Node.js 18+ standard library (`http`, `zlib`,
 * built-in `fetch`) only. Listens on process.env.PORT (App Platform sets
 * this). The whole app sits behind HTTP Basic Auth.
 *
 * Env vars:
 *   MODEL_ACCESS_KEY     DigitalOcean Serverless Inference model access key.
 *                        Required unless DRY_RUN=true.
 *   CHAT_MODEL           Chat completion model for copy (default: openai-gpt-oss-120b).
 *   IMAGE_MODEL          Image generation model (default: openai-gpt-image-2).
 *   IMAGE_SIZE           auto | 1536x1024 | 1024x1536 (default: auto).
 *   IMAGE_QUALITY        auto | high | medium | low (default: auto).
 *   IMAGE_OUTPUT_FORMAT  png | webp | jpeg (default: jpeg).
 *   IMAGE_BACKGROUND     transparent | opaque | auto (default: opaque).
 *   AUTH_USERNAME        Basic Auth username (default: solutions).
 *   AUTH_PASSWORD        Basic Auth password (default: champs).
 *   DRY_RUN              "true" = mock copy + a locally generated placeholder
 *                        image, no API calls, no cost.
 *   PORT                 HTTP port to listen on (App Platform sets this).
 */

'use strict';

const http = require('http');
const zlib = require('zlib');

const BASE_URL = 'https://inference.do-ai.run';
const CHAT_PATH = '/v1/chat/completions';
const IMAGE_PATH = '/v1/images/generations';
const REQUEST_TIMEOUT_MS = 45000;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_IDEA_LEN = 300;

const COPY_SYSTEM_PROMPT =
  'You are an e-commerce copywriter. Given a one-line product idea, write compelling marketing copy for an ' +
  'online store listing. Respond with ONLY a single valid JSON object — no markdown code fences, no extra ' +
  'commentary before or after — matching exactly this shape: ' +
  '{"name": "short punchy product name", "tagline": "one short punchy tagline, under 12 words", ' +
  '"description": "a 2-3 sentence product description for the store listing", ' +
  '"bullets": ["benefit 1", "benefit 2", "benefit 3"]}. ' +
  'Keep it upbeat, concrete, and specific to the product idea given — avoid generic filler.';

function buildImagePrompt(productIdea) {
  return (
    `Professional e-commerce product photography of: ${productIdea}. ` +
    'Clean studio background, soft even lighting, centered composition, high detail, photorealistic, ' +
    'no text, no watermark, no logo.'
  );
}

// ---------------------------------------------------------------------------
// DigitalOcean Inference calls
// ---------------------------------------------------------------------------
async function callChat({ modelAccessKey, baseUrl, model, productIdea }) {
  const url = baseUrl.replace(/\/$/, '') + CHAT_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages: [
          { role: 'system', content: COPY_SYSTEM_PROMPT },
          { role: 'user', content: productIdea },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    return { content: null, error: err.name === 'AbortError' ? 'Copy request timed out.' : `Copy request failed: ${err.message}` };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { content: null, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`, latency_s };
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return {
    content: content ? String(content) : null,
    error: content ? null : 'Model returned an empty reply.',
    latency_s,
  };
}

async function callImageGeneration({ modelAccessKey, baseUrl, model, prompt, size, quality, outputFormat, background }) {
  const url = baseUrl.replace(/\/$/, '') + IMAGE_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        quality,
        output_format: outputFormat,
        background,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    return { imageBase64: null, error: err.name === 'AbortError' ? 'Image request timed out.' : `Image request failed: ${err.message}` };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { imageBase64: null, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`, latency_s };
  }

  const data = await res.json();
  const item = data.data && data.data[0];
  const b64 = item && item.b64_json;
  if (!b64) return { imageBase64: null, error: 'Image response did not include image data.', latency_s };

  const fmt = (item.output_format || outputFormat || 'png').replace('jpg', 'jpeg');
  return {
    imageBase64: b64,
    mime: `image/${fmt}`,
    revisedPrompt: item.revised_prompt || null,
    latency_s,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Copy JSON parsing — tolerant of markdown fences / stray text around the
// JSON, with a plain-text fallback so the UI never fully breaks.
// ---------------------------------------------------------------------------
function parseCopyJson(raw) {
  if (!raw) return null;
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

function normalizeCopy(parsed, rawContent, productIdea) {
  if (parsed && typeof parsed === 'object') {
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Your Product',
      tagline: typeof parsed.tagline === 'string' ? parsed.tagline.trim() : '',
      description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((b) => typeof b === 'string' && b.trim()).slice(0, 5)
        : [],
    };
  }
  return {
    name: 'Your Product',
    tagline: '',
    description: (rawContent || '').trim() || `A product based on: ${productIdea}`,
    bullets: [],
  };
}

// ---------------------------------------------------------------------------
// Dry-run mocks
// ---------------------------------------------------------------------------
function mockCopy(productIdea) {
  const snippet = productIdea.length > 60 ? productIdea.slice(0, 60) + '…' : productIdea;
  return {
    name: 'Dry-Run Demo Product',
    tagline: `Inspired by: "${snippet}"`,
    description:
      "This is mock marketing copy — DRY_RUN is on, so DigitalOcean's chat completions endpoint was never called. " +
      'Flip DRY_RUN off and add a model access key to see real AI-written copy for your product idea.',
    bullets: [
      'Zero API calls in dry-run mode, zero cost',
      'Same UI and JSON shape as live mode',
      'Flip DRY_RUN=false once a key is configured',
    ],
  };
}

// --- Minimal, dependency-free PNG encoder, used only for the dry-run
// --- placeholder image (a simple two-tone gradient derived from the typed
// --- product idea, so different ideas get different-looking placeholders).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function hashStringToInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function generateMockProductPng(seedText) {
  const width = 512;
  const height = 512;
  const hash = hashStringToInt(seedText || 'product');
  const hue1 = hash % 360;
  const hue2 = (hue1 + 50) % 360;
  const [r1, g1, b1] = hslToRgb(hue1, 0.55, 0.72);
  const [r2, g2, b2] = hslToRgb(hue2, 0.55, 0.42);

  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const compressed = zlib.deflateSync(raw);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buf = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Page — colorful e-commerce "build it live" widget
// ---------------------------------------------------------------------------
const PAGE_STYLE = `
  :root {
    --ink: #221a12; --muted: #8a7a63; --border: #f0e3cf; --bg: #fff8ec; --card: #ffffff;
    --accent-orange: #ff7a1a; --accent-pink: #ff4f8b; --accent-purple: #7b3ff2; --accent-green: #11a35a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--ink);
  }
  header {
    background: radial-gradient(circle at 10% 10%, #ffb020 0%, transparent 40%),
                radial-gradient(circle at 90% 0%, #ff4f8b 0%, transparent 42%),
                linear-gradient(120deg, #7b3ff2, #ff4f8b 60%, #ff7a1a);
    color: #fff; padding: 30px 28px 26px 28px;
  }
  header .title-row { display: flex; align-items: center; gap: 14px; }
  header h1 { margin: 0; font-size: 22px; }
  header p { margin: 6px 0 0 0; font-size: 13.5px; color: #ffe9d6; }
  .pipeline { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .pipeline .step { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.3); border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600; }
  .pipeline svg { width: 15px; height: 15px; flex: none; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 22px 20px 36px 20px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(123,63,242,0.07); margin-bottom: 18px; }
  .input-row { display: flex; gap: 10px; }
  .input-row input[type="text"] { flex: 1; padding: 13px 16px; border: 1px solid var(--border); border-radius: 999px; font-size: 15px; font-family: inherit; }
  .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent-purple); color: #fff; border: none; border-radius: 999px; padding: 13px 22px; font-weight: 700; font-size: 14.5px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: #6a2fe0; }
  .btn:disabled { opacity: .55; cursor: default; }
  .btn svg { width: 16px; height: 16px; }
  .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .chip { background: #fff1e0; color: #b45309; border: 1px solid #ffdca8; border-radius: 999px; padding: 6px 13px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip:hover { background: #ffe3bd; }
  .chip:disabled { opacity: .5; cursor: default; }

  .status-line { margin-top: 12px; font-size: 13.5px; color: var(--muted); min-height: 18px; }
  .note { font-size: 13px; color: var(--muted); margin-top: 12px; line-height: 1.6; }
  .mode-flag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.22); color: #fff; margin-left: 10px; vertical-align: middle; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
  @media (min-width: 760px) { .grid { grid-template-columns: 1fr 1fr; } }

  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .card-head .label { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14.5px; }
  .card-head .label svg { width: 18px; height: 18px; color: var(--accent-purple); }
  .regen-btn { display: inline-flex; align-items: center; gap: 6px; background: #f3ecff; color: #6a2fe0; border: none; border-radius: 999px; padding: 7px 13px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .regen-btn:hover { background: #e6d9ff; }
  .regen-btn:disabled { opacity: .5; cursor: default; }
  .regen-btn svg { width: 13px; height: 13px; }

  .image-frame { width: 100%; aspect-ratio: 1 / 1; border-radius: 12px; background: linear-gradient(135deg, #fff1e0, #ffe3ef); display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--border); }
  .image-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .image-frame .placeholder { color: var(--muted); font-size: 13px; text-align: center; padding: 20px; }
  .image-frame .placeholder svg { width: 40px; height: 40px; margin-bottom: 8px; opacity: .6; }
  .image-meta { font-size: 11.5px; color: var(--muted); margin-top: 8px; }

  .copy-name { font-size: 20px; font-weight: 800; margin: 0 0 4px 0; }
  .copy-tagline { font-size: 14px; font-style: italic; color: var(--accent-pink); margin: 0 0 12px 0; }
  .copy-description { font-size: 14px; line-height: 1.6; margin: 0 0 14px 0; }
  .copy-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .copy-bullets li { display: flex; align-items: flex-start; gap: 8px; font-size: 13.5px; line-height: 1.4; }
  .copy-bullets li svg { width: 15px; height: 15px; color: var(--accent-green); flex: none; margin-top: 2px; }
  .copy-empty { color: var(--muted); font-size: 13.5px; }
  .panel-error { color: #b91c1c; font-size: 13px; background: #fff1f0; border: 1px dashed #ffc9c4; border-radius: 10px; padding: 10px 12px; }

  footer { text-align: center; font-size: 11px; color: var(--muted); padding: 10px 24px 28px 24px; }
`;

function bagIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.6"/></svg>';
}
function imageIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4 17l5-5 3.5 3.5L17 10l3 3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function penIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4 11-11 3 3-11 11-4 1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 7l3 3" stroke="currentColor" stroke-width="1.6"/></svg>';
}
function refreshIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 11a8 8 0 0 1 14.2-4.9M20 13a8 8 0 0 1-14.2 4.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function sparkleIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3Z" fill="currentColor"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" fill="currentColor"/></svg>';
}
function checkIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 13l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function chatBubbleIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5h16v11H8l-4 4V5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}

const CLIENT_SCRIPT = `
var busy = false;
var lastIdea = '';

function setStatus(text) {
  document.getElementById('statusLine').textContent = text;
}

function setBusy(flag) {
  busy = flag;
  document.getElementById('generateBtn').disabled = flag;
  document.getElementById('regenImageBtn').disabled = flag;
  document.getElementById('regenCopyBtn').disabled = flag;
  var chips = document.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) chips[i].disabled = flag;
}

function loadPreset(text) {
  document.getElementById('ideaInput').value = text;
}

function renderImageLoading() {
  document.getElementById('imageFrame').innerHTML = '<div class="placeholder">Generating image...</div>';
  document.getElementById('imageMeta').textContent = '';
}

function renderImageError(msg) {
  document.getElementById('imageFrame').innerHTML = '<div class="placeholder panel-error">' + msg.replace(/</g, '&lt;') + '</div>';
  document.getElementById('imageMeta').textContent = '';
}

function renderImage(data) {
  var frame = document.getElementById('imageFrame');
  frame.innerHTML = '';
  var img = document.createElement('img');
  img.src = 'data:' + data.mime + ';base64,' + data.imageBase64;
  img.alt = 'Generated product image';
  frame.appendChild(img);
  var metaParts = [];
  if (data.dryRun) metaParts.push('dry run — placeholder image');
  if (typeof data.latencyS === 'number') metaParts.push(data.latencyS.toFixed(1) + 's');
  if (data.revisedPrompt) metaParts.push('prompt: ' + data.revisedPrompt);
  document.getElementById('imageMeta').textContent = metaParts.join(' · ');
}

function renderCopyLoading() {
  document.getElementById('copyBody').innerHTML = '<div class="copy-empty">Writing copy...</div>';
}

function renderCopyError(msg) {
  document.getElementById('copyBody').innerHTML = '<div class="panel-error">' + msg.replace(/</g, '&lt;') + '</div>';
}

function renderCopy(data) {
  var c = data.copy;
  var html = '';
  html += '<p class="copy-name">' + escapeText(c.name) + '</p>';
  if (c.tagline) html += '<p class="copy-tagline">' + escapeText(c.tagline) + '</p>';
  if (c.description) html += '<p class="copy-description">' + escapeText(c.description) + '</p>';
  if (c.bullets && c.bullets.length) {
    html += '<ul class="copy-bullets">';
    for (var i = 0; i < c.bullets.length; i++) {
      html += '<li>' + ${JSON.stringify(checkIconSvg())} + '<span>' + escapeText(c.bullets[i]) + '</span></li>';
    }
    html += '</ul>';
  }
  document.getElementById('copyBody').innerHTML = html;
  var metaParts = [];
  if (data.dryRun) metaParts.push('dry run — mock copy');
  if (typeof data.latencyS === 'number') metaParts.push(data.latencyS.toFixed(1) + 's');
  document.getElementById('copyMeta').textContent = metaParts.join(' · ');
}

function escapeText(s) {
  var div = document.createElement('div');
  div.textContent = s == null ? '' : s;
  return div.innerHTML;
}

async function runImage(idea) {
  renderImageLoading();
  try {
    var res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIdea: idea }),
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      renderImageError(data.error || ('Request failed with status ' + res.status));
      return;
    }
    renderImage(data);
  } catch (err) {
    renderImageError('Request failed: ' + err.message);
  }
}

async function runCopy(idea) {
  renderCopyLoading();
  try {
    var res = await fetch('/api/generate-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIdea: idea }),
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      renderCopyError(data.error || ('Request failed with status ' + res.status));
      return;
    }
    renderCopy(data);
  } catch (err) {
    renderCopyError('Request failed: ' + err.message);
  }
}

async function generateBoth() {
  if (busy) return;
  var idea = document.getElementById('ideaInput').value.trim();
  if (!idea) {
    setStatus('Type a one-line product idea first.');
    return;
  }
  lastIdea = idea;
  setBusy(true);
  setStatus('Generating image and copy in parallel...');

  var imagePromise = runImage(idea);
  var copyPromise = runCopy(idea);
  await Promise.all([imagePromise, copyPromise]);

  setBusy(false);
  setStatus('Done. Use Regenerate on either side to try again independently.');
}

async function regenerateImage() {
  if (busy) return;
  var idea = lastIdea || document.getElementById('ideaInput').value.trim();
  if (!idea) { setStatus('Type a one-line product idea first.'); return; }
  setBusy(true);
  setStatus('Regenerating image...');
  await runImage(idea);
  setBusy(false);
  setStatus('Image regenerated.');
}

async function regenerateCopy() {
  if (busy) return;
  var idea = lastIdea || document.getElementById('ideaInput').value.trim();
  if (!idea) { setStatus('Type a one-line product idea first.'); return; }
  setBusy(true);
  setStatus('Regenerating copy...');
  await runCopy(idea);
  setBusy(false);
  setStatus('Copy regenerated.');
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('generateBtn').addEventListener('click', generateBoth);
  document.getElementById('regenImageBtn').addEventListener('click', regenerateImage);
  document.getElementById('regenCopyBtn').addEventListener('click', regenerateCopy);
  document.getElementById('ideaInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') generateBoth();
  });
  var chips = document.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].addEventListener('click', function () {
      loadPreset(this.getAttribute('data-text'));
    });
  }
  setStatus('Type a product idea and click Generate.');
});
`;

const EXAMPLE_IDEAS = [
  'a minimalist ceramic pour-over coffee maker',
  'a foldable bamboo laptop stand',
  'a pair of noise-cancelling headphones for commuters',
];

function landingPage({ dryRun, hasKey, chatModel, imageModel }) {
  const chips = EXAMPLE_IDEAS.map((p) => `<button type="button" class="chip" data-text="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Build It Live — Product Image + Copy Generator</title><style>${PAGE_STYLE}</style></head><body>
<header>
  <div class="title-row">
    ${bagIconSvg()}
    <div>
      <h1>Build It Live${dryRun ? '<span class="mode-flag">dry run</span>' : ''}</h1>
      <p>DigitalOcean Serverless Inference — product image + marketing copy, generated side by side</p>
    </div>
  </div>
  <div class="pipeline">
    <span class="step">${sparkleIconSvg()} One-line product idea</span>
    <span class="step">${imageIconSvg()} DO images/generations</span>
    <span class="step">${chatBubbleIconSvg()} DO chat completions</span>
  </div>
</header>

<div class="wrap">
  <div class="panel">
    <div class="input-row">
      <input type="text" id="ideaInput" maxlength="${MAX_IDEA_LEN}" placeholder="e.g. a minimalist ceramic pour-over coffee maker">
      <button type="button" class="btn" id="generateBtn">${sparkleIconSvg()} Generate</button>
    </div>
    <div class="presets">${chips}</div>
    <div class="status-line" id="statusLine"></div>
    <div class="note">
      ${dryRun
        ? `Running in <strong>dry-run mode</strong>: copy is canned and the image is a locally generated placeholder gradient, not real AI output — no API calls, no cost. Set <code>DRY_RUN=false</code> and a valid <code>MODEL_ACCESS_KEY</code> to go live.`
        : hasKey
          ? `Running live — copy model <code>${escapeHtml(chatModel)}</code>, image model <code>${escapeHtml(imageModel)}</code>. Each generate/regenerate is a small real usage charge.`
          : `<strong>No MODEL_ACCESS_KEY is configured</strong> — live requests will fail. Set it as an app-level secret, or set DRY_RUN=true to demo with mock data.`}
    </div>
  </div>

  <div class="grid">
    <div class="panel">
      <div class="card-head">
        <span class="label">${imageIconSvg()} Product Image</span>
        <button type="button" class="regen-btn" id="regenImageBtn">${refreshIconSvg()} Regenerate</button>
      </div>
      <div class="image-frame" id="imageFrame"><div class="placeholder">${imageIconSvg()}<div>Your product image will appear here</div></div></div>
      <div class="image-meta" id="imageMeta"></div>
    </div>

    <div class="panel">
      <div class="card-head">
        <span class="label">${penIconSvg()} Marketing Copy</span>
        <button type="button" class="regen-btn" id="regenCopyBtn">${refreshIconSvg()} Regenerate</button>
      </div>
      <div id="copyBody"><div class="copy-empty">Your marketing copy will appear here</div></div>
      <div class="image-meta" id="copyMeta"></div>
    </div>
  </div>
</div>
<footer>Unofficial internal demo. Images and copy are AI-generated — review before using in a real store listing.</footer>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY || null;
const CHAT_MODEL = process.env.CHAT_MODEL || 'openai-gpt-oss-120b';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'openai-gpt-image-2';
const IMAGE_SIZE = process.env.IMAGE_SIZE || 'auto';
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'auto';
const IMAGE_OUTPUT_FORMAT = process.env.IMAGE_OUTPUT_FORMAT || 'jpeg';
const IMAGE_BACKGROUND = process.env.IMAGE_BACKGROUND || 'opaque';
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'solutions';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'champs';

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (err) {
    return false;
  }
  const sepIdx = decoded.indexOf(':');
  if (sepIdx === -1) return false;
  const user = decoded.slice(0, sepIdx);
  const pass = decoded.slice(sepIdx + 1);
  return user === AUTH_USERNAME && pass === AUTH_PASSWORD;
}

function requireAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Build It Live Demo"', 'Content-Type': 'text/plain' });
  res.end('Authentication required.');
}

function extractProductIdea(payload) {
  const idea = typeof payload.productIdea === 'string' ? payload.productIdea.trim() : '';
  return idea.slice(0, MAX_IDEA_LEN);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (!checkAuth(req)) {
      requireAuth(res);
      return;
    }

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingPage({ dryRun: DRY_RUN, hasKey: !!MODEL_ACCESS_KEY, chatModel: CHAT_MODEL, imageModel: IMAGE_MODEL }));
      return;
    }

    if (req.url === '/api/generate-image' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }
      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }
      const productIdea = extractProductIdea(payload);
      if (!productIdea) {
        sendJson(res, 400, { error: 'Field "productIdea" is required.' });
        return;
      }

      if (DRY_RUN) {
        sendJson(res, 200, {
          dryRun: true,
          imageBase64: generateMockProductPng(productIdea),
          mime: 'image/png',
          revisedPrompt: null,
          latencyS: 0.3 + Math.random() * 0.3,
          error: null,
        });
        return;
      }

      const result = await callImageGeneration({
        modelAccessKey: MODEL_ACCESS_KEY,
        baseUrl: BASE_URL,
        model: IMAGE_MODEL,
        prompt: buildImagePrompt(productIdea),
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        outputFormat: IMAGE_OUTPUT_FORMAT,
        background: IMAGE_BACKGROUND,
      });
      if (result.error) {
        console.error(`[image] model=${IMAGE_MODEL} error: ${result.error}`);
        sendJson(res, 502, { error: `Image generation failed: ${result.error}` });
        return;
      }
      sendJson(res, 200, {
        dryRun: false,
        imageBase64: result.imageBase64,
        mime: result.mime,
        revisedPrompt: result.revisedPrompt,
        latencyS: result.latency_s,
        error: null,
      });
      return;
    }

    if (req.url === '/api/generate-copy' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }
      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }
      const productIdea = extractProductIdea(payload);
      if (!productIdea) {
        sendJson(res, 400, { error: 'Field "productIdea" is required.' });
        return;
      }

      if (DRY_RUN) {
        sendJson(res, 200, { dryRun: true, copy: mockCopy(productIdea), latencyS: 0.25 + Math.random() * 0.2, error: null });
        return;
      }

      const result = await callChat({ modelAccessKey: MODEL_ACCESS_KEY, baseUrl: BASE_URL, model: CHAT_MODEL, productIdea });
      if (result.error) {
        console.error(`[copy] model=${CHAT_MODEL} error: ${result.error}`);
        sendJson(res, 502, { error: `Copy generation failed: ${result.error}` });
        return;
      }
      const parsed = parseCopyJson(result.content);
      const copy = normalizeCopy(parsed, result.content, productIdea);
      sendJson(res, 200, { dryRun: false, copy, latencyS: result.latency_s, error: null });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error — check app logs.');
  }
});

server.listen(PORT, () => {
  console.log(
    `Build-it-live demo listening on :${PORT} (DRY_RUN=${DRY_RUN}, key configured=${!!MODEL_ACCESS_KEY}, chatModel=${CHAT_MODEL}, imageModel=${IMAGE_MODEL})`
  );
});
