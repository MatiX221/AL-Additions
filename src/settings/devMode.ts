import { Settings } from './settings';
import { SETTING_PREFIX } from '../types';
import { registerDebugChannel } from '../utils/helpers';

export const DEV_MODE_DEF = {
  id: 'devMode',
  key: 'devModeEnabled',
  section: 'Advanced',
  title: 'Developer Mode',
  help: 'Enable developer diagnostics and verbose module logging in the browser console.',
  generalDebug: {
    key: 'debugGeneral',
    title: 'Core & Observer Debug',
    help: 'Log DOM observer mutations, route changes, and general script lifecycle events.'
  }
} as const;

Settings.registerCoreSetting({
  key: DEV_MODE_DEF.key,
  type: 'toggle',
  def: false,
  title: DEV_MODE_DEF.title,
  help: DEV_MODE_DEF.help
});

Settings.registerCoreSetting({
  key: DEV_MODE_DEF.generalDebug.key,
  type: 'toggle',
  def: false,
  title: DEV_MODE_DEF.generalDebug.title,
  help: DEV_MODE_DEF.generalDebug.help
});

registerDebugChannel(
  'general',
  `${SETTING_PREFIX}${DEV_MODE_DEF.generalDebug.key}`,
  false,
  /^\[(?:CORE|OBSERVER)/i
);
