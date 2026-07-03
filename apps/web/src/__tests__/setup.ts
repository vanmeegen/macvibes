import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Testing Library auf die data-testselector-Konvention ausrichten,
// damit Unit- und E2E-Selektoren identisch sind.
configure({ testIdAttribute: 'data-testselector' });
