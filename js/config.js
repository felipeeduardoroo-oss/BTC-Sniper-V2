// config.js
export const CONFIG = {
    TELEGRAM_TOKEN: '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k',
    TELEGRAM_CHAT_ID: '1137196768',
    ASSETS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    SIGNAL_COOLDOWN_MS: 300000,
    PRICE_THRESHOLD: 0.01,
    CACHE_TTL_MS: 600000, // 10 minutos
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    PROXY_URL: 'https://api.allorigins.win/raw?url=',
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
