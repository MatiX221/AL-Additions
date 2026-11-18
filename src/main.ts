import 'vite-plugin-monkey/dist/client';
import { Core } from './core/observer';
import { initSettingsPage } from './settings/panel';
import {
  configureCoreServices,
  registerShellModule,
  runMigrations,
  startModules
} from './core/registry';
import { runAccountAuthCallbacks } from './core/accounts';
import { AniList, MediaData } from './api/anilist';
import { captureCredentials } from './api/mal';
import { safe } from './utils/helpers';

configureCoreServices({
  api: {
    ...AniList,
    media: MediaData,
    session: {
      hasAuth: AniList.hasAuth,
      clear: AniList.clearViewer
    }
  },
  session: {
    hasAuth: AniList.hasAuth,
    clear: AniList.clearViewer
  }
});

import.meta.glob('./modules/*/index.ts', { eager: true });

registerShellModule('settings', initSettingsPage);

runMigrations();
safe(captureCredentials, 'credential capture');
void runAccountAuthCallbacks();
startModules(true);
Core.ready(() => startModules(false));
