# pi-deepseek-keypool

给 Pi 的 DeepSeek 存多个 API key，某个 key 没额度或限流时自动切到下一个。

第一个「家族」版本，目前只接管 `deepseek` provider；结构留好了扩展位，之后可以照同样方式加到别的家族。

## 功能

- **没有单独的斜杠命令**。密钥管理集成在 Pi 原生的 `/login` 里：`/login deepseek` → API key 登录 → 密钥池菜单（界面英文）。
- 如果池是空的但你已经有一个 key（`auth.json` / `models.json` / `DEEPSEEK_API_KEY`），**会自动导入**，不会再让你重新 paste。
- 请求发出前用当前 key；如果**还没产生任何内容**就失败，自动换下一个 key 重发同一个请求，用户侧无感。
- 失败自动分类：余额不足 / key 无效 → 永久禁用该 key；限流 → 冷却 30 秒。详见[运行时的判断与重试规则](#运行时的判断与重试规则)。
- 池里没有 key 时，行为跟内置 DeepSeek provider 完全一致（回退到 `auth.json` / `DEEPSEEK_API_KEY`）。
- key 存在 `<agent-dir>/deepseek-keypool.json`，权限 `0600`。

## 安装

方式一（推荐，开发用）：把仓库目录软链到 Pi 的用户扩展目录。

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/deepseek-keypool
```

方式二：作为本地 package 安装。

```bash
pi install "$(pwd)"
```

方式三：单次加载，不写配置。

```bash
pi -e "$(pwd)/index.ts"
```

改完代码后在会话里跑 `/reload` 即可生效。

## 使用

和 Pi 原生的登录完全一样：

1. 执行 `/login`（或直接 `/login deepseek`）。
2. 选 `DeepSeek`。
3. DeepSeek 只有 API key 一种登录方式，会直接进入密钥池菜单。

如果池里还没有 key，会先尝试自动导入你已有的：

- `auth.json` 里存的 DeepSeek key（标为 `imported`）
- `models.json` 里给 deepseek 配的 `apiKey`
- 环境变量 `DEEPSEEK_API_KEY`（标为 `imported (DEEPSEEK_API_KEY)`）

导入成功会提示 `Imported N existing DeepSeek key(s)` 并直接进菜单。只有确实找不到任何 key 时，才会让你粘贴：

```
Login to DeepSeek
> Paste your DeepSeek API key (sk-...)
> Label for this key (optional)
```

之后进入菜单：

```
DeepSeek key pool (2 stored)
▶ #1 sk-abc123...wxyz     主号 · available
  #2 sk-def456...uvwx     备用 · available
➕ Add key
🗑 Remove key
↻ Re-enable disabled keys
✔ Done
```

- `▶` = 当前 key；选中某个 key 行就把它设为当前。
- `➕ Add key` 再存一个。
- `🗑 Remove key` 进入子菜单选择要删的 key。
- `↻ Re-enable disabled keys` 清掉所有 `disabled` 和冷却。
- `✔ Done` 结束登录流程（必须至少有一个 key）。

选完 `✔ Done` 后，Pi 会照常做登录收尾，并把当前 key 存进 `auth.json`。但我们的解析只认 key 池，所以那条 `auth.json` 记录只是顺带存的，不影响轮换。

之后用 `/model` 选任意 `deepseek/*` 模型即可，轮换自动发生。

## 运行时的判断与重试规则

扩展**不做主动探测**（登录时也不校验 key 的格式或可用性），只有上一次请求的结果。

「可用」的定义：

```ts
isUsable(key) = !key.disabled && !isCoolingDown(key)
```

每次请求开始时，按「当前 active 优先」排出所有 usable 的 key 作为候选。

失败分类（按顺序匹配 `errorMessage` 文本）：

| 顺序 | 匹配（正则） | 判定 | 后果 |
|---|---|---|---|
| 1 | `insufficient balance` / `insufficient_quota` / `quota` / `out of budget` / `billing` / `not enough balance` / `余额不足` / `欠费` | balance | **永久禁用**（写盘），activeIndex 前移 |
| 2 | `invalid api key` / `authentication fail` / `unauthorized` / `invalid token` / `401` | auth | **永久禁用**（写盘），activeIndex 前移 |
| 3 | `rate limit` / `429` / `too many requests` / `overloaded` / `server busy` / `请求过多` / `服务繁忙` | rate | **冷却 30 秒**（内存），activeIndex 前移 |
| — | 其它（超时、5xx、abort、context overflow…） | 不分类 | 不改状态，不重试 |

**单次请求内**换 key 重试的条件（四个同时满足）：

```ts
canRetry = 有失败分类
        && 当前用的是池里的 key
        && 还没产出任何正文
        && 还有下一个候选
```

含义：

- 每个 key 在**一次请求里最多尝试一次**。
- 正文一旦开始输出，之后出错**不重试、不标记 key**（宁可透传半截错误，也不重复正文）。
- 候选为空时会退化成一个 `undefined` 候选，用 `resolve()` 给的第一个 key 硬发一次；再失败就直接报错。

**跨请求**：

- rate 的 key：30 秒后自动恢复可用（冷却在内存里，重启 Pi 会清零）。
- balance / auth 的 key：**不会自愈**，必须在 `/login deepseek` 里选 `↻ Re-enable disabled keys`，或手改 JSON。
- 成功的 key：没有正向记录，只是「没被打标记」。

## 配置

文件：`~/.pi/agent/deepseek-keypool.json`（受 `PI_CODING_AGENT_DIR` 影响）

```json
{
  "version": 1,
  "providers": {
    "deepseek": {
      "keys": [
        { "id": "a1b2c3", "key": "sk-...", "label": "主号" },
        { "id": "d4e5f6", "key": "sk-...", "label": "备用" }
      ],
      "activeIndex": 0
    }
  }
}
```

`disabled` / `disabledReason` / `disabledAt` 由扩展在失败时写入；手动删掉就可以恢复。

## 工作原理

1. `/login deepseek` 时，Pi 调用 provider 的 `auth.apiKey.login(interaction)`。我们在包装 provider 时替换了它，把它变成密钥池的管理流程（`interaction.prompt` 支持 select / secret / text，且可以循环）。
2. 在 `session_start` 时取出内置 `deepseek` provider，用一个薄包装替换它：
   - `getModels` / 模型元数据 / baseUrl 等全部沿用原来的；
   - 只改 `auth`（从 key 池取 key，`login` 走上面的流程）和 `stream` / `streamSimple`（加重试）。
3. 包装层缓冲响应的 `start` 事件：
   - 一旦出现正文（`text_delta`、`toolcall_*` 等）就锁定这次尝试，后续事件原样透传；
   - 如果 `start` 之后直接是 `error`，说明请求在产生内容前就被拒了——正是额度/限流的形态，于是标记失败、换下一个 key、重发。
4. 所有 key 都用完仍未成功时，把最后一次错误原样交给 Pi。

因为重试发生在 provider 层、且在任何内容产生之前，所以不需要 Pi 的 agent 级重试，也不受 `retry.provider.maxRetries` 限制。

## 测试

仓库自带一个假 DeepSeek 服务，验证「坏 key → 自动换好 key」：

```bash
./test/run-e2e.sh
```

它会起一个本地 OpenAI 兼容服务，`sk-bad` 返回 402 `Insufficient Balance`，`sk-good` 返回正常流式回复；然后跑一次 `pi -p`，断言：

- 请求日志里先出现 `sk-bad`，再出现 `sk-good`；
- Pi 最终拿到 `sk-good` 的回复；
- 存储文件里 `sk-bad` 被标记 `disabled`。

## 扩展到其他家族

主要动两个常量：

- `PROVIDER_ID`：目前写死 `deepseek`；
- `session_start` 里捕获并包装对应 provider。

存储文件的 `providers` 结构本身就是按 provider 分组的，稍加改造（把 `PROVIDER_ID` 换成可配置列表、给 `poolAuth` / `attemptWithRotation` 传入 providerId）即可扩展到 `anthropic`、`openai`、`openrouter` 等。

## 已知限制

- 只对**请求发出时用 header / API key 鉴权**的 provider 有效；依赖 OAuth 的家族需要额外适配。
- 如果错误发生在正文已经输出之后，不会重试（宁可让用户看到半截错误，也不重复正文）。
- `/login` 的输入框是明文（Pi 原生行为），不会隐藏 key。
- 登录收尾时 Pi 仍会把当前 key 写入 `auth.json`；之后若清空池并 `/logout deepseek`，这条记录会被删掉，池文件不受影响。
- 不做格式校验、不做登录时探测：粘错 key 也能存进去，等到第一次真实请求才会暴露并（在有备份 key 时）自动切换。
