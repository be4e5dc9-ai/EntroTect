# Pinned Commits —— 笔记引用基线

> **用途**：本目录全部笔记中的 `文件:行号` 引用均以**下表所列 commit** 为准。上游仓库持续演进，行号会随后续提交漂移；复核或更新笔记时请以此表为准绳。

## 基线清单

| 仓库 | 本地路径 | 远程 | 分支 | HEAD commit | 提交日期 | HEAD 主题 |
|---|---|---|---|---|---|---|
| ClaudeCode | `D:\my agent\ClaudeCode\` | https://github.com/Rito-w/ClaudeCode | main | `895221e6964cf288c5fa1d2bb86edb568c491061` | 2026-03-31 | init: restored runnable Claude Code source from source maps |
| deepseek-harness | `D:\my agent\deepseek-harness\` | https://github.com/deepseek-ai/deepseek-harness | master | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 2026-08-21 | Merge pull request #2908 from deepseek-harness/release/dsh-0.1.1-rc.2 |
| opencode | `D:\my agent\opencode\` | https://github.com/anomalyco/opencode | dev | `3a31c4ea801915c0b050df4b3842997ea62b6e93` | 2026-08-22 | fix(app): keep model provider headers visible (#44115) |
| codex | `D:\my agent\codex\` | https://github.com/openai/codex | main | `343074d4207d572809bd8cea15f4be1d09d98e0b` | 2026-08-22 | Report runtime MCP connection status (#40068) |

分析日期：2026-08-23。

## 使用约定

### 1. 行号引用的有效性

- 所有 `文件:行号` **仅对上表 commit 有效**。上游更新后行号必然漂移。
- 行号失效时的定位方法：笔记中每处引用都附带**符号名**（函数名 / 类型名 / 常量名），应优先按符号全文检索而非按行号跳转。例如"queryLoop"在 `src/query.ts` 内全局唯一，`grep -n queryLoop` 即可重新锚定。

### 2. 源码位置

- 四个仓库均完整克隆在本工作区：`D:\my agent\<仓库名>\`（各含 `.git`，可随时用下述命令核对当前 checkout 是否仍为基线 commit）：

```powershell
git -C "D:\my agent\ClaudeCode" rev-parse HEAD
git -C "D:\my agent\deepseek-harness" rev-parse HEAD
git -C "D:\my agent\opencode" rev-parse HEAD
git -C "D:\my agent\codex" rev-parse HEAD
```

- 若目录被移动/删除：按"远程 URL + HEAD commit"重新获取——前三个是公开 GitHub 仓库，可直接 clone 后 `git checkout <hash>`；ClaudeCode 为还原源码仓库，其历史即该 commit 本身。

### 3. 数据来源三级标注规范

笔记中的定量陈述分三类，可信度递减：

| 标注 | 含义 | 示例 |
|---|---|---|
| 【源码常量】（默认，不加标注） | 直接读自代码/配置的字面值 | 截断阈值 50k 字符、超时 120s、池上限 10 |
| 【上游注释称】 | 来自上游代码注释或文档的**自述数据**，本笔记未独立复测 | packChunks "日志体积约减 60%"（dsh session-persistence-jsonl 注释）、BetaMessageStream "O(n²)"（Claude Code claude.ts 注释） |
| 【分析推断】 | 本笔记基于代码结构做出的推断/估算 | 复刻人日预估 |

**当前状态**：绝大多数定量数字属第一类；第二类已在正文逐处标注"上游注释"；第三类仅出现在"复刻路径"章节且已标明为估算。后续新增笔记请沿用此规范。

### 4. 更新流程

若日后升级到新 commit 重做分析：

1. 在上表追加新行（保留旧行作为历史基线）；
2. 用 `git diff <旧hash>..<新hash> --stat` 圈定受影响文件；
3. 仅修订受影响主题文件中的行号，并在文件头部注明"已对齐 <新hash>"。
