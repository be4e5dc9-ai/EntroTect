import { z } from "zod";

const tabId = z.string().min(1).max(160);
const url = z.string().trim().min(1).max(8192);
export const browserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), url }),
  z.object({ action: z.literal("navigate"), tabId, url }),
  ...(["back", "forward", "reload", "close", "snapshot", "extract", "screenshot"] as const)
    .map((action) => z.object({ action: z.literal(action), tabId })),
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("click"), tabId, ref: z.string().min(1).max(80) }),
  z.object({ action: z.literal("type"), tabId, ref: z.string().min(1).max(80), text: z.string().max(20000) }),
  z.object({ action: z.literal("press"), tabId, key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown"]) }),
  z.object({ action: z.literal("scroll"), tabId, direction: z.enum(["up", "down", "left", "right"]), pixels: z.number().int().min(1).max(3000).optional() }),
  z.object({ action: z.literal("wait"), tabId, text: z.string().max(500).optional(), timeoutMs: z.number().int().min(100).max(15000).optional() }),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}
export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
}
export interface BrowserSnapshot {
  title: string;
  url: string;
  text: string;
  elements: BrowserElement[];
  truncated: boolean;
}
export interface BrowserTable {
  caption: string;
  rows: string[][];
  truncated: boolean;
}
export interface BrowserExtraction {
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  doi?: string;
  selection: string;
  text: string;
  tables: BrowserTable[];
  extractedAt: string;
}
export interface BrowserReply {
  ok: boolean;
  tabs: BrowserTabState[];
  tabId?: string;
  snapshot?: BrowserSnapshot;
  extraction?: BrowserExtraction;
  screenshot?: { dataUrl: string; width: number; height: number };
  error?: string;
}
export interface BrowserViewport { x: number; y: number; width: number; height: number }
