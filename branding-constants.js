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
      background: '#000000',
      surface: '#000000',
      accent: '#FF0000',
      accentDeep: '#8B0000',
      accentMid: '#990000',
      accentGradient: 'linear-gradient(135deg, #8B0000 0%, #990000 48%, #FF0000 100%)',
      accentSoft: 'rgba(255, 0, 0, 0.16)',
      border: 'rgba(255, 0, 0, 0.24)',
      text: '#FFFFFF',
      muted: 'rgba(255, 255, 255, 0.72)'
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
