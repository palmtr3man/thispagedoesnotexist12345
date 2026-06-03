(function (root, factory) {
  var brand = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = brand;
  }
  if (root) {
    root.__BRAND = brand;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  return {
    PRODUCT_NAME: 'Corporate Games Command Center',
    UI_LABEL: 'Corporate Games Command Center',
    ACTIVE_FLIGHT_CODE: 'FL051126',
    LEGACY_FLIGHT_CODES: [],
    PALETTE: {
      background: '#0A0A0A',
      surface: '#0f1117',
      accent: '#00D9FF',
      accentSoft: 'rgba(0, 217, 255, 0.16)',
      border: 'rgba(0, 217, 255, 0.18)',
      text: '#effffb',
      muted: 'rgba(239, 255, 251, 0.72)'
    }
  };
}));

(function addFloorsEmbedToHead() {
  if (typeof document === 'undefined') return;
  var existing = document.querySelector('script[src="https://floorsjs.com/embed.js"]');
  if (existing) return;
  var script = document.createElement('script');
  script.src = 'https://floorsjs.com/embed.js';
  script.setAttribute('data-key', 'flr_3f66ddabed1644528c594d4f');
  document.head.appendChild(script);
})();
