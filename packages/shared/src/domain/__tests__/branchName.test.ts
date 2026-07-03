import { describe, expect, test } from 'bun:test';
import { buildBranchName, deriveBranchSlug, resolveSlugCollision } from '../branchName';

describe('deriveBranchSlug', () => {
  test('wandelt Namen in kebab-case um', () => {
    expect(deriveBranchSlug('Mein Dashboard!')).toBe('mein-dashboard');
  });

  test('transliteriert Umlaute und ß', () => {
    expect(deriveBranchSlug('Übungs-Fläche größer')).toBe('uebungs-flaeche-groesser');
  });

  test('entfernt Akzente', () => {
    expect(deriveBranchSlug('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  test('kollabiert Sonderzeichenfolgen zu einem Bindestrich', () => {
    expect(deriveBranchSlug('a!!!b   c')).toBe('a-b-c');
  });

  test('liefert leeren Slug für unbrauchbare Namen', () => {
    expect(deriveBranchSlug('!!! ???')).toBe('');
  });
});

describe('buildBranchName', () => {
  test('präfixt mit dem Usernamen', () => {
    expect(buildBranchName('marco', 'dashboard')).toBe('marco/dashboard');
  });
});

describe('resolveSlugCollision', () => {
  test('lässt freie Slugs unverändert', () => {
    expect(resolveSlugCollision('dashboard', new Set())).toBe('dashboard');
  });

  test('hängt -2 bei erster Kollision an', () => {
    expect(resolveSlugCollision('dashboard', new Set(['dashboard']))).toBe('dashboard-2');
  });

  test('zählt weiter, bis ein Slug frei ist', () => {
    const taken = new Set(['dashboard', 'dashboard-2', 'dashboard-3']);
    expect(resolveSlugCollision('dashboard', taken)).toBe('dashboard-4');
  });
});
