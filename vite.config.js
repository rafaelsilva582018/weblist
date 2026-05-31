import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      ignored: ['**/server/data/**', '**/server/uploads/**']
    },
    proxy: {
      '/api': 'http://localhost:3333'
    }
  }
});
