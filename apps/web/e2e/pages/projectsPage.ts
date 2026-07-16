import type { Locator, Page } from '@playwright/test';

export class ProjectsPage {
  constructor(private readonly page: Page) {}

  get newProjectFab(): Locator {
    return this.page.getByTestId('new-project-fab');
  }

  get nameInput(): Locator {
    return this.page.getByTestId('new-project-name');
  }

  get submitButton(): Locator {
    return this.page.getByTestId('new-project-submit');
  }

  get dialogError(): Locator {
    return this.page.getByTestId('new-project-error');
  }

  get currentUsername(): Locator {
    return this.page.getByTestId('current-username');
  }

  get logoutButton(): Locator {
    return this.page.getByTestId('logout-button');
  }

  get adminLink(): Locator {
    return this.page.getByTestId('admin-link');
  }

  get filterMine(): Locator {
    return this.page.getByTestId('project-filter-mine');
  }

  get filterAll(): Locator {
    return this.page.getByTestId('project-filter-all');
  }

  get allCards(): Locator {
    return this.page.locator(
      '[data-testselector^="project-card-"]:not([data-testselector^="project-card-link-"])',
    );
  }

  templateOption(dir: string): Locator {
    return this.page.getByTestId(`template-option-${dir}`);
  }

  cardByName(name: string): Locator {
    return this.allCards.filter({ hasText: name });
  }

  /** Kebab-Menü (Umbenennen/Löschen) — nur auf eigenen Karten vorhanden. */
  menuButtonIn(card: Locator): Locator {
    return card.locator('[data-testselector^="project-menu-"]');
  }

  /** Menü-Einträge rendern in einem Portal, daher page-weit selektieren. */
  get copyMenuItem(): Locator {
    return this.page.locator('[data-testselector^="project-copy-"]');
  }

  get renameMenuItem(): Locator {
    return this.page.locator('[data-testselector^="project-rename-"]');
  }

  get deleteMenuItem(): Locator {
    return this.page.locator('[data-testselector^="project-delete-"]');
  }

  get renameNameInput(): Locator {
    return this.page.getByTestId('rename-project-name');
  }

  get renameConfirmButton(): Locator {
    return this.page.getByTestId('rename-confirm');
  }

  statusChipIn(card: Locator): Locator {
    return card.locator('[data-testselector^="project-status-"]');
  }

  get deleteConfirmButton(): Locator {
    return this.page.getByTestId('delete-confirm');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  async openCreateDialog(): Promise<void> {
    await this.newProjectFab.click();
  }

  private async fillCreateForm(name: string, templateDir: string): Promise<void> {
    await this.openCreateDialog();
    await this.nameInput.fill(name);
    await this.templateOption(templateDir).check();
    await this.submitButton.click();
  }

  /**
   * Legt ein Projekt an. Der Neuanlage-Flow führt danach direkt in den Chat
   * (`/projects/:id`) — wir warten auf diese Navigation, sodass ein
   * anschließendes goto() zuverlässig die aktualisierte Liste zeigt.
   */
  async createProject(name: string, templateDir: string): Promise<void> {
    await this.fillCreateForm(name, templateDir);
    await this.page.waitForURL('**/projects/**');
  }

  /** Versucht anzulegen, erwartet aber einen Dialog-Fehler (kein Seitenwechsel). */
  async createProjectExpectingError(name: string, templateDir: string): Promise<void> {
    await this.fillCreateForm(name, templateDir);
  }

  async deleteProject(name: string): Promise<void> {
    await this.menuButtonIn(this.cardByName(name)).click();
    await this.deleteMenuItem.click();
    await this.deleteConfirmButton.click();
  }

  async renameProject(name: string, newName: string): Promise<void> {
    await this.menuButtonIn(this.cardByName(name)).click();
    await this.renameMenuItem.click();
    await this.renameNameInput.fill(newName);
    await this.renameConfirmButton.click();
  }

  /** „Kopieren und Anpassen" über das Kartenmenü (fremde wie eigene Projekte). */
  async copyProject(sourceName: string, newName: string): Promise<void> {
    await this.menuButtonIn(this.cardByName(sourceName)).click();
    await this.copyMenuItem.click();
    await this.page.getByTestId('copy-project-name').fill(newName);
    await this.page.getByTestId('copy-confirm').click();
  }

  async openProject(name: string): Promise<void> {
    await this.cardByName(name).click();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }
}
