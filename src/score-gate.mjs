#!/usr/bin/env node
/* The gate. Finds this repository's agent instruction files, scores them against RuleStack, and
 * refuses the job below a threshold.
 *
 * WHAT IT IS ACTUALLY FOR. An AGENTS.md is the one file in a repository that nothing checks. It
 * has no schema, so it always parses. It has no tests, because it is prose. It is read by a
 * machine that will not complain, and the failure mode is silent: the agent gets a file with no
 * runnable commands in it, guesses the build command, guesses wrong, and the person who wrote the
 * file never learns that it taught nothing. Every other file in the repository has a linter.
 *
 * ⛔ THE RECOGNISER IS NOT IN THIS REPOSITORY, AND THAT IS DELIBERATE. Which paths count as an
 * agent instruction file is RuleStack's answer, read live from `GET /api/score`. A copy here would
 * drift the first time RuleStack learns a new format, and the symptom of that drift is a file that
 * quietly stops being checked while the job still prints green. If the descriptor cannot be
 * fetched, this exits 2. It does not fall back to a guess.
 *
 * Exit codes, the same four deferless uses:
 *   0  every recognised file is at or above the threshold
 *   1  a file scores below the threshold, or the repository has no agent instruction file at all
 *   2  the gate could not run, which is NOT a pass and never collapses into 0
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { annotate, summary, setOutput, fetchJson } from './gh.mjs';

const API = (process.env.STUBLESS_API || 'https://rulestack.thecompound.tech').replace(/\/+$/, '');
const WORKSPACE = process.env.STUBLESS_WORKSPACE || process.env.GITHUB_WORKSPACE || process.cwd();
const REPO = process.env.STUBLESS_REPO || process.env.GITHUB_REPOSITORY || '';
const SHOW_BADGE = (process.env.STUBLESS_BADGE || 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Math.max(5, Number(process.env.STUBLESS_TIMEOUT || 60)) * 1000;

function intInput(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  /* ⛔ A THRESHOLD THAT DOES NOT PARSE IS EXIT 2, NEVER THE DEFAULT. Silently substituting 60 for
   * a typed `6O` would run a check the caller did not ask for and report it as the one they did. */
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    die(2, `${name}="${raw}" is not a number between 0 and 100.`);
  }
  return n;
}

const THRESHOLD = intInput('STUBLESS_THRESHOLD', 60);
const PER_FILE = (process.env.STUBLESS_PER_FILE_THRESHOLD ?? '').trim() === ''
  ? null
  : intInput('STUBLESS_PER_FILE_THRESHOLD', null);

function die(code, message) {
  annotate('error', { title: 'stubless' }, message);
  summary(`## stubless\n\n**Could not check.** ${message}\n`);
  process.exit(code);
}

/* ── the repository's files ─────────────────────────────────────────────────────────────────── */

/** Every tracked path, from git. A checkout is a git repository, so this is the fast and correct
 *  answer; the walk below is the fallback for a tarball or a local run outside one. */
