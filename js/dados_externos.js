// js/dados_externos.js – Com todas as correções P0 a P4 + rodada 3
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

// ============================================================
// 0. HELPER: fetchViaProxy com retry e jitter
// ============================================================
const PROXY_LIST = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://thingproxy.freeboard.io/fetch/'
];
async function fetchFRED(id) {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2025-01-01`;
    try {
        const csv = await fetchViaProxy(url, {}, 2);
        if (typeof csv === 'string') {
            const lines = csv.trim().split('\n');
            if (lines.length < 2) return null;
            const lastLine = lines[lines.length - 1];
            const parts = lastLine.split(',');
            if (parts.length < 2) return null;
            const val = parseFloat(parts[1]);
            return isNaN(val) ? null : val;
        }
        return null;
    } catch(e) {
        return null;
    }
}
async function fetchViaProxy(url, options = {}, retries = 2) {
    // Tenta diretamente primeiro
    try {
        const resp = await fetchWithTimeout(url, options, 10000);
        if (resp.ok) {
            const text = await resp.text();
            try { return JSON.parse(text); } catch(e) { return text; }
        }
    } catch (e) { /* continua para proxies */ }

    // Tenta cada proxy em sequência com jitter
    for (let attempt = 0; attempt < retries; attempt++) {
        for (const proxy of PROXY_LIST) {
            const proxyUrl = proxy + encodeURIComponent(url);
            try {
                const resp = await fetchWithTimeout(proxyUrl, options, 15000);
                if (resp.ok) {
                    const text = await resp.text();
                    try { return JSON.parse(text); } catch(e) { return text; }
                }
            } catch (e) { 
                // Jitter antes de tentar próximo proxy
                await sleep(200 + Math.random() * 300);
            }
        }
    }
    throw new Error(`Falha ao buscar ${url} após tentar todos os proxies`);
}

// ============================================================
// HELPERS EXISTENTES
// ============================================================
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
            const wait = (CONFIG.RETRY_DELAY_MS || 1000) * Math.pow(2, i) + 500 + Math.random() * 300;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastError || new Error(`Falha ao buscar ${url}`);
}

// ===== CACHE COM STALE-WHILE-REVALIDATE + localStorage (P3 melhorado) =====
const CACHE = new Map();

function getCachedData(key, maxAge = CONFIG.CACHE_TTL_MS) {
    // Primeiro tenta cache em memória
    const memEntry = CACHE.get(key);
    if (memEntry) {
        const age = Date.now() - memEntry.timestamp;
        if (age < maxAge) return memEntry.data;
        if (age < (CONFIG.STALE_CACHE_TTL_MS || 3600000)) return { data: memEntry.data, stale: true };
    }
    // Fallback para localStorage
    try {
        const raw = localStorage.getItem(`cache_${key}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const age = Date.now() - parsed.timestamp;
        if (age < maxAge) return parsed.data;
        if (age < (CONFIG.STALE_CACHE_TTL_MS || 3600000)) return { data: parsed.data, stale: true };
    } catch(e) { /* ignore */ }
    return null;
}

