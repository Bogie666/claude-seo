'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePage, attr, stripTags } = require('../lib/audit-engine');

const base = {
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  statusCode: 200,
  headers: {
    'content-encoding': 'br',
    'cache-control': 'public, max-age=300',
    'strict-transport-security': 'max-age=31536000',
  },
  htmlBytes: 24000,
  responseTimeMs: 420,
  robots: { status: 200, url: 'https://example.com/robots.txt' },
  sitemap: { status: 200, url: 'https://example.com/sitemap.xml' },
  llms: { status: 200, url: 'https://example.com/llms.txt' },
};

function healthyHtml() {
  const words = Array.from({ length: 540 }, (_, index) => `useful${index}`).join(' ');
  return `<!doctype html><html lang="en"><head>
    <title>Complete local SEO audit dashboard guide</title>
    <meta name="description" content="A complete and practical guide to auditing local search performance, technical SEO, structured data, content quality, and AI visibility for modern websites.">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="canonical" href="https://example.com/">
    <meta property="og:title" content="SEO guide"><meta property="og:description" content="Guide"><meta property="og:image" content="https://example.com/og.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
  </head><body><h1>Local SEO audit guide</h1><h2>Technical</h2><h2>Content</h2><h2>Schema</h2>
  <p>${words}</p><a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a>
  <img src="a.jpg" alt="Audit dashboard"></body></html>`;
}

test('attribute and text helpers parse common HTML', () => {
  assert.equal(attr('<meta name="description" content="Hello world">', 'content'), 'Hello world');
  assert.equal(stripTags('<strong>Hello</strong> &amp; goodbye'), 'Hello & goodbye');
});

test('healthy page receives structured scores and findings', () => {
  const audit = analyzePage({ ...base, html: healthyHtml() });
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.source, 'live');
  assert.equal(audit.domain, 'example.com');
  assert.ok(audit.overall.score >= 85, `score was ${audit.overall.score}`);
  assert.equal(audit.page.h1Count, 1);
  assert.equal(audit.page.missingAlt, 0);
  assert.equal(audit.counts.critical, 0);
  assert.ok(audit.findings.every((item) => ['pass', 'warning', 'critical'].includes(item.status)));
});

test('thin noindex page produces critical prioritized findings', () => {
  const html = '<html><head><meta name="robots" content="noindex"><title>Short</title></head><body><p>Hello</p></body></html>';
  const audit = analyzePage({ ...base, html, llms: { status: 404 }, sitemap: { status: 404 }, robots: { status: 404 } });
  assert.ok(audit.overall.score < 60, `score was ${audit.overall.score}`);
  assert.ok(audit.counts.critical >= 5);
  assert.equal(audit.findings[0].status, 'critical');
  assert.ok(audit.findings.some((item) => item.id === 'robots-meta' && item.status === 'critical'));
});

test('audit result is JSON serializable', () => {
  const audit = analyzePage({ ...base, html: healthyHtml() });
  const roundTrip = JSON.parse(JSON.stringify(audit));
  assert.equal(roundTrip.overall.score, audit.overall.score);
  assert.equal(roundTrip.findings.length, audit.findings.length);
});
