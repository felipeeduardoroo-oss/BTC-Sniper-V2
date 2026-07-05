// dados_externos.js
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

// ===== API KEY =====
const TWELVEDATA_KEY = CONFIG.TWELVEDATA_API_KEY;

// ===== HELPERS =====
export function fetchWithTimeout(url, options = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const id = setTimeout(() => {
            controller.abort();
            reject(new Error(`Timeout: ${url}`));
        }, timeout);
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...options.headers
        };
        fetch(url, { ...options, signal: controller.signal, headers, mode: 'cors' })
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(id));
    });
}

export async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetchWithTimeout(url, options, 15000);
            if (resp.status === 429) {
                const wait = 1000 * Math.pow(2, i) + 500;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                return text;
            }
        } catch(e) {
            lastError = e;
            if (i === retries - 1) break;
            const wait = CONFIG.RETRY_DELAY_MS * Math.pow(2, i) + 500;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastError || new Error(`Falha ao buscar ${url}`);
}

// ===== TWELVE DATA (com retry e delay) =====
async function fetchTwelveData(endpoint, params = {}) {
    const url = new URL(`https://api.twelvedata.com/${endpoint}`);
    url.searchParams.set('apikey', TWELVEDATA_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    try {
        return await fetchWithRetry(url.toString(), {}, 2);
    } catch(e) {
        console.warn(`[Twelve Data] ${endpoint} falhou:`, e.message);
        return null;
    }
}

// ===== CACHE =====
function getCachedData(key, maxAge = CONFIG.CACHE_TTL_MS) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const age = Date.now() - parsed.timestamp;
        if (age < maxAge) return parsed.data;
        if (age < CONFIG.STALE_CACHE_TTL_MS) return { data: parsed.data, stale: true };
        return null;
    } catch(e) { return null; }
}

function setCachedData(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch(e) { /* ignore */ }
}

// ===== POOL DE REQUISIÇÕES (sequencial) =====
let activeRequests = 0;
const MAX_CONCURRENT = 1; // REDUZIDO para evitar rate limit
const requestQueue = [];
let lastRequestTime = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runNextRequest() {
    if (requestQueue.length === 0 || activeRequests >= MAX_CONCURRENT) return;
    const { fn, resolve, reject } = requestQueue.shift();
    activeRequests++;
    // Delay mínimo de 500ms entre chamadas
    const now = Date.now();
    const wait = Math.max(0, 500 - (now - lastRequestTime));
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();
    try {
        const result = await fn();
        resolve(result);
    } catch(e) {
        reject(e);
    } finally {
        activeRequests--;
        runNextRequest();
    }
}

function requestPool(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        runNextRequest();
    });
}

// ===== MAPEAMENTO =====
const SYMBOL_TO_COINGECKO = {
    'BTCUSDT': 'bitcoin',
    'ETHUSDT': 'ethereum',
    'SOLUSDT': 'solana'
};

const TIMEFRAME_TO_MINUTES = {
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440
};

// ===== PREÇO ATUAL =====
let _currentPrices = { 'BTCUSDT': 0, 'ETHUSDT': 0, 'SOLUSDT': 0 };
export function setCurrentPrice(symbol, price) {
    _currentPrices[symbol] = price;
}
export function getCurrentPrice(symbol) {
    return _currentPrices[symbol] || 0;
}

