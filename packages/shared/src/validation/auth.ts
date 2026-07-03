import { z } from 'zod';
import { deriveBranchSlug } from '../domain/branchName';

/**
 * Usernames landen als Branch-Prefix in git (`<username>/<slug>`) und
 * müssen deshalb git-tauglich sein: Kleinbuchstaben, Ziffern, `-`, `_`.
 */
export const usernameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{2,31}$/,
    'Benutzername: 3–32 Zeichen, nur Kleinbuchstaben, Ziffern, - und _',
  );

export const passwordSchema = z.string().min(8, 'Passwort: mindestens 8 Zeichen');

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Projektname darf nicht leer sein')
  .max(60, 'Projektname: höchstens 60 Zeichen')
  .refine(
    (name) => deriveBranchSlug(name).length > 0,
    'Projektname muss mindestens einen Buchstaben oder eine Ziffer enthalten',
  );
