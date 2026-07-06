// dados_externos.js – COMPLETO (CryptoQuant + FRED + Etherscan + fallbacks)
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

const BACKEND_URL = CONFIG.BACKEND_URL || 'https://twelvedata-backend.onrender.com';

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

// ===== PROXY COM FALLBACK REAL =====
export async function fetchViaProxy(targetUrl, retries = 2) {
    const primary = `${CONFIG.PROXY_URL}${encodeURIComponent(targetUrl)}`;
    try {
        return await fetchWithRetry(primary, {}, retries);
    } catch (e) {
        console.warn('[Proxy] Primário (corsproxy.io) falhou, tentando fallback (allorigins.win):', e);
        const fallback = `${CONFIG.PROXY_FALLBACK}${encodeURIComponent(targetUrl)}`;
        return await fetchWithRetry(fallback, {}, retries);
    }
}

// ===== STATUS DO BACKEND =====
let _backendStatus = 'checking';
export function getBackendStatus() { return _backendStatus; }
export function setBackendStatus(status) { _backendStatus = status; }

// ===== WARM-UP DO BACKEND =====
export async function warmupBackend() {
    setBackendStatus('checking');
    try {
        await fetchWithTimeout(`${BACKEND_URL}/`, {}, 5000);
        setBackendStatus('online');
        return true;
    } catch (e) {
        console.warn('[Backend] Warm-up falhou (Render pode estar dormindo):', e);
        setBackendStatus('sleeping');
        return false;
    }
}

// ===== CRYPTOQUANT (com cache) =====
const CQ_API_KEY = CONFIG.CRYPTOQUANT_API_KEY;
const CQ_BASE = 'https://api.cryptoquant.com/v1';

async function fetchCryptoQuant(endpoint, params = {}) {
    const url = new URL(`${CQ_BASE}${endpoint}`);
    url.searchParams.set('limit', '1');
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${CQ_API_KEY}` }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${resp.statusText}`);
    const data = await resp.json();
    return data && data.length > 0 ? data[0] : null;
}

function fetchCQWithCache(endpoint, cacheKey, maxAge = 300000) {
    return async () => {
        const cached = getCachedData(cacheKey, maxAge);
        if (cached && !cached.stale) return cached;
        try {
            const result = await fetchCryptoQuant(endpoint);
            if (result && result.value !== undefined) {
                const val = parseFloat(result.value);
                setCachedData(cacheKey, val);
                return val;
            }
            return null;
        } catch(e) {
            console.warn(`[CryptoQuant] ${cacheKey} falhou:`, e);
            if (cached) return cached;
            return null;
        }
    };
}

export const fetchMVRV = fetchCQWithCache('/btc/market-indicator/mvrv', 'cq_mvrv');
export const fetchSOPR = fetchCQWithCache('/btc/market-indicator/sopr', 'cq_sopr');
export const fetchASOPR = fetchCQWithCache('/btc/market-indicator/asopr', 'cq_asopr');
export const fetchRealizedPrice = fetchCQWithCache('/btc/network-data/realized-price', 'cq_realized_price');
export const fetchExchangeNetflow = fetchCQWithCache('/btc/exchange-flows/netflow', 'cq_netflow');
export const fetchMinerOutflow = fetchCQWithCache('/btc/miner-flows/outflow', 'cq_miner_outflow');
export const fetchCQActiveAddresses = fetchCQWithCache('/btc/network-data/active-addresses', 'cq_active_addresses');
export const fetchCQDifficulty = fetchCQWithCache('/btc/network-data/difficulty', 'cq_difficulty');
export const fetchCQHashrate = fetchCQWithCache('/btc/network-data/hashrate', 'cq_hashrate');

// ===== FRED API HELPER =====
async function fetchFREDSeries(seriesId, limit = 1) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${CONFIG.FRED_API_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
    const resp = await fetchWithTimeout(url, {}, 10000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.observations && data.observations.length > 0) {
        const latest = data.observations[0];
        return latest.value ? parseFloat(latest.value) : null;
    }
    return null;
}

function fetchFREDWithCache(seriesId, cacheKey, maxAge = 300000) {
    return async () => {
        const cached = getCachedData(cacheKey, maxAge);
        if (cached && !cached.stale) return cached;
        try {
            const val = await fetchFREDSeries(seriesId);
            if (val !== null) {
                setCachedData(cacheKey, val);
                return val;
            }
        } catch(e) { console.warn(`[FRED] ${cacheKey} falhou:`, e); }
        if (cached) return cached;
        return null;
    };
}

export const fetchFREDVIX = fetchFREDWithCache('VIXCLS', 'fred_vix');
export const fetchFREDUS10Y = fetchFREDWithCache('DGS10', 'fred_us10y');
export const fetchFREDDXY = fetchFREDWithCache('DTWEXBGS', 'fred_dxy');

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