function setCachedData(key, data) {
    const entry = { data, timestamp: Date.now() };
    CACHE.set(key, entry);
    // Persiste também em localStorage (se não for muito grande)
    try {
        const str = JSON.stringify(entry);
        if (str.length < 500000) { // 500KB limite
            localStorage.setItem(`cache_${key}`, str);
        }
    } catch(e) { /* localStorage cheio ou indisponível */ }
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 1. ETH GAS PRICE — CORREÇÃO #7 (fallback sem API key)
// ============================================================
export const fetchEthGasPrice = async () => {
    const cacheKey = 'ethGas';
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    // Tenta Etherscan se tiver API key
    if (CONFIG.ETHERSCAN_API_KEY) {
        try {
            const url = `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.status === '1' && data.result) {
                const gasPrice = parseFloat(data.result.ProposeGasPrice);
                setCachedData(cacheKey, gasPrice);
                return gasPrice;
            }
        } catch(e) { /* fallback */ }
    }

    // Fallback: Blockchair via proxy (sem API key necessária)
    try {
        const data = await fetchViaProxy('https://api.blockchair.com/ethereum/stats', {}, 2);
        if (data?.data?.gas_price) {
            const gwei = parseFloat(data.data.gas_price) / 1e9;
            setCachedData(cacheKey, gwei);
            return gwei;
        }
    } catch(e) { /* silencioso */ }

    // Último fallback: gas station pública
    try {
        const data = await fetchWithRetry('https://ethgasstation.info/api/ethgasAPI.json', {}, 2);
        if (data?.average) {
            const gwei = data.average / 10; // ethgasstation retorna em Gwei*10
            setCachedData(cacheKey, gwei);
            return gwei;
        }
    } catch(e) { /* silencioso */ }

    if (cached) return cached;
    return 5; // fallback estático
};

// ============================================================
// 2. MACRO — CORREÇÃO #7 (funciona sem Alpha Vantage key)
// ============================================================
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    let macro = {
        dxy: null,
        us10y: null,
        vix: null,
        spChange: null,
        nasdaqChange: null
    };

    // 1. Tenta Alpha Vantage (se tiver chave)
    if (CONFIG.ALPHAVANTAGE_API_KEY) {
        try {
            const symbols = ['DXY', 'DGS10', 'VIX', 'SPX', 'NDX'];
            const fetchSymbol = async (symbol) => {
                await sleep(300);
                const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${CONFIG.ALPHAVANTAGE_API_KEY}`;
                return await fetchWithRetry(url, {}, 2);
            };
            const results = await Promise.all(symbols.map(s => fetchSymbol(s)));

            const parseQuote = (data) => {
                const val = data?.['Global Quote']?.['05. price'];
                return val !== undefined && val !== null ? parseFloat(val) : null;
            };
            const parseChange = (data) => {
                const val = data?.['Global Quote']?.['10. change percent'];
                if (val) {
                    const num = parseFloat(val.replace('%', ''));
                    return isNaN(num) ? null : num;
                }
                return null;
            };

            macro.dxy = parseQuote(results[0]);
            macro.us10y = parseQuote(results[1]);
            macro.vix = parseQuote(results[2]);
            macro.spChange = parseChange(results[3]);
            macro.nasdaqChange = parseChange(results[4]);

            // Se pelo menos DXY ou US10Y vieram, consideramos sucesso e retornamos (não precisa do FRED)
            if (macro.dxy !== null || macro.us10y !== null) {
                setCachedData(cacheKey, macro);
                return macro;
            }
        } catch (e) {
            console.warn('[Macro] Alpha Vantage falhou:', e.message);
        }
    }

    // 2. Se Alpha Vantage não retornou DXY/US10Y, tenta FRED
    try {
        // Buscar DXY
        if (macro.dxy === null) {
            const dxy = await fetchFRED('DTWEXBGS');
            if (dxy !== null) macro.dxy = dxy;
        }
        // Buscar US10Y
        if (macro.us10y === null) {
            const us10y = await fetchFRED('DGS10');
            if (us10y !== null) macro.us10y = us10y;
        }
        // Buscar VIX
        if (macro.vix === null) {
            const vix = await fetchFRED('VIXCLS');
            if (vix !== null) macro.vix = vix;
        }
    } catch(e) {
        console.warn('[Macro] FRED fallback falhou:', e.message);
    }

    // 3. Para spChange e nasdaqChange, tenta Yahoo
    if (macro.spChange === null || macro.nasdaqChange === null) {
        try {
            const fetchYahooChange = async (symbol) => {
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`;
                const data = await fetchViaProxy(url, {}, 2);
                if (data?.chart?.result?.[0]?.meta) {
                    const meta = data.chart.result[0].meta;
                    const current = meta.regularMarketPrice;
                    const previousClose = meta.chartPreviousClose;
                    if (current && previousClose && previousClose > 0) {
                        return ((current - previousClose) / previousClose) * 100;
                    }
                }
                return null;
            };

            const [spChangeYahoo, nasdaqChangeYahoo] = await Promise.all([
                fetchYahooChange('%5EGSPC'),
                fetchYahooChange('%5EIXIC')
            ]);

            if (spChangeYahoo !== null && macro.spChange === null) macro.spChange = spChangeYahoo;
            if (nasdaqChangeYahoo !== null && macro.nasdaqChange === null) macro.nasdaqChange = nasdaqChangeYahoo;
        } catch (e) {
            console.warn('[Macro] Yahoo para índices falhou:', e.message);
        }
    }

    // 4. Se ainda faltar spChange ou nasdaqChange, tenta FRED (último recurso)
    if (macro.spChange === null || macro.nasdaqChange === null) {
        try {
            const fetchFREDChange = async (id) => {
                const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2025-01-01`;
                const csv = await fetchViaProxy(url, {}, 2);
                if (typeof csv === 'string') {
                    const lines = csv.trim().split('\n');
                    if (lines.length < 3) return null;
                    const lastLine = lines[lines.length - 1];
                    const prevLine = lines[lines.length - 2];
                    const lastVal = parseFloat(lastLine.split(',')[1]);
                    const prevVal = parseFloat(prevLine.split(',')[1]);
                    if (!isNaN(lastVal) && !isNaN(prevVal) && prevVal > 0) {
                        return ((lastVal - prevVal) / prevVal) * 100;
                    }
                }
                return null;
            };

            if (macro.spChange === null) {
                const spChangeFRED = await fetchFREDChange('SP500');
                if (spChangeFRED !== null) macro.spChange = spChangeFRED;
            }
            if (macro.nasdaqChange === null) {
                const nasdaqChangeFRED = await fetchFREDChange('NASDAQ100');
                if (nasdaqChangeFRED !== null) macro.nasdaqChange = nasdaqChangeFRED;
            }
        } catch(e) {
            console.warn('[Macro] FRED para índices falhou:', e.message);
        }
    }

    // 5. Verifica se pelo menos DXY ou US10Y foram obtidos
    if (macro.dxy !== null || macro.us10y !== null) {
        setCachedData(cacheKey, macro);
        return macro;
    }

    // Se tudo falhar, retorna null
    setCachedData(cacheKey, null);
    return null;
};
// ============================================================
// 3. FED RATE — CORREÇÃO #7 (funciona sem Alpha Vantage key)
// ============================================================
export const fetchFedRate = async () => {
    const cacheKey = 'fedRate';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

    if (CONFIG.ALPHAVANTAGE_API_KEY) {
        try {
            const url = `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${CONFIG.ALPHAVANTAGE_API_KEY}`;
            const data = await fetchViaProxy(url, {}, 2);
            if (data?.data?.[0]?.value) {
                const rate = parseFloat(data.data[0].value);
                setCachedData(cacheKey, rate);
                return rate;
            }
        } catch (e) { /* silencioso */ }
    }

    // Fallback: FRED CSV via proxy (sem API key)
    try {
        const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS';
        const csv = await fetchViaProxy(url, {}, 2);
        if (typeof csv === 'string') {
            const lastLine = csv.trim().split('\n').pop();
            const rate = parseFloat(lastLine.split(',')[1]);
            if (!isNaN(rate) && rate > 0) {
                setCachedData(cacheKey, rate);
                return rate;
            }
        }
    } catch (e) { /* silencioso */ }

    if (cached) return cached;
    return 4.33;
};

