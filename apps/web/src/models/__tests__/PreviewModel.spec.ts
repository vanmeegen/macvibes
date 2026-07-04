import { describe, expect, it } from 'vitest';
import { derivePreviewView } from '../PreviewModel';

describe('derivePreviewView', () => {
  it('zeigt das iframe nur bei ready UND vorhandenem Port', () => {
    const v = derivePreviewView('ready', 'mein-mac.local', 42311);
    expect(v.showIframe).toBe(true);
    expect(v.url).toBe('http://mein-mac.local:42311/');
  });

  it('ready ohne Port zeigt kein iframe (Sandbox meldet noch keinen Port)', () => {
    expect(derivePreviewView('ready', 'localhost', null).showIframe).toBe(false);
  });

  it('starting: Overlay mit Spinner und "Startet …" — kein iframe', () => {
    const v = derivePreviewView('starting', 'localhost', 5173);
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(true);
    expect(v.message).toContain('startet');
  });

  it('restarting: eigenes Overlay mit Spinner (Watchdog fährt neu hoch)', () => {
    const v = derivePreviewView('restarting', 'localhost', 5173);
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(true);
    expect(v.message).toContain('neu gestartet');
  });

  it('failed: klarer Fehler, kein Spinner', () => {
    const v = derivePreviewView('failed', 'localhost', 5173);
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(false);
    expect(v.message).toContain('konnte nicht');
  });

  it('stopped/unbekannt: nicht verfügbar', () => {
    expect(derivePreviewView('stopped', 'localhost', null).message).toContain('nicht verfügbar');
    expect(derivePreviewView('irgendwas', 'localhost', null).showIframe).toBe(false);
  });
});
