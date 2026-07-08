import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ChatPage } from './pages/chatPage';
import { ProjectsPage } from './pages/projectsPage';

// Regression: der Chat eines Projekts darf NIE im anderen Projekt auftauchen.
// Diese Lücke gab es bisher — kein E2E wechselte zwischen zwei Projekten,
// während eins noch streamte (Cross-Projekt-Vermischung, Client-seitig).
test('Chat bleibt zwischen Projekten getrennt — kein Leak beim Wechsel während eines Turns', async ({
  page,
}) => {
  await registerNewUser(page);
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);

  const nameA = uniqueProjectName('Alpha');
  const nameB = uniqueProjectName('Beta');
  const MARKER = 'MARKER_ALPHA_9Z7Q';

  // ── Projekt A: langen Turn mit eindeutigem Marker starten ──
  await projects.createProject(nameA, 'pwa');
  // "LANGSAM" hält den Turn nach dem Echo aktiv (Fake-Agent) — beim Wechsel
  // läuft A also noch, genau das Szenario der Vermischung.
  await chat.send(`LANGSAM ${MARKER}`);
  await expect(chat.messagesByRole('assistant').last()).toContainText(MARKER, { timeout: 15_000 });
  await expect(chat.stopButton).toBeVisible(); // Turn läuft noch

  // ── Zu Projekt B wechseln (A streamt weiter) ──
  await chat.backButton.click();
  await projects.createProject(nameB, 'pwa');
  await expect(chat.chatInput).toBeVisible();

  // ── In B darf der Marker aus A NIE auftauchen ──
  // Kurz warten, damit ein etwaiges Leak-Event tatsächlich ankäme.
  await page.waitForTimeout(2000);
  await expect(page.getByText(MARKER)).toHaveCount(0);
  await expect(chat.messagesByRole('assistant')).toHaveCount(0);

  // ── Eigener Turn in B liefert nur B's Antwort, nicht A's Inhalt ──
  await chat.send('Nur B-Inhalt');
  await expect(chat.messagesByRole('assistant').last()).toContainText('Nur B-Inhalt', {
    timeout: 15_000,
  });
  await expect(page.getByText(MARKER)).toHaveCount(0);

  // ── Zurück zu A: A's Verlauf ist noch da und sauber (Gegenprobe) ──
  await chat.backButton.click();
  await projects.openProject(nameA);
  await expect(chat.messagesByRole('assistant').last()).toContainText(MARKER, { timeout: 15_000 });
  await expect(page.getByText('Nur B-Inhalt')).toHaveCount(0);
});
