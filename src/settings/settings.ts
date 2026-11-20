import { store, safe, esc, parseToggle } from '../utils/helpers';
import {
  SETTING_PREFIX,
  type SettingRow,
  type SettingOption,
  type SettingType,
  type FeatureMeta,
  type RegisteredFeature
} from '../types';

export { SETTING_PREFIX as PREFIX };
const PREFIX = SETTING_PREFIX;
export const features: RegisteredFeature[] = [];
export const ROWS: Record<string, SettingRow> = {};

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function cloneJsonValue<T>(val: T): T {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((item) => cloneJsonValue(item)) as unknown as T;
  const out: Record<string, any> = {};
  for (const key of Object.keys(val)) {
    if (key === '__proto__') continue;
    out[key] = cloneJsonValue((val as Record<string, any>)[key]);
  }
  return out as T;
}

const textIO = {
  read: (el: HTMLInputElement | HTMLSelectElement) => el.value,
  write: (el: HTMLInputElement | HTMLSelectElement, v: any) => {
    el.value = v;
  }
};

export const TYPES: Record<
  SettingType,
  {
    normalize: (v: any, r?: SettingRow) => any;
    html: (r: SettingRow, v: any) => string;
    read: (el: any) => any;
    write: (el: any, v: any) => void;
  }
> = {
  toggle: {
    normalize: (v) => parseToggle(v),
    html: (r, v) =>
      `<span class="ala-switch"><input type="checkbox" data-key="${r.key}" ${v ? 'checked' : ''}><span class="ala-slider"></span></span>`,
    read: (el: HTMLInputElement) => el.checked,
    write: (el: HTMLInputElement, v) => {
      el.checked = !!v;
    }
  },
  number: {
    normalize: (v, r) => {
      if (typeof v !== 'number' && typeof v !== 'string') return r?.def;
      if (typeof v === 'string' && v.trim() === '') return r?.def;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return r?.def;
      const min = r?.min ?? 0;
      const max = r?.max ?? 100;
      return Math.max(min, Math.min(max, n));
    },
    html: (r, v) =>
      `<input type="number" data-key="${r.key}" min="${r.min ?? 0}" max="${r.max ?? 100}" step="1" inputmode="numeric" value="${esc(v)}">`,
    ...textIO
  },
  select: {
    normalize: (v, r) => (r?.options?.some((o) => o[0] === v) ? v : r?.def),
    html: (r, v) =>
      `<select data-key="${r.key}">${(r.options || [])
        .map(([val, label]) => `<option value="${val}" ${v === val ? 'selected' : ''}>${label}</option>`)
        .join('')}</select>`,
    ...textIO
  },
  list: {
    normalize: (v, r) => {
      let arr: string[] = [];
      if (typeof v === 'string') {
        arr = v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
      } else if (Array.isArray(v)) {
        arr = v
          .filter((x): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))
          .map((x) => String(x).trim())
          .filter(Boolean);
      }
      return arr.length ? arr : Array.isArray(r?.def) ? r.def.slice() : [];
    },
    html: (r, v) =>
      `<input type="text" data-key="${r.key}" value="${esc((v || []).join(', '))}" autocomplete="off" autocapitalize="off" spellcheck="false">`,
    read: (el: HTMLInputElement) => el.value,
    write: (el: HTMLInputElement, v: string[]) => {
      el.value = v.join(', ');
    }
  },
  json: {
    normalize: (v, r) => {
      if (v == null) return cloneJsonValue(r?.def);
      let val = v;
      if (typeof v === 'string') {
        try {
          val = JSON.parse(v);
        } catch (_) {
          return cloneJsonValue(r?.def);
        }
      }
      if (val === r?.def) {
        val = cloneJsonValue(val);
      }
      if (r?.validate) {
        let check: any;
        try {
          check = r.validate(val);
        } catch (_) {
          return cloneJsonValue(r?.def);
        }
        if (check === false) return cloneJsonValue(r?.def);
        if (check && typeof check === 'object') {
          if (check.valid === false) return cloneJsonValue(r?.def);
          const resolved = check.value ?? check.tiers ?? check.config ?? check.overrides ?? val;
          return resolved === r.def ? cloneJsonValue(r.def) : resolved;
        }
      }
      return val;
    },
    html: (r, v) =>
      `<input type="hidden" data-key="${r.key}" value="${esc(JSON.stringify(v))}"><button type="button" class="ala-btn ala-btn--secondary ala-btn--edit-json" id="ala-btn-edit-${r.key}">Customize</button>`,
    read: (el: HTMLInputElement) => {
      try {
        return JSON.parse(el.value);
      } catch (_) {
        const key = el.dataset?.key;
        return key && hasOwn(ROWS, key) ? cloneJsonValue(ROWS[key].def) : undefined;
      }
    },
    write: (el: HTMLInputElement, v: any) => {
      el.value = JSON.stringify(v);
    }
  }
};

