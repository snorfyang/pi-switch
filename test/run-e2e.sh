#!/usr/bin/env bash
# End-to-end check: the wrapper must retry a dead key with the next one.
#
#   ./test/run-e2e.sh
#
# Runs the first supported provider (deepseek) against a fake OpenAI-compatible
# endpoint in a throwaway agent dir. Requires `pi` on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="$(mktemp -d)/agent"
mkdir -p "$agent_dir"

cat > "$agent_dir/models.json" <<'JSON'
{ "providers": { "deepseek": { "baseUrl": "http://127.0.0.1:8799" } } }
JSON

cat > "$agent_dir/pi-switch.json" <<'JSON'
{
  "version": 1,
  "providers": {
    "deepseek": {
      "keys": [
        { "id": "bad",  "key": "sk-bad",  "label": "no-balance" },
        { "id": "good", "key": "sk-good", "label": "works" }
      ],
      "activeIndex": 0
    }
  }
}
JSON
chmod 600 "$agent_dir/pi-switch.json"

log="$(mktemp)"
PORT=8799 BAD_KEY=sk-bad RATE_KEY=sk-rate LOG="$log" node "$here/test/fake-openai-server.mjs" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
sleep 0.7

out="$(PI_CODING_AGENT_DIR="$agent_dir" pi --offline --no-extensions -e "$here/index.ts" \
  --no-session -p "Reply with exactly: hi" --model deepseek/deepseek-v4-pro 2>&1 | tail -3)"

kill "$server_pid" 2>/dev/null || true

echo "--- pi output ---"
echo "$out"
echo "--- requests ---"
cat "$log"
echo "--- store ---"
cat "$agent_dir/pi-switch.json"

echo "$out" | grep -q "pong from sk-good" || { echo "FAILED: did not rotate to the good key"; exit 1; }
grep -q '"apiKey":"sk-bad"' "$log" || { echo "FAILED: never tried the bad key"; exit 1; }
grep -q '"apiKey":"sk-good"' "$log" || { echo "FAILED: never tried the good key"; exit 1; }
grep -q '"disabled": true' "$agent_dir/pi-switch.json" || { echo "FAILED: bad key was not disabled"; exit 1; }

echo "OK"
