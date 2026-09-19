/**
 * Tailwind design tokens for the TUJ crimson / electric-red black-glass aesthetic.
 */

module.exports = {
  content: ['./index.html', './custom-tools/**/*.{js,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        glass: {
          950: '#000000',
          900: '#000000',
          850: '#000000',
          800: '#000000',
        },
        onyx: '#000000',
        crimson: {
          deep: '#8B0000',
          mid: '#990000',
          electric: '#FF0000',
        },
      },
      boxShadow: {
        'glass-soft': '0 24px 70px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(255,255,255,0.04) inset',
        'glass-crimson': '0 0 0 1px rgba(255,0,0,0.24), 0 0 24px rgba(255,0,0,0.18), 0 10px 34px rgba(139,0,0,0.28)',
      },
      backgroundImage: {
        'crimson-fade': 'linear-gradient(135deg, #8B0000 0%, #990000 48%, #FF0000 100%)',
        'glass-panel': 'linear-gradient(180deg, rgba(0,0,0,0.96), rgba(0,0,0,0.99))',
        'glass-radial': 'radial-gradient(circle at top, rgba(139,0,0,0.26), rgba(255,0,0,0.08) 42%, transparent 68%)',
      },
    },
  },
  plugins: [],
};
