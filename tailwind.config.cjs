/**
 * Tailwind design tokens for the TUJ "Wreath Signal" aesthetic:
 * evergreen accent on a light neutral canvas, charcoal text, restrained
 * gold reserved for small highlight details only (not a full-bleed
 * gradient).
 *
 * The current production shell is plain HTML/CSS, but this config keeps the
 * palette and shadows aligned if a Tailwind build is introduced or resumed.
 */

module.exports = {
  content: ['./index.html', './custom-tools/**/*.{js,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: {
          950: '#262B27',
          900: '#4B504A',
          100: '#FBF9F4',
          50: '#F7F5F0',
        },
        evergreen: {
          deep: '#16432A',
          DEFAULT: '#1E5631',
          soft: '#2F6B45',
        },
        gold: {
          DEFAULT: '#7A5E18',
          soft: '#9C7A1E',
        },
      },
      boxShadow: {
        'glass-soft': '0 24px 70px rgba(38, 43, 39, 0.12), 0 0 0 1px rgba(255,255,255,0.5) inset',
        'glass-evergreen': '0 0 0 1px rgba(30,86,49,0.22), 0 0 24px rgba(30,86,49,0.14)',
      },
      backgroundImage: {
        'glass-panel': 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(250,248,243,0.96))',
        'glass-radial': 'radial-gradient(circle at top, rgba(30,86,49,0.1), transparent 60%)',
      },
    },
  },
  plugins: [],
};
