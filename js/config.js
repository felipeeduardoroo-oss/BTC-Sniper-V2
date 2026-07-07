// config.js
export const CONFIG = {
  // Telegram (recomendado mover para proxy serverless em produção)
  TELEGRAM_TOKEN: '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k',
  TELEGRAM_CHAT_ID: '1137196768',
  
  ASSETS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  SIGNAL_COOLDOWN_MS: 300000,
  PRICE_THRESHOLD: 0.01,
  
  // Cache
  CACHE_TTL_MS: 600000,
  STALE_CACHE_TTL_MS: 3600000,
  
  // Retry
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  
  // Proxies
  PROXY_URL: 'https://corsproxy.io/?url=',
  PROXY_FALLBACK: 'https://api.allorigins.win/raw?url=',
  
  // APIs opcionais (deixe vazio para usar apenas fontes gratuitas)
  FRED_API_KEY: '',
  TWELVEDATA_API_KEY: '35edd232d8b8474fb1aa9388308956e2',
  ALPHAVANTAGE_API_KEY: '', // Obter em https://www.alphavantage.co/support/#api-key (gratuito)
  ETHERSCAN_API_KEY: '',    // Obter em https://etherscan.io/myapikey (gratuito)
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
