'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const handler = require('../api/audit');

const { normalizeUrl, isBlockedIpv4, isBlockedIp, sitemapFromRobots, requestPinned } = handler._test;

async function withServer(listener, callback) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await callback(new URL(`http://127.0.0.1:${port}/`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('normalizes a bare hostname to HTTPS', () => {
  assert.equal(normalizeUrl('example.com/path').toString(), 'https://example.com/path');
});

test('rejects unsafe protocols, credentials, and ports', () => {
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only HTTP/);
  assert.throws(() => normalizeUrl('https://user:pass@example.com'), /credentials/);
  assert.throws(() => normalizeUrl('https://example.com:8443'), /standard web ports/);
});

test('blocks private and reserved IPv4 ranges', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.51.100.5', '203.0.113.7', '224.0.0.1']) {
    assert.equal(isBlockedIpv4(ip), true, ip);
  }
  assert.equal(isBlockedIpv4('8.8.8.8'), false);
  assert.equal(isBlockedIpv4('1.1.1.1'), false);
});

test('blocks loopback, local IPv6, and mapped private IPv4', () => {
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fc00::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIp('64:ff9b::7f00:1'), true);
  assert.equal(isBlockedIp('2002:7f00:1::'), true);
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('uses robots sitemap when present and standard sitemap otherwise', () => {
  assert.equal(sitemapFromRobots('User-agent: *\nSitemap: https://example.com/map.xml', 'https://example.com'), 'https://example.com/map.xml');
  assert.equal(sitemapFromRobots('User-agent: *', 'https://example.com'), 'https://example.com/sitemap.xml');
});

test('enforces a wall-clock timeout across the complete response', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html>');
    setTimeout(() => res.end('</html>'), 250);
  }, async (url) => {
    await assert.rejects(
      requestPinned(url, { address: '127.0.0.1', family: 4 }, { limit: 1024, timeout: 60, accept: 'text/html' }),
      (error) => error && error.name === 'TimeoutError',
    );
  });
});

test('caps the decoded body of compressed responses', async () => {
  const compressed = zlib.gzipSync(Buffer.alloc(64 * 1024, 'x'));
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  }, async (url) => {
    await assert.rejects(
      requestPinned(url, { address: '127.0.0.1', family: 4 }, { limit: 1024, timeout: 1000, accept: 'text/html' }),
      /decoded limit/i,
    );
  });
});

test('returns a bounded partial HTML body when truncation is enabled', async () => {
  const compressed = zlib.gzipSync(Buffer.alloc(64 * 1024, 'x'));
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  }, async (url) => {
    const result = await requestPinned(url, { address: '127.0.0.1', family: 4 }, {
      limit: 1024, timeout: 1000, accept: 'text/html', truncate: true,
    });
    assert.equal(result.body.length, 1024);
    assert.equal(result.truncated, true);
  });
});
