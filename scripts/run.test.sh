#!/bin/bash
# Unit tests for scripts/run.sh. Sourcing loads the helpers WITHOUT running the
# relaunch loop (source-guard). Uses a throwaway origin + clone.
set -u
RUN_SH="$(cd "$(dirname "$0")" && pwd)/run.sh"
source "$RUN_SH"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }
assert_ok() { if ! "$@"; then echo "FAIL: expected success: $*"; fail=1; fi; }
assert_fails() { if "$@"; then echo "FAIL: expected failure: $*"; fail=1; fi; }

assert_defined crashed_on_boot
assert_defined can_roll_back
assert_defined roll_back

assert_ok crashed_on_boot 1 5
assert_fails crashed_on_boot 75 5
assert_fails crashed_on_boot 0 5
assert_fails crashed_on_boot 1 45
assert_fails crashed_on_boot 130 5
assert_fails crashed_on_boot 143 5

git init -q --bare -b master "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/clone" 2>/dev/null
cd "$tmp/clone"
git checkout -q -b master 2>/dev/null
echo a > f.txt; git add f.txt; git commit -qm one
echo a > pnpm-lock.yaml; git add pnpm-lock.yaml; git commit -qm lock
base=$(git rev-parse HEAD)
echo b > f.txt; git commit -qam two
pushed=$(git rev-parse HEAD)
git push -q origin master 2>/dev/null
git fetch -q origin

assert_ok can_roll_back "$base" "$pushed"
assert_fails can_roll_back "$pushed" "$base"
assert_fails can_roll_back "" "$pushed"

echo c > f.txt; git commit -qam local-only
local_sha=$(git rev-parse HEAD)
assert_fails can_roll_back "$pushed" "$local_sha"

git reset -q --hard "$pushed"
echo dirty > f.txt
assert_fails can_roll_back "$base" "$pushed"
git checkout -q f.txt

echo keep > untracked.txt
assert_ok can_roll_back "$base" "$pushed"
roll_back "$base" "$pushed" >/dev/null 2>&1
assert_eq "$(git rev-parse HEAD)" "$base" "roll_back moves HEAD to prev"
assert_eq "$(cat untracked.txt)" "keep" "roll_back leaves untracked files"

# Loop tests: a fake pnpm drives run.sh from a copy inside the clone.
git reset -q --hard "$pushed"
mkdir -p scripts "$tmp/bin"
cp "$RUN_SH" scripts/run.sh
export PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp"
cat > "$tmp/bin/pnpm" <<'FAKE'
#!/bin/bash
n=$(( $(cat "$FAKE_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo $n > "$FAKE_DIR/count"
echo "launch $n updated=${YIMBOT_UPDATED_FROM:-} rolled=${YIMBOT_ROLLED_BACK:-}" >> "$FAKE_DIR/log"
case "$FAKE_MODE:$n" in
  *:1) echo x >> f.txt; git commit -qam update; git push -qf origin master 2>/dev/null; exit 75 ;;
  int:2) trap 'exit 1' INT; touch "$FAKE_DIR/ready"; sleep 30 & wait; exit 1 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$tmp/bin/pnpm"

before=$(git rev-parse HEAD)
rm -f "$tmp/count" "$tmp/log"
FAKE_MODE=ok bash scripts/run.sh >/dev/null 2>&1
assert_eq "$?" "0" "loop exits 0 after relaunch"
assert_eq "$(sed -n 1p "$tmp/log")" "launch 1 updated= rolled=" "first launch has no update env"
assert_eq "$(sed -n 2p "$tmp/log")" "launch 2 updated=$before rolled=" "relaunch carries YIMBOT_UPDATED_FROM"

git reset -q --hard "$before"
rm -f "$tmp/count" "$tmp/log" "$tmp/ready"
# A backgrounded shell ignores SIGINT, so reset it to default before exec.
FAKE_MODE=int python3 -c 'import os,signal,sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.setsid(); os.execvp("bash", ["bash", "scripts/run.sh"])' >/dev/null 2>&1 &
wpid=$!
for _ in $(seq 100); do [ -e "$tmp/ready" ] && break; sleep 0.1; done
after_update=$(git rev-parse HEAD)
kill -INT -- "-$wpid"
wait "$wpid"
assert_eq "$?" "1" "interrupt ends the wrapper with the child code"
assert_eq "$(git rev-parse HEAD)" "$after_update" "interrupt does not roll back"
assert_eq "$(wc -l < "$tmp/log")" "2" "no relaunch after interrupt"

exit $fail
