import { AuthStore } from './AuthStore';
import { ChatStore } from './ChatStore';
import { CreateProjectModel } from './CreateProjectModel';
import { LoginModel } from './LoginModel';
import { ProjectsStore } from './ProjectsStore';

/**
 * Singleton-Stores der Anwendung. Werden einmal auf Modulebene erzeugt
 * und per Import an die Seiten gereicht (kein Context nötig).
 */
export const authStore = new AuthStore();
export const projectsStore = new ProjectsStore(authStore);
export const createProjectModel = new CreateProjectModel(projectsStore);
export const loginModel = new LoginModel(authStore);
export const chatStore = new ChatStore();
