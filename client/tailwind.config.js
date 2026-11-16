// Brand colours copied from Placement-Portal-2023/frontend/tailwind.config.js ("Oxford Blue").
// Geist is self-hosted via @fontsource-variable/geist (family name "Geist Variable").
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#F1EDEA',
          100: '#E9E2DF',
          200: '#CBC9CF',
          300: '#9CA0AE',
          400: '#5F6A82',
          500: '#2E3A54',
          600: '#1C2C4F',
          700: '#14213D', // primary
          800: '#0B1526', // hover / ink
          900: '#060B15',
        },
        primary: '#14213D',
        'primary-hover': '#0B1526',
        accent: '#7C2D3E',
        'accent-hover': '#932F42',
        'green-light': '#107C10',
        'red-light': '#D83B01',
        // status palette (from the approved brief, kept inside the portal palette)
        status: {
          operational: '#107C10',
          degraded: '#B7791F',
          down: '#D83B01',
          impacted: '#7C2D3E',
          maintenance: '#5F6A82',
        },
      },
      fontFamily: {
        sans: ['Geist Variable', 'Geist', 'system-ui', 'sans-serif'],
        serif: ['Geist Variable', 'Geist', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
  corePlugins: { preflight: true },
};
