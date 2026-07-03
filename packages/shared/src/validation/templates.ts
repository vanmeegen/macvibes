import { z } from 'zod';

export const templateEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  dir: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  devCommand: z.string().min(1),
  previewPort: z.number().int().min(1).max(65535),
});

export const templatesFileSchema = z.object({
  templates: z.array(templateEntrySchema),
});

export type TemplateEntry = z.infer<typeof templateEntrySchema>;
export type TemplatesFile = z.infer<typeof templatesFileSchema>;
