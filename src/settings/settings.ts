import { store, safe, esc, parseToggle } from '../utils/helpers';
import { SETTING_PREFIX, type SettingRow, type SettingType, type FeatureMeta, type RegisteredFeature } from '../types';

export { SETTING_PREFIX as PREFIX };
const PREFIX = SETTING_PREFIX;
export const features: RegisteredFeature[] = [];
export const ROWS: Record<string, SettingRow> = {};

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
      if (v == null || String(v).trim() === '') return r?.def;
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
      const arr = (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
        .map((x) => String(x).trim())
        .filter(Boolean);
      return arr.length ? arr : (r?.def || []).slice();
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
      if (v == null) return r?.def;
      let val = v;
      if (typeof v === 'string') {
        try {
          val = JSON.parse(v);
        } catch (_) {
          return r?.def;
        }
      }
      if (r?.validate) {
        const check = r.validate(val);
        if (check === false) return r.def;
        if (check && typeof check === 'object') {
          if (check.valid === false) return r.def;
          if (check.tiers) return check.tiers;
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
        return ROWS[el.dataset.key!]?.def;
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
  const seenKeys = new Set<string>();
  for (const row of batch) {
    if (seenKeys.has(row.key) || ROWS[row.key]) {
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
    layer: f.layer ?? (f.early ? 'intercept' : 'feature'),
    hosts: f.hosts,
    requiresReload: f.requiresReload,
    dependsOn: f.dependsOn,
    after: f.after,
    accounts: f.accounts,
    debug: f.debug,
    standalone: f.standalone,
    backupTools: f.backupTools
  });
}

function get(key: string): any {
  const r = ROWS[key];
  if (!r) throw new Error(`Unknown setting: ${key}`);
  return TYPES[r.type].normalize(store.get(PREFIX + key, r.def), r);
}

function set(key: string, raw: any): void {
  store.set(PREFIX + key, raw);
  store.set(PREFIX + key, get(key));
}

function migrate(): void {
  safe(() => {
    // Purge legacy AniList OAuth token
    store.del('al_token');

    for (const r of Object.values(ROWS)) {
      if (store.get(PREFIX + r.key, undefined) !== undefined) continue;
      for (const name of r.legacy) {
        let v: any = store.get(PREFIX + name, undefined);
        if (v === undefined) {
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

export const Settings = { get, set, register, migrate };