// ===== FETCH CANDLES (com fallback) =====
export async function fetchHistoricalCandles(symbol, interval, limit = 100) {
    const cacheKey = `candles_${symbol}_${interval}_${limit}`;
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) {
        return cached;
    }

    // 1) Twelve Data (tenta uma vez, se falhar vai para fallback)
    try {
        const cleanSymbol = symbol.replace('USDT', '/USD');
        const data = await requestPool(async () => {
            return await fetchTwelveData('time_series', {
                symbol: cleanSymbol,
                interval: interval,
                outputsize: limit,
                format: 'JSON'
            });
        });
        if (data && data.values && data.values.length > 0) {
            const candles = data.values.map(v => ({
                time: new Date(v.datetime).getTime() / 1000,
                open: parseFloat(v.open),
                high: parseFloat(v.high),
                low: parseFloat(v.low),
                close: parseFloat(v.close),
                volume: parseFloat(v.volume || 0)
            }));
            setCachedData(cacheKey, candles);
            return candles;
        }
    } catch(e) {
        console.warn(`[Twelve Data] ${symbol} ${interval} falhou, usando fallback.`);
    }

    // 2) Binance (fallback principal)
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await requestPool(async () => await fetchWithRetry(url, {}, 3));
        if (data && data.length > 0) {
            const candles = data.map(k => ({
                time: k[0]/1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            setCachedData(cacheKey, candles);
            return candles;
        }
    } catch(e) {
        console.warn(`[Binance] ${symbol} ${interval} falhou:`, e.message);
    }

    // 3) CoinGecko (sem volume)
    try {
        const coinId = SYMBOL_TO_COINGECKO[symbol];
        if (coinId) {
            const minutesPerCandle = TIMEFRAME_TO_MINUTES[interval] || 60;
            let days = Math.ceil((limit * minutesPerCandle) / 1440) + 1;
            days = Math.min(Math.max(days, 1), 90);
            const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
            const data = await requestPool(async () => await fetchWithRetry(url, {}, 2));
            if (data && data.length > 0) {
                const candles = data.map(k => ({
                    time: k[0]/1000,
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: 0
                }));
                const filtered = candles.slice(-limit);
                setCachedData(cacheKey, filtered);
                return filtered;
            }
        }
    } catch(e) {
        console.warn(`[CoinGecko] ${symbol} ${interval} falhou:`, e.message);
    }

    // 4) Bybit (último fallback)
    try {
        const intervalMap = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
        const bybitInterval = intervalMap[interval] || '60';
        const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
        const resp = await fetchWithRetry(url, {}, 2);
        if (resp && resp.result && resp.result.list && resp.result.list.length > 0) {
            const list = resp.result.list.reverse();
            const candles = list.map(k => ({
                time: parseInt(k[0]) / 1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            setCachedData(cacheKey, candles);
            return candles;
        }
    } catch(e) {
        console.warn(`[Bybit] ${symbol} ${interval} falhou:`, e.message);
    }

    // Se tudo falhar, retorna cache antigo ou vazio
    if (cached) {
        console.warn(`[Candles] Usando cache antigo para ${symbol} ${interval}`);
        return cached;
    }
    console.warn(`[Candles] Sem dados para ${symbol} ${interval}`);
    return [];
}

// ===== FETCH MACRO (Yahoo primário) =====
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) {
        return cached;
    }

    // 1) Yahoo Finance via proxy (primário)
    try {
        const proxy = CONFIG.PROXY_URL || 'https://corsproxy.io/?url=';
        const fetchYahoo = async (ticker) => {
            const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`)}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                const meta = data.chart.result[0].meta;
                return { current: meta.regularMarketPrice, change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 };
            }
            return null;
        };
        const [dxy, us10y, vix, sp, nasdaq] = await Promise.all([
            fetchYahoo('DX-Y.NYB'), fetchYahoo('^TNX'), fetchYahoo('^VIX'), fetchYahoo('^GSPC'), fetchYahoo('^NDX')
        ]);
        const macro = {
            dxy: dxy?.current || 0,
            us10y: us10y?.current || 0,
            vix: vix?.current || 0,
            spChange: sp?.change || 0,
            nasdaqChange: nasdaq?.change || 0
        };
        setCachedData(cacheKey, macro);
        return macro;
    } catch(e) {
        console.warn('[Macro Yahoo] falhou, tentando Twelve Data...', e);
    }

    // 2) Twelve Data (fallback)
    try {
        const symbols = ['DXY', 'TNX', 'VIX', 'SPX', 'NDX'];
        const promises = symbols.map(sym =>
            requestPool(async () => {
                const data = await fetchTwelveData('price', { symbol: sym });
                return { symbol: sym, price: parseFloat(data?.price || 0) };
            })
        );
        const results = await Promise.all(promises);
        const map = {};
        results.forEach(r => map[r.symbol] = r.price);

        // Mudanças (aproximadas via quote)
        const changePromises = ['SPX', 'NDX'].map(sym =>
            requestPool(async () => {
                const data = await fetchTwelveData('quote', { symbol: sym });
                return { symbol: sym, change: parseFloat(data?.change || 0) };
            })
        );
        const changeResults = await Promise.all(changePromises);
        const changeMap = {};
        changeResults.forEach(r => changeMap[r.symbol] = r.change);

        const macro = {
            dxy: map.DXY || 0,
            us10y: map.TNX || 0,
            vix: map.VIX || 0,
            spChange: changeMap.SPX || 0,
            nasdaqChange: changeMap.NDX || 0
        };
        setCachedData(cacheKey, macro);
        return macro;
    } catch(e) {
        console.warn('[Macro Twelve Data] falhou:', e);
    }

    if (cached) {
        console.warn('[Macro] Usando cache antigo');
        return cached;
    }
    return { dxy: 0, us10y: 0, vix: 0, spChange: 0, nasdaqChange: 0 };
};

// ===== FETCH FED RATE (corrigido) =====
export const fetchFedRate = async () => {
    const cacheKey = 'fedRate';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) {
        return cached;
    }

    // 1) Twelve Data (opcional)
    try {
        const data = await fetchTwelveData('price', { symbol: 'FEDFUNDS' });
        if (data && data.price) {
            const rate = parseFloat(data.price);
            if (!isNaN(rate) && rate > 0) {
                setCachedData(cacheKey, rate);
                return rate;
            }
        }
    } catch(e) {
        console.warn('[FedRate Twelve Data] falhou:', e);
    }

    // 2) FRED via proxy (corrigido)
    const proxy = 'https://api.allorigins.win/raw?url=';
    const url = proxy + encodeURIComponent('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS');
    try {
        const resp = await fetchWithTimeout(url, {}, 15000);
        if (resp.ok) {
            const csv = await resp.text();
            const lastLine = csv.trim().split('\n').pop();
            const rate = parseFloat(lastLine.split(',')[1]);
            if (!isNaN(rate) && rate > 0) {
                setCachedData(cacheKey, rate);
                return rate;
            }
        }
    } catch(e) {
        console.warn('[FedRate FRED via proxy] falhou:', e);
    }

    if (cached) {
        console.warn('[FedRate] Usando cache antigo');
        return cached;
    }
    console.warn('[FedRate] Todas as tentativas falharam, usando fallback estático (4.33%)');
    const fallback = 4.33;
    setCachedData(cacheKey, fallback);
    return fallback;
};

// ===== DEMAIS FUNÇÕES (mantidas) =====
export const fetchFundingRate = async (symbol) => {
    try {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
        const data = await fetchWithRetry(url);
        if (data && data.length > 0) {
            const rate = parseFloat(data[0].fundingRate);
            let interpretacao = 'EQUILIBRADO';
            if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
            else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
            return { rate, time: data[0].fundingTime, interpretacao };
        }
    } catch(e) { console.warn('[Binance FR]', e); }

    try {
        const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
        const resp = await fetchWithRetry(url);
        if (resp && resp.result && resp.result.list && resp.result.list.length > 0) {
            const item = resp.result.list[0];
            const rate = parseFloat(item.fundingRate);
            let interpretacao = 'EQUILIBRADO';
            if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
            else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
            return { rate, time: parseInt(item.nextFundingTime), interpretacao };
        }
    } catch(e) { console.warn('[Bybit FR]', e); }
    return null;
};

export const fetchOpenInterest = async (symbol) => {
    try {
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=8`;
        const data = await fetchWithRetry(url);
        if (data && data.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[data.length - 1].sumOpenInterest);
            return { oi: curr, delta: ((curr - prev) / prev) * 100 };
        }
    } catch(e) { console.warn('[Binance OI]', e); }

    try {
        const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=8`;
        const resp = await fetchWithRetry(url);
        if (resp && resp.result && resp.result.list && resp.result.list.length >= 2) {
            const list = resp.result.list;
            const curr = parseFloat(list[0].openInterest);
            const prev = parseFloat(list[list.length - 1].openInterest);
            return { oi: curr, delta: ((curr - prev) / prev) * 100 };
        }
    } catch(e) { console.warn('[Bybit OI]', e); }
    return null;
};

export const fetchBasis = async (symbol = 'BTCUSDT') => {
    try {
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
        const data = await fetchWithRetry(url);
        if (data && data.markPrice && data.indexPrice) {
            return ((parseFloat(data.markPrice) - parseFloat(data.indexPrice)) / parseFloat(data.indexPrice)) * 100;
        }
    } catch(e) { console.warn('[Basis]', e); }
    return null;
};

export const fetchOrderBook = async (symbol = 'BTCUSDT', limit = 10) => {
    try {
        const data = await fetchWithRetry(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
        if (!data || !data.bids || !data.asks) return null;
        const bidTotal = data.bids.reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0);
        const askTotal = data.asks.reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0);
        return {
            bids: data.bids.slice(0, 5).map(b => ({ price: +b[0], qty: +b[1] })),
            asks: data.asks.slice(0, 5).map(a => ({ price: +a[0], qty: +a[1] })),
            bidTotal, askTotal,
            imbalance: ((bidTotal - askTotal) / (bidTotal + askTotal) * 100)
        };
    } catch(e) { console.warn('[OrderBook]', e); return null; }
};

export const fetchBlockchairStats = async () => {
    try {
        const [btcResp, ethResp] = await Promise.all([
            fetchWithRetry('https://api.blockchair.com/bitcoin/stats'),
            fetchWithRetry('https://api.blockchair.com/ethereum/stats')
        ]);
        return {
            blockHeight: btcResp?.data?.best_block_height || 0,
            mempoolSize: btcResp?.data?.mempool_total_size || 0,
            activeAddresses: btcResp?.data?.addresses_count_24h || 0,
            ethGas: (ethResp?.data?.gas_price || 0) / 1e9
        };
    } catch(e) { console.warn('[Blockchair]', e); return null; }
};

export const fetchMempoolStats = async () => {
    try {
        const [hashResp, diffResp] = await Promise.all([
            fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1w'),
            fetchWithRetry('https://mempool.space/api/v1/difficulty-adjustment')
        ]);
        return {
            hashrate: hashResp?.hashesPerSecond ? hashResp.hashesPerSecond / 1e18 : 0,
            difficulty: diffResp?.currentDifficulty || 0
        };
    } catch(e) { console.warn('[Mempool]', e); return null; }
};

export const fetchETFData = async () => {
    try {
        const proxy = CONFIG.PROXY_URL;
        const fetchYahooChange = async (ticker) => {
            const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`)}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                const meta = data.chart.result[0].meta;
                return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
            }
            return 0;
        };
        const [btcChange, ethChange] = await Promise.all([fetchYahooChange('IBIT'), fetchYahooChange('ETHA')]);
        return { btcFlow: btcChange, ethFlow: ethChange };
    } catch(e) { console.warn('[ETF]', e); return null; }
};

