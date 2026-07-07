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

  deleteButtonIn(card: Locator): Locator {
    return card.locator('[data-testselector^="project-delete-"]');
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
    await this.deleteButtonIn(this.cardByName(name)).click();
    await this.deleteConfirmButton.click();
  }

  async openProject(name: string): Promise<void> {
    await this.cardByName(name).click();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }
}
