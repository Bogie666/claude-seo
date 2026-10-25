'use strict';

const { parse } = require('node-html-parser');

const MAX_HTML_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 500_000;
const MAX_EVIDENCE_CHARS = 500;
const MAX_HEADINGS = 100;
const MAX_IMAGES = 2_000;
const MAX_LINKS = 5_000;

const CATEGORY_LABELS = {
  technical: 'Technical',
  onPage: 'On-page',
  content: 'Content',
  schema: 'Schema',
  ai: 'AI search',
  performance: 'Performance',
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clip(value, max = MAX_EVIDENCE_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseDocument(value) {
  return parse(String(value || '').slice(0, MAX_HTML_CHARS), {
    comment: false,
    lowerCaseTagName: true,
    blockTextElements: { script: true, style: true, pre: true, noscript: true },
  });
}

function attr(tag, name) {
  if (tag && typeof tag.getAttribute === 'function') return clip(tag.getAttribute(name) || '', 2_000);
  const root = parseDocument(String(tag || ''));
  const node = root.firstChild;
  return node && typeof node.getAttribute === 'function' ? clip(node.getAttribute(name) || '', 2_000) : '';
}

function safeCodePoint(value) {
  const point = Number(value);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
    ? String.fromCodePoint(point)
    : '\ufffd';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
}

function nodeText(node, max = MAX_EVIDENCE_CHARS) {
  return clip(decodeHtml(node && node.textContent ? node.textContent : ''), max);
}

function stripTags(value) {
  return nodeText(parseDocument(value), MAX_TEXT_CHARS);
}

function tagContents(html, tag) {
  return parseDocument(html).querySelectorAll(tag).slice(0, MAX_HEADINGS).map((node) => nodeText(node));
}

function tags(html, tag) {
  return parseDocument(html).querySelectorAll(tag).slice(0, MAX_LINKS);
}

function asRoot(value) {
  return typeof value === 'string' ? parseDocument(value) : value;
}

function metaContent(rootOrHtml, key, value) {
  const root = asRoot(rootOrHtml);
  const match = root.querySelectorAll('meta').slice(0, 500).find((node) => attr(node, key).toLowerCase() === value.toLowerCase());
  return match ? clip(attr(match, 'content'), 1_000) : '';
}

function linkHref(rootOrHtml, relValue) {
  const root = asRoot(rootOrHtml);
  const match = root.querySelectorAll('link').slice(0, 500).find((node) => attr(node, 'rel').toLowerCase().split(/\s+/).includes(relValue.toLowerCase()));
  return match ? clip(attr(match, 'href'), 2_000) : '';
}

function check({ id, category, status, title, detail, recommendation, evidence, weight = 1 }) {
  return {
    id: clip(id, 100),
    category,
    status,
    title: clip(title, 200),
    detail: clip(detail, 1_000),
    recommendation: clip(recommendation, 1_000),
    evidence: clip(evidence || '', MAX_EVIDENCE_CHARS),
    weight,
  };
}

function resultFor(condition, warningCondition = false) {
  if (condition) return 'pass';
  return warningCondition ? 'warning' : 'critical';
}

function scoreChecks(checks, category) {
  const selected = checks.filter((item) => item.category === category);
  const max = selected.reduce((sum, item) => sum + item.weight, 0) || 1;
  const earned = selected.reduce((sum, item) => {
    const factor = item.status === 'pass' ? 1 : item.status === 'warning' ? 0.5 : 0;
    return sum + item.weight * factor;
  }, 0);
  return clamp((earned / max) * 100);
}

function grade(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Needs work';
  return 'Critical';
}

function analyzePage(input) {
  const html = String(input.html || '').slice(0, MAX_HTML_CHARS);
  const root = parseDocument(html);
  const headers = Object.fromEntries(Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const title = nodeText(root.querySelector('title'), 300);
  const description = metaContent(root, 'name', 'description');
  const viewport = metaContent(root, 'name', 'viewport');
  const robotsMeta = metaContent(root, 'name', 'robots');
  const canonical = linkHref(root, 'canonical');
  const h1s = root.querySelectorAll('h1').slice(0, MAX_HEADINGS).map((node) => nodeText(node));
  const h2s = root.querySelectorAll('h2').slice(0, MAX_HEADINGS).map((node) => nodeText(node));
  const imageTags = root.querySelectorAll('img').slice(0, MAX_IMAGES);
  const missingAlt = imageTags.filter((node) => !attr(node, 'alt')).length;
  const links = root.querySelectorAll('a').slice(0, MAX_LINKS);
  const hrefs = links.map((node) => attr(node, 'href')).filter(Boolean);
  const host = new URL(input.finalUrl).hostname;
  const internalLinks = hrefs.filter((href) => {
    try { return new URL(href, input.finalUrl).hostname === host; } catch { return false; }
  }).length;
  const externalLinks = hrefs.length - internalLinks;
  const jsonLdTags = root.querySelectorAll('script').slice(0, 2_000).filter((node) => attr(node, 'type').toLowerCase() === 'application/ld+json').length;
  const language = attr(root.querySelector('html'), 'lang');
  const ogTitle = metaContent(root, 'property', 'og:title');
  const ogDescription = metaContent(root, 'property', 'og:description');
  const ogImage = metaContent(root, 'property', 'og:image');
  for (const selector of ['script', 'style', 'noscript']) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }
  const visibleText = nodeText(root, MAX_TEXT_CHARS);
  const words = visibleText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const checks = [];

  checks.push(check({
    id: 'https', category: 'technical', weight: 2,
    status: input.finalUrl.startsWith('https://') ? 'pass' : 'critical',
    title: 'HTTPS delivery',
    detail: input.finalUrl.startsWith('https://') ? 'The page is delivered over HTTPS.' : 'The page is not delivered over HTTPS.',
    recommendation: 'Redirect all HTTP requests to HTTPS and update internal references.', evidence: input.finalUrl,
  }));
  checks.push(check({
    id: 'status', category: 'technical', weight: 2,
    status: input.statusCode >= 200 && input.statusCode < 300 ? 'pass' : 'critical',
    title: 'HTTP status', detail: `The audited URL returned HTTP ${input.statusCode}.`,
    recommendation: 'Serve the canonical page with a successful 2xx status.', evidence: String(input.statusCode),
  }));
  checks.push(check({
    id: 'canonical', category: 'technical', weight: 2,
    status: canonical ? 'pass' : 'warning', title: 'Canonical URL',
    detail: canonical ? 'A canonical link is declared.' : 'No canonical link was found.',
    recommendation: 'Add one absolute, self-referencing canonical URL to the document head.', evidence: canonical,
  }));
  checks.push(check({
    id: 'robots-meta', category: 'technical', weight: 2,
    status: /noindex/i.test(robotsMeta) ? 'critical' : 'pass', title: 'Indexability directive',
    detail: /noindex/i.test(robotsMeta) ? `The page declares ${robotsMeta}.` : 'No page-level noindex directive was detected.',
    recommendation: 'Remove noindex from pages that should appear in search.', evidence: robotsMeta || 'indexable',
  }));
  checks.push(check({
    id: 'robots-file', category: 'technical', weight: 1,
    status: input.robots && input.robots.status === 200 ? 'pass' : 'warning', title: 'robots.txt',
    detail: input.robots && input.robots.status === 200 ? 'robots.txt is reachable.' : 'robots.txt was not confirmed.',
    recommendation: 'Publish a valid robots.txt at the site root.', evidence: input.robots ? String(input.robots.status) : '',
  }));
  checks.push(check({
    id: 'sitemap', category: 'technical', weight: 1,
    status: input.sitemap && input.sitemap.status === 200 ? 'pass' : 'warning', title: 'XML sitemap',
    detail: input.sitemap && input.sitemap.status === 200 ? 'An XML sitemap is reachable.' : 'No XML sitemap was confirmed at the standard location or in robots.txt.',
    recommendation: 'Publish an XML sitemap and reference it in robots.txt.', evidence: input.sitemap ? input.sitemap.url : '',
  }));
  checks.push(check({
    id: 'viewport', category: 'technical', weight: 1,
    status: viewport ? 'pass' : 'critical', title: 'Mobile viewport',
    detail: viewport ? 'A viewport meta tag is present.' : 'No viewport meta tag was found.',
    recommendation: 'Add a responsive viewport meta tag.', evidence: viewport,
  }));
  checks.push(check({
    id: 'language', category: 'technical', weight: 1,
    status: language ? 'pass' : 'warning', title: 'Document language',
    detail: language ? `The document language is ${language}.` : 'The html element has no lang attribute.',
    recommendation: 'Set the html lang attribute to the primary page language.', evidence: language,
  }));
  checks.push(check({
    id: 'hsts', category: 'technical', weight: 1,
    status: headers['strict-transport-security'] ? 'pass' : 'warning', title: 'HSTS header',
    detail: headers['strict-transport-security'] ? 'Strict-Transport-Security is enabled.' : 'No Strict-Transport-Security header was found.',
    recommendation: 'Enable HSTS after confirming HTTPS coverage.', evidence: headers['strict-transport-security'] || '',
  }));

  const titleStatus = resultFor(title.length >= 30 && title.length <= 60, title.length > 0);
  checks.push(check({
    id: 'title', category: 'onPage', weight: 3, status: titleStatus, title: 'Title tag',
    detail: title ? `The title is ${title.length} characters.` : 'No title tag was found.',
    recommendation: 'Write a unique, descriptive title of roughly 30 to 60 characters.', evidence: title,
  }));
  const descriptionStatus = resultFor(description.length >= 120 && description.length <= 165, description.length > 0);
  checks.push(check({
    id: 'description', category: 'onPage', weight: 2, status: descriptionStatus, title: 'Meta description',
    detail: description ? `The description is ${description.length} characters.` : 'No meta description was found.',
    recommendation: 'Write a compelling description of roughly 120 to 165 characters.', evidence: description,
  }));
  checks.push(check({
    id: 'h1', category: 'onPage', weight: 3,
    status: h1s.length === 1 ? 'pass' : h1s.length > 0 ? 'warning' : 'critical', title: 'Primary heading',
    detail: h1s.length === 1 ? 'The page has one H1.' : `The page has ${h1s.length} H1 elements.`,
    recommendation: 'Use one clear H1 that describes the primary page topic.', evidence: h1s.join(' | '),
  }));
  checks.push(check({
    id: 'headings', category: 'onPage', weight: 1,
    status: h2s.length > 0 ? 'pass' : 'warning', title: 'Heading structure',
    detail: h2s.length > 0 ? `${h2s.length} H2 headings help organize the page.` : 'No H2 headings were found.',
    recommendation: 'Use descriptive H2 headings to organize major sections.', evidence: h2s.slice(0, 5).join(' | '),
  }));
  checks.push(check({
    id: 'image-alt', category: 'onPage', weight: 2,
    status: missingAlt === 0 ? 'pass' : missingAlt <= Math.max(1, Math.floor(imageTags.length * 0.15)) ? 'warning' : 'critical', title: 'Image alternative text',
    detail: imageTags.length ? `${missingAlt} of ${imageTags.length} images are missing non-empty alt text.` : 'No images were detected.',
    recommendation: 'Add concise alt text to meaningful images and use empty alt attributes for decorative images.', evidence: `${missingAlt}/${imageTags.length}`,
  }));
  checks.push(check({
    id: 'social', category: 'onPage', weight: 1,
    status: ogTitle && ogDescription && ogImage ? 'pass' : 'warning', title: 'Social sharing metadata',
    detail: ogTitle && ogDescription && ogImage ? 'Core Open Graph tags are present.' : 'One or more core Open Graph tags are missing.',
    recommendation: 'Add og:title, og:description, and og:image metadata.', evidence: `${Boolean(ogTitle)}/${Boolean(ogDescription)}/${Boolean(ogImage)}`,
  }));

  checks.push(check({
    id: 'word-count', category: 'content', weight: 3,
    status: words.length >= 500 ? 'pass' : words.length >= 200 ? 'warning' : 'critical', title: 'Content depth',
    detail: `Approximately ${words.length.toLocaleString()} visible words were detected.`,
    recommendation: 'Expand thin pages with original, useful content that fully answers the target intent.', evidence: String(words.length),
  }));
  checks.push(check({
    id: 'internal-links', category: 'content', weight: 2,
    status: internalLinks >= 3 ? 'pass' : internalLinks > 0 ? 'warning' : 'critical', title: 'Internal links',
    detail: `${internalLinks} internal and ${externalLinks} external links were detected.`,
    recommendation: 'Add relevant internal links to important supporting and conversion pages.', evidence: `${internalLinks} internal`,
  }));
  checks.push(check({
    id: 'readability', category: 'content', weight: 1,
    status: words.length === 0 ? 'critical' : visibleText.length / words.length < 8 ? 'pass' : 'warning', title: 'Readable copy',
    detail: words.length ? 'The page has extractable text content.' : 'No meaningful visible copy was detected.',
    recommendation: 'Use concise sentences, descriptive headings, and scannable paragraphs.', evidence: `${visibleText.length} characters`,
  }));

  checks.push(check({
    id: 'json-ld', category: 'schema', weight: 3,
    status: jsonLdTags > 0 ? 'pass' : 'critical', title: 'JSON-LD structured data',
    detail: jsonLdTags > 0 ? `${jsonLdTags} JSON-LD block${jsonLdTags === 1 ? '' : 's'} detected.` : 'No JSON-LD structured data was detected.',
    recommendation: 'Add valid, page-specific Schema.org JSON-LD that matches visible content.', evidence: String(jsonLdTags),
  }));
  checks.push(check({
    id: 'schema-context', category: 'schema', weight: 1,
    status: /"@context"\s*:\s*"https?:\/\/schema\.org/i.test(html) ? 'pass' : 'warning', title: 'Schema.org context',
    detail: /"@context"\s*:\s*"https?:\/\/schema\.org/i.test(html) ? 'A Schema.org context was found.' : 'No Schema.org context was confirmed.',
    recommendation: 'Use https://schema.org as the JSON-LD context.', evidence: '',
  }));

  checks.push(check({
    id: 'llms-txt', category: 'ai', weight: 2,
    status: input.llms && input.llms.status === 200 ? 'pass' : 'warning', title: 'llms.txt discovery',
    detail: input.llms && input.llms.status === 200 ? 'llms.txt is reachable.' : 'No llms.txt file was confirmed.',
    recommendation: 'Consider publishing a concise llms.txt that points AI systems to authoritative content.', evidence: input.llms ? String(input.llms.status) : '',
  }));
  checks.push(check({
    id: 'quotable-content', category: 'ai', weight: 2,
    status: h2s.length >= 3 && words.length >= 500 ? 'pass' : h2s.length > 0 && words.length >= 200 ? 'warning' : 'critical', title: 'Quotable content structure',
    detail: 'AI citation readiness is estimated from content depth and descriptive section headings.',
    recommendation: 'Use clear question-led headings, direct answers, evidence, and attributable facts.', evidence: `${h2s.length} H2s, ${words.length} words`,
  }));
  checks.push(check({
    id: 'entity-signals', category: 'ai', weight: 1,
    status: jsonLdTags > 0 && canonical ? 'pass' : 'warning', title: 'Entity clarity',
    detail: jsonLdTags > 0 && canonical ? 'Canonical and structured-data signals support entity clarity.' : 'Entity signals are incomplete.',
    recommendation: 'Connect organization, author, service, product, and location entities with consistent schema and canonical URLs.', evidence: '',
  }));

  checks.push(check({
    id: 'response-time', category: 'performance', weight: 3,
    status: input.responseTimeMs <= 800 ? 'pass' : input.responseTimeMs <= 1800 ? 'warning' : 'critical', title: 'Server response time',
    detail: `The HTML response completed in ${input.responseTimeMs} ms from the audit region.`,
    recommendation: 'Reduce origin latency with caching, optimized server work, and a nearby CDN.', evidence: `${input.responseTimeMs} ms`,
  }));
  checks.push(check({
    id: 'html-size', category: 'performance', weight: 2,
    status: input.htmlBytes <= 200000 ? 'pass' : input.htmlBytes <= 500000 ? 'warning' : 'critical', title: 'HTML payload size',
    detail: input.htmlTruncated
      ? `The HTML payload exceeds the ${(input.htmlBytes / 1024).toFixed(1)} KB inspection limit.`
      : `The HTML payload is ${(input.htmlBytes / 1024).toFixed(1)} KB.`,
    recommendation: 'Reduce excessive inline data, unused markup, and server-rendered payload size.', evidence: `${input.htmlBytes} bytes`,
  }));
  checks.push(check({
    id: 'compression', category: 'performance', weight: 1,
    status: /gzip|br|zstd/i.test(headers['content-encoding'] || '') ? 'pass' : 'warning', title: 'HTML compression',
    detail: headers['content-encoding'] ? `Content encoding: ${headers['content-encoding']}.` : 'No HTML compression header was detected.',
    recommendation: 'Enable Brotli or gzip compression for text responses.', evidence: headers['content-encoding'] || '',
  }));
  checks.push(check({
    id: 'cache', category: 'performance', weight: 1,
    status: headers['cache-control'] ? 'pass' : 'warning', title: 'Caching policy',
    detail: headers['cache-control'] ? `Cache-Control: ${headers['cache-control']}.` : 'No Cache-Control header was detected.',
    recommendation: 'Define an intentional browser and CDN caching policy.', evidence: headers['cache-control'] || '',
  }));

  const categories = {};
  for (const key of Object.keys(CATEGORY_LABELS)) {
    categories[key] = { label: CATEGORY_LABELS[key], score: scoreChecks(checks, key) };
  }
  const overall = clamp(
    categories.technical.score * 0.25 +
    categories.onPage.score * 0.2 +
    categories.content.score * 0.15 +
    categories.schema.score * 0.15 +
    categories.ai.score * 0.1 +
    categories.performance.score * 0.15
  );
  const ordered = [...checks].sort((a, b) => {
    const priority = { critical: 0, warning: 1, pass: 2 };
    return priority[a.status] - priority[b.status] || b.weight - a.weight;
  });
  const counts = ordered.reduce((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { critical: 0, warning: 0, pass: 0 });

  return {
    schemaVersion: 1,
    id: input.id || `audit_${Date.now().toString(36)}`,
    source: 'live',
    url: input.requestedUrl,
    finalUrl: input.finalUrl,
    domain: host,
    auditedAt: input.auditedAt || new Date().toISOString(),
    overall: { score: overall, grade: grade(overall) },
    categories,
    counts,
    findings: ordered,
    page: {
      statusCode: input.statusCode,
      title,
      description,
      canonical,
      language,
      h1Count: h1s.length,
      h2Count: h2s.length,
      imageCount: imageTags.length,
      missingAlt,
      wordCount: words.length,
      internalLinks,
      externalLinks,
      jsonLdBlocks: jsonLdTags,
      responseTimeMs: input.responseTimeMs,
      htmlBytes: input.htmlBytes,
      htmlTruncated: Boolean(input.htmlTruncated),
    },
    limitations: [
      'This is a single-page synthetic audit from the Vercel region, not a full crawl.',
      'Core Web Vitals require field or Lighthouse data and are not inferred from response time.',
      'AI citation readiness is directional and should be validated against real visibility data.',
      ...(input.htmlTruncated ? ['The HTML response exceeded the bounded inspection limit; page-level findings use the first 1 MB.'] : []),
    ],
  };
}

module.exports = { analyzePage, CATEGORY_LABELS, attr, stripTags, scoreChecks };
