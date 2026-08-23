// EntroTect Agent 核心公共入口。
// 设计依据:ClaudeCode/11 §2 设计精华第 10 条——先做成纯库,UI 只是消费者。
export * from "./provider/index.js";
export * from "./tools/index.js";
export * from "./loop/index.js";
export * from "./prompt/index.js";
export * from "./permission/index.js";
export * from "./config.js";
