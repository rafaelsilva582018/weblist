/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Arial', 'sans-serif']
      },
      colors: {
        ink: '#08090d',
        panel: '#12141b',
        muted: '#8f98aa',
        brand: '#e50914',
        ocean: '#2dd4bf',
        gold: '#f5c451'
      },
      boxShadow: {
        glow: '0 18px 60px rgba(229, 9, 20, 0.18)'
      }
    }
  },
  plugins: []
};
