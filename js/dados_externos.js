// js/dados_externos.js – completo com fallbacks
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

// ===== HELPERS =====
export function fetchWithTimeout(url, options = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const id = setTimeout(() => { controller.abort(); reject(new Error(`Timeout: ${url}`)); }, timeout);
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

export async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES || 2) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetchWithTimeout(url, options, 15000);
            if (resp.status === 429) {
                const wait = 1000 * Math.pow(2, i) + 500 + Math.random() * 200;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            try { return JSON.parse(text); } catch(e) { return text; }
        } catch(e) {
            lastError = e;
            if (i === retries - 1) break;
            const wait = CONFIG.RETRY_DELAY_MS * Math.pow(2, i) + 500 + Math.random() * 300;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastError || new Error(`Falha ao buscar ${url}`);
}

// ===== CACHE =====
function getCachedData(key, maxAge = CONFIG.CACHE_TTL_MS) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const age = Date.now() - parsed.timestamp;
        if (age < maxAge) return parsed.data;
        if (age < CONFIG.STALE_CACHE_TTL_MS || age < 3600000) return { data: parsed.data, stale: true };
        return null;
    } catch(e) { return null; }
}

function setCachedData(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() })); } catch(e) { /* ignore */ }
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 1. ETH GAS PRICE
// ============================================================
export const fetchEthGasPrice = async () => {
    const cacheKey = 'ethGas';
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const resp = await fetchWithRetry('https://ethereum.publicnode.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })
        }, 2);
        if (resp && resp.result) {
            const gwei = parseInt(resp.result, 16) / 1e9;
            setCachedData(cacheKey, gwei);
            return gwei;
        }
    } catch (e) { /* silencioso */ }

    try {
        const url = `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
        const data = await fetchWithRetry(url, {}, 2);
        if (data && data.status === '1' && data.result) {
            const gasPrice = parseFloat(data.result.ProposeGasPrice);
            setCachedData(cacheKey, gasPrice);
            return gasPrice;
        }
    } catch (e) { /* silencioso */ }
    if (cached) return cached;
    return 5;
};

// ============================================================
// 2. MACRO – Alpha Vantage + Yahoo fallback
// ============================================================
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    const apiKey = CONFIG.ALPHAVANTAGE_API_KEY;
    if (!apiKey) {
        console.warn('[Macro] Alpha Vantage API key não configurada. Usando fallback.');
        if (cached) return cached;
        return { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
    }

    try {
        const symbols = ['DXY', 'DGS10', 'VIX', 'SPX', 'NDX'];
        
        const fetchSymbol = async (symbol) => {
            await sleep(300);
            return await fetchWithRetry(
                `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`,
                {},
                2
            );
        };

        const results = await Promise.all(symbols.map(s => fetchSymbol(s)));

        const parseQuote = (data, defaultVal) => {
            try {
                const val = data?.['Global Quote']?.['05. price'];
                return val !== undefined && val !== null ? parseFloat(val) : defaultVal;
            } catch(e) { return defaultVal; }
        };

        const parseChange = (data, defaultVal) => {
            try {
                const val = data?.['Global Quote']?.['10. change percent'];
                if (val) return parseFloat(val.replace('%', ''));
                return defaultVal;
            } catch(e) { return defaultVal; }
        };

        const macro = {
            dxy: parseQuote(results[0], 101.5),
            us10y: parseQuote(results[1], 4.28),
            vix: parseQuote(results[2], 20.5),
            spChange: parseChange(results[3], -0.5),
            nasdaqChange: parseChange(results[4], -0.8)
        };

        // Se todos os valores vierem com fallback, tenta Yahoo
        if (macro.dxy === 101.5 && macro.us10y === 4.28 && macro.vix === 20.5) {
            throw new Error('Alpha Vantage retornou dados inválidos, tentando Yahoo...');
        }

        setCachedData(cacheKey, macro);
        return macro;
    } catch (e) {
        console.warn('[Macro] Alpha Vantage falhou, tentando Yahoo via proxy:', e);
        try {
            // Yahoo Finance via proxy (corsproxy.io)
            const fetchYahoo = async (ticker) => {
                const data = await fetchViaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`, 2);
                if (data?.chart?.result?.[0]?.meta) {
                    const meta = data.chart.result[0].meta;
                    return { current: meta.regularMarketPrice, change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 };
                }
                return null;
            };
            const [dxy, us10y, vix, sp, nasdaq] = await Promise.all([
                fetchYahoo('DX-Y.NYB'), fetchYahoo('^TNX'), fetchYahoo('^VIX'), fetchYahoo('^GSPC'), fetchYahoo('^NDX')
            ]);
            const macro = {
                dxy: dxy?.current || 101.5,
                us10y: us10y?.current || 4.28,
                vix: vix?.current || 20.5,
                spChange: sp?.change || -0.5,
                nasdaqChange: nasdaq?.change || -0.8
            };
            setCachedData(cacheKey, macro);
            return macro;
        } catch(e2) {
            console.warn('[Macro] Yahoo também falhou, usando cache ou estático:', e2);
            if (cached) return cached;
            return { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
        }
    }
};

