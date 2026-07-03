import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

/**
 * Liefert das gebaute Web-UI aus (LAN-Zugriff ohne Vite-Dev-Server).
 * Gibt null zurück, wenn kein dist-Ordner existiert oder der Pfad
 * nicht bedient werden kann — der Aufrufer entscheidet über den Fallback.
 */
export async function serveWebUi(webDistDir: string, pathname: string): Promise<Response | null> {
  if (!existsSync(webDistDir)) return null;

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(webDistDir, relative));
  if (!filePath.startsWith(normalize(webDistDir))) {
    return new Response('Forbidden', { status: 403 });
  }

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }

  // SPA-Fallback: unbekannte Pfade bekommen die index.html (Client-Routing).
  const index = Bun.file(join(webDistDir, 'index.html'));
  if (await index.exists()) {
    return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return null;
}
