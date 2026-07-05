// dados_externos.js
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

const BACKEND_URL = CONFIG.BACKEND_URL || 'https://twelvedata-backend.onrender.com';

// ===== HELPERS (fallback local) =====
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

// ===== CACHE LOCAL =====
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

// ===== FUNÇÕES QUE USAM O BACKEND =====

export async function fetchHistoricalCandles(symbol, interval, limit = 100) {
    const cacheKey = `candles_${symbol}_${interval}_${limit}`;
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) {
        return cached;
    }

    try {
        const resp = await fetch(
            `${BACKEND_URL}/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data && data.length > 0) {
            setCachedData(cacheKey, data);
            return data;
        }
    } catch(e) {
        console.warn('[Backend] Candles falhou, usando fallback local:', e);
    }

    // Fallback local: Binance via proxy
    try {
        const proxy = CONFIG.PROXY_URL || 'https://corsproxy.io/?url=';
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await fetchWithRetry(proxy + encodeURIComponent(url), {}, 2);
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
        console.warn('[Fallback] Binance falhou:', e);
    }

    if (cached) return cached;
    return [];
}

export async function fetchMacroStatic() {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const resp = await fetch(`${BACKEND_URL}/api/macro`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        setCachedData(cacheKey, data);
        return data;
    } catch(e) {
        console.warn('[Backend] Macro falhou:', e);
        // Fallback: Yahoo via proxy
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
        } catch(e2) {
            console.warn('[Macro fallback] falhou:', e2);
            if (cached) return cached;
            return { dxy: 0, us10y: 0, vix: 0, spChange: 0, nasdaqChange: 0 };
        }
    }
}

export async function fetchFedRate() {
    const cacheKey = 'fedRate';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

    try {
        const resp = await fetch(`${BACKEND_URL}/api/fedrate`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data && data.rate) {
            setCachedData(cacheKey, data.rate);
            return data.rate;
        }
    } catch(e) {
        console.warn('[Backend] FedRate falhou:', e);
    }

    // Fallback estático
    if (cached) return cached;
    console.warn('[FedRate] Usando fallback estático 4.33%');
    return 4.33;
}

export async function fetchFundingRate(symbol) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/funding?symbol=${symbol}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch(e) {
        console.warn('[Backend] Funding falhou:', e);
        // Fallback: Binance direta
        try {
            const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
            const data = await fetchWithRetry(url);
            if (data && data.length > 0) {
                const rate = parseFloat(data[0].fundingRate);
                let interpretacao = 'EQUILIBRADO';
                if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
                else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
                return { rate, interpretacao };
            }
        } catch(e2) { /* ignora */ }
        return null;
    }
}

export async function fetchOrderBook(symbol, limit = 10) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/orderbook?symbol=${symbol}&limit=${limit}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch(e) {
        console.warn('[Backend] OrderBook falhou:', e);
        // Fallback: Binance direta
        try {
            const data = await fetchWithRetry(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
            if (data && data.bids && data.asks) {
                const bidTotal = data.bids.reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0);
                const askTotal = data.asks.reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0);
                return {
                    bids: data.bids.slice(0, 5).map(b => ({ price: +b[0], qty: +b[1] })),
                    asks: data.asks.slice(0, 5).map(a => ({ price: +a[0], qty: +a[1] })),
                    bidTotal, askTotal,
                    imbalance: ((bidTotal - askTotal) / (bidTotal + askTotal) * 100)
                };
            }
        } catch(e2) { /* ignora */ }
        return null;
    }
}

// ===== FUNÇÕES LOCAIS (não cobertas pelo backend) =====

export async function fetchFearGreed() {
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
}

export async function fetchBlockchairStats() {
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
}

export async function fetchMempoolStats() {
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
}

export async function fetchETFData() {
    try {
        const proxy = CONFIG.PROXY_URL || 'https://corsproxy.io/?url=';
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
}

export async function fetchPutCallRatio() {
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
}

export async function fetchDeFiData() {
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
}

export async function fetchTetherPremium() {
    const cacheKey = 'tetherPremium';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

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
    } catch(e) { console.warn('[TetherPremium]', e); }

    if (cached) return cached;
    return 0;
}

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

// ===== AUXILIAR =====
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
