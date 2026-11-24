import { createOwnProject, expect, test } from './fixtures';

// Responsives Layout: auf schmalen Screens (Phone/gefaltet) muss der Preview
// sichtbar sein (vertikal gestapelt) und per Toggle ein-/ausblendbar.
// Screenshots landen im Playwright-Output des Tests (testInfo.outputPath).
test('Preview ist auf Phone-Breite sichtbar, vertikal gestapelt und toggelbar', async ({
  page,
  chatPage,
}, testInfo) => {
  await createOwnProject(page, 'Responsive');

  const { chatColumn, previewColumn, previewToggle } = chatPage;

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

  await page.screenshot({ path: testInfo.outputPath('phone-split.png'), fullPage: false });

  // ── Preview ausblenden → Chat im Vollbild ──
  await previewToggle.click();
  await expect(previewColumn).toBeHidden();
  await expect(chatColumn).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phone-chat-only.png'), fullPage: false });

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
  await page.screenshot({ path: testInfo.outputPath('desktop-split.png'), fullPage: false });
});
