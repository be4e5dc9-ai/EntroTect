/** Only consecutive, explicitly safe calls overlap. Writes and shell commands
 * form barriers; results are committed by the caller in original call order. */
export const MAX_PARALLEL_TOOLS = 8;

export async function scheduleTools<T>(
  items: readonly T[],
  parallelGroup: (item: T) => string | null,
  execute: (item: T) => Promise<void>,
): Promise<void> {
  const running = new Set<Promise<void>>();
  let currentGroup: string | null = null;
  // execute must report ordinary tool failures as results. Also drain started
  // work if infrastructure unexpectedly throws, before propagating the error.
  try {
    for (const item of items) {
      const group = parallelGroup(item);
      if (group === null || group !== currentGroup) {
        await Promise.all(running);
        currentGroup = group;
      }
      if (group === null) {
        await execute(item);
        continue;
      }
      if (running.size >= MAX_PARALLEL_TOOLS) await Promise.race(running);
      const pending = execute(item);
      running.add(pending);
      void pending.then(() => running.delete(pending), () => {});
    }
    await Promise.all(running);
  } finally {
    await Promise.allSettled(running);
  }
}
