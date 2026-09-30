# pi-switch

Keep several API keys per provider in Pi and switch to the next one automatically when a key runs out of quota or hits its rate limit.

## Supported providers

**Supported:** `deepseek`, `zai-coding-cn` (Z.AI Coding CN), `anthropic`, `google`, `huggingface`, `openai`.

- For these providers, pi-switch takes over key selection: you can store several keys and it rotates between them.
- Providers that also have an OAuth login (Anthropic, OpenAI) keep working normally: an OAuth credential takes precedence, and the pool only applies when the stored credential is an API key.
- **For every other provider, pi-switch does nothing.** They keep Pi's built-in behavior exactly as if this extension were not installed (Pi's own `/login`, its `auth.json` / environment-variable resolution, and its normal error handling).

More providers will be added over time. The storage format and the code are already provider-agnostic, so adding one is just an entry in `PROVIDERS`.

## Features

- **No extra slash command.** Key management lives inside Pi's normal `/login` flow: `/login <provider>` (e.g. `/login deepseek`, `/login zai-coding-cn`) → "Sign in with an API key" → the key-pool menu.
- An empty pool is seeded from the key Pi already has stored for that provider (`auth.json`), so you do not have to paste it again.
- Before sending a request the active key is used. If the request fails **before any content is produced** (the usual quota / rate-limit shape), the next usable key is used to resend the same request. The retry is transparent.
- Failures are classified: insufficient balance or an invalid key disables that key; a rate limit only parks it for a short cooldown.
- Keys are de-duplicated automatically.
- Keys are stored in `<agent-dir>/pi-switch.json` with `0600` permissions.

## Install

```bash
pi install npm:@snorfyang/pi-switch
```

While developing from a checkout:

```bash
pi install "$(pwd)"          # local package
pi -e "$(pwd)/index.ts"      # one-off, does not write any config
```

## Usage

Use it exactly like a normal login:

1. Run `/login` (or `/login <provider>`, for example `/login deepseek`, `/login openai`).
2. Pick the provider.
3. Providers without OAuth (deepseek, zai-coding-cn, google, huggingface) go straight to the key-pool menu. Anthropic and OpenAI also offer their subscription login next to it; pick "Sign in with an API key" to reach the pool.

If the pool is empty and Pi has a stored credential for that provider, pi-switch imports it and goes straight to the menu. Otherwise it asks for a key (DeepSeek shown; the menu always uses the provider's own name):

```
Login to DeepSeek
> Paste your DeepSeek API key
> Label for this key (optional)
```

The menu:

```
DeepSeek key pool (2 stored)
▶ #1 sk-abc123...wxyz  (main)
  #2 sk-def456...uvwx  (backup)
➕ Add key
↻ Re-enable disabled keys
✔ Done
```

- `▶` marks the active key.
- **Select a key row** to open its submenu:

  ```
  ▶ #1 sk-abc123...wxyz  (main)
  ▶ Use this key
  ✎ Change label (main)
  ✎ Edit key value
  🗑 Remove this key
  ↩ Back
  ```

  - `Use this key` makes it active.
  - `Change label` / `Set label` renames a key (leave empty to clear).
  - `Edit key value` replaces the secret (leave empty to keep it); duplicate values are rejected.
  - `Remove this key` deletes it after a confirmation.
  - `Back` returns to the main menu.

- `Add key` stores another key (it asks for an optional label; duplicate values are rejected).
- `Re-enable disabled keys` clears every `disabled` flag and cooldown.
- `Done` finishes the login flow. At least one key is required.

When you finish, Pi stores the active key in `auth.json` as usual. pi-switch only reads the pool, so that entry is just a side effect and does not affect rotation.

Afterwards pick any model of that provider with `/model` (e.g. `deepseek/*`); rotation happens automatically.

## How a key is chosen, and when it retries

pi-switch does not probe keys. It only reacts to the result of the last request.

A key is "usable" when it is neither disabled nor cooling down:

```ts
isUsable(key) = !key.disabled && !isCoolingDown(key)
```

At the start of each request the usable keys are ordered with the active one first.

Failures are classified from the error message:

| Check | Match examples | Result |
|---|---|---|
| 1 | `insufficient balance`, `insufficient_quota`, `quota`, `out of budget`, `billing`, `not enough balance`, `余额不足`, `欠费` | key is **disabled** (persisted) when another enabled key remains, pointer moves on |
| 2 | `invalid api key`, `authentication fail`, `unauthorized`, `invalid token`, `401` | key is **disabled** (persisted) when another enabled key remains, pointer moves on |
| 3 | `rate limit`, `429`, `too many requests`, `overloaded`, `server busy`, `请求过多`, `服务繁忙` | key is cooled down for 30 seconds, not disabled |
| — | anything else (timeouts, 5xx, aborts, context overflow…) | passed through, no key marked, no retry |

Within a single request, pi-switch moves to the next key only when all of these hold:

```ts
canRetry = the error was classified
        && a pool key was used
        && no content has been produced yet
        && another candidate exists
```

- Each key is tried at most once per request.
- Once content has started streaming, an error is passed through and the key is **not** marked (a half-finished response is never duplicated).
- If no key is usable, a single attempt is made with the fallback key; another failure is reported as-is.

Across requests:

- Rate-limited keys become usable again after 30 seconds (the cooldown is in memory and resets when Pi restarts).
- A key is only disabled while **another enabled key remains**. The last usable key is never disabled: it keeps being tried, so after you top it up it works again with no manual re-enable.
- Disabled keys never recover on their own. Re-enable them with `Re-enable disabled keys` in `/login <provider>`, or edit the JSON file.
- Successful keys are not recorded; they are simply "not marked".

## Configuration

File: `~/.pi/agent/pi-switch.json` (honors `PI_CODING_AGENT_DIR`).

```json
{
  "version": 1,
  "providers": {
    "deepseek": {
      "keys": [
        { "id": "a1b2c3", "key": "sk-...", "label": "main" },
        { "id": "d4e5f6", "key": "sk-...", "label": "backup" }
      ],
      "activeIndex": 0
    }
  }
}
```

`disabled` / `disabledReason` / `disabledAt` are written when a key fails; remove them by hand to recover a key.

The file is keyed by provider, so every provider shares one file. Duplicate key values are collapsed when the file is read.

## How it works

1. On `session_start` the extension takes each supported built-in provider and replaces it with a thin wrapper. Models, metadata, and `baseUrl` are reused; only `auth` and `stream` / `streamSimple` change.
2. `/login <provider>` calls the provider's `auth.apiKey.login(interaction)`, which the wrapper replaces with the key-pool menu.
3. The wrapper buffers a response's `start` event. If the request fails before any content arrives, it marks the key and resends with the next one. Once content arrives it commits to that attempt and passes everything through.

Because the retry happens at the provider layer and before any content, it does not depend on Pi's agent-level retry and is not limited by `retry.provider.maxRetries`.

## Limitations

- Only providers that authenticate with a header / API key at request time are supported. OAuth-based providers need extra work.
- Errors that happen after content has already streamed are not retried.
- The `/login` input is plain text (Pi behavior); the key is not masked.
- pi-switch does not validate key format and does not probe keys at login time. A wrong key is accepted, then fails on the first real request (and is skipped automatically if a backup key exists).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 snorfyang
