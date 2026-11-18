import { Settings } from '../settings/settings';
import { HOST, logDebug } from '../utils/helpers';
import type { ModuleDef, FeatureMeta, ModuleLayer, FeatureLayer } from '../types';

export const modules: ModuleDef[] = [];

const LAYER_ORDER: Record<ModuleLayer, number> = {
  intercept: 0,
  preload: 1,
  service: 2,
  feature: 3,
  shell: 4
};

const ID_RE = /^[a-z][A-Za-z0-9]*$/;
const registeredIds = new Set<string>();

export const defineModule = (
  name: string,
  setting: string | null,
  init: () => void | Promise<void>,
  hosts: string[] = ['anilist.co'],
  early = false,
  layer?: ModuleLayer,
  dependsOn: string[] = [],
  after: string[] = []
): void => {
  const resolvedLayer: ModuleLayer = layer ?? (early ? 'intercept' : 'feature');
  const resolvedEarly = resolvedLayer === 'intercept' || resolvedLayer === 'preload';
  modules.push({
    name,
    setting,
    init,
    hosts,
    early: resolvedEarly,
    layer: resolvedLayer,
    dependsOn: dependsOn.slice(),
    after: after.slice()
  });
};

export const registerShellModule = (
  name: string,
  init: () => void | Promise<void>,
  hosts: string[] = ['anilist.co']
): void => {
  if (!ID_RE.test(name)) {
    console.error(`[AL-Additions] Invalid shell module ID "${name}". Must match ${ID_RE}.`);
    return;
  }
  if (registeredIds.has(name)) {
    console.error(`[AL-Additions] Duplicate module ID "${name}" ignored.`);
    return;
  }
  registeredIds.add(name);
  defineModule(name, null, init, hosts, false, 'shell');
};

export const defineFeature = (meta: FeatureMeta, init: () => void | Promise<void>): void => {
  if (!ID_RE.test(meta.id)) {
    console.error(`[AL-Additions] Invalid module ID "${meta.id}". Must match ${ID_RE}.`);
    return;
  }
  if (registeredIds.has(meta.id)) {
    console.error(`[AL-Additions] Duplicate module ID "${meta.id}" ignored.`);
    return;
  }
  registeredIds.add(meta.id);
  Settings.register(meta);
  const layer: FeatureLayer = meta.layer ?? (meta.early ? 'intercept' : 'feature');
  defineModule(
    meta.id,
    meta.alwaysRun ? null : meta.key,
    init,
    meta.hosts,
    layer === 'intercept' || layer === 'preload',
    layer,
    meta.dependsOn || [],
    meta.after || []
  );
};

function hasHardDepPath(byId: Map<string, ModuleDef>, startId: string, targetId: string, seen = new Set<string>()): boolean {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  const mod = byId.get(startId);
  if (!mod) return false;
  for (const dep of mod.dependsOn) {
    if (hasHardDepPath(byId, dep, targetId, seen)) return true;
  }
  return false;
}

function resolveBootOrder(all: ModuleDef[]): ModuleDef[] {
  const active = new Map<string, ModuleDef>();
  for (const m of all) {
    if (!m.hosts.includes('*') && !m.hosts.includes(HOST)) continue;
    if (m.setting && !Settings.get(m.setting)) continue;
    active.set(m.name, m);
  }

  // Prune missing, disabled, or cross-layer hard dependencies iteratively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, m] of active) {
      const invalidDep = m.dependsOn.find((depId) => {
        const dep = active.get(depId);
        if (!dep) return true;
        return LAYER_ORDER[dep.layer] > LAYER_ORDER[m.layer];
      });
      if (invalidDep !== undefined) {
        console.warn(`[AL-Additions] Module "${id}" disabled: dependency "${invalidDep}" is unavailable or in a later layer.`);
        active.delete(id);
        changed = true;
      }
    }
  }

  // Prune hard dependency cycles via Kahn's algorithm.
  const hardIn = new Map<string, number>();
  const hardOut = new Map<string, string[]>();
  for (const id of active.keys()) {
    hardIn.set(id, 0);
    hardOut.set(id, []);
  }
  for (const [id, m] of active) {
    for (const depId of new Set(m.dependsOn)) {
      hardIn.set(id, (hardIn.get(id) || 0) + 1);
      hardOut.get(depId)!.push(id);
    }
  }
  const q: string[] = [];
  for (const [id, deg] of hardIn) if (deg === 0) q.push(id);
  const acyclicIds = new Set<string>();
  while (q.length) {
    const id = q.shift()!;
    acyclicIds.add(id);
    for (const next of hardOut.get(id) || []) {
      const d = (hardIn.get(next) || 0) - 1;
      hardIn.set(next, d);
      if (d === 0) q.push(next);
    }
  }
  for (const id of [...active.keys()]) {
    if (!acyclicIds.has(id)) {
      console.warn(`[AL-Additions] Module "${id}" disabled due to dependency cycle.`);
      active.delete(id);
    }
  }

  const ordered: ModuleDef[] = [];
  const layers: ModuleLayer[] = ['intercept', 'preload', 'service', 'feature', 'shell'];

  for (const layer of layers) {
    const layerMods = [...active.values()].filter((m) => m.layer === layer);
    if (!layerMods.length) continue;

    const layerSet = new Set(layerMods.map((m) => m.name));
    const hardDeps = new Map<string, Set<string>>();
    const allDeps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();

    for (const m of layerMods) {
      hardDeps.set(m.name, new Set());
      allDeps.set(m.name, new Set());
      dependents.set(m.name, new Set());
    }

    for (const m of layerMods) {
      for (const depId of m.dependsOn) {
        if (layerSet.has(depId) && depId !== m.name) {
          hardDeps.get(m.name)!.add(depId);
          allDeps.get(m.name)!.add(depId);
          dependents.get(depId)!.add(m.name);
        }
      }
    }

    for (const m of layerMods) {
      for (const afterId of m.after) {
        if (!layerSet.has(afterId) || afterId === m.name) continue;
        // Ignore soft `after` if it contradicts a hard `dependsOn` chain.
        if (hasHardDepPath(active, afterId, m.name)) continue;
        allDeps.get(m.name)!.add(afterId);
        dependents.get(afterId)!.add(m.name);
      }
    }

    const remaining = new Set(layerSet);
    while (remaining.size) {
      const ready = [...remaining]
        .filter((id) => allDeps.get(id)!.size === 0)
        .sort((a, b) => a.localeCompare(b));

      let pick: string;
      if (ready.length) {
        pick = ready[0];
      } else {
        // Soft `after` cycle: pick alphabetically smallest node with zero remaining hard deps.
        const hardReady = [...remaining]
          .filter((id) => hardDeps.get(id)!.size === 0)
          .sort((a, b) => a.localeCompare(b));
        pick = hardReady[0] || [...remaining].sort((a, b) => a.localeCompare(b))[0];
      }

      remaining.delete(pick);
      ordered.push(active.get(pick)!);
      for (const next of dependents.get(pick) || []) {
        hardDeps.get(next)?.delete(pick);
        allDeps.get(next)?.delete(pick);
      }
    }
  }

  return ordered;
}

export function startModules(early: boolean): void {
  const ordered = resolveBootOrder(modules).filter((m) => m.early === early);
  for (const m of ordered) {
    logDebug('[CORE]', `Initializing module "${m.name}" (layer=${m.layer}, early=${early})`);
    try {
      Promise.resolve(m.init()).catch((e) => console.error('[AL-Additions]', m.name, e));
    } catch (e) {
      console.error('[AL-Additions]', m.name, e);
    }
  }
}
