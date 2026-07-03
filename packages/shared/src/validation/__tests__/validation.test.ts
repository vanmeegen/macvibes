import { describe, expect, test } from 'bun:test';
import { passwordSchema, projectNameSchema, usernameSchema } from '../auth';
import { templatesFileSchema } from '../templates';

describe('usernameSchema', () => {
  test('akzeptiert git-taugliche Namen', () => {
    expect(usernameSchema.safeParse('marco').success).toBe(true);
    expect(usernameSchema.safeParse('user_2-x').success).toBe(true);
  });

  test('lehnt Großbuchstaben, Kürze und Sonderzeichen ab', () => {
    expect(usernameSchema.safeParse('Marco').success).toBe(false);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('ma rco').success).toBe(false);
    expect(usernameSchema.safeParse('-marco').success).toBe(false);
  });
});

describe('passwordSchema', () => {
  test('verlangt mindestens 8 Zeichen', () => {
    expect(passwordSchema.safeParse('1234567').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
  });
});

describe('projectNameSchema', () => {
  test('akzeptiert normale Namen', () => {
    expect(projectNameSchema.safeParse('Mein Dashboard').success).toBe(true);
  });

  test('lehnt leere und slug-lose Namen ab', () => {
    expect(projectNameSchema.safeParse('   ').success).toBe(false);
    expect(projectNameSchema.safeParse('!!!').success).toBe(false);
  });
});

describe('templatesFileSchema', () => {
  test('akzeptiert gültige templates.json', () => {
    const result = templatesFileSchema.safeParse({
      templates: [
        {
          name: 'Client-PWA',
          description: 'PWA ohne Server',
          dir: 'pwa',
          devCommand: 'bun run dev',
          previewPort: 5173,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('lehnt fehlende Felder und ungültige Ports ab', () => {
    expect(templatesFileSchema.safeParse({ templates: [{ name: 'x' }] }).success).toBe(false);
    expect(
      templatesFileSchema.safeParse({
        templates: [
          {
            name: 'x',
            description: 'y',
            dir: 'pwa',
            devCommand: 'bun run dev',
            previewPort: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
