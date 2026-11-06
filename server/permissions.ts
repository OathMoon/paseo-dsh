import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";

export function withPermissionCleanup(connection: ProviderConnection): ProviderConnection {
  type Permission = { state: "pending" } | { state: "withdrawn"; resolve(): void };
  const pending = new Map<string, Map<string, Permission>>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  const unsubscribe = connection.onEvent(event => {
    if (event.type === "session.permission") {
      const ids = pending.get(event.sessionId) ?? new Map<string, Permission>();
      ids.set(event.request.id, { state: "pending" });
      pending.set(event.sessionId, ids);
    } else if (event.type === "session.permission_resolved") {
      const ids = pending.get(event.sessionId);
      const permission = ids?.get(event.permissionId);
      if (permission?.state === "withdrawn") permission.resolve();
      ids?.delete(event.permissionId);
      if (ids?.size === 0) pending.delete(event.sessionId);
    }
    if (event.type === "session.turn" && event.state !== "started") {
      const session = pending.get(event.sessionId);
      const ids = [...(session?.keys() ?? [])];
      if (ids.length) {
        // The bridge maps this SDK-only release to cancelled after the prompt has withdrawn its requests.
        void Promise.all(ids.map(permissionId => new Promise<void>((resolve, reject) => {
          session?.set(permissionId, { state: "withdrawn", resolve });
          void connection.send({
            type: "session.permission", sessionId: event.sessionId, permissionId,
            response: { behavior: "deny" },
          }).catch(reject);
        }))).then(() => emit(event), error => emit({
          type: "session.runtime_failed", sessionId: event.sessionId,
          error: { message: String(error) },
        }));
        return;
      }
    }
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      for (const [permissionId, permission] of pending.get(event.sessionId) ?? []) {
        if (permission.state === "withdrawn") permission.resolve();
        emit({ type: "session.permission_resolved", sessionId: event.sessionId, permissionId });
      }
      pending.delete(event.sessionId);
    }
    emit(event);
  });
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    send(input) {
      if (input.type === "session.permission" &&
          pending.get(input.sessionId)?.get(input.permissionId)?.state !== "pending") {
        return Promise.resolve();
      }
      return connection.send(input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      try { await connection.close(); }
      finally { unsubscribe(); pending.clear(); listeners.clear(); }
    },
  };
}
