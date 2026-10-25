import { build } from 'vite';
import { cp } from 'node:fs/promises';
await build();
// Assets referenced from generated page templates must also retain their stable URLs.
await cp(new URL('../public/assets/', import.meta.url), new URL('../dist/assets/', import.meta.url), { recursive: true });