export const fetchPutCallRatio = async () => {
    try {
        const data = await fetchWithRetry('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
        let putVolume = 0, callVolume = 0;
        if (data.result) {
            data.result.forEach(item => {
                if (item.option_type === 'put') putVolume += item.volume || 0;
                if (item.option_type === 'call') callVolume += item.volume || 0;
            });
        }
        return callVolume > 0 ? putVolume / callVolume : 0;
    } catch(e) { console.warn('[PutCall]', e); return null; }
};

export const fetchDeFiData = async () => {
    try {
        const [stableData, tvlData] = await Promise.all([
            fetchWithRetry('https://stablecoins.llama.fi/stablecoins'),
            fetchWithRetry('https://api.llama.fi/charts')
        ]);
        let totalStable = 0;
        if (stableData.peggedAssets) stableData.peggedAssets.forEach(a => totalStable += a.total || 0);
        let tvl = 0, tvlChange = 0;
        if (tvlData && tvlData.length > 1) {
            tvl = tvlData[tvlData.length-1].totalLiquidityUSD;
            const prev = tvlData[tvlData.length-2].totalLiquidityUSD;
            tvlChange = ((tvl - prev) / prev) * 100;
        }
        return { totalStable: totalStable / 1e9, tvl: tvl / 1e9, tvlChange };
    } catch(e) { console.warn('[DeFi]', e); return null; }
};

export const fetchTetherPremium = async () => {
    const cacheKey = 'tetherPremium';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) {
        return cached;
    }

    try {
        const [cryptoData, fiatData] = await Promise.all([
            fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl'),
            fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
        ]);
        const usdtBrl = cryptoData?.tether?.brl;
        const usdBrl = fiatData?.rates?.BRL;
        if (usdtBrl && usdBrl) {
            const premium = ((usdtBrl / usdBrl) - 1) * 100;
            setCachedData(cacheKey, premium);
            return premium;
        }
    } catch(e) {
        console.warn('[TetherPremium]', e);
    }

    if (cached) {
        console.warn('[TetherPremium] Usando cache antigo');
        return cached;
    }
    console.warn('[TetherPremium] Falhou, retornando 0%');
    return 0;
};

