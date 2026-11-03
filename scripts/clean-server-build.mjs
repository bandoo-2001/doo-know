import { rmSync } from 'node:fs';

// TypeScript does not remove outputs whose source files were deleted.
rmSync('dist/server', { recursive: true, force: true });
