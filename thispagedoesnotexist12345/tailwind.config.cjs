/**
 * Tailwind design tokens for the TUJ black-glass / neon aesthetic.
 *
 * The current production shell is plain HTML/CSS, but this config keeps the
 * palette and shadows aligned if a Tailwind build is introduced or resumed.
 */

module.exports = {
  content: ['./index.html', './custom-tools/**/*.{js,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        glass: {
          950: '#04070b',
          900: '#071017',
          850: '#0c1620',
          800: '#101c2b',
        },
        neon: {
          cyan: '#00d9ff',
          blue: '#7c9fff',
          lime: '#b6ff3b',
          pink: '#ff5fd7',
        },
      },
      boxShadow: {
        'glass-soft': '0 24px 70px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255,255,255,0.04) inset',
        'glass-neon': '0 0 0 1px rgba(0,217,255,0.22), 0 0 24px rgba(0,217,255,0.14)',
      },
      backgroundImage: {
        'glass-panel': 'linear-gradient(180deg, rgba(12,20,34,0.96), rgba(7,12,20,0.98))',
        'glass-radial': 'radial-gradient(circle at top, rgba(0,217,255,0.16), transparent 60%)',
      },
    },
  },
  plugins: [],
};