// ============================================================
// 4. ON-CHAIN — CoinMetrics + fallbacks
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
// 5. BLOCKCHAIR via proxy + fallback mempool
// ============================================================
export const fetchBlockchairStats = async () => {
    const cacheKey = 'blockchair';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchViaProxy('https://api.blockchair.com/bitcoin/stats', {}, 2);
        if (data?.data) {
            const result = {
                blockHeight: data.data.best_block_height || 0,
                mempoolSize: data.data.mempool_total_size || 0,
                activeAddresses: data.data.addresses_count_24h || 0
            };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e) { /* fallback */ }

    // Fallback: mempool.space para block height + mempool
    try {
        const [heightResp, mempoolResp] = await Promise.all([
            fetchWithRetry('https://mempool.space/api/blocks/tip/height', {}, 2),
            fetchWithRetry('https://mempool.space/api/mempool', {}, 2)
        ]);
        const height = parseInt(heightResp);
        const mempoolSize = mempoolResp?.count || 0;
        if (!isNaN(height)) {
            const result = { blockHeight: height, mempoolSize, activeAddresses: 0 };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e) { /* silencioso */ }

    if (cached) return cached;
    return null;
};

// ============================================================
// 6. OI Delta — CORREÇÃO P0 (URL) + otimização (1 requisição)
// ============================================================
export const fetchOIDelta = async (symbol = 'BTCUSDT') => {
    const cacheKey = `oi_delta_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        // Otimização: 1 requisição com 2 pontos (atual + 24h atrás)
        const data = await fetchWithRetry(
            `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=97`, {}, 2
        );
        if (data?.length >= 97) {
            const currOi = parseFloat(data[data.length - 1].sumOpenInterest);
            const pastOi = parseFloat(data[0].sumOpenInterest);
            const delta = pastOi > 0 ? ((currOi - pastOi) / pastOi) * 100 : 0;
            const result = { oi: currOi, delta };
            setCachedData(cacheKey, result);
            return result;
        }
        // Se não tiver 97 pontos, usa o que tiver
        if (data?.length >= 2) {
            const currOi = parseFloat(data[data.length - 1].sumOpenInterest);
            const pastOi = parseFloat(data[0].sumOpenInterest);
            const delta = pastOi > 0 ? ((currOi - pastOi) / pastOi) * 100 : 0;
            const result = { oi: currOi, delta };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch (e) {
        // Fallback Bybit
        try {
            const resp = await fetchWithRetry(
                `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=96`, {}, 2
            );
            if (resp?.result?.list?.length >= 2) {
                const list = resp.result.list;
                const currOi = parseFloat(list[0].openInterest);
                const pastOi = parseFloat(list[list.length - 1].openInterest);
                const delta = pastOi > 0 ? ((currOi - pastOi) / pastOi) * 100 : 0;
                const result = { oi: currOi, delta };
                setCachedData(cacheKey, result);
                return result;
            }
        } catch(e2) { /* silencioso */ }
    }

    if (cached) return cached;
    return null;
};

// ============================================================
// 7. Put/Call Ratio via proxy
// ============================================================
export const fetchPutCallRatio = async () => {
    const cacheKey = 'pcr';
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const url = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option';
        const data = await fetchViaProxy(url, {}, 2);
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
// 8. Basis (perp vs spot)
// ============================================================
export const fetchBasis = async (symbol = 'BTCUSDT') => {
    const cacheKey = `basis_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

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
    } catch (e) {
        // Fallback Bybit
        try {
            const resp = await fetchWithRetry(
                `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`, {}, 2
            );
            if (resp?.result?.list?.[0]) {
                const item = resp.result.list[0];
                const markPrice = parseFloat(item.markPrice);
                const spotPrice = parseFloat(item.indexPrice);
                if (spotPrice > 0) {
                    const basis = ((markPrice - spotPrice) / spotPrice) * 100;
                    setCachedData(cacheKey, basis);
                    return basis;
                }
            }
        } catch(e2) { /* silencioso */ }
    }

    if (cached) return cached;
    return null;
};

