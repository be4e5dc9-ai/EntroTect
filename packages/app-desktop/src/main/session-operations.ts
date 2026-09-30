/** UI operations belong to a task activation, not an individual model turn. */
export class SessionOperationScopes {
  private readonly scopes = new Map<string, AbortController>();
  private disposed = false;

  signal(sessionId: string): AbortSignal {
    if (this.disposed) throw new Error("应用正在关闭，不能开始新操作。");
    const controller = this.scopes.get(sessionId) ?? new AbortController();
    this.scopes.set(sessionId, controller);
    return controller.signal;
  }

  cancel(sessionId: string): void {
    this.scopes.get(sessionId)?.abort(new Error("对话已切换或关闭，操作已取消。"));
    this.scopes.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.scopes.keys()) this.cancel(sessionId);
  }
}