// ===== FETCH MACRO (FRED primário, Yahoo fallback) =====
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    // 1) FRED
    try {
        const [dxy, us10y, vix] = await Promise.all([
            fetchFREDDXY(),
            fetchFREDUS10Y(),
            fetchFREDVIX()
        ]);
        const macro = {
            dxy: dxy || 0,
            us10y: us10y || 0,
            vix: vix || 0,
            spChange: 0,
            nasdaqChange: 0
        };
        // Yahoo para changes
        try {
            const fetchYahooChange = async (ticker) => {
                const data = await fetchViaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`, 2);
                if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                    const meta = data.chart.result[0].meta;
                    return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
                }
                return 0;
            };
            const [spChange, nasdaqChange] = await Promise.all([
                fetchYahooChange('^GSPC'),
                fetchYahooChange('^NDX')
            ]);
            macro.spChange = spChange || 0;
            macro.nasdaqChange = nasdaqChange || 0;
        } catch(e) { /* ignora */ }
        setCachedData(cacheKey, macro);
        return macro;
    } catch(e) {
        console.warn('[Macro FRED] falhou, tentando Yahoo fallback...', e);
    }

    // 2) Yahoo fallback
    try {
        const fetchYahoo = async (ticker) => {
            const data = await fetchViaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`, 2);
            if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                const meta = data.chart.result[0].meta;
                return { current: meta.regularMarketPrice, change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 };
            }
            return null;
        };
        const [dxy, us10y, vix, sp, nasdaq] = await Promise.all([
            fetchYahoo('DX-Y.NYB'),
            fetchYahoo('^TNX'),
            fetchYahoo('^VIX'),
            fetchYahoo('^GSPC'),
            fetchYahoo('^NDX')
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
        console.warn('[Macro Yahoo] falhou:', e);
        if (cached) return cached;
        return { dxy: 0, us10y: 0, vix: 0, spChange: 0, nasdaqChange: 0 };
    }
};

// ===== FED RATE (FRED API) =====
export const fetchFedRate = async () => {
    const cacheKey = 'fedRate';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

    try {
        const val = await fetchFREDSeries('FEDFUNDS');
        if (val !== null) {
            setCachedData(cacheKey, val);
            return val;
        }
    } catch(e) { console.warn('[FRED FedRate] falhou:', e); }

    // Fallback CSV via proxy
    try {
        const csv = await fetchViaProxy('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS', 2);
        if (csv && typeof csv === 'string') {
            const lastLine = csv.trim().split('\n').pop();
            const rate = parseFloat(lastLine.split(',')[1]);
            if (!isNaN(rate) && rate > 0) {
                setCachedData(cacheKey, rate);
                return rate;
            }
        }
    } catch(e) { console.warn('[FRED CSV fallback] falhou:', e); }

    if (cached) return cached;
    return 4.33;
};

// ===== ETH GAS (Etherscan) =====
export const fetchEthGasPrice = async () => {
    const cacheKey = 'ethGas';
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const url = `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
        const resp = await fetchWithTimeout(url, {}, 10000);
        if (resp.ok) {
            const data = await resp.json();
            if (data.status === '1' && data.result) {
                const gasPrice = parseFloat(data.result.ProposeGasPrice) / 10;
                setCachedData(cacheKey, gasPrice);
                return gasPrice;
            }
        }
    } catch(e) { console.warn('[Etherscan] falhou:', e); }

    if (cached) return cached;
    return 5;
};

// ===== FETCH CANDLES =====
export async function fetchHistoricalCandles(symbol, interval, limit = 100) {
    const cacheKey = `candles_${symbol}_${interval}_${limit}`;
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    // 1) Backend
    try {
        const resp = await fetch(`${BACKEND_URL}/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data && data.length > 0) {
                setBackendStatus('online');
                setCachedData(cacheKey, data);
                return data;
            }
        }
    } catch(e) { setBackendStatus('sleeping'); }

    // 2) Binance
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

    // 3) CoinGecko
    try {
        const coinId = { 'BTCUSDT':'bitcoin','ETHUSDT':'ethereum','SOLUSDT':'solana' }[symbol];
        if (coinId) {
            const minutes = { '15m':15,'1h':60,'4h':240,'1d':1440 }[interval] || 60;
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

    // 4) Bybit
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

    if (cached) return cached;
    return [];
}

// ===== DEMAIS FUNÇÕES (mantidas) =====
export const fetchFundingRate = async (symbol) => {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
        if (data?.length) {
            const rate = parseFloat(data[0].fundingRate);
            let interpretacao = 'EQUILIBRADO';
            if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
            else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
            return { rate, interpretacao };
        }
    } catch(e) { /* ignore */ }
    return null;
};

