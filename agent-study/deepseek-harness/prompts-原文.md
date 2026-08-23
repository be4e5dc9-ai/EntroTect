# DeepSeek Harness 提示词原文汇编

> 提取自 `D:\my agent\deepseek-harness\packages\` @ commit `
> 结构说明：harness 自身几乎不写长提示词——身份句固定、persona 由部署配置注入、变量 {{model}}/{{cwd}} 严格插值；工具指引由各工具 description 承担。这是"薄提示词"流派的最佳样本。

## 1. 固定身份段 harness:identity（system-prompt 注册表内置）

> 来源：`packages/core/system-prompt/src/index.ts`（L340-L385）@ commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` —— 逐字原文，未改写

``````
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    persona: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // Keep harness-owned openers independent of the selected loop plugin.
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: -100,
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      // The fallback narrows the optional input type; the schema already defaults it.
      text: config.persona ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
``````

## 2. headless 部署 persona 模板（含 {{model}}/{{cwd}} 变量用法）

> 来源：`packages/bundle/headless/cordis.patch.yml`（全文 35 行）@ commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` —— 逐字原文，未改写

``````
# The dsh-headless bundle patch: one-shot task mode directly over dsh-base.
# It mounts no Host, HTTP server, Web runtime, or browser plugin. An ordinary
# provider plugin injects `cmdlineArgs`, parses the task positional
# (`dsh --profile headless "<task>"`) and this app's --help, then the direct
# driver creates an Agent through the core registry and prints its durable result.

- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

# The shared module-reload HMR row stays off; the launcher's watch-only
# fallback still keeps the user patch layers live until the run exits.
- id: hmr
  disabled: true

- id: tools
  config:
    # Keep the same temporary process-wide Code Mode opt-in as the Web surface.
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    # Code Mode is a core execution capability, not a Web component.
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: headless-startup
      name: '@deepseek-ai/dsh-headless/startup'

    # Reads its task from the ordinary headlessStartup provider.
    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
``````

## 3. 压缩摘要指令 COMPACTION_INSTRUCTION（KV-cache 感知设计注释也在其中）

> 来源：`packages/compaction/compaction-basic/src/summarizer.ts`（L15-L90）@ commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` —— 逐字原文，未改写

``````
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
``````