function register(f: FeatureMeta): void {
  const toggleType = f.type || 'toggle';
  const toggleDef = f.def !== undefined ? f.def : toggleType === 'json' ? {} : false;
  if (toggleType === 'toggle' && toggleDef !== false) {
    throw new Error(`Toggle setting "${f.key}" for module "${f.id}" must default to false`);
  }

  const toggle: SettingRow = {
    key: f.key,
    type: toggleType,
    def: toggleDef,
    legacy: f.legacy || [],
    title: f.title,
    help: f.help
  };
  const options: SettingRow[] = (f.options || []).map((o) => ({
    ...o,
    legacy: o.legacy || []
  }));

  const batch = [toggle, ...options];
  if (f.debug && f.debug.debug !== false) {
    const channelEntries = Object.entries(f.debug.channels || {});
    for (const [chId] of channelEntries) {
      if (chId.toLowerCase() === 'general') {
        throw new Error(
          `Debug channel "${chId}" for module "${f.id}" conflicts with reserved "general" channel`
        );
      }
    }
  }
  const seenKeys = new Set<string>();
  for (const row of batch) {
    if (seenKeys.has(row.key) || hasOwn(ROWS, row.key)) {
      throw new Error(`Duplicate setting: ${row.key}`);
    }
    seenKeys.add(row.key);
  }

  for (const row of batch) {
    row.legacy = [...new Set([row.key, ...row.legacy])];
    ROWS[row.key] = row;
  }

  features.push({
    id: f.id,
    section: f.section || 'Other',
    title: f.title,
    help: f.help,
    toggle,
    options,
    layer: f.layer ?? 'feature',
    hosts: f.hosts,
    requiresReload: f.requiresReload,
    dependsOn: f.dependsOn,
    after: f.after,
    accounts: f.accounts,
    debug: f.debug,
    standalone: f.standalone
  });
}

function registerCoreSetting(o: SettingOption): SettingRow {
  const rowType = o.type || 'toggle';
  const rowDef = o.def !== undefined ? o.def : rowType === 'json' ? {} : false;
  if (rowType === 'toggle' && rowDef !== false) {
    throw new Error(`Toggle setting "${o.key}" must default to false`);
  }
  if (hasOwn(ROWS, o.key)) {
    throw new Error(`Duplicate setting: ${o.key}`);
  }
  const row: SettingRow = {
    ...o,
    type: rowType,
    def: rowDef,
    legacy: [...new Set([o.key, ...(o.legacy || [])])]
  };
  ROWS[row.key] = row;
  return row;
}

function has(key: string): boolean {
  if (!hasOwn(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
  return store.get(PREFIX + key, undefined) !== undefined;
}

function get(key: string): any {
  if (!hasOwn(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
  const r = ROWS[key];
  return TYPES[r.type].normalize(store.get(PREFIX + key, r.def), r);
}

function set(key: string, raw: any): void {
  if (!hasOwn(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
  const r = ROWS[key];
  const normalized = TYPES[r.type].normalize(raw, r);
  store.set(PREFIX + key, normalized);
}

function migrate(): void {
  safe(() => {
    // @migration(from: "v0.9.0", kind: "cleanup", sunset: "2-3 releases")
    store.del('al_token');

    for (const r of Object.values(ROWS)) {
      if (store.get(PREFIX + r.key, undefined) !== undefined) continue;
      for (const name of r.legacy) {
        // @migration(from: "v0.8.0", kind: "storage", sunset: "2-3 releases")
        let v: any = store.get(PREFIX + name, undefined);
        if (v === undefined) {
          // @migration(from: "pre-0.8.0", kind: "storage", sunset: "2-3 releases")
          const raw = localStorage.getItem('ALAdditions:' + name);
          if (raw != null) {
            try {
              v = JSON.parse(raw);
            } catch (_) {
              v = raw;
            }
          }
        }
        if (v !== undefined) {
          store.set(PREFIX + r.key, v);
          break;
        }
      }
    }
  }, 'settings migration');
}

export const Settings = { has, get, set, register, registerCoreSetting, migrate };