export const fetchOpenInterest = async (symbol) => {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=8`);
        if (data?.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[data.length-1].sumOpenInterest);
            return { oi: curr, delta: ((curr - prev) / prev) * 100 };
        }
    } catch(e) { /* ignore */ }
    return null;
};

export const fetchBasis = async (symbol = 'BTCUSDT') => {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (data?.markPrice && data?.indexPrice) {
            return ((parseFloat(data.markPrice) - parseFloat(data.indexPrice)) / parseFloat(data.indexPrice)) * 100;
        }
    } catch(e) { /* ignore */ }
    return null;
};

export const fetchOrderBook = async (symbol = 'BTCUSDT', limit = 10) => {
    try {
        const data = await fetchWithRetry(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
        if (data?.bids && data?.asks) {
            const bidTotal = data.bids.reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0);
            const askTotal = data.asks.reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0);
            return {
                bids: data.bids.slice(0,5).map(b => ({ price: +b[0], qty: +b[1] })),
                asks: data.asks.slice(0,5).map(a => ({ price: +a[0], qty: +a[1] })),
                bidTotal, askTotal,
                imbalance: ((bidTotal - askTotal) / (bidTotal + askTotal) * 100)
            };
        }
    } catch(e) { /* ignore */ }
    return null;
};

export const fetchBlockchairStats = async () => {
    try {
        const btc = await fetchWithRetry('https://api.blockchair.com/bitcoin/stats');
        return {
            blockHeight: btc?.data?.best_block_height || 0,
            mempoolSize: btc?.data?.mempool_total_size || 0,
            activeAddresses: btc?.data?.addresses_count_24h || 0
        };
    } catch(e) { return null; }
};

export const fetchETFData = async () => {
    try {
        const fetchYahoo = async (ticker) => {
            const data = await fetchViaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`, 2);
            if (data?.chart?.result?.[0]?.meta) {
                const meta = data.chart.result[0].meta;
                return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
            }
            return 0;
        };
        const [btc, eth] = await Promise.all([fetchYahoo('IBIT'), fetchYahoo('ETHA')]);
        return { btcFlow: btc, ethFlow: eth };
    } catch(e) { return null; }
};

export const fetchPutCallRatio = async () => {
    try {
        const data = await fetchWithRetry('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
        let put=0, call=0;
        data?.result?.forEach(item => {
            if (item.option_type === 'put') put += item.volume || 0;
            if (item.option_type === 'call') call += item.volume || 0;
        });
        return call > 0 ? put / call : 0;
    } catch(e) { return null; }
};

export const fetchDeFiData = async () => {
    try {
        const [stable, tvl] = await Promise.all([
            fetchWithRetry('https://stablecoins.llama.fi/stablecoins'),
            fetchWithRetry('https://api.llama.fi/charts')
        ]);
        let total = 0;
        stable?.peggedAssets?.forEach(a => total += a.total || 0);
        let tvlVal = 0, tvlChange = 0;
        if (tvl?.length > 1) {
            tvlVal = tvl[tvl.length-1].totalLiquidityUSD;
            const prev = tvl[tvl.length-2].totalLiquidityUSD;
            tvlChange = ((tvlVal - prev) / prev) * 100;
        }
        return { totalStable: total/1e9, tvl: tvlVal/1e9, tvlChange };
    } catch(e) { return null; }
};

export const fetchTetherPremium = async () => {
    const cacheKey = 'tetherPremium';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;
    try {
        const [crypto, fiat] = await Promise.all([
            fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl'),
            fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
        ]);
        const usdtBrl = crypto?.tether?.brl;
        const usdBrl = fiat?.rates?.BRL;
        if (usdtBrl && usdBrl) {
            const premium = ((usdtBrl / usdBrl) - 1) * 100;
            setCachedData(cacheKey, premium);
            return premium;
        }
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return 0;
};

export const fetchFearGreed = async () => {
    try {
        const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1');
        const v = parseInt(data.data[0].value);
        const color = v < 25 ? '#ff1744' : v < 45 ? '#ff9800' : v < 55 ? '#ffc107' : v < 75 ? '#8bc34a' : '#00e676';
        return { value: v, classification: data.data[0].value_classification, color };
    } catch(e) { return null; }
};

export async function getMTFConfluence(symbol) {
    const timeframes = ['15m','1h','4h'];
    const directions = [];
    for (const tf of timeframes) {
        const candles = await fetchHistoricalCandles(symbol, tf, 50);
        if (!candles.length) continue;
        const closes = candles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        const last = candles.length - 1;
        if (ema20[last] > ema50[last] && candles[last].close > ema20[last]) directions.push({ tf, dir: 'BULL' });
        else if (ema20[last] < ema50[last] && candles[last].close < ema20[last]) directions.push({ tf, dir: 'BEAR' });
        else directions.push({ tf, dir: 'NEUTRO' });
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

// ===== EXPORTS ADICIONAIS =====
export let _currentPrices = { 'BTCUSDT':0,'ETHUSDT':0,'SOLUSDT':0 };
export function setCurrentPrice(symbol, price) { _currentPrices[symbol] = price; }
export function getCurrentPrice(symbol) { return _currentPrices[symbol] || 0; }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
