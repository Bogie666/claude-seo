(() => {
  'use strict';

  const STORAGE_KEY = 'claudeSeoAuditHistoryV1';
  const MAX_HISTORY = 20;
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const CATEGORY_LABELS = {
    technical: 'Technical', onPage: 'On-page', content: 'Content',
    schema: 'Schema', ai: 'AI search', performance: 'Performance',
  };
  const state = {
    audit: null,
    view: 'overview',
    severity: 'all',
    importContent: '',
    loadingTimer: null,
    operationId: 0,
    auditController: null,
  };
  const $ = (id) => document.getElementById(id);
  const els = {
    auditForm: $('auditForm'), auditUrl: $('auditUrl'), emptyState: $('emptyState'), loadingState: $('loadingState'),
    dashboard: $('dashboard'), loadingDomain: $('loadingDomain'), loadingMessage: $('loadingMessage'),
    loadingProgress: $('loadingProgress'), loadingSteps: $('loadingSteps'), progressTrack: document.querySelector('.progress-track'),
    historyList: $('historyList'), clearHistoryButton: $('clearHistoryButton'), issuesNavCount: $('issuesNavCount'),
    importDialog: $('importDialog'), importButton: $('importButton'), emptyImportButton: $('emptyImportButton'),
    reportFile: $('reportFile'), reportText: $('reportText'), dropZone: $('dropZone'), processImportButton: $('processImportButton'),
    toast: $('toast'), mobileMenuButton: $('mobileMenuButton'), sidebarCloseButton: $('sidebarCloseButton'),
    mobileOverlay: $('mobileOverlay'), sidebar: $('sidebar'), mainColumn: document.querySelector('.main-column'),
    exportButton: $('exportButton'), reportExportButton: $('reportExportButton'), emptyRunButton: $('emptyRunButton'),
    rerunButton: $('rerunButton'), sourceBadge: $('sourceBadge'), auditTimestamp: $('auditTimestamp'),
    reportDomain: $('reportDomain'), reportUrl: $('reportUrl'), scoreRing: $('scoreRing'), overallScore: $('overallScore'),
    overallGrade: $('overallGrade'), scoreSummary: $('scoreSummary'), criticalCount: $('criticalCount'),
    warningCount: $('warningCount'), passCount: $('passCount'), categoryGrid: $('categoryGrid'),
    findingsTitle: $('findingsTitle'), findingsList: $('findingsList'), pageFacts: $('pageFacts'),
    limitationsList: $('limitationsList'), severityFilters: $('severityFilters'),
    runButton: document.querySelector('#auditForm .run-button'),
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch { return ''; }
  }

  function scoreColor(score) {
    if (score == null) return '#9aa1af';
    if (score >= 80) return '#1d9b72';
    if (score >= 60) return '#dc8d27';
    return '#e95d65';
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
    } catch { return 'Unknown date'; }
  }

  function formatNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : 'Unavailable';
  }

  function toast(message, error = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', error);
    els.toast.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('is-visible'), 3200);
  }

  function isStoredAudit(item) {
    return Boolean(
      item && typeof item === 'object' && typeof item.id === 'string' && item.id.length <= 200 &&
      item.overall && typeof item.overall === 'object' && Array.isArray(item.findings) &&
      item.findings.length <= 500 && item.findings.every((finding) => finding && typeof finding === 'object'),
    );
  }

  function history() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(isStoredAudit).slice(0, MAX_HISTORY) : [];
    } catch { return []; }
  }

  function saveHistory(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
      return true;
    } catch {
      toast('The browser could not save this audit. Export it before leaving.', true);
      return false;
    }
  }

  function saveAudit(audit) {
    const items = history().filter((item) => item.id !== audit.id);
    items.unshift(audit);
    saveHistory(items);
    renderHistory();
  }

  function deleteAudit(id) {
    saveHistory(history().filter((item) => item.id !== id));
    if (state.audit && state.audit.id === id) showEmpty();
    renderHistory();
  }

  function renderHistory() {
    const items = history();
    if (!items.length) {
      els.historyList.innerHTML = '<p class="history-empty">No saved audits yet.</p>';
      return;
    }
    els.historyList.innerHTML = items.map((audit) => {
      const score = audit.overall && Number.isFinite(Number(audit.overall.score)) ? Math.round(audit.overall.score) : '--';
      return `<div class="history-item ${state.audit && state.audit.id === audit.id ? 'is-active' : ''}" data-id="${escapeHtml(audit.id)}">
        <button class="history-open" data-action="open" title="Open ${escapeHtml(audit.domain || 'audit')}">
          <span class="history-score">${escapeHtml(score)}</span>
          <span><strong>${escapeHtml(audit.domain || audit.title || 'Imported report')}</strong><small>${escapeHtml(formatDate(audit.auditedAt))}</small></span>
        </button>
        <button class="history-delete" data-action="delete" aria-label="Delete ${escapeHtml(audit.domain || audit.title || 'imported')} audit" title="Delete audit">×</button>
      </div>`;
    }).join('');
  }

  function showEmpty() {
    cancelPendingAudit();
    state.audit = null;
    els.emptyState.hidden = false;
    els.loadingState.hidden = true;
    els.dashboard.hidden = true;
    els.exportButton.disabled = true;
    els.issuesNavCount.textContent = '0';
    renderHistory();
  }

  function startLoading(url) {
    clearInterval(state.loadingTimer);
    els.emptyState.hidden = true;
    els.dashboard.hidden = true;
    els.loadingState.hidden = false;
    let domain = url;
    try { domain = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname; } catch {}
    els.loadingDomain.textContent = domain || 'Inspecting website';
    const stages = [
      { progress: 14, message: 'Connecting to the target and validating the response.' },
      { progress: 38, message: 'Inspecting metadata, headings, links, and indexability.' },
      { progress: 61, message: 'Checking schema, AI discovery, and content signals.' },
      { progress: 82, message: 'Scoring each discipline and prioritizing findings.' },
    ];
    let index = 0;
    const update = () => {
      const stage = stages[Math.min(index, stages.length - 1)];
      els.loadingProgress.style.width = `${stage.progress}%`;
      els.progressTrack.setAttribute('aria-valuenow', String(stage.progress));
      els.loadingMessage.textContent = stage.message;
      [...els.loadingSteps.children].forEach((child, childIndex) => child.classList.toggle('is-current', childIndex === Math.min(index, 3)));
      index += 1;
    };
    update();
    state.loadingTimer = setInterval(update, 2300);
  }

  function stopLoading() {
    clearInterval(state.loadingTimer);
    state.loadingTimer = null;
    els.loadingProgress.style.width = '100%';
    els.progressTrack.setAttribute('aria-valuenow', '100');
  }

  function cancelPendingAudit() {
    state.operationId += 1;
    if (state.auditController) state.auditController.abort();
    state.auditController = null;
    els.runButton.disabled = false;
    els.runButton.querySelector('span').textContent = 'Run audit';
  }

  async function runAudit(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) {
      toast('Enter a website URL first.', true);
      els.auditUrl.focus();
      return;
    }
    const previousAudit = state.audit;
    cancelPendingAudit();
    const operationId = ++state.operationId;
    const controller = new AbortController();
    state.auditController = controller;
    els.runButton.disabled = true;
    els.runButton.querySelector('span').textContent = 'Auditing';
    startLoading(url);
    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      let payload;
      try { payload = await response.json(); } catch { payload = {}; }
      if (operationId !== state.operationId) return;
      if (!response.ok || !payload.audit) throw new Error(payload.error || `Audit failed with HTTP ${response.status}.`);
      stopLoading();
      setAudit(payload.audit, true, false);
      toast(`Audit complete: ${payload.audit.overall.score}/100.`);
    } catch (error) {
      if (operationId !== state.operationId || error.name === 'AbortError') return;
      stopLoading();
      if (previousAudit) setAudit(previousAudit, false, false);
      else showEmpty();
      toast(error.message || 'The live audit failed.', true);
    } finally {
      if (operationId === state.operationId) {
        state.auditController = null;
        els.runButton.disabled = false;
        els.runButton.querySelector('span').textContent = 'Run audit';
      }
    }
  }

  function setAudit(audit, persist = false, cancelPending = true) {
    if (cancelPending) cancelPendingAudit();
    state.audit = audit;
    state.view = 'overview';
    state.severity = 'all';
    els.auditUrl.value = audit.url || audit.finalUrl || '';
    if (persist) saveAudit(audit);
    els.emptyState.hidden = true;
    els.loadingState.hidden = true;
    els.dashboard.hidden = false;
    els.exportButton.disabled = false;
    document.querySelectorAll('.nav-item').forEach((item) => {
      const active = item.dataset.view === 'overview';
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.querySelectorAll('.filter-chip').forEach((item) => {
      const active = item.dataset.severity === 'all';
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderAudit();
    renderHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderAudit() {
    const audit = state.audit;
    if (!audit) return;
    const score = audit.overall && Number.isFinite(Number(audit.overall.score)) ? Math.round(audit.overall.score) : null;
    const sourceLabel = audit.source === 'live' ? 'Live audit' : 'Imported report';
    els.sourceBadge.textContent = sourceLabel;
    els.sourceBadge.classList.toggle('imported', audit.source !== 'live');
    els.auditTimestamp.textContent = formatDate(audit.auditedAt);
    els.reportDomain.textContent = audit.domain || audit.title || 'Imported SEO audit';
    const link = safeUrl(audit.finalUrl || audit.url);
    els.reportUrl.textContent = link || 'No audited URL included';
    if (link) {
      els.reportUrl.href = link;
      els.reportUrl.removeAttribute('tabindex');
    } else {
      els.reportUrl.removeAttribute('href');
      els.reportUrl.setAttribute('tabindex', '-1');
    }
    els.rerunButton.hidden = !link;
    els.rerunButton.disabled = !link;
    els.overallScore.textContent = score == null ? '--' : score;
    els.overallGrade.textContent = audit.overall && audit.overall.grade ? audit.overall.grade : 'Imported';
    els.scoreRing.style.setProperty('--score', score || 0);
    els.scoreRing.style.setProperty('--ring-color', scoreColor(score));
    const counts = audit.counts || countFindings(audit.findings || []);
    els.criticalCount.textContent = counts.critical || 0;
    els.warningCount.textContent = counts.warning || 0;
    els.passCount.textContent = counts.pass || 0;
    els.issuesNavCount.textContent = (counts.critical || 0) + (counts.warning || 0);
    els.scoreSummary.textContent = score == null
      ? 'This imported report did not include a numeric score.'
      : `${counts.critical || 0} critical and ${counts.warning || 0} warning findings shape this score.`;
    renderCategories();
    renderFindings();
    renderFacts();
    renderLimitations();
    applyView();
  }

  function renderCategories() {
    const categories = state.audit.categories || {};
    els.categoryGrid.innerHTML = Object.entries(CATEGORY_LABELS).map(([key, label]) => {
      const value = categories[key] && categories[key].score;
      const raw = value == null ? Number.NaN : Number(value);
      const score = Number.isFinite(raw) ? Math.round(raw) : null;
      return `<button class="category-card" data-category="${key}" title="Show ${escapeHtml(label)} findings">
        <span class="category-top"><span>${escapeHtml(label)}</span><strong>${score == null ? '--' : score}</strong></span>
        <span class="meter" style="--meter-color:${scoreColor(score)}"><span style="width:${score || 0}%"></span></span>
      </button>`;
    }).join('');
  }

  function visibleFindings() {
    let findings = Array.isArray(state.audit.findings) ? state.audit.findings : [];
    if (!['overview', 'issues'].includes(state.view)) findings = findings.filter((item) => item.category === state.view);
    if (state.view === 'issues' && state.severity === 'all') findings = findings.filter((item) => item.status !== 'pass');
    if (state.severity !== 'all') findings = findings.filter((item) => item.status === state.severity);
    return findings;
  }

  function renderFindings() {
    const findings = visibleFindings();
    const category = CATEGORY_LABELS[state.view];
    els.findingsTitle.textContent = category ? `${category} findings` : state.view === 'issues' ? 'All issues' : 'Prioritized findings';
    if (!findings.length) {
      els.findingsList.innerHTML = '<div class="no-findings">No findings match the selected filters.</div>';
      return;
    }
    const symbol = { critical: '!', warning: '△', pass: '✓' };
    els.findingsList.innerHTML = findings.map((finding) => `<article class="finding">
      <span class="status-mark ${escapeHtml(finding.status)}">${symbol[finding.status] || '•'}</span>
      <div class="finding-body">
        <div class="finding-title-row"><strong>${escapeHtml(finding.title || 'Finding')}</strong><span class="category-pill">${escapeHtml(CATEGORY_LABELS[finding.category] || finding.category || 'General')}</span></div>
        <p>${escapeHtml(finding.detail || '')}</p>
        ${(finding.recommendation || finding.evidence) ? `<details><summary>View recommendation</summary>
          ${finding.recommendation ? `<p class="recommendation">${escapeHtml(finding.recommendation)}</p>` : ''}
          ${finding.evidence ? `<p class="evidence">Evidence: ${escapeHtml(finding.evidence)}</p>` : ''}
        </details>` : ''}
      </div>
      <span class="finding-severity">${escapeHtml(finding.status || 'info')}</span>
    </article>`).join('');
  }

  function renderFacts() {
    const page = state.audit.page || {};
    const facts = state.audit.source === 'live' ? [
      ['HTTP status', page.statusCode], ['Response time', page.responseTimeMs != null ? `${page.responseTimeMs} ms` : null],
      ['HTML size', page.htmlBytes != null ? `${(page.htmlBytes / 1024).toFixed(1)} KB` : null], ['Visible words', page.wordCount],
      ['H1 headings', page.h1Count], ['Images', page.imageCount], ['Missing alt', page.missingAlt],
      ['Internal links', page.internalLinks], ['JSON-LD blocks', page.jsonLdBlocks],
    ] : [
      ['Source', 'Imported file or paste'], ['Report title', state.audit.title || state.audit.domain],
      ['Findings', (state.audit.findings || []).length], ['Imported', formatDate(state.audit.auditedAt)],
    ];
    els.pageFacts.innerHTML = facts.filter(([, value]) => value != null && value !== '').map(([label, value]) => `<div class="fact-row"><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(formatNumberMaybe(value))}</dd></div>`).join('');
  }

  function formatNumberMaybe(value) {
    return typeof value === 'number' ? formatNumber(value) : value;
  }

  function renderLimitations() {
    const defaults = state.audit.source === 'live'
      ? ['Single-page audit, not a full site crawl.', 'Synthetic response timing, not field Core Web Vitals.', 'AI visibility score is directional.']
      : ['Imported content is interpreted heuristically.', 'Unknown report fields remain unavailable.', 'Report history is local to this browser.'];
    const items = Array.isArray(state.audit.limitations) && state.audit.limitations.length ? state.audit.limitations : defaults;
    els.limitationsList.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  }

  function applyView() {
    const isOverview = state.view === 'overview';
    document.querySelectorAll('[data-section="overview"]').forEach((element) => { element.hidden = !isOverview; });
    const contentGrid = document.querySelector('.content-grid');
    if (contentGrid) contentGrid.classList.toggle('single-column', !isOverview);
    document.querySelectorAll('.nav-item').forEach((item) => {
      const active = item.dataset.view === state.view;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    });
    renderFindings();
  }

  function countFindings(findings) {
    return findings.reduce((counts, finding) => {
      if (Object.prototype.hasOwnProperty.call(counts, finding.status)) counts[finding.status] += 1;
      return counts;
    }, { critical: 0, warning: 0, pass: 0 });
  }

  function inferCategory(text) {
    const value = text.toLowerCase();
    if (/schema|json-ld|structured data|rich result/.test(value)) return 'schema';
    if (/ai search|geo|llms\.txt|citation|crawler/.test(value)) return 'ai';
    if (/speed|performance|core web|lcp|cls|inp|payload/.test(value)) return 'performance';
    if (/content|e-e-a-t|readability|thin|word count|authority/.test(value)) return 'content';
    if (/title|description|heading|h1|image|alt text|canonical/.test(value)) return 'onPage';
    return 'technical';
  }

  function inferStatus(text) {
    const value = String(text || '').toLowerCase();
    if (/\b(?:no|without|zero)\s+(?:items?\s+)?(?:are\s+)?(?:missing|blocked|failed|errors?)\b|\ball\b.{0,40}\bpass(?:ed)?\b/.test(value)) return 'pass';
    if (/\bpass(?:ed)?\b|\bvalid\b|\bgood\b|\bok\b|\bsuccess(?:ful)?\b/.test(value) && !/\bnot\s+(?:valid|good|ok)\b/.test(value)) return 'pass';
    if (/\bcritical\b|\berror\b|\bfail(?:ed)?\b|\bmissing\b|\bblocked\b|\bhigh\s+(?:priority|severity|risk)\b/.test(value)) return 'critical';
    if (/\bwarning\b|\bwarn\b|\bimprove\b|\brecommend|\bmedium\s+(?:priority|severity|risk)\b|\blow\s+(?:priority|severity|risk)\b/.test(value)) return 'warning';
    return 'warning';
  }

  function grade(score) {
    if (score == null) return 'Imported';
    if (score >= 90) return 'Excellent';
    if (score >= 75) return 'Good';
    if (score >= 60) return 'Needs work';
    return 'Critical';
  }

  function scoreFromFindings(findings, category) {
    const selected = findings.filter((item) => item.category === category);
    if (!selected.length) return null;
    const value = selected.reduce((sum, item) => sum + (item.status === 'pass' ? 100 : item.status === 'warning' ? 55 : 15), 0) / selected.length;
    return Math.round(value);
  }

  function importText(value, max = 2_000) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }

  function normalizeFinding(item, index) {
    if (typeof item === 'string') item = { title: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const merged = [item.title, item.name, item.detail, item.description, item.message, item.recommendation, item.fix, item.action].filter(Boolean).join(' ');
    if (!merged.trim()) return null;
    const rawCategory = String(item.category || '').replace(/[\s_-]+/g, '').toLowerCase();
    const categoryMap = { technical: 'technical', onpage: 'onPage', content: 'content', schema: 'schema', ai: 'ai', aisearch: 'ai', geo: 'ai', performance: 'performance' };
    const rawStatus = String(item.status || item.severity || '').toLowerCase();
    const statusMap = { critical: 'critical', high: 'critical', error: 'critical', failed: 'critical', fail: 'critical', warning: 'warning', warn: 'warning', medium: 'warning', low: 'warning', info: 'warning', pass: 'pass', passed: 'pass', success: 'pass', good: 'pass' };
    return {
      id: importText(item.id || `imported-${index + 1}`, 120),
      category: categoryMap[rawCategory] || inferCategory(merged),
      status: statusMap[rawStatus] || inferStatus(merged),
      title: importText(item.title || item.name || `Imported finding ${index + 1}`, 200),
      detail: importText(item.detail || item.description || item.message || merged, 2_000),
      recommendation: importText(item.recommendation || item.fix || item.action || '', 2_000),
      evidence: importText(item.evidence || '', 1_000),
      weight: Math.max(0.1, Math.min(10, Number(item.weight) || 1)),
    };
  }

  function normalizeJsonReport(parsed) {
    let candidate = parsed && parsed.audit ? parsed.audit : parsed;
    if (Array.isArray(candidate)) candidate = { title: 'Imported SEO findings', findings: candidate };
    if (!candidate || typeof candidate !== 'object') throw new Error('The JSON report must be an object or an array of findings.');
    const rawFindings = candidate.findings || candidate.issues || candidate.recommendations;
    if (!rawFindings || (typeof rawFindings !== 'object' && !Array.isArray(rawFindings))) {
      throw new Error('The JSON report does not contain findings, issues, or recommendations.');
    }
    const values = Array.isArray(rawFindings) ? rawFindings : Object.values(rawFindings);
    if (values.length > 500) throw new Error('JSON reports can contain at most 500 findings.');
    const findings = values.map(normalizeFinding).filter(Boolean);
    if (!findings.length) throw new Error('The JSON report did not contain any usable findings.');
    const audit = buildImportedAudit({
      title: importText(candidate.title || candidate.name || 'Imported SEO report', 200),
      url: safeUrl(candidate.url || candidate.finalUrl || ''),
      score: Number(candidate.score ?? candidate.overallScore ?? candidate.overall?.score),
      findings,
    });
    if (Array.isArray(candidate.limitations)) audit.limitations = candidate.limitations.slice(0, 20).map((item) => importText(item, 500)).filter(Boolean);
    return audit;
  }

  function parseMarkdownReport(text) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Paste report content or choose a file first.');
    const heading = importText((clean.match(/^#\s+(.+)$/m) || [])[1] || 'Imported SEO report', 200);
    const explicitUrl = clean.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:audited\s+url|target\s+url|website|site|url)(?:\*\*)?\s*:\s*<?(https?:\/\/[^\s)>\]]+)/im);
    const url = explicitUrl ? safeUrl(explicitUrl[1]) : '';
    const scoreMatch = clean.match(/(?:overall\s+(?:seo\s+)?score|score)\s*[:|-]?\s*(\d{1,3})(?:\s*\/\s*100|%)/i);
    let section = '';
    const findings = [];
    for (const line of clean.split(/\r?\n/)) {
      const sectionMatch = line.match(/^#{2,4}\s+(.+)$/);
      if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
      const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (!bullet) continue;
      const value = bullet[1].replace(/^\[[ xX]\]\s*/, '').replace(/^\*\*(.*?)\*\*[: ]*/, '$1: ').trim();
      if (value.length < 8) continue;
      const merged = `${section} ${value}`;
      const split = value.split(/:\s+/, 2);
      findings.push({
        id: `imported-${findings.length + 1}`,
        category: inferCategory(merged), status: inferStatus(merged),
        title: split.length > 1 && split[0].length < 90 ? split[0] : (section || `Finding ${findings.length + 1}`),
        detail: split.length > 1 ? split[1] : value,
        recommendation: /recommend|fix|action|should|add|remove|improve/i.test(value) ? value : '',
        evidence: section, weight: 1,
      });
      if (findings.length >= 150) break;
    }
    if (findings.length < 150) {
      for (const line of clean.split(/\r?\n/)) {
        if (!/^\s*\|.+\|\s*$/.test(line)) continue;
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
        if (/^(?:issue|finding|check|status|severity|category)$/i.test(cells[0])) continue;
        const value = cells.join(': ');
        if (value.length < 8) continue;
        findings.push({
          id: `imported-${findings.length + 1}`,
          category: inferCategory(`${section} ${value}`),
          status: inferStatus(value),
          title: importText(cells[0], 200),
          detail: importText(cells.slice(1).join(' | '), 2_000),
          recommendation: /recommend|fix|action|should|add|remove|improve/i.test(value) ? importText(value, 2_000) : '',
          evidence: importText(section, 500),
          weight: 1,
        });
        if (findings.length >= 150) break;
      }
    }
    if (!findings.length) {
      const paragraphs = clean.split(/\n\s*\n/).map((item) => item.replace(/^#+\s*/gm, '').trim()).filter((item) => item.length > 20).slice(0, 30);
      paragraphs.forEach((paragraph, index) => findings.push({ id: `imported-${index + 1}`, category: inferCategory(paragraph), status: inferStatus(paragraph), title: `Report note ${index + 1}`, detail: paragraph, recommendation: '', evidence: '', weight: 1 }));
    }
    return buildImportedAudit({ title: heading, url, score: scoreMatch ? Number(scoreMatch[1]) : NaN, findings });
  }

  function buildImportedAudit({ title, url, score, findings }) {
    const categories = {};
    for (const [key, label] of Object.entries(CATEGORY_LABELS)) categories[key] = { label, score: scoreFromFindings(findings, key) };
    const categoryScores = Object.values(categories).map((item) => item.score).filter(Number.isFinite);
    const normalizedScore = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : categoryScores.length ? Math.round(categoryScores.reduce((a, b) => a + b, 0) / categoryScores.length) : null;
    const safeReportUrl = safeUrl(url);
    const safeTitle = importText(title || 'Imported SEO report', 200);
    return {
      schemaVersion: 1, id: `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      source: 'import', title: safeTitle, url: safeReportUrl, finalUrl: safeReportUrl, domain: domainFrom(safeReportUrl) || safeTitle, auditedAt: new Date().toISOString(),
      overall: { score: normalizedScore, grade: grade(normalizedScore) }, categories,
      counts: countFindings(findings), findings,
      page: {}, limitations: ['Imported report content is normalized heuristically.', 'Fields not present in the source remain unavailable.', 'This report is stored only in this browser unless exported.'],
    };
  }

  function domainFrom(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function importContent(content) {
    const text = String(content || '').trim();
    if (!text) throw new Error('Paste report content or choose a file first.');
    let audit;
    if (/^[\[{]/.test(text)) {
      try { audit = normalizeJsonReport(JSON.parse(text)); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error('The JSON report is not valid.');
        throw error;
      }
    } else {
      audit = parseMarkdownReport(text);
    }
    setAudit(audit, true);
    els.importDialog.close();
    els.reportText.value = '';
    els.reportFile.value = '';
    state.importContent = '';
    toast(`Imported ${audit.findings.length} findings.`);
  }

  function exportAudit() {
    if (!state.audit) return;
    const blob = new Blob([JSON.stringify(state.audit, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `claude-seo-${(state.audit.domain || 'audit').replace(/[^a-z0-9.-]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Audit exported as JSON.');
  }

  async function readFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Report files must be 2 MB or smaller.');
    state.importContent = await file.text();
    els.reportText.value = state.importContent;
    toast(`${file.name} is ready to import.`);
  }

  function openImport() {
    if (typeof els.importDialog.showModal === 'function') els.importDialog.showModal();
    else els.importDialog.setAttribute('open', '');
  }

  const mobileMedia = window.matchMedia('(max-width: 1050px)');

  function setMobileMenu(open, returnFocus = false) {
    const mobile = mobileMedia.matches;
    const shouldOpen = mobile && Boolean(open);
    document.body.classList.toggle('menu-open', shouldOpen);
    els.mobileMenuButton.setAttribute('aria-expanded', String(shouldOpen));
    els.sidebar.inert = mobile && !shouldOpen;
    els.mainColumn.inert = shouldOpen;
    if (shouldOpen) {
      window.requestAnimationFrame(() => els.sidebarCloseButton.focus());
    } else if (returnFocus && mobile) {
      window.requestAnimationFrame(() => els.mobileMenuButton.focus());
    }
  }

  function syncMobileMenu() {
    setMobileMenu(false, false);
  }

  els.auditForm.addEventListener('submit', (event) => { event.preventDefault(); runAudit(els.auditUrl.value); });
  els.emptyRunButton.addEventListener('click', () => els.auditUrl.focus());
  els.importButton.addEventListener('click', openImport);
  els.emptyImportButton.addEventListener('click', openImport);
  els.exportButton.addEventListener('click', exportAudit);
  els.reportExportButton.addEventListener('click', exportAudit);
  els.rerunButton.addEventListener('click', () => runAudit(state.audit && (state.audit.finalUrl || state.audit.url)));
  els.mobileMenuButton.addEventListener('click', () => setMobileMenu(true));
  els.sidebarCloseButton.addEventListener('click', () => setMobileMenu(false, true));
  els.mobileOverlay.addEventListener('click', () => setMobileMenu(false, true));
  mobileMedia.addEventListener('change', syncMobileMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('menu-open')) setMobileMenu(false, true);
  });

  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    if (!state.audit) { toast('Run or import an audit first.'); return; }
    state.view = item.dataset.view;
    setMobileMenu(false, false);
    applyView();
  }));

  els.severityFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-severity]');
    if (!button) return;
    state.severity = button.dataset.severity;
    document.querySelectorAll('.filter-chip').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderFindings();
  });

  els.categoryGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.view = button.dataset.category;
    applyView();
  });

  els.historyList.addEventListener('click', (event) => {
    const item = event.target.closest('.history-item');
    if (!item) return;
    if (event.target.closest('[data-action="delete"]')) { deleteAudit(item.dataset.id); return; }
    const audit = history().find((candidate) => candidate.id === item.dataset.id);
    if (audit) setAudit(audit, false);
  });

  els.clearHistoryButton.addEventListener('click', () => {
    if (!history().length) return;
    if (window.confirm('Clear all browser-local audit history?')) {
      localStorage.removeItem(STORAGE_KEY);
      showEmpty();
      toast('Audit history cleared.');
    }
  });

  els.reportFile.addEventListener('change', async () => {
    try { await readFile(els.reportFile.files[0]); } catch (error) { toast(error.message, true); }
  });
  for (const eventName of ['dragenter', 'dragover']) els.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.add('is-dragging'); });
  for (const eventName of ['dragleave', 'drop']) els.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.remove('is-dragging'); });
  els.dropZone.addEventListener('drop', async (event) => {
    try { await readFile(event.dataTransfer.files[0]); } catch (error) { toast(error.message, true); }
  });
  els.processImportButton.addEventListener('click', (event) => {
    event.preventDefault();
    try { importContent(els.reportText.value || state.importContent); } catch (error) { toast(error.message, true); }
  });
  els.importDialog.addEventListener('click', (event) => {
    if (event.target === els.importDialog) els.importDialog.close();
  });

  syncMobileMenu();
  renderHistory();
  const savedAudits = history();
  if (savedAudits.length) setAudit(savedAudits[0], false);
  else showEmpty();
})();
