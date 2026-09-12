// =====================================================================
// zod → JSON Schema 转换(手写最小子集)
// 设计依据:ClaudeCode/03 §5——zod 是唯一事实来源,序列化按 schema 缓存
// 保证字节级稳定(保 prompt cache 前缀)。
// =====================================================================

import { z } from "zod";

/** 会话级缓存:同一 zod schema 对象每次产出完全相同的 JSON */
const cache = new WeakMap<z.ZodType, unknown>();

export function zodToJsonSchema(schema: z.ZodType): unknown {
  const cached = cache.get(schema);
  if (cached) return cached;
  const result = convert(schema);
  cache.set(schema, result);
  return result;
}

function convert(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return withDescription(schema, convert(schema._def.innerType) as Record<string, unknown>);
  }
  if (schema instanceof z.ZodEffects) {
    return convert(schema._def.schema);
  }
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(
      schema.shape as Record<string, z.ZodType>,
    )) {
      properties[key] = convert(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = {
      type: "object",
      properties,
      required,
      additionalProperties: false, // strictObject 语义:幻觉参数直接被拦
    };
    return withDescription(schema, result);
  }
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    for (const check of schema._def.checks) {
      if (check.kind === "min") result.minLength = check.value;
      if (check.kind === "max") result.maxLength = check.value;
      if (check.kind === "regex") result.pattern = check.regex.source;
    }
    return withDescription(schema, result);
  }
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") result.type = "integer";
      if (check.kind === "min") result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      if (check.kind === "max") result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      if (check.kind === "multipleOf") result.multipleOf = check.value;
    }
    return withDescription(schema, result);
  }
  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: "boolean" });
  }
  if (schema instanceof z.ZodArray) {
    const result: Record<string, unknown> = {
      type: "array",
      items: convert(schema.element),
    };
    if (schema._def.minLength) result.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) result.maxItems = schema._def.maxLength.value;
    return withDescription(schema, result);
  }
  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, {
      type: "string",
      enum: [...schema.options],
    });
  }
  if (schema instanceof z.ZodLiteral) {
    return withDescription(schema, { const: schema.value });
  }
  if (schema instanceof z.ZodNativeEnum) {
    return withDescription(schema, {
      type: "string",
      enum: Object.values(schema.enum),
    });
  }
  throw new Error(`不支持的 zod schema 类型: ${schema.constructor.name}`);
}

function withDescription(schema: z.ZodType, result: Record<string, unknown>): unknown {
  const description = schema.description;
  return description ? { ...result, description } : result;
}