export const fetchFearGreed = async () => {
    try {
        const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1');
        const v = parseInt(data.data[0].value);
        let color = '#ffc107';
        if (v < 25) color = '#ff1744';
        else if (v < 45) color = '#ff9800';
        else if (v < 55) color = '#ffc107';
        else if (v < 75) color = '#8bc34a';
        else color = '#00e676';
        return { value: v, classification: data.data[0].value_classification, color };
    } catch(e) { console.warn('[FearGreed]', e); return null; }
};

// ===== MTF Confluence =====
export async function getMTFConfluence(symbol) {
    const timeframes = ['15m', '1h', '4h'];
    const directions = [];
    for (const tf of timeframes) {
        try {
            const candles = await fetchHistoricalCandles(symbol, tf, 50);
            if (!candles.length) continue;
            const closes = candles.map(c => c.close);
            const ema20 = calcEMA(closes, 20);
            const ema50 = calcEMA(closes, 50);
            const last = candles.length - 1;
            if (ema20[last] > ema50[last] && candles[last].close > ema20[last]) directions.push({ tf, dir: 'BULL' });
            else if (ema20[last] < ema50[last] && candles[last].close < ema20[last]) directions.push({ tf, dir: 'BEAR' });
            else directions.push({ tf, dir: 'NEUTRO' });
        } catch(e) { directions.push({ tf, dir: 'ERROR' }); }
    }
    const bulls = directions.filter(d => d.dir === 'BULL').length;
    const bears = directions.filter(d => d.dir === 'BEAR').length;
    return {
        directions,
        score: bulls - bears,
        confluencia: Math.max(bulls, bears) === 3 ? 'FORTE' : Math.max(bulls, bears) === 2 ? 'MODERADA' : 'FRACA',
        alinhado: Math.max(bulls, bears) >= 2
    };
}
