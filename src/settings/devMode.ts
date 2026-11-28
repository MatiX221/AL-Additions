import { Settings, features } from './settings';
import {
  CORE_DEBUG_CHANNELS,
  CORE_DEBUG_MASTER,
  CORE_DEBUG_SCOPE,
  getDebuggableChannels,
  parseToggle
} from '../utils/helpers';
import type {
  DebugScopeState,
  DebugSettingsMap,
  ModuleDebugEnabledDef,
  RegisteredFeature
} from '../types';

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

export const DEV_MODE_DEF = {
  id: 'devMode',
  key: 'devModeEnabled',
  debugKey: 'debug',
  section: 'Advanced',
  title: 'Developer Mode',
  help: 'Enable developer diagnostics and verbose module logging in the browser console.',
  coreDebug: CORE_DEBUG_MASTER,
  coreChannels: CORE_DEBUG_CHANNELS
} as const;

export function getDefaultDebugSettings(): DebugSettingsMap {
  const out: DebugSettingsMap = {
    [CORE_DEBUG_SCOPE]: {
      enabled: false,
      channels: Object.fromEntries(Object.values(CORE_DEBUG_CHANNELS).map((ch) => [ch.id, true]))
    }
  };

  const debugModules = features
    .filter((f): f is RegisteredFeature & { debug: ModuleDebugEnabledDef } =>
      Boolean(f.debug && f.debug.debug !== false && f.id !== CORE_DEBUG_SCOPE)
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const f of debugModules) {
    const debuggable = getDebuggableChannels(f.debug);
    out[f.id] = debuggable.length
      ? {
          enabled: false,
          channels: Object.fromEntries([
            ['general', true],
            ...debuggable.map(([chId]) => [chId, true] as const)
          ])
        }
      : { enabled: false };
  }
  return out;
}

export function normalizeDebugSettings(raw: unknown): DebugSettingsMap {
  const defaults = getDefaultDebugSettings();
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  const out: DebugSettingsMap = {};

  for (const [scope, defEntry] of Object.entries(defaults)) {
    const src = hasOwn(input, scope) ? input[scope] : undefined;
    const enabled = src && typeof src === 'object' ? parseToggle(src.enabled) : false;
    if (defEntry.channels) {
      const srcChannels =
        src && typeof src === 'object' && src.channels && typeof src.channels === 'object' ? src.channels : {};
      const channels: Record<string, boolean> = {};
      for (const [chId, defVal] of Object.entries(defEntry.channels)) {
        channels[chId] = hasOwn(srcChannels, chId) ? parseToggle(srcChannels[chId]) : defVal;
      }
      out[scope] = { enabled, channels };
    } else {
      out[scope] = { enabled };
    }
  }

  for (const [scope, src] of Object.entries(input)) {
    if (hasOwn(out, scope)) continue;
    if (scope === '__proto__' || scope === 'constructor' || scope === 'prototype') continue;
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const entry: DebugScopeState = { enabled: parseToggle((src as any).enabled) };
    if ((src as any).channels && typeof (src as any).channels === 'object' && !Array.isArray((src as any).channels)) {
      const channels: Record<string, boolean> = {};
      for (const [chId, chVal] of Object.entries((src as any).channels)) {
        if (chId === '__proto__' || chId === 'constructor' || chId === 'prototype') continue;
        channels[chId] = parseToggle(chVal);
      }
      if (Object.keys(channels).length > 0) entry.channels = channels;
    }
    out[scope] = entry;
  }

  return out;
}

Settings.registerCoreSetting({
  key: DEV_MODE_DEF.key,
  type: 'toggle',
  def: false,
  title: DEV_MODE_DEF.title,
  help: DEV_MODE_DEF.help
});

const debugRow = Settings.registerCoreSetting({
  key: DEV_MODE_DEF.debugKey,
  type: 'json',
  def: {},
  title: 'Debug Channels',
  help: 'Per-subsystem and per-module debug channel configuration.',
  validate: (val) => ({ valid: true, value: normalizeDebugSettings(val) })
});

Object.defineProperty(debugRow, 'def', {
  get: () => getDefaultDebugSettings(),
  enumerable: true,
  configurable: true
});
