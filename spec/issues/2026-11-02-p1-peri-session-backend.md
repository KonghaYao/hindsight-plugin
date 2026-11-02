# P1：Peri 会话下自动 retain / 多轮 recall 完全失效

**状态**：已确认，待修复。
**优先级**：P1。
**类型**：错误（缺少宿主会话后端）。
**创建日期**：2026-11-02。
**来源**：GitHub issue KonghaYao/hindsight-plugin#1。
**确认方式**：explorer 只读确认 + 主 agent 运行时复核（基线 745d7bc）。

## 确认证据

- `src/hooks/retain.ts:127-130`：`readTranscript()` 在 `transcript_path` 为空或不是普通文件时返回 `[]`。
- `src/hooks/retain.ts:188-192`：`allMessages.length === 0` 时直接 `return`，Stop hook 不写任何记忆。
- `src/hooks/session-end.ts:72`：最终 retain 被 `hookInput.transcript_path` 的真值门控，Peri 下永远不触发。
- `src/hooks/recall.ts:329-337`：`recallContextTurns > 1` 时只从 `transcript_path` 读多轮上下文。
- Peri hook stdin 固定包含 `session_id` 与 `transcript_path`（缺失时为空串，见 `peri-middlewares/src/hooks/types.rs:17-21`、`executor.rs:70-76`），没有 JSONL transcript。
- 本地库默认 `~/.peri/threads/threads.db`（`peri-tui/src/main.rs:53-54`）；`messages` 列为 `message_id, thread_id, role, content, truncated, excluded, projection`（`peri-resources/src/sessions/canonical.rs:149-153`）。
- 运行时实测：`node:sqlite` 以只读方式打开本机 11 GB 库耗时 1 ms，读取 154 条消息耗时 181 ms；行内容为 `{"version":1,"type":"message","message":{...}}`，存在 `system_reminder` 行。

## 根因链

Peri 不写 Claude Code JSONL（观察）→ hook 的 `transcript_path` 为空（观察）
→ `readTranscript('')` 返回空数组（代码证据）→ Stop retain 直接返回（观察）
；SessionEnd 的门控同样跳过；多轮 recall 读不到上下文。

用户可见后果：Peri 下不会写入任何新记忆；会话结束没有兜底 retain；`recallContextTurns > 1` 实际退化为单轮查询。

## 影响面

- 用户影响：Peri 用户的自动记忆写入完全不可用，且无报错提示。
- 受影响模块：`src/hooks/retain.ts`、`src/hooks/session-end.ts`、`src/hooks/recall.ts`。
- 是否可规避：无（只能手工调用 Hindsight API）。
- 范围外：Peri 远程 session store（本 issue 只覆盖本地 SQLite，远端跳过并记诊断）。

## 修复方案

- 新增 `src/lib/peri.ts`：识别 Peri 后端（`transcript_path` 为空且 `session_id` 非空）；默认库路径 `~/.peri/threads/threads.db`，`PERI_DB_PATH` 覆盖；只读打开 + 有界 busy timeout；按 `thread_id` 查询 `excluded = 0` 的行并按 `rowid` 排序。
- 解析 V1 envelope 与 legacy 未包裹 `BaseMessage`；跳过 `system_reminder`；`content` 支持字符串与块数组。
- `retain` / `session-end` / `recall` 接入该来源；`transcript_path` 非空时保持原 Claude Code 路径不变。
- 运行时：Bun 下用内置 `bun:sqlite`，Node 下用内置 `node:sqlite`（Node ≥ 22.13 无需 flag）；两者都不引入 npm 依赖。库缺失、锁定、损坏或运行时不可用时记录诊断并跳过，绝不让 hook 失败。
- 有界读取：SQL 侧按有效角色过滤（并始终排除 `system_reminder`），`COUNT(*)` 给出 thread 的有效总数，窗口只取最新 2000 条消息（多轮 recall 取最新 500 条）；checkpoint 仍推进到总数，避免大 session 每次 Stop 都重新解析全部历史。
- 明确不做：远程会话存储、数据库 schema 迁移、transcript 格式变更、版本号提升。

## 验收标准

1. 仅带 `session_id` 的 Stop hook 能从 SQLite 写入新的 user/assistant 消息。
2. 没有 `transcript_path` 时 SessionEnd 仍执行最终 retain。
3. 库缺失、锁定或不可读时输出诊断并跳过，不崩溃、不谎报已 retain。
4. `transcript_path` 存在时 Claude Code 现有行为不变。
5. 带 `threads` / `messages` 的 SQLite 夹具与仅含 `session_id` 的 hook 输入产出预期 retain payload。

## 验证记录

- `bun run typecheck` → 通过（`tsc --noEmit`，退出码 0）。
- `bun run lint` → 通过（`biome check .`，38 个文件，无修复）。
- `bun run build` → 通过，`dist/cli.js` 817.0 KiB；动态 `import(specifier)` 保留在产物中。
- `bun run test` → 通过，10 个测试文件，267 passed / 1 skipped（共 268；skip 为既有 `bank.test.ts`）。
- `bunx vitest run tests/hooks.test.ts` → 通过，42 个用例（Peri 用例 10 个）。
- `git diff --check` → 通过，无空白错误。
- 新增回归用例：`PeriSession > re-retains a rewritten Peri thread when the count is unchanged`。删除 1 条旧消息并追加 1 条新消息、总数保持 4，第二次 Stop 触发 retain，`document_id` 为 `<session>-c1`，payload 含新消息与非空内容。
- 新增大 session 用例：`PeriSession > retains only the newest bounded window of a large Peri thread`。2500 条消息时首次只加载最新 2000 条（含 `bulk message 2499`、不含 `bulk message 0`），checkpoint 提交 2500；追加 2 条后第二次仅 retain 这 2 条（含 `newest large question`、不含 `bulk message 2499`），`document_id` 为 `<session>-c1`，checkpoint 提交 2502。
- 构建产物端到端：对真实 Peri 库（`~/.peri/threads/threads.db`，只读）+ 不可达 API 运行 `node dist/cli.js hook retain`，输出 `Peri session store: read 173/173 messages from thread <session_id>`、`Full session retain: 173 new messages from 173 total (window 173) into chunk 0`、`Retaining ... doc '<session_id>'`；随后仅因 API 不可达报 `Retain failed: fetch failed`，退出码 0。证明打包后的动态 SQLite 加载、角色过滤与真实 schema 兼容，失败不阻塞 hook。
- 大 session 实测：本机原始行数最多的 thread 有 16,725 行（有效 user/assistant 仅 103 行），有效行最多的 thread 有 1,102 行；读取最新 2000 条窗口（实际 1,102 条）约 12 ms / 2.7 MB。窗口上限用于防止极端 thread 拖垮 15s 的 Stop hook。
- 环境说明：worktree 初始没有 `node_modules` 与 `dist/`；执行 `bun install --frozen-lockfile`（锁文件未变）和 `bun run build` 后上述命令通过。测试夹具使用 `node:sqlite`，因此测试套件要求 Node ≥ 22.13（CI 为 Node 22 latest）。
- 端到端依赖：Peri PR KonghaYao/peri#329 在生产 hook 装配中传入真实 `session_id`、导出 `PERI_DB_PATH`，并接受 camelCase `hookSpecificOutput`；合并后 Stop / UserPromptSubmit 可用。合并前 Stop 因 `session_id` 为空安全跳过；SessionEnd 当前即可工作。

