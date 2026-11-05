# dsh-suggest-actions

English | [中文](#中文)

Claude-style next-step suggestions under the assistant's latest reply: after a Turn closes, the card asks one concrete follow-up question and offers two or three clickable chips. Clicking a chip sends that sentence as your message — no copy, no retyping, no composer round-trip.

```
┌──────────────────────────────────────────────────────────┐
│ 希望优先深入或推进哪一类 VSM 改进项？                    │  ✕
│ [优先做单池多光源重构 ↵] [优先做 GPU 侧缓存与剔除]       │
│ 点一下就把这句话发出去                                    │
└──────────────────────────────────────────────────────────┘
```

## What it does

- Mounts into the `conversation.chat.turnTail` slot, so the card sits directly under the closing assistant message rather than inside the composer.
- Only the newest closed Turn shows a card. Older Turns render nothing and never spend a model call; each Turn makes at most one suggestion request, cached per `(session, seq)` for 15 minutes.
- One small model call per Turn, using the Session's own provider/model (falling back to the configured default). Transcript trimming keeps the newest user/assistant text only — tool results, attachments, system prompts and injected context never leave the machine.
- Clicking a chip calls the same prompt path the composer uses (local submission echo, then `session.prompt`), so the message lands exactly like a typed one.
- The card and its copy follow the UI language (Chinese/English) through the `locale` service.

## Install

Requirements: DSH `0.2.1-rc.3` or newer on the 0.2.x line (built against `0.2.1-rc.5`), a web surface (desktop app or `dsh web`), and the dsh CLI. Quit the app before installing.

```powershell
# Point -Cli at the CLI your installation ships (or set DSH_CLI, or have `dsh` on PATH):
powershell -ExecutionPolicy Bypass -File plugins/dsh-suggest-actions/install.ps1 `
  -Cli "E:\DSH-Desktop\resources\runtime\cli\bin\dsh.cmd"
```

The script registers this directory as a `link:` dependency of the profile through the dsh CLI, which runs pnpm in the profile and materializes `<profile>/node_modules/dsh-suggest-actions`, then appends `dsh-suggest-actions` to `dsh.profile.bundles`. Use `-Profile web` for another profile. PowerShell 5.1 and 7 both read UTF-8 and write the profile without a BOM.

Registering through pnpm is the part that matters: pnpm owns `node_modules` and deletes anything its lockfile does not list. A package merely copied into `node_modules` survives until the next `dsh plugin` operation, after which the app fails with `cannot resolve profile bundle`. `-Copy` still exists as an offline fallback and prints that warning.

Manual equivalent:

```powershell
dsh plugin --profile desktop add "link:E:/deepseek-harness/plugins/dsh-suggest-actions"
# then add "dsh-suggest-actions" to the dsh.profile.bundles array in "<profile>/package.json"
```

Restart DSH. The card appears under the next completed reply.

## Troubleshooting

`dsh: cannot resolve profile bundle "dsh-suggest-actions"` — the bundle is listed in `dsh.profile.bundles` but no package resolves to that name from the profile. Check `dependencies` and `node_modules` in the profile; a package that only exists as a copied directory has already been pruned. Re-run the install command above, which records the dependency, then restart.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File plugins/dsh-suggest-actions/install.ps1 -Uninstall `
  -Cli "E:\DSH-Desktop\resources\runtime\cli\bin\dsh.cmd"
```

This removes the dependency (and its symlink), then drops the bundle entry. Nothing else is written.

## Configuration

Defaults are contributed by `cordis.patch.yml`; override per profile by editing the generated entry in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` answers every request with `disabled` and never calls the model. |
| `maxActions` | `3` | Chips per card, 1–4. |
| `timeoutMs` | `15000` | Deadline for the suggestion call. |
| `maxTokens` | `500` | Output cap for the suggestion call. |
| `maxMessages` | `8` | Transcript messages considered. |
| `maxChars` | `6000` | Transcript character budget. |

## Cost and privacy

- Default: one extra model call per completed Turn, on the Session's own model. A repair call happens only when the first reply is not usable JSON.
- Only trimmed user/assistant text from that Session is sent, framed as quoted data. Credentials, tool output, attachments and system prompts are excluded.
- Suggestions are never written to the Session log: nothing becomes durable until you click a chip and send it.

## How it works

- **Host** (`lib/`): registers `POST /dsh-suggest-actions/suggest` behind DSH's browser-cookie check. It trims `session.deriveMessages()`, resolves the Session's route, asks for strict JSON (`question` + `actions[{label,prompt}]`), repairs one malformed reply, and normalizes lengths and duplicates.
- **Client** (`client/client.js`): one `conversation.chat.turnTail` entry. A monotonic per-Session watermark decides which tail is the newest, a per-`(session,seq)` cache avoids refetching on virtualized re-mounts, and chips send through `ctx.sessions.binding(sessionId).session`.

## Known limitations

- A newly completed Turn only claims the card once its tail mounts; while scrolled far up the transcript, an older card can stay visible until the newest tail renders.
- The card hides itself after sending one chip; it does not come back for the same Turn.
- Suggestions are only as good as one small model call; a cheaper model gives blunter chips. Set the Session model accordingly.

## Tests

```powershell
cd plugins/dsh-suggest-actions
npm test
```

Covers transcript trimming, language detection, JSON extraction/normalization, the HTTP route (payload, cache, repair, auth, disabled), a client render/send smoke test with a hooks harness, and Windows installer install/uninstall JSON encoding and field preservation.

## Layout

```
lib/index.js     host entry (name / inject / apply)
lib/route.mjs    HTTP route, cache, model call
lib/suggest.mjs  pure transcript + prompt + payload helpers
client/client.js single-file browser bundle (module-loader factory)
test/            node:test suites (run in-process, no browser)
install.ps1      profile installer
```

## 中文

Claude 风格的「下一步」建议卡：助手这一轮回复结束后，在回复正下方出现一张卡片——一句针对当前内容的追问，加 2–3 个可点击的动作胶囊。点一下就把那句话作为你的消息发出去，不用复制、不用重打。

- 挂在 `conversation.chat.turnTail`（回合尾部），所以卡片在回复下方，而不是输入框里。
- 只有最新一个已结束回合显示卡片；更早的回合不渲染、也不发模型请求。每回合最多一次调用，按 `(会话, seq)` 缓存 15 分钟。
- 用会话自身的 provider/model 发一次小请求；只发送最近几条用户/助手纯文本，工具结果、附件、系统提示不外发。
- 点击走的是输入框同一条发送路径（本地回显 + `session.prompt`），落地方式与手打一致。
- 中英文案跟随界面语言。

安装（先退出 DSH，`-Cli` 指向你的安装自带的 CLI）：

```powershell
powershell -ExecutionPolicy Bypass -File plugins/dsh-suggest-actions/install.ps1 `
  -Cli "E:\DSH-Desktop\resources\runtime\cli\bin\dsh.cmd"
```

脚本通过 dsh CLI 把本目录登记成 profile 的 `link:` 依赖（pnpm 会在 profile 里生成 `node_modules/dsh-suggest-actions`），再把 `dsh-suggest-actions` 追加到 `dsh.profile.bundles`；用 `-Profile web` 可装到别的 profile。之所以必须走 pnpm 登记：`node_modules` 由 pnpm 管理，lockfile 里没有的包会在下一次 `dsh plugin` 操作时被清掉，之后启动就报 `cannot resolve profile bundle`。`-Copy` 只作离线兜底，并会打印这条警告。

卸载：`install.ps1 -Uninstall -Cli <同上>`，会移除依赖与 bundles 条目。

已知限制：滚动到很上面时，新的回合尾部未挂载，旧卡片可能短暂保留；点过一次后卡片自行隐藏。
