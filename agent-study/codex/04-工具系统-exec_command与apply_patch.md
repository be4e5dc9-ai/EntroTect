# Codex 工具系统：ToolSpec、exec_command 与 apply_patch

> 归属：`agent-study/codex/` | 关键词：ToolSpec、FreeformTool、exec_command、yield_time_ms、write_stdin、apply_patch、Lark 文法、seek_sequence
> 核心文件：`codex-rs/tools/src/{tool_spec,responses_api,json_schema}.rs`、`core/src/tools/handlers/shell_spec.rs`、`apply-patch/src/`

---

## 1. 三层架构

```
模型看到的 JSON Schema      ← codex-tools crate: ToolSpec / JsonSchema
        ↑
ToolRouter / ToolRegistry   ← core/src/tools/{router,registry}.rs：名字→runtime 映射与分发
        ↑
CoreToolRuntime(handler)    ← core/src/tools/handlers/*.rs + runtimes/*.rs
```

注册表为 IndexMap（registry.rs:270-274）；spec_plan.rs 按 feature/model 能力规划本轮最终工具集并检测重名冲突。

## 2. ToolSpec（tools/src/tool_spec.rs:20-56）

```rust
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum ToolSpec {
    #[serde(rename = "function")]    Function(ResponsesApiTool),
    #[serde(rename = "namespace")]   Namespace(ResponsesApiNamespace),  // MCP 工具分组
    #[serde(rename = "tool_search")] ToolSearch { execution, description, parameters },
    #[serde(rename = "web_search")]  WebSearch { external_web_access, .. },
    #[serde(rename = "custom")]      Freeform(FreeformTool),            // apply_patch 用
}
// ResponsesApiTool { name, description, strict, defer_loading, parameters: JsonSchema }
//   (responses_api.rs:32-44)
// FreeformTool 带 format: { type, syntax, definition } (16-29) —— apply_patch 用 .lark 语法定义
//   (handlers/apply_patch.lark)
```

序列化入口 create_tools_json_for_responses_api()（tool_spec.rs:82）。工程细节：
- MCP 工具转 Responses API 工具时 schema 超 **8000 字节自动退化为空对象 schema**（responses_api.rs:13、136-142）;
- 延迟加载 into_deferred()（146-155）配合 tool_search 工具按需暴露——工具多时不撑爆 system。

## 3. exec_command 工具（shell_spec.rs:21-111）

参数：
- cmd(必填)、workdir、tty、**yield_time_ms**（Windows 默认 10s 且有效区间不同，26-30 平台分支文案）、max_output_tokens、shell、login、environment_id;
- 审批相关可选参数（228-274）：sandbox_permissions ∈ {use_default, with_additional_permissions, require_escalated}、justification、prefix_rule（如 ["git","pull"] 复用审批前缀）、additional_permissions（网络开关+文件读写根列表的 JSON Schema，276-333）。

输出 schema unified_exec_output_schema()（194-226）：

```json
{ "chunk_id?": "...", "wall_time_seconds": 1.2, "exit_code?": 0,
  "session_id?": "...", "original_token_count?": 100, "output": "..." }
```

★ 未结束的命令返回 session_id——配套 **write_stdin 工具**（113-155）向仍在运行的会话写字符/轮询输出，实现长驻进程（后台终端）。

参数反序列化（unified_exec.rs:27-48 ExecCommandArgs）；get_command（97-142）按 UnifiedExecShellMode::{Direct, ZshFork} 把 cmd 展开为 `[shell_path, "-lc", cmd]`；login 受 config.allow_login_shell 约束。Windows 专属安全提示注入描述文本（windows_shell_guidance，335-340）。

执行链：runtimes/unified_exec 维护 PTY 会话表（utils/pty / portable-pty）→ core/src/exec.rs process_exec_tool_call（291-311）→ build_exec_request 选择 SandboxType 并应用代理环境变量（315-399）→ SandboxManager::transform 把裸命令改写成沙箱包裹的 argv → execute_exec_request spawn 并聚合 stdout/stderr（带字节上限 append_capped，:814）。

输出格式 format_exec_output_for_model()："Exit code:/Wall time:/Output:" 文本格式（tools/mod.rs:93-118）。

## 4. apply_patch：自定义补丁格式 ★

### Lark 文法（apply-patch/src/parser.rs:4-25）

```
start: begin_patch environment_id? hunk+ end_patch
begin_patch: "*** Begin Patch" LF
hunk: add_hunk | delete_hunk | update_hunk
add_hunk:    "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
change_context: ("@@" | "@@ " /(.+)/) LF          # 定位行（通常是函数签名）
change_line: ("+" | "-" | " ") /(.+)/ LF
eof_line: "*** End of File" LF
```

标记常量在 parser.rs:37-45。解析产物：

```rust
// parser.rs:64-132
enum Hunk {
    AddFile { path, contents },
    DeleteFile { path },
    UpdateFile { path, move_path: Option<PathBuf>, chunks: Vec<UpdateFileChunk> },
}
struct UpdateFileChunk {
    change_context: Option<String>,                  // @@ 定位行
    old_lines / new_lines: Vec<String>,              // '-'/' ' 行 与 '+'/' ' 行
    context_line_indices: Vec<(usize, usize)>,       // 上下文行两侧配对索引
    is_end_of_file: bool,
}
```

两个值得学习的细节：

1. **Lenient 解析**（154-190）：GPT-4.1 会把 heredoc `<<'EOF'...EOF` 当字面量传入，lenient 模式识别并剥掉包装（PARSE_IN_STRICT_MODE=false，53 行）；
2. **流式解析器 StreamingPatchParser**（streaming_parser.rs，36KB）：模型还在流式吐 patch 参数时就能增量解析出 hunk，实时渲染 diff 事件（ApplyPatchArgumentDiffConsumer 每 500ms 节流发 EventMsg::PatchApplyUpdated，core handler 86-155）。

### 应用逻辑（apply-patch/src/lib.rs）

- ApplyPatchArgs { patch, hunks, workdir, environment_id }（152-157）；
- 校验阶段产出 ApplyPatchAction（193-205）：HashMap<PathUri, ApplyPatchFileChange>，其中 Update { unified_diff, move_path, new_content }（160-173）;
- **验证后应用**：verify_apply_patch_args_with_mode 先不落盘验证所有 hunk 能命中上下文（seek_sequence.rs 在文件中搜索 old_lines 序列定位插入点，容忍尾部换行差异），通过才逐 hunk 应用（apply_hunks_to_files 470+）;失败携带 AppliedPatchDelta（已成功写入部分）精确报告半途状态（310-336）;
- 换行策略 ApplyPatchFileUpdateMode::{NormalizeToLf, PreserveLineEndings} 由 feature flag 控制（core handler 61-71）。

core 侧 handler（core/src/tools/handlers/apply_patch.rs:351-363）：spec 返回 FreeformTool；handle_call（366-449）流程=parse → 选环境 → verify → 权限不足的写入路径自动推导 AdditionalPermissionProfile（write_permissions_for_paths 236-271，跳过本就可写目录避免反向授权父目录）→ 触发审批 → 执行。

## 5. 自研启示

1. 自由格式工具（Freeform + lark 语法定义）比 JSON 转义的多文件编辑对模型友好得多。
2. 补丁"先验证后应用"+ 半途状态回传，把部分失败从灾难变成可报告事件。
3. exec 的 yield_time_ms/session_id/write_stdin 组合是"长命令不阻塞回合"的完整方案。
