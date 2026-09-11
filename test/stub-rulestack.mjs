#!/usr/bin/env node
/* A stub RuleStack, so the suite runs from a clean clone with no network and no install.
 *
 * ⛔ IT IS NOT A SECOND SCORER AND MUST NEVER BECOME ONE. It returns canned numbers so the tests
 * can assert what the GATE does with a score. Whether RuleStack's arithmetic is right is
 * RuleStack's own test suite's job, and duplicating it here would give this repository a scoring
 * opinion it has no business having.
 *
 *   node test/stub-rulestack.mjs <mode>
 *
 * Prints the base URL on the first line of stdout, then serves until killed. The descriptor it
 * serves is the shape of the real one, read from https://rulestack.kynth.studio/api/score on
 * 2026-09-04; if the real shape changes, this stub is the thing that must change with it.
 */
import http from 'node:http';

const MODE = process.argv[2] || 'ok';

const DESCRIPTOR = {
  endpoint: 'POST /api/score',
  limits: { maxFiles: 60, maxFileChars: 1000000, maxTotalChars: 2000000 },
  recogniser: {
    source: 'ghscrape MATCHERS',
    readAt: '2026-09-04',
    noise: {
      source: '(^|\\/)(node_modules|\\.git|vendor|dist|build|\\.next|__tests?__|fixtures?|testdata)(\\/|$)',
      flags: 'i',
    },
    formats: [
      {
        kind: 'agents_md',
        format: 'agents-md',
        name: 'AGENTS.md',
        filename: 'AGENTS.md',
        patterns: [{ source: '(^|\\/)AGENTS\\.md$', flags: '' }],
      },
      {
        kind: 'claude_md',
        format: 'claude-md',
        name: 'CLAUDE.md',
        filename: 'CLAUDE.md',
        patterns: [{ source: '(^|\\/)CLAUDE\\.md$', flags: '' }],
      },
    ],
  },
};

/** Canned. AGENTS.md scores 90, anything else scores 40, so a test can put a weak second file
 *  behind a strong first one and prove the per file gate catches what the repository score hides. */
const scoreFor = (p) => (/AGENTS\.md$/.test(p) ? 90 : 40);

const fileRow = (p) => {
  const q = scoreFor(p);
  return {
    path: p,
    recognised: true,
    kind: 'agents_md',
    format: 'agents-md',
    formatName: 'AGENTS.md',
    quality: q,
    capabilities: [
      { key: 'length', label: 'Length', points: 34, max: 34, detail: '400 words' },
      { key: 'structure', label: 'Section headings', points: 14, max: 14, detail: '9 headings' },
      { key: 'commands', label: 'Runnable commands', points: q >= 90 ? 20 : 0, max: 20, detail: 'stub' },
      { key: 'coverage', label: 'Core topic coverage', points: 15, max: 15, detail: 'stub' },
      { key: 'prohibitions', label: 'Explicit prohibitions', points: 7, max: 7, detail: 'stub' },
      { key: 'specificity', label: "Names this repository's own paths", points: 8, max: 8, detail: 'stub' },
      { key: 'examples', label: 'Worked examples', points: 6, max: 6, detail: 'stub' },
    ],
    rawPoints: q,
    cappedAt100: false,
    reasons: q >= 90 ? [] : [{ text: 'no runnable commands', line: 1, located: false }],
    metrics: { words: 400, headings: 9, codeBlocks: 3, commands: q >= 90 ? 7 : 0, sectionTags: ['build', 'test'] },
    commands: [],
    sections: [],
    publishable: { ok: true, reasons: [] },
  };
};

const send = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(s);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/score') return send(res, 404, { error: 'no route' });

  if (req.method === 'GET') {
    if (MODE === 'descriptor-500') return send(res, 500, { error: 'stub is down' });
    return send(res, 200, DESCRIPTOR);
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (MODE === 'post-500') return send(res, 500, { error: 'stub is down' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
    const paths = (body.files || []).map((f) => f.path);
    // `short` drops one row on purpose: a file that matched and then vanished from the response is
    // a check that stopped running, and the gate must call that could-not-check.
    const rows = (MODE === 'short' ? paths.slice(1) : paths).map(fileRow);
    const best = rows.length ? rows.reduce((a, b) => (b.quality > a.quality ? b : a)) : null;
    send(res, 200, {
      scoredAt: new Date().toISOString(),
      repo: body.repo ?? null,
      scored: rows.length,
      best: best && { path: best.path, format: best.format, quality: best.quality },
      files: rows,
      unrecognised: [],
      badge: body.repo
        ? {
            markdown: `[![AGENTS.md](https://toolproof.thecompound.tech/badge/rulestack/${body.repo}.svg)](https://rulestack.thecompound.tech)`,
            reads: 'the RuleStack nightly index',
            unindexedRendersAs: 'not indexed',
          }
        : null,
    });
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
