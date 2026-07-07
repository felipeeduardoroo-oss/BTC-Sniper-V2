// js/dados_externos.js – completo com Alpha Vantage para Macro
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

// ===== SLEEP (para evitar rate limit) =====
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
// 2. MACRO – Alpha Vantage (com fallback estático)
// ============================================================
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    const apiKey = CONFIG.ALPHAVANTAGE_API_KEY;
    if (!apiKey) {
        console.warn('[Macro] Alpha Vantage API key não configurada. Usando fallback estático.');
        if (cached) return cached;
        return { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
    }

    try {
        // Símbolos da Alpha Vantage
        const symbols = ['DXY', 'DGS10', 'VIX', 'SPX', 'NDX'];
        
        // Função para buscar um símbolo com delay (evita rate limit de 5/min)
        const fetchSymbol = async (symbol) => {
            await sleep(300); // 300ms entre cada chamada
            return await fetchWithRetry(
                `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`,
                {},
                2
            );
        };

        const results = await Promise.all(symbols.map(s => fetchSymbol(s)));

        // Função para extrair o preço (05. price)
        const parseQuote = (data, defaultVal) => {
            try {
                const val = data?.['Global Quote']?.['05. price'];
                return val !== undefined && val !== null ? parseFloat(val) : defaultVal;
            } catch(e) { return defaultVal; }
        };

        // Função para extrair a variação percentual (10. change percent)
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

        // Validação simples: se todos vierem com os valores padrão, algo deu errado
        if (macro.dxy === 101.5 && macro.us10y === 4.28 && macro.vix === 20.5) {
            throw new Error('Dados inválidos retornados da Alpha Vantage');
        }

        setCachedData(cacheKey, macro);
        return macro;
    } catch (e) {
        console.warn('[Macro] Alpha Vantage falhou, usando fallback:', e);
        if (cached) return cached;
        return { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
    }
};

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

    // mempool.space (CORS liberado)
    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1d', {}, 2);
        if (data?.avgHashrate) {
            const hashrate = parseFloat(data.avgHashrate);
            setCachedData(cacheKey, hashrate);
            return hashrate;
        }
    } catch (e) { /* silencioso */ }

    // CoinMetrics (fallback)
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
// 8. Basis (perp vs spot) – Binance
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
        return null;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
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
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return null;
};
export const fetchDeFiData = async () => {
    const cacheKey = 'defiData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        // 1. Tenta buscar stablecoins
        const stableResp = await fetchWithRetry('https://stablecoins.llama.fi/stablecoins', {}, 2);
        let total = 0;
        console.log('[DefiLlama] Resposta stablecoins:', stableResp);

        // Estrutura esperada: { peggedAssets: [ { total: 12345 }, ... ] }
        if (stableResp && Array.isArray(stableResp.peggedAssets)) {
            total = stableResp.peggedAssets.reduce((acc, item) => acc + (item.total || 0), 0);
        } else if (stableResp && typeof stableResp === 'object') {
            // Fallback: tenta encontrar qualquer chave que contenha "total" ou "usd"
            for (const key of Object.keys(stableResp)) {
                if (key.toLowerCase().includes('total') || key.toLowerCase().includes('usd')) {
                    const val = stableResp[key];
                    if (typeof val === 'number') total += val;
                }
            }
        }

        // 2. Busca TVL
        const tvlResp = await fetchWithRetry('https://api.llama.fi/charts', {}, 2);
        let tvlVal = 0, tvlChange = 0;
        if (tvlResp && Array.isArray(tvlResp) && tvlResp.length > 1) {
            const last = tvlResp[tvlResp.length - 1];
            const prev = tvlResp[tvlResp.length - 2];
            tvlVal = last.totalLiquidityUSD || 0;
            tvlChange = prev.totalLiquidityUSD ? ((tvlVal - prev.totalLiquidityUSD) / prev.totalLiquidityUSD) * 100 : 0;
        }

        const result = {
            totalStable: total / 1e9, // converte para bilhões
            tvl: tvlVal / 1e9,
            tvlChange: tvlChange
        };

        console.log('[DefiLlama] Resultado processado:', result);
        setCachedData(cacheKey, result);
        return result;

    } catch (e) {
        console.warn('[DefiLlama] Erro na requisição:', e);
        // Fallback com dados mockados para não quebrar a UI
        const mock = { totalStable: 180.5, tvl: 85.2, tvlChange: 0.5 };
        setCachedData(cacheKey, mock);
        return mock;
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

export async function getMTFConfluence(symbol) {
    const cacheKey = `mtf_${symbol}`;
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

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
    const result = {
        directions,
        score: bulls - bears,
        confluencia: Math.max(bulls, bears) === 3 ? 'FORTE' : Math.max(bulls, bears) === 2 ? 'MODERADA' : 'FRACA',
        alinhado: Math.max(bulls, bears) >= 2
    };
    setCachedData(cacheKey, result);
    return result;
}

// ===== COMPATIBILIDADE =====
export const fetchFREDVIX = async () => null;
export const fetchFREDUS10Y = async () => null;
export const fetchFREDDXY = async () => null;
