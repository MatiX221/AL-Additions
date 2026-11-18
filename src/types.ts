export const SETTING_PREFIX = 'ala_setting_';

export const ANILIST_SESSION_KEYS = [
  'al_token',
  'al_username',
  'al_user_id',
  'al_score_format',
  'al_token_auth'
] as const;

export type SettingType = 'toggle' | 'number' | 'select' | 'list' | 'json';

export type ModuleLayer = 'intercept' | 'preload' | 'service' | 'feature' | 'shell';
export type FeatureLayer = Exclude<ModuleLayer, 'shell'>;

export interface SettingOption {
  key: string;
  type: SettingType;
  def: any;
  title: string;
  help: string;
  min?: number;
  max?: number;
  options?: [string, string][];
  legacy?: string[];
  validate?: (v: any) => any;
  childOf?: string;
}

export interface SettingRow extends SettingOption {
  legacy: string[];
}

export interface FeatureMeta {
  id: string;
  key: string;
  section?: string;
  title: string;
  help: string;
  type?: SettingType;
  def?: any;
  legacy?: string[];
  options?: SettingOption[];
  hosts?: string[];
  layer?: FeatureLayer;
  dependsOn?: string[];
  after?: string[];
  early?: boolean;
  alwaysRun?: boolean;
}

export interface RegisteredFeature {
  id: string;
  section: string;
  title: string;
  help: string;
  toggle: SettingRow;
  options: SettingRow[];
}

export interface MediaRoute {
  kind: 'anime' | 'manga';
  type: 'ANIME' | 'MANGA';
  id: number;
}

export interface ModuleDef {
  name: string;
  setting: string | null;
  init: () => void | Promise<void>;
  hosts: string[];
  early: boolean;
  layer: ModuleLayer;
  dependsOn: string[];
  after: string[];
}