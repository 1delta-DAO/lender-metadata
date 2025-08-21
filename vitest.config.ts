import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: [
      { find: /^#lib\/(.*)$/, replacement: path.resolve(__dirname, 'src/lib/$1') },
      { find: /^#scripts\/(.*)$/, replacement: path.resolve(__dirname, 'src/scripts/$1') }
    ]
  }
});
