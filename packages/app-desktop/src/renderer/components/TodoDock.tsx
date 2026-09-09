import { useStore, type UiToolBlock } from "../store";
import { TodoCard } from "./TodoCard";

function latestTodoBlock(messages: ReturnType<typeof useStore.getState>["messages"]): UiToolBlock | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const blocks = messages[messageIndex]?.blocks ?? [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block?.kind === "tool-call" && block.name === "todowrite") return block;
    }
  }
  return null;
}

export function TodoDock(): React.JSX.Element | null {
  const block = useStore((state) => latestTodoBlock(state.messages));
  if (!block) return null;

  return (
    <aside className="todo-dock" aria-label="当前任务计划">
      <TodoCard block={block} collapsible />
    </aside>
  );
}