// ============================================================
// 9. PREÇO E CANDLES — CORREÇÃO #8 (cache TTL por timeframe)
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
    // CORREÇÃO #5: Limitar a 1000 velas (máximo da Binance)
    const safeLimit = Math.min(limit, 1000);
    const cacheKey = `candles_${symbol}_${interval}_${safeLimit}`;
    const ttlMap = { '15m': 30000, '1h': 120000, '4h': 300000, '1d': 1800000 };
    const ttl = ttlMap[interval] || 60000;
    const cached = getCachedData(cacheKey, ttl);
    if (cached && !cached.stale) return cached;

    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}`;
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
    } catch(e) { /* fallback */ }

    // Bybit (secundário)
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
    } catch(e) { /* fallback */ }

    // CoinGecko (terciário)
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
    } catch(e) { /* fallback */ }

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
    } catch(e) { /* fallback */ }
    
    // Fallback Bybit
    try {
        const resp = await fetchWithRetry(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`, {}, 2);
        if (resp?.result?.list?.[0]) {
            const item = resp.result.list[0];
            const rate = parseFloat(item.fundingRate);
            let interpretacao = 'EQUILIBRADO';
            if (rate > 0.01) interpretacao = 'LONGS SOBRE-APOSTADOS';
            else if (rate < -0.01) interpretacao = 'SHORTS SOBRE-APOSTADOS';
            const result = { rate, interpretacao };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e2) { /* silencioso */ }
    
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
    } catch(e) { /* fallback */ }
    
    // Fallback Bybit
    try {
        const resp = await fetchWithRetry(
            `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=8`, {}, 2
        );
        if (resp?.result?.list?.length >= 2) {
            const list = resp.result.list;
            const curr = parseFloat(list[0].openInterest);
            const prev = parseFloat(list[list.length - 1].openInterest);
            const result = { oi: curr, delta: ((curr - prev) / prev) * 100 };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e2) { /* silencioso */ }
    
    if (cached) return cached;
    return null;
};

