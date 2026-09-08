# stubless

[![gates](https://github.com/kyisaiah47/stubless/actions/workflows/ci.yml/badge.svg)](https://github.com/kyisaiah47/stubless/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![AGENTS.md](https://toolproof.kynth.studio/badge/rulestack/kyisaiah47/stubless.svg)](https://rulestack.kynth.studio)

A GitHub Action that scores this repository's `AGENTS.md`, `CLAUDE.md` and the rest of the
agent-instruction family against [RuleStack](https://rulestack.kynth.studio), prints the
per-capability breakdown as a job summary with annotations on the lines RuleStack flags, and
fails the job below a threshold.

A stub agent config is a file that always parses and teaches nothing: no build command, no test
command, no stated boundary. Nothing else in a repository checks it, because it is prose with no
schema. This gives it a linter.

## What it looks like

Real output. `stubless gate` run against a repository with one `AGENTS.md`, talking to
`test/stub-rulestack.mjs` (the offline double the test suite uses, hence the capability details
literally reading `stub`; a run against the live RuleStack fills those in with real measurements,
the way the [inputs](#inputs) table below documents):

```
## stubless

1 agent instruction file scored by [RuleStack](https://rulestack.kynth.studio). The repository
score is the strongest file, which is what RuleStack's own badge reports: **90/100**, at or above
the threshold of 60.

| File | Format | Score | Words | Headings | Commands | Topics |
| --- | --- | --: | --: | --: | --: | --: |
| `AGENTS.md` | AGENTS.md | 90/100 | 400 | 9 | 7 | 2 |

### Where `AGENTS.md` earned its points

| Capability | Points | Measured |
| --- | --: | --- |
| Length | 34/34 | 400 words |
| Section headings | 14/14 | 9 headings |
| Runnable commands | 20/20 | stub |
| Core topic coverage | 15/15 | stub |
| Explicit prohibitions | 7/7 | stub |
| Names this repository's own paths | 8/8 | stub |
| Worked examples | 6/6 | stub |

### Badge

​```markdown
[![AGENTS.md](https://toolproof.kynth.studio/badge/rulestack/kyisaiah47/example.svg)](https://rulestack.kynth.studio)
​```

That badge reads the RuleStack nightly index, not this run. Until the nightly crawl reaches a
repository it renders **not indexed**, which is the correct output for an unmeasured subject and
is not a bad score.
```

Against the live RuleStack, the "Measured" column carries the real per-file text (word counts,
which topics were covered, whether the file names its own paths) instead of a stand-in. Below the
threshold, every reason RuleStack found lands on the exact line as a workflow annotation, and the
job exits 1.

## Usage

```yaml
name: rulestack
on: [push, pull_request]
jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kyisaiah47/stubless@v1
        with:
          threshold: '70'
```

### Inputs

| Name | Default | Meaning |
| --- | --- | --- |
| `threshold` | `60` | Fail below this. The repository score is the strongest recognised file, the same number RuleStack's own badge reports. |
| `per-file-threshold` | (unset) | Optional second gate: every recognised file must clear this too, not only the strongest one. Catches a weak file a strong one is hiding. |
| `badge` | `true` | Print the RuleStack badge markdown in the job summary. |
| `workspace` | checkout root | Directory to walk. |
| `api` | `https://rulestack.kynth.studio` | RuleStack base URL. Only change this to point at a local RuleStack. |
| `timeout` | `60` | Seconds per RuleStack request before the run becomes exit 2. |

### Outputs

| Name | Meaning |
| --- | --- |
| `score` | The repository score, 0 to 100. |
| `best-file` | Path of the file the repository score came from. |
| `files` | How many agent instruction files were recognised and scored. |
| `badge` | Markdown for the RuleStack badge for this repository. |
| `report-path` | Path to the full JSON response, under `RUNNER_TEMP`. |

## Exit codes

| | |
| --- | --- |
| `0` | every recognised file is at or above the threshold |
| `1` | a file scores below it, or the repository has no agent instruction file at all |
| `2` | the gate could not run. Not a pass, and it never collapses into 0 |

`2` is the one that matters. A RuleStack outage, an unreadable file or a threshold that does not
parse is a different answer from "checked and clean", and a pipeline that renders both green has
taught itself to ignore the gate.

## The recogniser lives in RuleStack, not here

Which paths count as an agent instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
`.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, and
whatever RuleStack learns next) is read live from `GET /api/score` on every run. A copy held in
this repository would drift the first time RuleStack recognises a new format, and the symptom of
that drift is a file that quietly stops being checked while the job still prints green. If the
descriptor cannot be fetched, this exits 2. It does not fall back to a guess.

## Local use

```sh
npm i -D stubless
npx stubless gate --threshold 80
```

No build step, no bundler, zero runtime dependencies. `node bin/stubless.mjs gate` runs the exact
same code path the action does; flags map onto the same environment variables the action sets, so
a local run and a CI run cannot diverge.

```
stubless gate                 score this repository and fail below the threshold
stubless gate --threshold 70  the same, with the threshold set here rather than in the env
stubless gate --no-badge      leave the badge markdown out of the summary
```

## Running the tests

```sh
git clone https://github.com/kyisaiah47/stubless && cd stubless
npm test
```

Nothing to install. `test/run.sh` runs entirely offline against `test/stub-rulestack.mjs`, a stub
RuleStack that returns canned scores so the suite can assert what the gate does with a score.
Whether RuleStack's arithmetic is right is RuleStack's own test suite's job; this repository has
no scoring opinion of its own. Every exit code this README claims has a case that proves it fails
on bad input: a descriptor RuleStack cannot serve, a scoring call that 500s, a file that matches
and then vanishes from the response, a threshold that does not parse, a repository with no
recognised file, and the fallback directory walk when there is no git checkout at all.

## Honest limitations

- **This is a view over RuleStack's classifier, not a second one.** The score is whatever
  `qualityScore()` returns for the file's content; this repository never restates that logic.
- **The per-capability breakdown can occasionally disagree with the score itself** after
  RuleStack's 100-point cap. When that happens the summary says so explicitly (`mismatch`) rather
  than silently picking one number.
- **Line numbers on an annotation are real positions, not estimates,** for the checks that have
  one (where a file crosses a length band). A finding that is a property of the whole file, like
  "no runnable commands", carries no line and says so rather than inventing one.
- **This scores content it is given, not a git history.** A file that was good on the last commit
  RuleStack's nightly crawl reached and has since regressed shows the current content, which is
  the point of running this on a pull request rather than waiting for the next crawl.

## Why it is called stubless

The failure this exists to catch is the AGENTS.md that always parses and teaches nothing: no
build command, no boundary, no stated architecture. Same naming shape as
[deferless](https://github.com/kyisaiah47/deferless), which this action is built beside and holds
itself to the same standard: no `--force`, no allowlist, no known-issues file.

## Licence

MIT. Built and used in production by [Compound Labs](https://thecompound.tech).
