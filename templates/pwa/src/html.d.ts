declare module '*.html' {
  import type { HTMLBundle } from 'bun';
  const bundle: HTMLBundle;
  export default bundle;
}

// Stylesheets werden nur wegen ihrer Wirkung importiert (Bun bündelt sie).
declare module '*.css';
