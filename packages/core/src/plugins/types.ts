// =====================================================================
// 插件系统类型:Plugin = 声明式 Hooks 集合
// 设计依据:opencode/13 §2——插件即"函数返回 Hooks"的形态;
// v1 只取三个钩子:chat.message / tool.execute.before / tool.execute.after,
// 全部同步、主流程内联调用(插件异常由 manager 兜底,绝不中断主流程)。
// =====================================================================

/** 注入给插件工厂的宿主 API(v1 最小集:仅带前缀日志) */
export interface PluginApi {
  /** 带 [plugin] 前缀的 console.log */
  log: (...args: unknown[]) => void;
}

/** 插件钩子集合:每个钩子可选,缺省即不参与该阶段 */
export interface PluginHooks {
  /** 用户消息发送前改写文本;返回 string 替换,返回 undefined 保持原样 */
  "chat.message"?: (text: string) => string | undefined | void;
  /** 工具执行前(审批通过后、call 之前);返回 string 则替换为新的 args JSON 字符串 */
  "tool.execute.before"?: (toolName: string, args: unknown) => string | undefined | void;
  /** 工具执行后观察;不能改结果 */
  "tool.execute.after"?: (toolName: string, output: string, isError: boolean) => void;
}

/** 一个已加载的插件:name 用于日志与调试,hooks 参与主流程 */
export interface Plugin {
  name: string;
  hooks: PluginHooks;
}

/** 插件工厂:接收宿主 API,返回 Plugin 或直接返回 Hooks(缺 name 时用文件名) */
export type PluginFactory = (api: PluginApi) => Plugin | PluginHooks;
