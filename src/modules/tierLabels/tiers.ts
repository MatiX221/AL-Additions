export const PROBE_ATTR = 'data-ala-probe';

export interface TierConfig {
  min: number;
  max: number;
  label: string;
  color: string;
  textColor: string;
}

export const DEFAULT_TIERS: TierConfig[] = [
  { min: 95, max: 100, label: 'S+', color: '#FFD700', textColor: '#000000' },
  { min: 85, max: 94.9, label: 'S', color: '#ff7f00', textColor: '#FFFFFF' },
  { min: 75, max: 84.9, label: 'A', color: '#aa00ff', textColor: '#FFFFFF' },
  { min: 65, max: 74.9, label: 'B', color: '#007fff', textColor: '#FFFFFF' },
  { min: 55, max: 64.9, label: 'C', color: '#00aa00', textColor: '#FFFFFF' },
  { min: 41, max: 54.9, label: 'D', color: '#aaaaaa', textColor: '#FFFFFF' },
  { min: 0, max: 40.9, label: 'F', color: '#666666', textColor: '#FFFFFF' }
];

export function getTier(rating: number, tiers: TierConfig[]): TierConfig | null {
  if (rating <= 0 || !Number.isFinite(rating)) return null;
  for (const tier of tiers) {
    if (rating >= tier.min && rating <= tier.max) {
      return tier;
    }
  }
  for (const tier of tiers) {
    if (rating >= tier.min - 0.05 && rating <= tier.max + 0.05) {
      return tier;
    }
  }
  return null;
}

const NAMED_COLOR_HEX: Record<string, string | null> = {
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  red: '#ff0000',
  maroon: '#800000',
  yellow: '#ffff00',
  olive: '#808000',
  lime: '#00ff00',
  green: '#008000',
  aqua: '#00ffff',
  cyan: '#00ffff',
  teal: '#008080',
  blue: '#0000ff',
  navy: '#000080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  purple: '#800080',
  orange: '#ffa500',
  gold: '#ffd700',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  transparent: null
};

export function isValidColor(color: string): boolean {
  if (typeof color !== 'string') return false;
  const s = color.trim();
  if (!s) return false;

  // Hex: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return true;

  // Functional CSS: rgb(), rgba(), hsl(), hsla()
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,/+-]+\s*\)$/i.test(s)) return true;

  if (Object.prototype.hasOwnProperty.call(NAMED_COLOR_HEX, s.toLowerCase())) return true;

  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    try {
      if (CSS.supports('color', s)) return true;
    } catch (_) {}
  }

  if (typeof Option !== 'undefined') {
    try {
      const opt = new Option();
      opt.style.color = s;
      return !!opt.style.color;
    } catch (_) {}
  }

  return false;
}

function byteToHex(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, '0');
}

function parseRgbChannel(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.endsWith('%')) {
    const pct = parseFloat(s.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * 255 : null;
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

function hslToRgb(h: number, sPct: number, lPct: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(100, sPct)) / 100;
  const l = Math.max(0, Math.min(100, lPct)) / 100;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue2rgb(hue + 1 / 3) * 255, hue2rgb(hue) * 255, hue2rgb(hue - 1 / 3) * 255];
}

export function cssColorToHex(color: string): string | null {
  const s = (color || '').trim();
  if (!s) return null;

  const m3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])[0-9a-fA-F]?$/);
  if (m3) {
    return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    return s.slice(0, 7).toLowerCase();
  }

  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_COLOR_HEX, lower)) {
    return NAMED_COLOR_HEX[lower];
  }

  const rgbMatch = s.match(/^rgba?\(\s*([^)]+)\s*\)$/i);
  if (rgbMatch) {
    const body = rgbMatch[1].split('/')[0].trim();
    const parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
    if (parts.length >= 3) {
      const r = parseRgbChannel(parts[0]);
      const g = parseRgbChannel(parts[1]);
      const b = parseRgbChannel(parts[2]);
      if (r !== null && g !== null && b !== null) {
        return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
      }
    }
  }

  const hslMatch = s.match(/^hsla?\(\s*([^)]+)\s*\)$/i);
  if (hslMatch) {
    const body = hslMatch[1].split('/')[0].trim();
    const parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
    if (parts.length >= 3) {
      const h = parseFloat(parts[0]);
      const sat = parseFloat(parts[1]);
      const light = parseFloat(parts[2]);
      if (Number.isFinite(h) && Number.isFinite(sat) && Number.isFinite(light)) {
        const [r, g, b] = hslToRgb(h, sat, light);
        return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
      }
    }
  }

  return null;
}

export function normalizeHexColor(color: string): string {
  const s = (color || '').trim();
  const m3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (m3) {
    return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) {
    return s.toLowerCase();
  }
  return s;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  tiers?: TierConfig[];
}

export function validateTiers(input: any): ValidationResult {
  if (!Array.isArray(input)) {
    return { valid: false, error: 'Tiers configuration must be an array.' };
  }
  if (input.length === 0) {
    return { valid: false, error: 'At least one tier must be defined.' };
  }

  const validated: TierConfig[] = [];

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const idx = i + 1;
    if (!item || typeof item !== 'object') {
      return { valid: false, error: `Tier #${idx} is invalid (must be an object).` };
    }

    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label) {
      return { valid: false, error: `Tier #${idx} must have a non-empty label.` };
    }
    if (label.length > 20) {
      return { valid: false, error: `Tier "${label}" label is too long (maximum 20 characters).` };
    }

    const min = typeof item.min === 'number' ? item.min : parseFloat(item.min);
    if (!Number.isFinite(min)) {
      return { valid: false, error: `Tier "${label}" has an invalid min score (must be a number).` };
    }
    if (min < 0 || min > 100) {
      return { valid: false, error: `Tier "${label}" min score (${min}) must be between 0 and 100.` };
    }

    const max = typeof item.max === 'number' ? item.max : parseFloat(item.max);
    if (!Number.isFinite(max)) {
      return { valid: false, error: `Tier "${label}" has an invalid max score (must be a number).` };
    }
    if (max < 0 || max > 100) {
      return { valid: false, error: `Tier "${label}" max score (${max}) must be between 0 and 100.` };
    }

    if (min > max) {
      return {
        valid: false,
        error: `Tier "${label}" min score (${min}) cannot be greater than max score (${max}).`
      };
    }

    const color = typeof item.color === 'string' ? item.color.trim() : '';
    if (!isValidColor(color)) {
      return {
        valid: false,
        error: `Tier "${label}" has an invalid badge color: "${item.color}". Must be a valid hex or CSS color.`
      };
    }

    const textColor = typeof item.textColor === 'string' ? item.textColor.trim() : '';
    if (!isValidColor(textColor)) {
      return {
        valid: false,
        error: `Tier "${label}" has an invalid text color: "${item.textColor}". Must be a valid hex or CSS color.`
      };
    }

    validated.push({
      label,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      color: normalizeHexColor(color),
      textColor: normalizeHexColor(textColor)
    });
  }

  return { valid: true, tiers: validated };
}

