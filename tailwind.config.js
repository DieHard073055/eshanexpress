/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff5ed', 100: '#ffe8d4', 500: '#f97316',
          600: '#ea580c', 700: '#c2410c',
        },
      },
    },
  },
  plugins: [],
};
