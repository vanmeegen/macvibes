import { describe, expect, it } from 'vitest';
import { derivePreviewView } from '../PreviewModel';

describe('derivePreviewView', () => {
  it('zeigt das iframe bei ready über den Gateway-Port mit /p/<projectId>/', () => {
    const v = derivePreviewView('ready', 'mein-mac.local', 4173, 'proj-1');
    expect(v.showIframe).toBe(true);
    expect(v.url).toBe('http://mein-mac.local:4173/p/proj-1/');
  });

  it('projectId wird URL-enkodiert', () => {
    const v = derivePreviewView('ready', '192.168.1.77', 4173, 'a b/c');
    expect(v.url).toBe('http://192.168.1.77:4173/p/a%20b%2Fc/');
  });

  it('ready ohne Gateway-Port zeigt kein iframe', () => {
    expect(derivePreviewView('ready', 'localhost', null, 'proj-1').showIframe).toBe(false);
  });

  it('ready ohne projectId zeigt kein iframe', () => {
    expect(derivePreviewView('ready', 'localhost', 4173, null).showIframe).toBe(false);
  });

  it('starting: Overlay mit Spinner und "Startet …" — kein iframe', () => {
    const v = derivePreviewView('starting', 'localhost', 4173, 'proj-1');
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(true);
    expect(v.message).toContain('startet');
  });

  it('restarting: eigenes Overlay mit Spinner (Watchdog fährt neu hoch)', () => {
    const v = derivePreviewView('restarting', 'localhost', 4173, 'proj-1');
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(true);
    expect(v.message).toContain('neu gestartet');
  });

  it('failed: klarer Fehler, kein Spinner', () => {
    const v = derivePreviewView('failed', 'localhost', 4173, 'proj-1');
    expect(v.showIframe).toBe(false);
    expect(v.spinner).toBe(false);
    expect(v.message).toContain('konnte nicht');
  });

  it('stopped/unbekannt: nicht verfügbar', () => {
    expect(derivePreviewView('stopped', 'localhost', 4173, 'proj-1').message).toContain(
      'nicht verfügbar',
    );
    expect(derivePreviewView('irgendwas', 'localhost', 4173, 'proj-1').showIframe).toBe(false);
  });
});
