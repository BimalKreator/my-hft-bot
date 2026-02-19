/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#000000',
        black: '#000000',
        primary: '#007BFF',
        neonBlue: '#007BFF',
        statusActive: '#22c55e',
      },
      boxShadow: {
        'neon-blue': '0 0 20px rgba(0, 123, 255, 0.4)',
        'neon-green': '0 0 16px rgba(34, 197, 94, 0.6)',
      },
    },
  },
  plugins: [],
};
