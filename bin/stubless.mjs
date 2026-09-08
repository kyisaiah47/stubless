#!/usr/bin/env node
/* stubless. The dispatcher.
 *
 * The action calls this with no arguments and every input in the environment, which is the
 * `gate` path. The named subcommands exist so the same check can be run on a laptop, against the
 * same live RuleStack, before anyone pushes.
 *
 * Exit codes are uniform and they are the point:
 *
 *   0  every recognised file is at or above the threshold
 *   1  a file scores below it, or the repository has no agent instruction file at all
 *   2  the gate could not run. NOT a pass, and it never collapses into 0.
 *
 * There is no --force, no allowlist and no known-issues file. Each of those is a supported way to
 * record a failure and ship past it, which is the behaviour this exists to make impossible.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, '..', 'src', 'score-gate.mjs');

const HELP = `
stubless. A stub agent config is a file that always parses and teaches nothing.

  stubless gate                 score this repository and fail below the threshold
  stubless gate --threshold 70  the same, with the threshold set here rather than in the env

Environment, which is how the action passes its inputs:

  STUBLESS_THRESHOLD            0 to 100, default 60. The repository score is the strongest file.
  STUBLESS_PER_FILE_THRESHOLD   optional second gate: every file must reach this too
  STUBLESS_WORKSPACE            directory to walk, default the git checkout
  STUBLESS_API                  RuleStack base URL, default https://rulestack.thecompound.tech
  STUBLESS_BADGE                false to leave the badge markdown out of the summary
  STUBLESS_TIMEOUT              seconds per request before the run becomes exit 2, default 60

Exit codes:  0 clean  ·  1 below the threshold, or no instruction file  ·  2 could not check

The recogniser is not in this repository. Which paths count as an agent instruction file is
RuleStack's answer, read from GET /api/score on every run, so a format it learns is a format this
checks without a release here.
`;

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'gate';
const rest = cmd === argv[0] ? argv.slice(1) : argv;

/* Flags map onto the same environment the action sets, so there is exactly one place a value can
 * come from and the local run and the CI run cannot diverge. */
const FLAGS = {
  '--threshold': 'STUBLESS_THRESHOLD',
  '--per-file-threshold': 'STUBLESS_PER_FILE_THRESHOLD',
  '--workspace': 'STUBLESS_WORKSPACE',
  '--api': 'STUBLESS_API',
  '--timeout': 'STUBLESS_TIMEOUT',
};

if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

if (cmd !== 'gate') {
  console.error(`stubless: unknown command "${cmd}"`);
  console.log(HELP);
  process.exit(2);
}

const env = { ...process.env };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--no-badge') {
    env.STUBLESS_BADGE = 'false';
    continue;
  }
  const key = FLAGS[a];
  if (!key) {
    console.error(`stubless: unknown flag "${a}"`);
    process.exit(2);
  }
  const v = rest[++i];
  if (v === undefined) {
    console.error(`stubless: ${a} needs a value`);
    process.exit(2);
  }
  env[key] = v;
}

const r = spawnSync(process.execPath, [GATE], { stdio: 'inherit', env });
/* A spawn that produced no status at all did not run the gate. That is could-not-check, so it is
 * 2 rather than the 0 a nullish default would hand back. */
process.exit(r.status ?? 2);
