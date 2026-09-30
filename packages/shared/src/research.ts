import { z } from "zod";

const shortText = z.string().trim().max(2_000);
const sourceFields = {
  title: shortText.min(1),
  url: z.string().trim().max(8_192).url().refine((value) => /^https?:\/\//i.test(value), "资料地址仅支持 HTTP/HTTPS"),
  authors: z.array(shortText).max(100),
  publishedAt: z.string().trim().max(100),
  doi: z.string().trim().max(500),
  excerpt: z.string().max(100_000),
  note: z.string().max(100_000),
  tags: z.array(z.string().trim().max(100)).max(50),
};
// Defaults belong to creation only. A partial update must never fill absent fields.
export const researchSourceInputSchema = z.object({
  ...sourceFields,
  authors: sourceFields.authors.default([]),
  publishedAt: sourceFields.publishedAt.default(""),
  doi: sourceFields.doi.default(""),
  excerpt: sourceFields.excerpt.default(""),
  note: sourceFields.note.default(""),
  tags: sourceFields.tags.default([]),
}).strict();
export const researchSourcePatchSchema = z.object(sourceFields).partial().strict();
export type ResearchSourceInput = z.input<typeof researchSourceInputSchema>;
export const researchSourceSchema = researchSourceInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  accessedAt: z.string().datetime(),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

// IDs are filenames, never paths. The leading alphanumeric also excludes Windows devices with a suffix.
const sessionId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).refine((value) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value));
const sourceIds = z.array(z.string().uuid()).max(500).optional();
export const researchCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), sessionId }).strict(),
  z.object({ action: z.literal("save"), sessionId, source: researchSourceInputSchema }).strict(),
  z.object({ action: z.literal("update"), sessionId, id: z.string().uuid(), patch: researchSourcePatchSchema }).strict(),
  z.object({ action: z.literal("remove"), sessionId, id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("export"), sessionId, format: z.enum(["markdown", "bibtex"]), sourceIds }).strict(),
  z.object({ action: z.literal("prompt"), sessionId, template: z.enum(["report", "study", "meeting"]), sourceIds }).strict(),
  z.object({ action: z.literal("export_table"), sessionId, rows: z.array(z.array(z.string().max(50_000)).max(200)).min(1).max(10_000), title: shortText.optional(), sourceUrl: z.string().max(8_192).optional() }).strict(),
]);
export type ResearchCommand = z.input<typeof researchCommandSchema>;
export interface ResearchExport { content: string; fileName: string; mimeType: string }
export interface ResearchReply {
  sources?: ResearchSource[];
  source?: ResearchSource;
  export?: ResearchExport;
  prompt?: string;
  error?: string;
  exportedPath?: string;
  canceled?: boolean;
}
