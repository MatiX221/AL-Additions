import 'vite-plugin-monkey/dist/client';
import { Core } from './core/observer';
import './settings/devMode';
import { initSettingsPage } from './settings/panel';
import {
  configureCoreServices,
  registerShellModule,
  runMigrations,
  startModules
} from './core/registry';
import { runAccountAuthCallbacks } from './core/accounts';
import { AniList, anilistApiClient } from './api/anilist';
import './api/mal';

configureCoreServices({
  api: anilistApiClient,
  session: AniList.session
});

import.meta.glob('./modules/*/index.ts', { eager: true });

registerShellModule('settings', initSettingsPage);

runMigrations();
void runAccountAuthCallbacks();
startModules(true);
Core.ready(() => startModules(false));