export const fetchOrderBook = async (symbol = 'BTCUSDT', limit = 10) => {
    const cacheKey = `ob_${symbol}`;
    const cached = getCachedData(cacheKey, 15000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
        if (data?.bids && data?.asks) {
            const bidTotal = data.bids.reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0);
            const askTotal = data.asks.reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0);
            const result = {
                bids: data.bids.slice(0,5).map(b => ({ price: +b[0], qty: +b[1] })),
                asks: data.asks.slice(0,5).map(a => ({ price: +a[0], qty: +a[1] })),
                bidTotal, askTotal,
                imbalance: ((bidTotal - askTotal) / (bidTotal + askTotal) * 100)
            };
            setCachedData(cacheKey, result);
            return result;
        }
    } catch(e) { /* silencioso */ }
    
    if (cached) return cached;
    return null;
};

// ============================================================
// 10. DEFI LLAMA — CORREÇÃO #6 (TVL 24h preciso via timestamp)
// ============================================================
export const fetchDeFiData = async () => {
    const cacheKey = 'defiData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const [stable, tvl] = await Promise.all([
            fetchWithRetry('https://stablecoins.llama.fi/stablecoins', {}, 2),
            fetchWithRetry('https://api.llama.fi/charts', {}, 2)
        ]);
        let total = 0;
        stable?.peggedAssets?.forEach(a => total += a.total || 0);
        
        let tvlVal = 0, tvlChange = 0;
        if (tvl?.length > 1) {
            const last = tvl.length - 1;
            tvlVal = tvl[last].totalLiquidityUSD;
            
            // CORREÇÃO: busca o ponto de ~24h atrás comparando timestamps
            const targetTime = (tvl[last].date || 0) - 86400; // 24h em segundos
            let prevIdx = Math.max(last - 2, 0);
            for (let i = last - 1; i >= 0; i--) {
                if (tvl[i].date && tvl[i].date <= targetTime) {
                    prevIdx = i;
                    break;
                }
            }
            const prevVal = tvl[prevIdx].totalLiquidityUSD;
            tvlChange = prevVal > 0 ? ((tvlVal - prevVal) / prevVal) * 100 : 0;
        }
        
        const result = { totalStable: total/1e9, tvl: tvlVal/1e9, tvlChange };
        setCachedData(cacheKey, result);
        return result;
    } catch(e) {
        if (cached) return cached;
        return null;
    }
};

