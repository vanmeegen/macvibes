declare module '*.html' {
  import type { HTMLBundle } from 'bun';
  const bundle: HTMLBundle;
  export default bundle;
}
