import { describe, it, expect } from 'vitest';
import '../src/api/mal';
import '../src/modules/tagFilter';
import '../src/modules/sync';
import {
  createBackup,
  createRawBackup,
  importBackup,
  applyVersion1Settings,
  MAGIC_PLAIN,
  MAGIC_ENCRYPTED,
  encryptData,
  decryptData,
  FORMAT_VERSION
} from '../src/settings/backup';
import { getAccountSecretKeys, registerAccountProvider } from '../src/core/accounts';
import { CoreHooks } from '../src/core/bus';
import { Settings } from '../src/settings/settings';
import { store } from '../src/utils/helpers';

describe('Settings Backup & Crypto Engine', () => {
  it('creates an unencrypted binary backup with ALAS magic bytes and valid header', async () => {
    const bytes = await createBackup(false);

    expect(bytes.subarray(0, 4)).toEqual(MAGIC_PLAIN);
    expect(bytes[4]).toBe(FORMAT_VERSION);
    expect(bytes.length).toBeGreaterThan(5);
  });

  it('creates an encrypted binary backup with ALAE magic bytes when a password is provided', async () => {
    const bytes = await createBackup(false, 'CorrectPassword123');

    expect(bytes.subarray(0, 4)).toEqual(MAGIC_ENCRYPTED);
    expect(bytes[4]).toBe(FORMAT_VERSION);
    expect(bytes.length).toBeGreaterThan(33);
  });

  it('rejects exporting credentials if no password is provided', async () => {
    await expect(createBackup(true)).rejects.toThrow('A password is required to export credentials.');
    await expect(createBackup(true, '   ')).rejects.toThrow('A password is required to export credentials.');
  });

  it('performs full roundtrip AES-GCM encryption and decryption', async () => {
    const originalText = JSON.stringify({ scoreRounding: 'round', customKey: 'valid' });
    const password = 'SuperSecretPassword!';

    const encrypted = await encryptData(originalText, password);
    expect(encrypted.salt).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();

    const decrypted = await decryptData(encrypted, password);
    expect(decrypted).toBe(originalText);
  });

  it('fails decryption when provided with the wrong password', async () => {
    const originalText = JSON.stringify({ secret: 'anilist-oauth-token' });
    const encrypted = await encryptData(originalText, 'right-password');

    await expect(decryptData(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('exports and restores settings via unencrypted binary backup', async () => {
    Settings.set('tagPercentage', 85);
    const backupBytes = await createBackup(false, undefined, { tagPercentage: 85 });

    Settings.set('tagPercentage', 50);
    expect(Settings.get('tagPercentage')).toBe(50);

    const result = await importBackup(backupBytes);
    expect(result.applied).toBeGreaterThan(0);
    expect(Settings.get('tagPercentage')).toBe(85);
  });

  it('exports and restores settings via password-encrypted binary backup', async () => {
    Settings.set('tagPercentage', 92);
    const password = 'BackupPassword456';
    const backupBytes = await createBackup(false, password, { tagPercentage: 92 });

    Settings.set('tagPercentage', 50);

    const result = await importBackup(backupBytes, async () => password);
    expect(result.applied).toBeGreaterThan(0);
    expect(Settings.get('tagPercentage')).toBe(92);
  });

  it('rejects encrypted backup import when password prompt fails or enters wrong password', async () => {
    const backupBytes = await createBackup(false, 'Secret123');

    await expect(
      importBackup(backupBytes, async () => 'WrongPassword321')
    ).rejects.toThrow('Incorrect password or corrupted backup file.');
  });

  it('cancels gracefully without throwing when password prompt is cancelled (null)', async () => {
    const backupBytes = await createBackup(false, 'Secret123');

    const result = await importBackup(backupBytes, async () => null);
    expect(result.cancelled).toBe(true);
    expect(result.applied).toBe(0);
  });

  it('restores legacy plain JSON string backup files', async () => {
    const legacyJson = JSON.stringify({
      version: 1,
      encrypted: false,
      exportedAt: Date.now(),
      data: {
        tagPercentage: 73
      }
    });

    const result = await importBackup(legacyJson);
    expect(result.applied).toBeGreaterThan(0);
    expect(Settings.get('tagPercentage')).toBe(73);
  });

  it('excludes AniList session cache and tokens from account secret keys and credential exports', async () => {
    const secretKeys = getAccountSecretKeys();
    expect(secretKeys).toContain('mal_token');
    expect(secretKeys.includes('al_token')).toBe(false);
    expect(secretKeys.includes('al_username')).toBe(false);
    expect(secretKeys.includes('al_user_id')).toBe(false);
    expect(secretKeys.includes('al_score_format')).toBe(false);

    store.set('al_token', 'stale_token_123');
    store.set('al_username', 'LocalUser');
    store.set('al_user_id', 12345);
    store.set('al_score_format', 'POINT_10');
    store.set('mal_token', 'valid_mal_token');

    const bytes = await createBackup(true, 'TestPassword123');
    const result = await importBackup(bytes, async () => 'TestPassword123');

    expect(result.secretsApplied).toBeGreaterThan(0);
    expect(store.get('al_token', null)).toBeNull();
    expect(store.get('al_username', null)).toBeNull();
    expect(store.get('al_user_id', null)).toBeNull();
    expect(store.get('al_score_format', null)).toBeNull();
    expect(store.get('mal_token', null)).toBe('valid_mal_token');
  });

  it('silently ignores and purges legacy AniList session cache and tokens when importing backups', async () => {
    store.set('al_token', 'old_local_token');
    store.set('al_username', 'StaleAccountA');
    store.set('al_user_id', 1111);
    store.set('al_score_format', 'POINT_100');

    const legacyJson = JSON.stringify({
      version: 1,
      encrypted: false,
      exportedAt: Date.now(),
      data: {
        tagPercentage: 60,
        al_token: 'legacy_backup_token',
        al_username: 'ImportedAccountB',
        al_user_id: 2222,
        al_score_format: 'POINT_10_DECIMAL'
      }
    });

    const result = await importBackup(legacyJson);
    expect(result.applied).toBeGreaterThan(0);
    expect(store.get('al_token', null)).toBeNull();
    expect(store.get('al_username', null)).toBeNull();
    expect(store.get('al_user_id', null)).toBeNull();
    expect(store.get('al_score_format', null)).toBeNull();
  });

  it('exports unminified raw JSON with all settings and credentials without requiring a password', async () => {
    Settings.set('tagPercentage', 88);
    store.set('mal_token', 'dev_raw_mal_token');
    store.set('mal_refresh_token', 'dev_raw_refresh');
    store.set('al_username', 'DevUser');

    const rawJson = createRawBackup({ tagPercentage: 88 });

    expect(rawJson).toContain('\n');
    expect(rawJson).toContain('  "version": 1');
    expect(rawJson).toContain('"tagPercentage": 88');
    expect(rawJson).toContain('"mal_token": "dev_raw_mal_token"');
    expect(rawJson).toContain('"mal_refresh_token": "dev_raw_refresh"');
    expect(rawJson).not.toContain('"al_username"');

    const parsed = JSON.parse(rawJson);
    expect(parsed.version).toBe(1);
    expect(parsed.data.tagPercentage).toBe(88);
    expect(parsed.data.mal_token).toBe('dev_raw_mal_token');
    expect(parsed.data.mal_refresh_token).toBe('dev_raw_refresh');
    expect(parsed.data.al_username).toBeUndefined();

    Settings.set('tagPercentage', 10);
    store.del('mal_token');
    store.del('mal_refresh_token');

    const result = await importBackup(rawJson);
    expect(result.applied).toBeGreaterThan(0);
    expect(result.secretsApplied).toBeGreaterThan(0);
    expect(Settings.get('tagPercentage')).toBe(88);
    expect(store.get('mal_token', null)).toBe('dev_raw_mal_token');
    expect(store.get('mal_refresh_token', null)).toBe('dev_raw_refresh');
  });

  it('purges al_token_auth and resets CoreHooks.setSessionClearing even if backup import throws', async () => {
    store.set('al_token_auth', 'Bearer secret_al_jwt');
    expect(CoreHooks.isSessionClearing()).toBe(false);

    await expect(
      importBackup(
        JSON.stringify({
          version: 1,
          encrypted: false,
          exportedAt: Date.now(),
          data: {
            al_token_auth: 'Bearer evil',
            al_username: 'SomeUser'
          }
        })
      )
    ).rejects.toThrow('No recognized settings found in the backup file.');

    expect(store.get('al_token_auth', null)).toBeNull();
    expect(CoreHooks.isSessionClearing()).toBe(false);
  });

  it('auto-enables manualOverridesEnabled when importing legacy backup with non-empty syncManualOverrides', async () => {
    Settings.set('manualOverridesEnabled', false);

    await importBackup(
      JSON.stringify({
        version: 1,
        encrypted: false,
        exportedAt: Date.now(),
        data: {
          syncManualOverrides: {
            '16498': { malId: 16498, type: 'ANIME', title: 'Attack on Titan', updatedAt: 100 }
          }
        }
      })
    );

    expect(Settings.get('manualOverridesEnabled')).toBe(true);
  });

  it('preserves explicit manualOverridesEnabled: false even with non-empty syncManualOverrides', async () => {
    await importBackup(
      JSON.stringify({
        version: 1,
        encrypted: false,
        exportedAt: Date.now(),
        data: {
          manualOverridesEnabled: false,
          syncManualOverrides: {
            '16498': { malId: 16498, type: 'ANIME', title: 'Attack on Titan', updatedAt: 100 }
          }
        }
      })
    );

    expect(Settings.get('manualOverridesEnabled')).toBe(false);
  });
});

describe('Settings Backup: B1-22 Regression Guards', () => {
  it('ignores Object.prototype keys in importBackup and applyVersion1Settings without throwing TypeError', async () => {
    const withValid = await importBackup(
      JSON.stringify({
        version: 1,
        encrypted: false,
        exportedAt: Date.now(),
        data: {
          toString: 'evil',
          constructor: { prototype: true },
          valueOf: 42,
          ala_setting_toString: 'bad',
          ala_setting_constructor: true,
          tagPercentage: 65
        }
      })
    );
    expect(withValid.applied).toBe(1);
    expect(Settings.get('tagPercentage')).toBe(65);

    const rawProtoPayload = '{"version":1,"encrypted":false,"exportedAt":1,"data":{"toString":"x","constructor":1,"__proto__":{"polluted":true}}}';
    await expect(importBackup(rawProtoPayload)).rejects.toThrow('No recognized settings found in the backup file.');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('uses own-property checks on overrides and null-prototype data objects', async () => {
    Settings.set('tagPercentage', 50);
    const protoOverrides = Object.create({ tagPercentage: 99 });
    const raw = JSON.parse(createRawBackup(protoOverrides));
    expect(raw.data.tagPercentage).toBe(50);

    const bytes = await createBackup(false, undefined, protoOverrides);
    const nullProtoData = Object.assign(Object.create(null), {
      syncManualOverrides: {
        '16498': { malId: 16498, type: 'ANIME', title: 'Attack on Titan', updatedAt: 100 }
      }
    });
    const res = applyVersion1Settings(nullProtoData);
    expect(res.applied).toBe(2);
    expect(Settings.get('manualOverridesEnabled')).toBe(true);

    Settings.set('tagPercentage', 20);
    await importBackup(bytes);
    expect(Settings.get('tagPercentage')).toBe(50);
  });

  it('validates secretKeys generically and skips invalid values without incrementing secretsApplied', async () => {
    const cleanupProvider = registerAccountProvider({
      id: 'custom_test',
      name: 'Custom Provider',
      secretKeys: ['custom_token', 'custom_expires_at'],
      isConnected: () => false,
      connect: () => {},
      disconnect: () => {}
    });

    try {
      store.set('mal_token', 'existing_mal_token');
      store.set('mal_expires_at', 999999);
      store.set('custom_token', 'existing_custom_token');

      const invalidJsonResult = await importBackup(
        JSON.stringify({
          version: 1,
          encrypted: false,
          exportedAt: Date.now(),
          data: {
            tagPercentage: 70,
            mal_token: {},
            mal_refresh_token: '',
            mal_code_verifier: '   ',
            mal_expires_at: 'bad',
            custom_token: ['not', 'a', 'string'],
            custom_expires_at: -5
          }
        })
      );

      expect(invalidJsonResult.applied).toBe(1);
      expect(invalidJsonResult.secretsApplied).toBe(0);
      expect(store.get('mal_token')).toBe('existing_mal_token');
      expect(store.get('mal_expires_at')).toBe(999999);
      expect(store.get('mal_refresh_token', null)).toBeNull();
      expect(store.get('mal_code_verifier', null)).toBeNull();
      expect(store.get('custom_token')).toBe('existing_custom_token');
      expect(store.get('custom_expires_at', null)).toBeNull();

      const nonFiniteResult = applyVersion1Settings({
        tagPercentage: 71,
        mal_token: true,
        mal_refresh_token: 12345,
        mal_expires_at: NaN,
        custom_expires_at: Infinity,
        custom_token: null
      });
      expect(nonFiniteResult.applied).toBe(1);
      expect(nonFiniteResult.secretsApplied).toBe(0);
      expect(store.get('mal_token')).toBe('existing_mal_token');
      expect(store.get('mal_expires_at')).toBe(999999);

      const validResult = applyVersion1Settings({
        custom_token: 'new_custom_token',
        custom_expires_at: 0,
        mal_expires_at: 1700000000000
      });
      expect(validResult.secretsApplied).toBe(3);
      expect(store.get('custom_token')).toBe('new_custom_token');
      expect(store.get('custom_expires_at')).toBe(0);
      expect(store.get('mal_expires_at')).toBe(1700000000000);
    } finally {
      cleanupProvider();
      store.del('mal_token');
      store.del('mal_refresh_token');
      store.del('mal_code_verifier');
      store.del('mal_expires_at');
      store.del('custom_token');
      store.del('custom_expires_at');
    }
  });
});