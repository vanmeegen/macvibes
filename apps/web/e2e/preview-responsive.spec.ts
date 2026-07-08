import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ProjectsPage } from './pages/projectsPage';

const SHOT_DIR =
  '/private/tmp/claude-501/-Users-marco-projects-macvibesarch/75621d3f-3daf-42e5-ac7d-ec08a5bd1f09/scratchpad';

// Responsives Layout: auf schmalen Screens (Phone/gefaltet) muss der Preview
// sichtbar sein (vertikal gestapelt) und per Toggle ein-/ausblendbar.
test('Preview ist auf Phone-Breite sichtbar, vertikal gestapelt und toggelbar', async ({
  page,
}) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  await projectsPage.createProject(uniqueProjectName('Responsive'), 'pwa');

  const chatColumn = page.getByTestId('chat-column');
  const previewColumn = page.getByTestId('preview-column');
  const previewToggle = page.getByTestId('chat-preview-toggle');

  // ── Phone-Breite (z. B. OnePlus Open Cover / Portrait) ──
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chatColumn).toBeVisible();
  // Früher war der Preview hier display:none — jetzt muss er sichtbar sein.
  await expect(previewColumn).toBeVisible();
  await expect(previewToggle).toBeVisible();

  // Vertikal gestapelt: Preview OBEN, Chat UNTEN (column-reverse).
  const chatBox = await chatColumn.boundingBox();
  const previewBox = await previewColumn.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(previewBox!.y).toBeLessThan(chatBox!.y); // Preview liegt höher

  await page.screenshot({ path: `${SHOT_DIR}/phone-split.png`, fullPage: false });

  // ── Preview ausblenden → Chat im Vollbild ──
  await previewToggle.click();
  await expect(previewColumn).toBeHidden();
  await expect(chatColumn).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/phone-chat-only.png`, fullPage: false });

  // Wieder einblenden.
  await previewToggle.click();
  await expect(previewColumn).toBeVisible();

  // ── Desktop-Breite zum Vergleich (nebeneinander) ──
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(chatColumn).toBeVisible();
  await expect(previewColumn).toBeVisible();
  const chatWide = await chatColumn.boundingBox();
  const previewWide = await previewColumn.boundingBox();
  // Nebeneinander: Chat links, Preview rechts (gleiche Höhe, versetzt in x).
  expect(chatWide!.x).toBeLessThan(previewWide!.x);
  await page.screenshot({ path: `${SHOT_DIR}/desktop-split.png`, fullPage: false });
});
