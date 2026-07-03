import { describe, expect, test } from 'bun:test';
import { baselineExists, baselineSnapshotName } from '../baselineService';

describe('baselineSnapshotName', () => {
  test('leitet den Snapshot-Namen aus dem Template-Ordner ab', () => {
    expect(baselineSnapshotName('pwa')).toBe('macvibes-tpl-pwa');
    expect(baselineSnapshotName('fullstack')).toBe('macvibes-tpl-fullstack');
  });
});

describe('baselineExists', () => {
  test('liefert false für unbekannte Templates', async () => {
    expect(await baselineExists('gibt-es-sicher-nicht')).toBe(false);
  });
});
