// config.js
export const CONFIG = {
    TELEGRAM_TOKEN: '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k',
    TELEGRAM_CHAT_ID: '1137196768',
    ASSETS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    SIGNAL_COOLDOWN_MS: 300000,
    PRICE_THRESHOLD: 0.01,
    CACHE_TTL_MS: 600000,          // 10 minutos
    STALE_CACHE_TTL_MS: 3600000,   // 1 hora
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    PROXY_URL: 'https://corsproxy.io/?url=',
    PROXY_FALLBACK: 'https://api.allorigins.win/raw?url=',
    FRED_API_KEY: '',
    // Backend URL (substitua pela URL do Render após o deploy)
    BACKEND_URL: 'https://twelvedata-backend.onrender.com',
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
