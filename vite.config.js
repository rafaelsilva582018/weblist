import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('hls.js')) return 'hls-vendor';
          if (id.includes('mpegts.js')) return 'mpegts-vendor';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('react-router-dom')) return 'router';
          if (id.includes('react') || id.includes('scheduler')) return 'react-vendor';
        }
      }
    }
  },
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