// Proxy CORS (reutilizado)
async function fetchViaProxy(targetUrl, retries = 2) {
    const primary = `${CONFIG.PROXY_URL}${encodeURIComponent(targetUrl)}`;
    try {
        return await fetchWithRetry(primary, {}, retries);
    } catch (e) {
        console.warn('[Proxy] Primário (corsproxy.io) falhou, tentando fallback (allorigins.win):', e);
        const fallback = `${CONFIG.PROXY_FALLBACK}${encodeURIComponent(targetUrl)}`;
        try {
            return await fetchWithRetry(fallback, {}, retries);
        } catch(e2) {
            console.warn('[Proxy] Fallback (allorigins.win) também falhou:', e2);
            throw e2;
        }
    }
}

// ============================================================
// 3. FED RATE (Alpha Vantage)
// ============================================================
export const fetchFedRate = async () => {
    const cacheKey = 'fedRate';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

    try {
        const url = `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${CONFIG.ALPHAVANTAGE_API_KEY}`;
        const data = await fetchWithRetry(url, {}, 2);
        if (data?.data?.[0]?.value) {
            const rate = parseFloat(data.data[0].value);
            setCachedData(cacheKey, rate);
            return rate;
        }
    } catch (e) { /* silencioso */ }
    if (cached) return cached;
    return 4.33;
};

// ============================================================
// 4. ON-CHAIN – MVRV, Active Addresses, Hashrate
// ============================================================
const CM_BASE = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';

function fetchCM(metric) {
    return async () => {
        const cacheKey = `cm_${metric}`;
        const cached = getCachedData(cacheKey, 300000);
        if (cached && !cached.stale) return cached;

        try {
            const url = `${CM_BASE}?assets=btc&metrics=${metric}&frequency=1d&page_size=1`;
            const data = await fetchWithRetry(url, {}, 2);
            const val = data?.data?.[0]?.[metric];
            if (val !== undefined && val !== null) {
                const num = parseFloat(val);
                setCachedData(cacheKey, num);
                return num;
            }
            return null;
        } catch (e) {
            if (cached) return cached;
            return null;
        }
    };
}

export const fetchMVRV = fetchCM('CapMVRVCur');
export const fetchCQActiveAddresses = fetchCM('AdrActCnt');

export const fetchHashrate = async () => {
    const cacheKey = 'hashrate';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1d', {}, 2);
        if (data?.avgHashrate) {
            const hashrate = parseFloat(data.avgHashrate);
            setCachedData(cacheKey, hashrate);
            return hashrate;
        }
    } catch (e) { /* silencioso */ }

    try {
        const url = `${CM_BASE}?assets=btc&metrics=HashRate&frequency=1d&page_size=1`;
        const data = await fetchWithRetry(url, {}, 2);
        const val = data?.data?.[0]?.HashRate;
        if (val !== undefined && val !== null) {
            const num = parseFloat(val);
            setCachedData(cacheKey, num);
            return num;
        }
    } catch (e) { /* silencioso */ }

    if (cached) return cached;
    return null;
};

// ============================================================
// 5. BLOCKCHAIR (fallback para Active Addresses)
// ============================================================
export const fetchBlockchairStats = async () => {
    try {
        const btc = await fetchWithRetry('https://api.blockchair.com/bitcoin/stats', {}, 2);
        return {
            blockHeight: btc?.data?.best_block_height || 0,
            mempoolSize: btc?.data?.mempool_total_size || 0,
            activeAddresses: btc?.data?.addresses_count_24h || 0
        };
    } catch(e) { return null; }
};

