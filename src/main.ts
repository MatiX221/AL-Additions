import 'vite-plugin-monkey/dist/client';
import { Core } from './core/observer';
import { Settings } from './settings/settings';
import { initSettingsPage } from './settings/panel';
import { registerShellModule, startModules } from './core/registry';
import { captureCredentials } from './api/mal';
import { safe } from './utils/helpers';

import.meta.glob('./modules/*/index.ts', { eager: true });

registerShellModule('settings', initSettingsPage);

Settings.migrate();
safe(captureCredentials, 'credential capture');
startModules(true);
Core.ready(() => startModules(false));