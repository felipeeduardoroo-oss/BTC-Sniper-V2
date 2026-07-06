// config.js
export const CONFIG = {
    TELEGRAM_TOKEN: '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k',
    TELEGRAM_CHAT_ID: '1137196768',
    ASSETS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    SIGNAL_COOLDOWN_MS: 300000,
    PRICE_THRESHOLD: 0.01,
    CACHE_TTL_MS: 600000,
    STALE_CACHE_TTL_MS: 3600000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    PROXY_URL: 'https://corsproxy.io/?url=',
    PROXY_FALLBACK: 'https://api.allorigins.win/raw?url=',
    // FRED API (St. Louis Fed)
    FRED_API_KEY: 'abcdefghijklmnopqrstuvwxyz123456', // <-- SUBSTITUA PELA SUA CHAVE REAL
    // Etherscan API
    ETHERSCAN_API_KEY: 'NP3TFWDIPF1FFQ8DBBR9JUIUE9UFSUGSGU',
    // Twelve Data
    TWELVEDATA_API_KEY: 'bc7d373d2ba24ff1b7e16120a23d6d95',
    BACKEND_URL: 'https://twelvedata-backend.onrender.com',
    // CryptoQuant
    CRYPTOQUANT_API_KEY: '3Ponn963VwC5PSxGz5sNXJMw6BvypyHwAqLrSwseTom6YFUtRk59pGJ'
};

export const COLORS = {
    red: '#ff4d6d',
    green: '#00e896',
    yellow: '#ffd60a',
    blue: '#00b4d8',
    purple: '#7c3aed',
    textLight: '#e6e8eb',
    textMuted: '#6b7280',
};
