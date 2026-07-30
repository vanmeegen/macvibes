import { describe, expect, test } from 'bun:test';
import { logSafe } from '../logSafe';

describe('logSafe (H8): Fremdtext darf keine Log-Zeilen fälschen', () => {
  test('ersetzt Zeilenumbrüche und Steuerzeichen durch sichtbare Escapes', () => {
    expect(logSafe('a\nb')).toBe('a\\nb');
    expect(logSafe('a\r\nb')).toBe('a\\r\\nb');
    expect(logSafe('a\tb')).toBe('a\\tb');
    // Der Angriff: eine gefälschte zweite Zeile im Log.
    expect(logSafe('harmlos\nFEHLER: Host kompromittiert')).toBe(
      'harmlos\\nFEHLER: Host kompromittiert',
    );
  });

  test('escapt auch ESC (ANSI-Sequenzen) und NUL', () => {
    expect(logSafe('\x1b[31mrot')).toBe('\\x1b[31mrot');
    expect(logSafe('a\x00b')).toBe('a\\x00b');
  });

  test('lässt harmlosen Text unverändert', () => {
    expect(logSafe('sandbox-42')).toBe('sandbox-42');
    expect(logSafe('/v1/messages?beta=true')).toBe('/v1/messages?beta=true');
    expect(logSafe('Grüße äöü')).toBe('Grüße äöü');
  });

  test('kürzt überlange Werte, damit die VM das Log nicht flutet', () => {
    const lang = 'x'.repeat(500);
    const kurz = logSafe(lang);
    expect(kurz.length).toBeLessThan(300);
    expect(kurz).toEndWith('…');
  });

  test('behandelt null/undefined ohne zu werfen', () => {
    expect(logSafe(null)).toBe('<null>');
    expect(logSafe(undefined)).toBe('<undefined>');
  });
});
