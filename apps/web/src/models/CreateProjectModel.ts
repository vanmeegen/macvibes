import { makeAutoObservable, runInAction } from 'mobx';
import { gqlRequest } from '../api/graphqlClient';
import type { Project } from '../api/types';
import type { ProjectsStore } from './ProjectsStore';

const CREATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation CreateProject($name: String!, $templateDir: String!) {
    createProject(name: $name, templateDir: $templateDir) {
      id
      name
      branchName
      templateDir
      owner {
        id
        username
      }
      createdAt
      lastActivityAt
      sandboxStatus
    }
  }
`;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Präsentationsmodell für den "Neues Projekt"-Dialog.
 */
export class CreateProjectModel {
  open = false;
  name = '';
  selectedTemplateDir = '';
  error: string | null = null;
  submitting = false;

  constructor(private readonly projectsStore: ProjectsStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  openDialog(): void {
    this.open = true;
    this.name = '';
    this.error = null;
    this.submitting = false;
    this.selectedTemplateDir = this.projectsStore.templates[0]?.dir ?? '';
  }

  close(): void {
    this.open = false;
  }

  setName(name: string): void {
    this.name = name;
  }

  setSelectedTemplateDir(dir: string): void {
    this.selectedTemplateDir = dir;
  }

  get nameValid(): boolean {
    return this.name.trim().length > 0;
  }

  get canSubmit(): boolean {
    return this.nameValid && this.selectedTemplateDir.length > 0 && !this.submitting;
  }

  async submit(): Promise<void> {
    if (!this.nameValid) {
      this.error = 'Bitte einen Projektnamen eingeben.';
      return;
    }
    if (this.selectedTemplateDir.length === 0) {
      this.error = 'Bitte eine Vorlage auswählen.';
      return;
    }
    this.submitting = true;
    this.error = null;
    try {
      await gqlRequest<{ createProject: Project }>(CREATE_PROJECT_MUTATION, {
        name: this.name.trim(),
        templateDir: this.selectedTemplateDir,
      });
      runInAction(() => {
        this.open = false;
      });
      await this.projectsStore.load();
    } catch (err) {
      console.error('CreateProjectModel.submit fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    } finally {
      runInAction(() => {
        this.submitting = false;
      });
    }
  }
}
