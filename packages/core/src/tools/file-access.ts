import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

// Shared across all tool instances and agents. Resolve aliases synchronously so calls
// reserve their FIFO position before yielding (including when the file is still new).
const queues = new Map<string, Promise<void>>();

function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    return path.join(canonicalPath(parent), path.basename(filePath));
  }
}

export async function withFileLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  operation: (canonical: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const canonical = canonicalPath(filePath);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try {
    signal?.throwIfAborted();
    return await operation(canonical);
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write beside the destination and rename only after the full content is flushed.
 * Call under withFileLock. The final comparison catches external edits made during
 * preparation; external editors/shell commands do not participate in our lock.
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  expected: string | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const mode = expected === null ? undefined : (await stat(filePath)).mode;
  const temporary = path.join(path.dirname(filePath), `.entrotect-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    signal?.throwIfAborted();
    if (await readTextIfExists(filePath) !== expected) {
      throw new Error(`文件 ${filePath} 在写入期间被修改,请重新 read 后重试。`);
    }
    await rename(temporary, filePath);
  } finally {
    if (!closed) await handle.close().catch(() => {});
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
