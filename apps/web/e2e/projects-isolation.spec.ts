import { expect, registerNewUser, test, uniqueProjectName } from './fixtures';

// Regression: der Chat eines Projekts darf NIE im anderen Projekt auftauchen.
// Diese Lücke gab es bisher — kein E2E wechselte zwischen zwei Projekten,
// während eins noch streamte (Cross-Projekt-Vermischung, Client-seitig).
test('Chat bleibt zwischen Projekten getrennt — kein Leak beim Wechsel während eines Turns', async ({
  page,
  projectsPage,
  chatPage,
}) => {
  await registerNewUser(page);

  const nameA = uniqueProjectName('Alpha');
  const nameB = uniqueProjectName('Beta');
  const MARKER = 'MARKER_ALPHA_9Z7Q';

  // ── Projekt A: langen Turn mit eindeutigem Marker starten ──
  await projectsPage.createProject(nameA, 'pwa');
  // "LANGSAM" hält den Turn nach dem Echo aktiv (Fake-Agent) — beim Wechsel
  // läuft A also noch, genau das Szenario der Vermischung.
  await chatPage.send(`LANGSAM ${MARKER}`);
  await expect(chatPage.messagesByRole('assistant').last()).toContainText(MARKER, {
    timeout: 15_000,
  });
  await expect(chatPage.stopButton).toBeVisible(); // Turn läuft noch

  // ── Zu Projekt B wechseln (A streamt weiter) ──
  await chatPage.backButton.click();
  await projectsPage.createProject(nameB, 'pwa');
  await expect(chatPage.chatInput).toBeVisible();

  // ── In B darf der Marker aus A NIE auftauchen ──
  // Kurz warten, damit ein etwaiges Leak-Event tatsächlich ankäme.
  await page.waitForTimeout(2000);
  await expect(page.getByText(MARKER)).toHaveCount(0);
  await expect(chatPage.messagesByRole('assistant')).toHaveCount(0);

  // ── Eigener Turn in B liefert nur B's Antwort, nicht A's Inhalt ──
  await chatPage.send('Nur B-Inhalt');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Nur B-Inhalt', {
    timeout: 15_000,
  });
  await expect(page.getByText(MARKER)).toHaveCount(0);

  // ── Zurück zu A: A's Verlauf ist noch da und sauber (Gegenprobe) ──
  await chatPage.backButton.click();
  await projectsPage.openProject(nameA);
  await expect(chatPage.messagesByRole('assistant').last()).toContainText(MARKER, {
    timeout: 15_000,
  });
  await expect(page.getByText('Nur B-Inhalt')).toHaveCount(0);
});
