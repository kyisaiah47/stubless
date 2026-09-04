# AGENTS.md

Instructions for an AI coding agent working in this repository.

This project scores agent instruction files and refuses a job whose file teaches nothing. It would
be a poor joke to ship a stub one here, so this file is both the plan and a fixture: CI runs the
action on this repository and holds it to a threshold of 90.

## Overview

A GitHub Action that finds every agent instruction file in a checkout, sends it to RuleStack for
scoring, prints the per capability breakdown as a job summary with annotations on the lines
RuleStack flags, and exits non zero below a threshold. Node 18 or newer, zero dependencies, ESM
throughout.

```
action.yml            the composite action: inputs, outputs, branding
bin/stubless.mjs      the dispatcher. Thin, and it owns the exit codes
src/score-gate.mjs    the gate. Walks the tree, calls RuleStack, writes the summary
src/gh.mjs            the runner protocol: annotations, job summary, step outputs
test/run.sh           the whole suite, offline, nothing to install
```

## Build, test, lint

There is no build step, no bundler and nothing to install.

```sh
npm test
node bin/stubless.mjs gate
node bin/stubless.mjs gate --threshold 80
node src/score-gate.mjs
git ls-files -z
npx stubless gate --no-badge
```

`npm test` is the gate. It runs offline against a stub RuleStack, so a clean clone can prove every
claim in the README with no network.

## Code style and conventions

ESM only. `import`, `node:` prefixed builtins, no `require`, no `__dirname`. Two space indent,
single quotes, semicolons. Comments carry provenance: a threshold, a cap or a magic string says
what was read to arrive at it and when.

## Architecture

`src/gh.mjs` is the only file that writes to stdout in the runner's protocol, so escaping lives in
exactly one place. `src/score-gate.mjs` never formats a workflow command itself.

The recogniser lives in RuleStack, not here. `GET /api/score` returns the path patterns and the
gate compiles them at run time. A copy in this repository would drift the first time RuleStack
learns a new format, and the symptom would be a file that quietly stops being checked while the
job still prints green.

## Never do these

- Never add a `--force`, `--skip`, `--allow` or `--no-verify` flag, an allowlist, an ignore file or
  a known issues file. Each is a supported way to record a failure and ship past it.
- Never let a failed fetch, an unparseable threshold or an unreadable file exit 0. Could not check
  is exit 2 and never collapses into a pass.
- Never hardcode the recogniser. Read it from RuleStack on every run.
- Never add a runtime dependency. The CI workflow has no install step on purpose; if you ever need
  one, the zero dependency claim in the README has stopped being true and the README changes in
  the same commit.
- Never make the test agree with a change. The tests are the specification.

## Tests

Every behaviour claimed in the README has a case in `test/run.sh` that proves it **fails** on bad
input. A suite that only proves the happy path leaves the actual claim unchecked.

## If you found a defect

Fix it in this change. The exceptions are narrow: it is genuinely destructive, or it needs a
product decision only a person can make. Out of the scope I was given is not one of them.
