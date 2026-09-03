import type { UiToolBlock } from "../store";
import { ToolCard } from "./ToolCard";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TodoPriority = "high" | "medium" | "low";

interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  cancelled: "已取消",
};

const VALID_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const VALID_PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"]);

function todosFromArgs(args: unknown): TodoItem[] {
  if (!args || typeof args !== "object") return [];
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];

  return todos.flatMap((value): TodoItem[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.content !== "string" ||
      !VALID_STATUSES.has(item.status as TodoStatus) ||
      !VALID_PRIORITIES.has(item.priority as TodoPriority)
    ) {
      return [];
    }
    return [{
      content: item.content,
      status: item.status as TodoStatus,
      priority: item.priority as TodoPriority,
    }];
  });
}

function TodoMarker({ status, step }: { status: TodoStatus; step: number }): React.JSX.Element {
  if (status === "completed") {
    return (
      <span className="todo-marker" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.3 4.8 8.6 9.6 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="todo-marker" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="m2.5 2.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="todo-marker" aria-hidden="true">
      {status === "in_progress" ? <span className="todo-marker-dot" /> : step}
    </span>
  );
}

function progressCaption(block: UiToolBlock, todos: TodoItem[]): string {
  if (block.state === "awaiting-approval") return "等待确认";
  if (block.state === "executing") return "正在同步计划";
  if (todos.every((todo) => todo.status === "completed" || todo.status === "cancelled")) {
    return "计划已收尾";
  }
  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress");
  if (activeIndex >= 0) return `正在执行第 ${activeIndex + 1} 步`;
  return "等待下一步";
}

export function TodoCard({ block }: { block: UiToolBlock }): React.JSX.Element {
  const todos = todosFromArgs(block.args);
  if (todos.length === 0 || block.state === "failed" || block.state === "denied") {
    return <ToolCard block={block} />;
  }

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const settled = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const progress = Math.round((settled / todos.length) * 100);

  return (
    <section className="todo-card" aria-label={`任务进度，已完成 ${completed} 项，共 ${todos.length} 项`}>
      <header className="todo-card-head">
        <span className="todo-card-symbol" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <path d="M3 4h1.5m2.5 0h5M3 7.5h1.5m2.5 0h5M3 11h1.5m2.5 0h5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          </svg>
        </span>
        <span className="todo-card-heading">
          <span className="todo-card-title">任务进度</span>
          <span className="todo-card-caption">{progressCaption(block, todos)}</span>
        </span>
        <span className="todo-card-count" aria-hidden="true">
          <strong>{completed}</strong>
          <span> / {todos.length}</span>
        </span>
      </header>

      <div className="todo-progress-track" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>

      <ol className="todo-list">
        {todos.map((todo, index) => (
          <li className={`todo-item todo-${todo.status}`} key={`${index}-${todo.content}`}>
            <span className="todo-rail">
              <TodoMarker status={todo.status} step={index + 1} />
            </span>
            <span className="todo-item-main">
              <span className="todo-item-content">{todo.content}</span>
              <span className="todo-item-meta">
                <span className="todo-status">{STATUS_LABEL[todo.status]}</span>
                {todo.priority !== "medium" && (
                  <span className={`todo-priority priority-${todo.priority}`}>
                    {todo.priority === "high" ? "高优先" : "低优先"}
                  </span>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