// ============================================================
// 6. OI Delta (Binance)
// ============================================================
export const fetchOIDelta = async (symbol = 'BTCUSDT') => {
    const cacheKey = `oi_delta_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const currData = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=1`);
        const currOi = currData?.length ? parseFloat(currData[0].sumOpenInterest) : 0;

        const histData = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=97`);
        if (histData?.length >= 97) {
            const pastOi = parseFloat(histData[histData.length - 97].sumOpenInterest);
            const delta = pastOi > 0 ? ((currOi - pastOi) / pastOi) * 100 : 0;
            const result = { oi: currOi, delta };
            setCachedData(cacheKey, result);
            return result;
        }
        return null;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 7. Put/Call Ratio (Deribit)
// ============================================================
export const fetchPutCallRatio = async () => {
    const cacheKey = 'pcr';
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
        let putVolume = 0, callVolume = 0;
        data?.result?.forEach(item => {
            if (item.option_type === 'put') putVolume += item.volume || 0;
            if (item.option_type === 'call') callVolume += item.volume || 0;
        });
        const ratio = callVolume > 0 ? putVolume / callVolume : 0;
        setCachedData(cacheKey, ratio);
        return ratio;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 8. Basis (perp vs spot) – Binance + fallback Bybit
// ============================================================
export const fetchBasis = async (symbol = 'BTCUSDT') => {
    const cacheKey = `basis_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    // 1) Tenta Binance
    try {
        const [perp, spot] = await Promise.all([
            fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {}, 2),
            fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {}, 2)
        ]);
        if (perp?.markPrice && spot?.price) {
            const mark = parseFloat(perp.markPrice);
            const spotPrice = parseFloat(spot.price);
            if (spotPrice > 0) {
                const basis = ((mark - spotPrice) / spotPrice) * 100;
                setCachedData(cacheKey, basis);
                return basis;
            }
        }
    } catch (e) { /* silencioso */ }

    // 2) Fallback: Bybit
    try {
        const bybitSymbol = symbol.replace('USDT', '');
        const [perp, spot] = await Promise.all([
            fetchWithRetry(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${bybitSymbol}USDT`, {}, 2),
            fetchWithRetry(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${bybitSymbol}USDT`, {}, 2)
        ]);
        const perpPrice = parseFloat(perp?.result?.list?.[0]?.markPrice);
        const spotPrice = parseFloat(spot?.result?.list?.[0]?.lastPrice);
        if (perpPrice && spotPrice && spotPrice > 0) {
            const basis = ((perpPrice - spotPrice) / spotPrice) * 100;
            setCachedData(cacheKey, basis);
            return basis;
        }
    } catch (e) { /* silencioso */ }

    if (cached) return cached;
    return null;
};

// ============================================================
// 9. Demais funções (Binance, DeFi, etc.)
// ============================================================
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

let _currentPrices = { 'BTCUSDT':0,'ETHUSDT':0,'SOLUSDT':0 };
export function setCurrentPrice(symbol, price) { _currentPrices[symbol] = price; }
export function getCurrentPrice(symbol) { return _currentPrices[symbol] || 0; }

export async function fetchHistoricalCandles(symbol, interval, limit = 100) {
    const cacheKey = `candles_${symbol}_${interval}_${limit}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await fetchWithRetry(url, {}, 3);
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
    } catch(e) { /* ignore */ }

    try {
        const map = { '15m':'15','1h':'60','4h':'240','1d':'D' };
        const bybitInterval = map[interval] || '60';
        const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
        const resp = await fetchWithRetry(url, {}, 2);
        if (resp?.result?.list?.length) {
            const candles = resp.result.list.reverse().map(k => ({
                time: parseInt(k[0])/1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            setCachedData(cacheKey, candles);
            return candles;
        }
    } catch(e) { /* ignore */ }

    try {
        const coinId = SYMBOL_TO_COINGECKO[symbol];
        if (coinId) {
            const minutes = TIMEFRAME_TO_MINUTES[interval] || 60;
            let days = Math.ceil((limit * minutes) / 1440) + 1;
            days = Math.min(Math.max(days, 1), 90);
            const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.length > 0) {
                const candles = data.map(k => ({
                    time: k[0]/1000,
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: 0
                })).slice(-limit);
                setCachedData(cacheKey, candles);
                return candles;
            }
        }
    } catch(e) { /* ignore */ }

    if (cached) return cached;
    return [];
}

export const fetchFundingRate = async (symbol) => {
    const cacheKey = `funding_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
        if (data?.length) {
            const rate = parseFloat(data[0].fundingRate);
            let interpretacao = 'EQUILIBRADO';
            if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
            else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
            const result = { rate, interpretacao };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return null;
};

export const fetchOpenInterest = async (symbol) => {
    const cacheKey = `oi_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=8`);
        if (data?.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[data.length-1].sumOpenInterest);
            const result = { oi: curr, delta: ((curr - prev) / prev) * 100 };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return null;
};

export const fetchOrderBook = async (symbol = 'BTCUSDT', limit =
