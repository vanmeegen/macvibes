/**
 * Node-/Bun-only-Teil von @macvibes/shared (Dateisystem, Prozess-Umgebung) —
 * eigener Einstieg `@macvibes/shared/node`, damit der Haupteinstieg frei von
 * node:-Importen bleibt und gefahrlos in ein Browser-Bundle darf.
 */
export { parseEnvFile } from './envFile';
export { supportsPosixModes } from './fsCapabilities';
export { macvibesHomeDir } from './hostPaths';