function trackedPaths() {
  try {
    const out = execFileSync('git', ['-C', WORKSPACE, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const list = out.split('\0').filter(Boolean);
    if (list.length) return list;
  } catch {
    /* not a git checkout, or git is absent. Fall through to the walk. */
  }
  return walk(WORKSPACE);
}

const SKIP_DIR = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', 'testdata']);

function walk(root, rel = '', out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(root, p, out, depth + 1);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/* ── main ───────────────────────────────────────────────────────────────────────────────────── */

const run = async () => {
  // 1. RuleStack's recogniser, live. Never a copy held here.
  const desc = await fetchJson(`${API}/api/score`, { timeoutMs: TIMEOUT_MS }).catch((e) => ({
    ok: false,
    status: 0,
    text: String(e?.message || e),
  }));
  if (!desc.ok || !desc.json?.recogniser?.formats?.length) {
    die(
      2,
      `RuleStack's recogniser could not be read from ${API}/api/score (HTTP ${desc.status}). ` +
        `Nothing was scored. This is not a pass.`,
    );
  }

  const noise = new RegExp(desc.json.recogniser.noise.source, desc.json.recogniser.noise.flags);
  const formats = desc.json.recogniser.formats.map((f) => ({
    ...f,
    tests: f.patterns.map((p) => new RegExp(p.source, p.flags)),
  }));
  const limits = desc.json.limits || { maxFiles: 20, maxTotalChars: 1_000_000 };

  // 2. The files RuleStack recognises, in this repository.
  const candidates = [];
  for (const p of trackedPaths()) {
    if (noise.test(p)) continue;
    const hit = formats.find((f) => f.tests.some((t) => t.test(p)));
    if (hit) candidates.push({ path: p, format: hit });
  }

  /* ⛔ NO INSTRUCTION FILE IS A FINDING, NOT AN ABSENCE OF ONE. A repository with nothing for an
   * agent to read is exactly what this gate exists to surface, so it exits 1 and says so. It is
   * not exit 2: the check ran, reached RuleStack, walked the tree and got an answer. */
  if (!candidates.length) {
    const names = formats.map((f) => f.filename || f.name).filter(Boolean);
    annotate(
      'error',
      { title: 'stubless' },
      `No agent instruction file in this repository. RuleStack recognises ${names.join(', ')}.`,
    );
    summary(
      `## stubless\n\n` +
        `**No agent instruction file found.** Nothing in this repository tells a coding agent how to ` +
        `build it, test it, or what never to touch.\n\n` +
        `RuleStack recognises: ${names.map((n) => '`' + n + '`').join(', ')}.\n\n` +
        `Add one at the repository root. An [AGENTS.md](https://agents.md) is read by more agents ` +
        `than any other format; RuleStack's gallery of real ones is at ` +
        `[rulestack.kynth.studio](https://rulestack.thecompound.tech/configs?sort=quality).\n`,
    );
    setOutput('score', '');
    setOutput('files', '0');
    process.exit(1);
  }

  // 3. Score them. Batched to RuleStack's published caps rather than to a number invented here.
  const payload = [];
  for (const c of candidates) {
    let content;
    try {
      content = fs.readFileSync(path.join(WORKSPACE, c.path), 'utf8');
    } catch (e) {
      die(2, `${c.path} matched but could not be read: ${e?.message || e}`);
    }
    payload.push({ path: c.path, content });
  }

  const batches = [];
  let batch = [];
  let chars = 0;
  for (const f of payload) {
    if (batch.length >= limits.maxFiles || (chars + f.content.length > limits.maxTotalChars && batch.length)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(f);
    chars += f.content.length;
  }
  if (batch.length) batches.push(batch);

  const files = [];
  let badge = null;
  for (const b of batches) {
    const res = await fetchJson(`${API}/api/score`, {
      method: 'POST',
      body: { repo: REPO || undefined, files: b },
      timeoutMs: TIMEOUT_MS,
    }).catch((e) => ({ ok: false, status: 0, text: String(e?.message || e) }));
    if (!res.ok || !res.json) {
      die(
        2,
        `RuleStack returned HTTP ${res.status} for ${b.length} file(s). ` +
          `${res.json?.error || (res.text || '').slice(0, 200)}`.trim(),
      );
    }
    files.push(...(res.json.files || []));
    badge = badge || res.json.badge;
  }

  /* Every candidate must come back scored. A file that matched the recogniser and then vanished
   * from the response is a check that stopped running, which is the one thing this must never
   * report as clean. */
  if (files.length !== candidates.length) {
    die(
      2,
      `${candidates.length} file(s) matched RuleStack's recogniser but ${files.length} came back scored. ` +
        `A file that silently stops being checked is indistinguishable from a file that passed.`,
    );
  }

  files.sort((a, b) => b.quality - a.quality || a.path.localeCompare(b.path));
  const best = files[0];

  // 4. Annotations, on the lines RuleStack flags.
  let failing = 0;
  for (const f of files) {
    const belowRepo = f === best && best.quality < THRESHOLD;
    const belowFile = PER_FILE !== null && f.quality < PER_FILE;
    const bad = belowRepo || belowFile;
    if (bad) failing++;
    for (const r of [...f.reasons, ...f.publishable.reasons]) {
      annotate(
        bad ? 'error' : 'warning',
        {
          file: f.path,
          line: r.line,
          title: `RuleStack ${f.quality}/100`,
        },
        r.located ? r.text : `${r.text} (a property of the whole file, so this sits at the top of it)`,
      );
    }
  }

  // 5. The job summary.
  const verdict =
    best.quality >= THRESHOLD
      ? `**${best.quality}/100**, at or above the threshold of ${THRESHOLD}.`
      : `**${best.quality}/100**, below the threshold of ${THRESHOLD}.`;

  const rows = files
    .map(
      (f) =>
        `| \`${f.path}\` | ${f.formatName} | ${f.quality}/100 | ${f.metrics.words} | ` +
        `${f.metrics.headings} | ${f.metrics.commands} | ${f.metrics.sectionTags.length} |`,
    )
    .join('\n');

  const caps = best.capabilities
    .map((c) => `| ${c.label} | ${c.points}/${c.max} | ${c.detail} |`)
    .join('\n');

  const reasonList = files
    .filter((f) => f.reasons.length || f.publishable.reasons.length)
    .map((f) => {
      const items = [...f.reasons, ...f.publishable.reasons]
        .map((r) => `  - ${r.text}${r.located ? ` (line ${r.line})` : ''}`)
        .join('\n');
      return `- \`${f.path}\`\n${items}`;
    })
    .join('\n');

  let md =
    `## stubless\n\n` +
    `${files.length} agent instruction file${files.length === 1 ? '' : 's'} scored by ` +
    `[RuleStack](https://rulestack.kynth.studio). The repository score is the strongest file, ` +
    `which is what RuleStack's own badge reports: ${verdict}\n\n` +
    `| File | Format | Score | Words | Headings | Commands | Topics |\n` +
    `| --- | --- | --: | --: | --: | --: | --: |\n${rows}\n\n` +
    `### Where \`${best.path}\` earned its points\n\n` +
    `| Capability | Points | Measured |\n| --- | --: | --- |\n${caps}\n`;

  if (best.cappedAt100) {
    md +=
      `\nThe bands add to ${best.rawPoints} before the cap at 100, so this file cleared every band ` +
      `with points to spare.\n`;
  }
  if (best.mismatch) {
    md +=
      `\n**The breakdown and the score disagree** (${best.mismatch.view} against ${best.mismatch.score}). ` +
      `That is a defect in RuleStack's breakdown view, not in the score. Report it at ` +
      `https://rulestack.kynth.studio.\n`;
  }
  if (reasonList) md += `\n### What RuleStack flagged\n\n${reasonList}\n`;

  if (SHOW_BADGE && badge?.markdown) {
    md +=
      `\n### Badge\n\n` +
      '```markdown\n' +
      `${badge.markdown}\n` +
      '```\n\n' +
      `That badge reads ${badge.reads}, not this run. Until the nightly crawl reaches a repository ` +
      `it renders **${badge.unindexedRendersAs}**, which is the correct output for an unmeasured ` +
      `subject and is not a bad score.\n`;
  }

  md +=
    `\n<sub>Scored with the same classifier RuleStack runs over ` +
    `[real repositories](https://rulestack.thecompound.tech/configs) every night. ` +
    `stubless is built and used in production by [Compound Labs](https://thecompound.tech).</sub>\n`;

  summary(md);

  // 6. Outputs and the verdict.
  const reportPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'stubless-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ repo: REPO, threshold: THRESHOLD, files }, null, 2));

  setOutput('score', String(best.quality));
  setOutput('best-file', best.path);
  setOutput('files', String(files.length));
  setOutput('report-path', reportPath);
  if (badge?.markdown) setOutput('badge', badge.markdown);

  console.log(`stubless: ${files.length} file(s), best ${best.path} at ${best.quality}/100, threshold ${THRESHOLD}`);
  process.exit(failing ? 1 : 0);
};

run().catch((e) => die(2, `stubless crashed: ${e?.stack || e}`));
