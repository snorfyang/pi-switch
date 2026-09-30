# pi-switch

一个 Pi 扩展：给每个 provider 存多个 API key，某个 key 没额度或限流时自动切到下一个。

目前支持 **DeepSeek**（第一个 provider）。存储文件按 provider 分组，接口也按 provider 泛化，后续可以照同样方式加别的 provider。

## 功能

- **没有单独的斜杠命令**。密钥管理集成在 Pi 原生的 `/login` 里：`/login <provider>`（目前是 `/login deepseek`）→ API key 登录 → 密钥池菜单（界面英文）。
- 如果池是空的但 Pi 已经存过一个 key（`auth.json`），**会自动导入**，不会再让你重新 paste。
- 请求发出前用当前 key；如果**还没产生任何内容**就失败，自动换下一个 key 重发同一个请求，用户侧无感。
- 失败自动分类：余额不足 / key 无效 → 永久禁用该 key；限流 → 冷却 30 秒。详见[运行时的判断与重试规则](#运行时的判断与重试规则)。
- key 值自动去重：添加 / 编辑 / 导入时若池里已有相同值会被拒绝；读盘时也会折叠历史遗留的重复项。
- 池里没有 key 时，行为跟内置 DeepSeek provider 完全一致（回退到 `auth.json` / `DEEPSEEK_API_KEY`）。
- key 存在 `<agent-dir>/pi-switch.json`，权限 `0600`。

## 安装

方式一：从 npm 安装（发布后）。

```bash
pi install npm:pi-switch
```

方式二：本地 package。

```bash
pi install "$(pwd)"
```

方式三（开发用）：把仓库目录软链到 Pi 的用户扩展目录。

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-switch
```

方式四：单次加载，不写配置。

```bash
pi -e "$(pwd)/index.ts"
```

改完代码后在会话里跑 `/reload` 即可生效。

## 使用

和 Pi 原生的登录完全一样：

1. 执行 `/login`（或直接 `/login deepseek`）。
2. 选 `DeepSeek`。
3. DeepSeek 只有 API key 一种登录方式，会直接进入密钥池菜单。

如果池里还没有 key，会先尝试导入 **Pi 自己存的凭据**（`auth.json` 里 deepseek 的 `api_key`，标为 `imported`）。

导入成功会提示 `Imported 1 stored DeepSeek key(s)` 并直接进菜单。只有确实没有存过 key 时，才会让你粘贴：

> 环境变量（`DEEPSEEK_API_KEY`）和 `models.json` 里的 `apiKey` **不会**被导入。它们仍然照常生效（空池时 provider 会回退到 Pi 的原生解析），只是不会出现在池里。

```
Login to DeepSeek
> Paste your DeepSeek API key (sk-...)
> Label for this key (optional)
```

之后进入菜单：

```
DeepSeek key pool (2 stored)
▶ #1 sk-abc123...wxyz  (主号)
  #2 sk-def456...uvwx  (备用)
➕ Add key
↻ Re-enable disabled keys
✔ Done
```

主菜单：

- `▶` = 当前 key。
- **选中某个 key 行** → 进入这个 key 的子菜单：

  ```
  ▶ #1 sk-abc123...wxyz  (主号)
  ▶ Use this key
  ✎ Change label (主号)
  ✎ Edit key value
  🗑 Remove this key
  ↩ Back
  ```

  - `▶ Use this key` 设为当前（当前那个会显示 `● Already active`）。
  - `✎ Change label / Set label` 改名 / 加标签（留空清除）。
  - `✎ Edit key value` 直接换成另一个 key（留空保持），会顺带清掉 disabled 状态；如果新值和池里别的 key 重复会被拒绝。
  - `🗑 Remove this key` 删除（会先确认）。
  - `↩ Back` 回主菜单。

- `➕ Add key` 再存一个：先粘贴 key（若已在池里会提示 `Already in the pool` 并跳过），再问标签（可留空）。
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

文件：`~/.pi/agent/pi-switch.json`（受 `PI_CODING_AGENT_DIR` 影响）

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

加载时会按 `key` 值去重（相同值只保留第一条），并在下一次写盘时清理掉文件里的重复项。

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

## 扩展到其他 provider

目前 `PROVIDERS = ["deepseek"]`，`PROVIDER_ID` 取第一个。存储文件的 `providers` 结构本来就被 provider 分组，`poolAuth` / `attemptWithRotation` / `readStoredKey` / `importExistingKeys` 也已经都以 providerId 为参数。

要加一个 provider，主要是两步：

1. 把 provider id 加进 `PROVIDERS`；
2. 在 `session_start` 里对每个 provider 各自捕获并包装一次（现在只包了第一个）。

注意：只有**请求发出时用 header / API key 鉴权**的 provider 适用；OAuth 类 provider 需要额外适配。

## 已知限制

- 只对**请求发出时用 header / API key 鉴权**的 provider 有效；依赖 OAuth 的 provider 需要额外适配。
- 如果错误发生在正文已经输出之后，不会重试（宁可让用户看到半截错误，也不重复正文）。
- `/login` 的输入框是明文（Pi 原生行为），不会隐藏 key。
- 登录收尾时 Pi 仍会把当前 key 写入 `auth.json`；之后若清空池并 `/logout deepseek`，这条记录会被删掉，池文件不受影响。
- 不做格式校验、不做登录时探测：粘错 key 也能存进去，等到第一次真实请求才会暴露并（在有备份 key 时）自动切换。

## 发布

已按 [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) 的要求准备好 manifest：

- `pi.extensions: ["./index.ts"]`
- `keywords` 包含 `pi-package`（这样才会出现在 [Pi package gallery](https://pi.dev/packages)）
- 宿主提供的包（`@earendil-works/pi-ai` / `pi-coding-agent`）放在 `peerDependencies: "*"`，**不**放 `dependencies`
- `files` 只打包 `index.ts` / `README.md` / `LICENSE`
- 无构建步骤，Pi 直接用 jiti 加载 TS

发布流程：

```bash
npm login          # 本机目前未登录
npm publish        # 发布 0.1.0
```

之后用户即可 `pi install npm:pi-switch`。

## License

[MIT](./LICENSE) © 2026 snorfyang
