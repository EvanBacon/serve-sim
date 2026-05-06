// Shared types + helpers for the WebKit DevTools target picker. Kept out of
// the client bundle so we can unit-test grouping behavior with `bun test`.

export interface WebKitTargetLike {
  id: string;
  appName?: string;
  bundleId?: string;
}

export interface AppGroup<T extends WebKitTargetLike> {
  key: string;
  appName: string;
  bundleId?: string;
  targets: T[];
}

// Group inspectable targets by their host application, the way Safari's
// Develop menu lists pages under the app that owns them. Stable order:
// groups appear in the order their first target was returned by the bridge.
export function groupTargetsByApp<T extends WebKitTargetLike>(targets: T[]): AppGroup<T>[] {
  const order: string[] = [];
  const groups = new Map<string, AppGroup<T>>();
  for (const target of targets) {
    const appName = target.appName || target.bundleId || "Unknown";
    const key = target.bundleId || appName;
    let group = groups.get(key);
    if (!group) {
      group = { key, appName, bundleId: target.bundleId, targets: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.targets.push(target);
  }
  return order.map((key) => groups.get(key)!);
}
