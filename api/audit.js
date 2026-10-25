'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Transform } = require('node:stream');
const zlib = require('node:zlib');
const ipaddr = require('ipaddr.js');
const { analyzePage } = require('../lib/audit-engine');

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_AUX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 12000;
const AUDIT_DEADLINE_MS = 25000;
const MAX_JSON_BYTES = 512 * 1024;
const USER_AGENT = 'ClaudeSEOAuditBot/1.0 (+https://github.com/Bogie666/claude-seo)';
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const requestsByIp = new Map();

function json(res, status, body) {
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) {
    status = 500;
    serialized = JSON.stringify({ error: 'The audit result exceeded the response-size limit.' });
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(serialized);
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) throw new Error('Enter a valid URL under 2,048 characters.');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(withProtocol); } catch { throw new Error('Enter a valid website URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not supported.');
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw new Error('Only standard web ports 80 and 443 are supported.');
  parsed.hash = '';
  return parsed;
}

function isBlockedIpv4(address) {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.kind() !== 'ipv4' || parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

function isBlockedIp(address) {
  try {
    const parsed = ipaddr.parse(String(address).replace(/^\[|\]$/g, ''));
    if (parsed.kind() === 'ipv4') return parsed.range() !== 'unicast';
    if (parsed.isIPv4MappedAddress && parsed.isIPv4MappedAddress()) return true;
    return parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function assertPublicUrl(parsed, deadline = Date.now() + REQUEST_TIMEOUT_MS) {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname === 'metadata.google.internal') {
    throw new Error('Private or local network targets are not allowed.');
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('Private or reserved IP targets are not allowed.');
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }
  const timeout = remainingMs(deadline);
  if (timeout < 1) throw Object.assign(new Error('The audit deadline was reached.'), { name: 'TimeoutError' });
  let records;
  try { records = await withTimeout(dns.lookup(hostname, { all: true, verbatim: true }), timeout, 'DNS resolution took too long.'); }
  catch (error) {
    if (error && error.name === 'TimeoutError') throw error;
    throw new Error('The hostname could not be resolved.');
  }
  if (!records.length || records.some((record) => isBlockedIp(record.address))) {
    throw new Error('The hostname resolves to a private or reserved network.');
  }
  return records[0];
}

function requestPinned(parsed, record, { limit, timeout, accept, truncate = false }) {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    let request;
    let response;
    let settled = false;
    const streams = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = (error) => {
      for (const stream of streams) {
        if (stream && !stream.destroyed) stream.destroy();
      }
      if (response && !response.destroyed) response.destroy();
      if (request && !request.destroyed) request.destroy();
      finish(error);
    };
    const timer = setTimeout(() => abort(Object.assign(new Error('The target took too long to respond.'), { name: 'TimeoutError' })), timeout);
    const lookup = (_hostname, options, callback) => {
      if (typeof options === 'function') callback = options;
      if (options && options.all) callback(null, [record]);
      else callback(null, record.address, record.family);
    };
    request = transport.request({
      protocol: parsed.protocol,
      hostname,
      servername: net.isIP(hostname) ? undefined : hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      lookup,
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'gzip, br, deflate' },
    }, (incoming) => {
      response = incoming;
      const status = response.statusCode || 0;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')]));
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        finish(null, { status, headers, body: Buffer.alloc(0) });
        return;
      }
      const contentLength = Number(headers['content-length'] || 0);
      if (!truncate && contentLength > limit) {
        abort(new Error(`The response exceeds the ${(limit / 1024 / 1024).toFixed(1)} MB audit limit.`));
        return;
      }
      let rawBytes = 0;
      const wireCounter = new Transform({
        transform(chunk, _encoding, callback) {
          rawBytes += chunk.length;
          if (rawBytes > limit) callback(new Error(`The response exceeds the ${(limit / 1024 / 1024).toFixed(1)} MB wire limit.`));
          else callback(null, chunk);
        },
      });
      streams.push(wireCounter);
      wireCounter.on('error', abort);
      let stream = response.pipe(wireCounter);
      const encodings = String(headers['content-encoding'] || '')
        .split(',').map((item) => item.trim().toLowerCase()).filter((item) => item && item !== 'identity');
      for (const encoding of encodings.reverse()) {
        let decoder;
        if (encoding === 'br') decoder = zlib.createBrotliDecompress();
        else if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
        else if (encoding === 'deflate') decoder = zlib.createInflate();
        else {
          abort(new Error(`Unsupported content encoding: ${encoding}.`));
          return;
        }
        streams.push(decoder);
        decoder.on('error', abort);
        stream = stream.pipe(decoder);
      }
      const chunks = [];
      let decodedBytes = 0;
      stream.on('data', (chunk) => {
        if (decodedBytes + chunk.length > limit && truncate) {
          const remaining = Math.max(0, limit - decodedBytes);
          if (remaining) chunks.push(chunk.subarray(0, remaining));
          decodedBytes += remaining;
          if (response && !response.destroyed) response.destroy();
          for (const item of streams) if (item && !item.destroyed) item.destroy();
          finish(null, { status, headers, body: Buffer.concat(chunks, decodedBytes), truncated: true });
          return;
        }
        decodedBytes += chunk.length;
        if (decodedBytes > limit) {
          abort(new Error(`The response exceeds the ${(limit / 1024 / 1024).toFixed(1)} MB decoded limit.`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => finish(null, { status, headers, body: Buffer.concat(chunks, decodedBytes), truncated: false }));
      stream.on('error', abort);
      response.on('error', abort);
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

async function safeFetch(rawUrl, {
  limit = MAX_HTML_BYTES,
  timeout = REQUEST_TIMEOUT_MS,
  deadline = Date.now() + timeout,
  maxRedirects = MAX_REDIRECTS,
  accept = 'text/html,application/xhtml+xml',
  truncate = false,
} = {}) {
  let current = normalizeUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const remaining = remainingMs(deadline);
    if (remaining < 1) throw Object.assign(new Error('The audit deadline was reached.'), { name: 'TimeoutError' });
    const record = await assertPublicUrl(current, deadline);
    const response = await requestPinned(current, record, { limit, timeout: Math.min(timeout, remainingMs(deadline)), accept, truncate });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error('The target returned a redirect without a location.');
      current = normalizeUrl(new URL(location, current).toString());
      continue;
    }
    return { response, body: response.body, url: current.toString() };
  }
  throw new Error(`The target exceeded the ${maxRedirects}-redirect limit.`);
}

async function fetchAuxiliary(url, accept, deadline) {
  if (remainingMs(deadline) < 1_500) return { status: 0, url: String(url), error: 'Skipped because the audit deadline was nearly reached.' };
  try {
    const result = await safeFetch(url, {
      limit: MAX_AUX_BYTES,
      timeout: Math.min(5_000, remainingMs(deadline)),
      deadline,
      maxRedirects: 1,
      accept,
    });
    return { status: result.response.status, url: result.url, text: result.body.toString('utf8', 0, 10000) };
  } catch (error) {
    return { status: 0, url: String(url), error: error.message };
  }
}

function sitemapFromRobots(text, origin) {
  const match = String(text || '').match(/^\s*Sitemap:\s*(\S+)/im);
  if (!match) return new URL('/sitemap.xml', origin).toString();
  try { return new URL(match[1], origin).toString(); }
  catch { return new URL('/sitemap.xml', origin).toString(); }
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req) {
  const now = Date.now();
  const key = getClientIp(req);
  const recent = (requestsByIp.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) return false;
  if (!requestsByIp.has(key) && requestsByIp.size >= 1000) {
    const oldest = requestsByIp.keys().next().value;
    if (oldest) requestsByIp.delete(oldest);
  }
  recent.push(now);
  requestsByIp.delete(key);
  requestsByIp.set(key, recent);
  for (const [ip, values] of requestsByIp.entries()) {
    if (!values.some((time) => now - time < WINDOW_MS)) requestsByIp.delete(ip);
  }
  return true;
}

function readRequestBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { ok: true, service: 'claude-seo-audit', schemaVersion: 1 });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!rateLimit(req)) return json(res, 429, { error: 'Audit rate limit reached. Try again in one minute.' });

  try {
    const raw = await readRequestBody(req);
    let payload;
    try { payload = JSON.parse(raw || '{}'); }
    catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
    const requested = normalizeUrl(payload.url);
    const started = Date.now();
    const deadline = started + AUDIT_DEADLINE_MS;
    const result = await safeFetch(requested.toString(), { deadline, truncate: true });
    const responseTimeMs = Date.now() - started;
    const contentType = result.response.headers['content-type'] || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return json(res, 422, { error: 'The target did not return an HTML document.' });
    }
    const finalUrl = new URL(result.url);
    const origin = finalUrl.origin;
    const robots = await fetchAuxiliary(new URL('/robots.txt', origin).toString(), 'text/plain,*/*', deadline);
    const sitemapUrl = sitemapFromRobots(robots.text, origin);
    const [sitemap, llms] = await Promise.all([
      fetchAuxiliary(sitemapUrl, 'application/xml,text/xml,*/*', deadline),
      fetchAuxiliary(new URL('/llms.txt', origin).toString(), 'text/plain,*/*', deadline),
    ]);
    const headers = result.response.headers;
    const audit = analyzePage({
      requestedUrl: requested.toString(),
      finalUrl: result.url,
      statusCode: result.response.status,
      headers,
      html: result.body.toString('utf8'),
      htmlBytes: result.body.length,
      htmlTruncated: Boolean(result.response.truncated),
      responseTimeMs,
      robots,
      sitemap,
      llms,
    });
    return json(res, 200, { audit });
  } catch (error) {
    const message = error && error.name === 'TimeoutError'
      ? 'The target took too long to respond.'
      : error && error.message ? error.message : 'The audit failed.';
    return json(res, 400, { error: message });
  }
}

module.exports = handler;
module.exports._test = { normalizeUrl, isBlockedIpv4, isBlockedIp, assertPublicUrl, sitemapFromRobots, safeFetch, requestPinned };