export const fetchTetherPremium = async () => {
    const cacheKey = 'tetherPremium';
    const cached = getCachedData(cacheKey, CONFIG.CACHE_TTL_MS);
    if (cached && !cached.stale) return cached;

    try {
        const [crypto, fiat] = await Promise.all([
            fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl', {}, 2),
            fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD', {}, 2)
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
    const cacheKey = 'fng';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1', {}, 2);
        const v = parseInt(data.data[0].value);
        const color = v < 25 ? '#ff1744' : v < 45 ? '#ff9800' : v < 55 ? '#ffc107' : v < 75 ? '#8bc34a' : '#00e676';
        const result = { value: v, classification: data.data[0].value_classification, color };
        setCachedData(cacheKey, result);
        return result;
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return null;
};

// ============================================================
// 11. ETF FLOWS — CORREÇÃO #9 (regex mais robusto)
// ============================================================
export const fetchETFData = async () => {
    const cacheKey = 'etfData';
    const cached = getCachedData(cacheKey, 600000); // 10 min
    if (cached && !cached.stale) return cached;

    try {
        const url = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';
        const html = await fetchViaProxy(url, {}, 2);
        
        // CORREÇÃO: regex mais robusto para encontrar a tabela de dados
        // Procura pela tabela que contém "Total" no cabeçalho
        const tableMatch = html.match(/<table[^>]*class="[^"]*etf[^"]*"[^>]*>([\s\S]*?)<\/table>/i) 
                        || html.match(/<table[^>]*>([\s\S]*?<th[^>]*>.*?Total.*?<\/th>[\s\S]*?)<\/table>/i)
                        || html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
        
        if (!tableMatch) throw new Error('Tabela ETF não encontrada');
        
        const rows = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        const data = [];
        
        for (let i = 1; i < rows.length; i++) {
            const cols = rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
            if (cols.length < 2) continue;
            
            // Extrai texto limpo
            const cleanText = (html) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
            
            const date = cleanText(cols[0]);
            const flowStr = cleanText(cols[cols.length - 1]).replace(/,/g, '').replace(/-/g, '');
            const flow = parseFloat(flowStr);
            
            if (date && !isNaN(flow)) {
                data.push({ date, total: flow });
            }
        }
        
        if (data.length === 0) throw new Error('Nenhum dado extraído da tabela');
        
        // Pega os últimos 30 dias
        const sorted = data.reverse().slice(0, 30);
        setCachedData(cacheKey, sorted);
        return sorted;
    } catch(e) {
        console.warn('[ETF] Erro ao buscar dados da Farside:', e.message);
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 12. MTF CONFLUENCE — CORREÇÃO #8 (paralelização)
// ============================================================
export async function getMTFConfluence(symbol) {
    const cacheKey = `mtf_${symbol}`;
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    const timeframes = ['15m','1h','4h'];
    
    // CORREÇÃO: paraleliza as 3 requisições
    const candlesPromises = timeframes.map(tf => fetchHistoricalCandles(symbol, tf, 50));
    const candlesResults = await Promise.all(candlesPromises);
    
    const directions = [];
    for (let i = 0; i < timeframes.length; i++) {
        const candles = candlesResults[i];
        if (!candles || !candles.length) continue;
        
        const closes = candles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        const last = candles.length - 1;
        
        if (ema20[last] > ema50[last] && candles[last].close > ema20[last]) {
            directions.push({ tf: timeframes[i], dir: 'BULL' });
        } else if (ema20[last] < ema50[last] && candles[last].close < ema20[last]) {
            directions.push({ tf: timeframes[i], dir: 'BEAR' });
        } else {
            directions.push({ tf: timeframes[i], dir: 'NEUTRO' });
        }
    }
    
    const bulls = directions.filter(d => d.dir === 'BULL').length;
    const bears = directions.filter(d => d.dir === 'BEAR').length;
    const result = {
        directions,
        score: bulls - bears,
        confluencia: Math.max(bulls, bears) === 3 ? 'FORTE' : Math.max(bulls, bears) === 2 ? 'MODERADA' : 'FRACA',
        alinhado: Math.max(bulls, bears) >= 2
    };
    setCachedData(cacheKey, result);
    return result;
}

// ============================================================
// 13. STUBS (compatibilidade)
// ============================================================
export const fetchFREDVIX = async () => null;
export const fetchFREDUS10Y = async () => null;
export const fetchFREDDXY = async () => null;
