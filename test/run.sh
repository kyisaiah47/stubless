#!/usr/bin/env bash
# The whole suite. Offline: everything talks to test/stub-rulestack.mjs, nothing touches the
# network, nothing needs `npm install`. Every claim this repository's README makes about exit
# codes has a case here that proves it fails on bad input. A suite that only proves the happy
# path leaves the actual claim unchecked, same rule deferless holds itself to.
set -u
cd "$(dirname "$0")/.."

# The runner exports GITHUB_STEP_SUMMARY and GITHUB_OUTPUT into every step, not only a composite
# action's own step. Left set, src/gh.mjs's summary()/setOutput() write to those files instead of
# stdout, and an assert_contains reading $OUT would find nothing even on a passing run. This
# repository's own CI happened not to expose it (the final console.log line covers the one
# assertion that checks OUT), but leakless's sibling suite did fail on it, so this is unset here
# too rather than relying on that coincidence.
unset GITHUB_STEP_SUMMARY GITHUB_OUTPUT

TMP="$(mktemp -d)"
STUB_PID=""
FAIL=0
CASE=0

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# start_stub <mode>  prints the stub's base URL on stdout, leaves it running in STUB_PID
start_stub() {
  local mode="$1"
  local out="$TMP/stub-$mode-$$.out"
  node test/stub-rulestack.mjs "$mode" > "$out" 2>&1 &
  STUB_PID=$!
  local url=""
  for _ in $(seq 1 50); do
    url="$(head -n1 "$out" 2>/dev/null)"
    [ -n "$url" ] && break
    sleep 0.1
  done
  if [ -z "$url" ]; then
    echo "stub-rulestack ($mode) never printed a URL" >&2
    cat "$out" >&2
    exit 2
  fi
  echo "$url"
}

stop_stub() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  wait "$STUB_PID" 2>/dev/null
  STUB_PID=""
}

# repo_with <dir> <file:content>...  a git repo with those files tracked
repo_with() {
  local dir="$1"; shift
  mkdir -p "$dir"
  ( cd "$dir" && git init -q && git config user.email t@t.test && git config user.name t )
  for pair in "$@"; do
    local file="${pair%%:*}"
    local content="${pair#*:}"
    mkdir -p "$dir/$(dirname "$file")"
    printf '%s\n' "$content" > "$dir/$file"
  done
  ( cd "$dir" && git add -A && git -c commit.gpgsign=false commit -q -m init )
}

STRONG_AGENTS="# AGENTS.md
Build: npm run build. Test: npm test. Never commit secrets."
WEAK_CLAUDE="stub"

# assert_exit <expected> <got> <label>
assert_exit() {
  CASE=$((CASE + 1))
  if [ "$1" = "$2" ]; then
    echo "ok   - $3 (exit $2)"
  else
    echo "FAIL - $3 (expected exit $1, got $2)"
    FAIL=1
  fi
}

assert_contains() {
  CASE=$((CASE + 1))
  if printf '%s' "$2" | grep -qF "$1"; then
    echo "ok   - $3"
  else
    echo "FAIL - $3 (did not find: $1)"
    FAIL=1
  fi
}

# 1. a strong AGENTS.md, at the default threshold
API="$(start_stub ok)"
REPO="$TMP/strong"
repo_with "$REPO" "AGENTS.md:$STRONG_AGENTS"
OUT="$(STUBLESS_WORKSPACE="$REPO" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 0 "$CODE" "a repository scoring 90 clears the default threshold of 60"
assert_contains "90/100" "$OUT" "the score appears in the summary"
stop_stub

# 2. the same repository, a threshold it cannot clear
API="$(start_stub ok)"
OUT="$(STUBLESS_WORKSPACE="$REPO" STUBLESS_API="$API" node bin/stubless.mjs gate --threshold 95 2>&1)"; CODE=$?
assert_exit 1 "$CODE" "a threshold above the score fails the job"
stop_stub

# 3. per-file threshold catches what the repository score hides
API="$(start_stub ok)"
REPO2="$TMP/mixed"
repo_with "$REPO2" "AGENTS.md:$STRONG_AGENTS" "CLAUDE.md:$WEAK_CLAUDE"
OUT="$(STUBLESS_WORKSPACE="$REPO2" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 0 "$CODE" "the repository score (best file) still clears the default threshold"
OUT="$(STUBLESS_WORKSPACE="$REPO2" STUBLESS_API="$API" node bin/stubless.mjs gate --per-file-threshold 60 2>&1)"; CODE=$?
assert_exit 1 "$CODE" "per-file-threshold fails a weak file the repository score alone hides"
stop_stub

# 4. no recognised file at all
API="$(start_stub ok)"
REPO3="$TMP/none"
repo_with "$REPO3" "README.md:hello"
OUT="$(STUBLESS_WORKSPACE="$REPO3" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 1 "$CODE" "no agent instruction file is a finding, exit 1, not a silent pass"
assert_contains "No agent instruction file" "$OUT" "says plainly that nothing was found"
stop_stub

# 5. RuleStack's descriptor cannot be read: exit 2, never 0
API="$(start_stub descriptor-500)"
OUT="$(STUBLESS_WORKSPACE="$REPO" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "a descriptor RuleStack cannot serve is could-not-check, not clean"
stop_stub

# 6. the scoring call itself fails: exit 2
API="$(start_stub post-500)"
OUT="$(STUBLESS_WORKSPACE="$REPO" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "a failed scoring call is could-not-check, not clean"
stop_stub

# 7. a file matches and then vanishes from the response: exit 2
API="$(start_stub short)"
OUT="$(STUBLESS_WORKSPACE="$REPO2" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "a file that stops being checked must never read as clean"
stop_stub

# 8. a threshold that does not parse is exit 2, never a silent default
API="$(start_stub ok)"
OUT="$(STUBLESS_WORKSPACE="$REPO" STUBLESS_API="$API" STUBLESS_THRESHOLD="6O" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "an unparsable threshold never falls back to the default"
stop_stub

# 9. no git checkout at all: the walk fallback still finds the file
API="$(start_stub ok)"
REPO4="$TMP/nogit"
mkdir -p "$REPO4"
printf '%s\n' "$STRONG_AGENTS" > "$REPO4/AGENTS.md"
OUT="$(STUBLESS_WORKSPACE="$REPO4" STUBLESS_API="$API" node bin/stubless.mjs gate 2>&1)"; CODE=$?
assert_exit 0 "$CODE" "outside a git checkout, the directory walk still finds AGENTS.md"
stop_stub

# 10. unknown flag: exit 2, not a silent ignore
OUT="$(node bin/stubless.mjs gate --nonsense 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "an unknown flag is exit 2"

# 11. unknown subcommand: exit 2
OUT="$(node bin/stubless.mjs bogus 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "an unknown subcommand is exit 2"

echo
echo "$CASE assertions."
if [ "$FAIL" = "1" ]; then
  echo "FAILED"
  exit 1
fi
echo "PASSED"
