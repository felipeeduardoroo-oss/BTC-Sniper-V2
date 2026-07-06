// js/dados_externos.js – todas as funções exportadas
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
// 2. MACRO – estático
// ============================================================
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached) return cached;
    const macro = { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
    setCachedData(cacheKey, macro);
    return macro;
};

// ============================================================
// 3. FED RATE
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
// 4. ON-CHAIN – MVRV, Active Addresses, Hashrate (CoinMetrics)
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
export const fetchCQHashrate = fetchCM('HashRate');

// ===== BLOCKCHAIR (fallback Active Addresses) =====
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
// 5. SOPR e aSOPR (bitcoin-data.com)
// ============================================================
export const fetchSOPR = async () => {
    const cacheKey = 'sopr_data';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const url = 'https://bitcoin-data.com/api/v1/sopr';
        const data = await fetchWithRetry(url, {}, 2);
        if (data?.data?.sopr !== undefined) {
            const sopr = parseFloat(data.data.sopr);
            const asopr = parseFloat(data.data.asopr);
            const result = { sopr, asopr };
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
// 6. Realized Price (bitcoin-data.com)
// ============================================================
export const fetchRealizedPrice = async () => {
    const cacheKey = 'realized_price';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const url = 'https://bitcoin-data.com/api/v1/realized-price';
        const data = await fetchWithRetry(url, {}, 2);
        if (data?.data?.realizedPrice !== undefined) {
            const price = parseFloat(data.data.realizedPrice);
            setCachedData(cacheKey, price);
            return price;
        }
        return null;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 7. ETF Flows (Farside Investors – scraping)
// ============================================================
export const fetchETFData = async () => {
    const cacheKey = 'etf_flows';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const btcUrl = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';
        const btcHtml = await fetchWithRetry(btcUrl, {}, 2);
        let btcFlow = 0;
        const btcMatch = btcHtml.match(/>Total</i);
        if (btcMatch) {
            const valMatch = btcHtml.substring(btcMatch.index).match(/([+-]?\d+\.?\d*)(M|B)/);
            if (valMatch) {
                const num = parseFloat(valMatch[1]);
                const mult = valMatch[2] === 'B' ? 1000 : 1;
                btcFlow = num * mult;
            }
        }

        const ethUrl = 'https://farside.co.uk/ethereum-etf-flow-all-data/';
        const ethHtml = await fetchWithRetry(ethUrl, {}, 2);
        let ethFlow = 0;
        const ethMatch = ethHtml.match(/>Total</i);
        if (ethMatch) {
            const valMatch = ethHtml.substring(ethMatch.index).match(/([+-]?\d+\.?\d*)(M|B)/);
            if (valMatch) {
                const num = parseFloat(valMatch[1]);
                const mult = valMatch[2] === 'B' ? 1000 : 1;
                ethFlow = num * mult;
            }
        }

        const result = { btcFlow, ethFlow };
        setCachedData(cacheKey, result);
        return result;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 8. Exchange Netflow (indisponível)
// ============================================================
export const fetchExchangeNetflow = async () => null;

// ============================================================
// 9. Mining Outflow (indisponível)
// ============================================================
export const fetchMinerOutflow = async () => null;

// ============================================================
// 10. OI Delta (Binance)
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
// 11. Put/Call Ratio (Deribit)
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
// 12. Hashrate (mempool.space)
// ============================================================
export const fetchHashrate = async () => {
    const cacheKey = 'hashrate';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1d', {}, 2);
        if (data?.avgHashrate) {
            const hashrate = parseFloat(data.avgHashrate); // em TH/s
            setCachedData(cacheKey, hashrate);
            return hashrate;
        }
        return null;
    } catch (e) {
        if (cached) return cached;
        return null;
    }
};

// ============================================================
// 13. FUNÇÕES ORIGINAIS (mantidas)
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
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

export const fetchBasis = async (symbol = 'BTCUSDT') => {
    const cacheKey = `basis_${symbol}`;
    const cached = getCachedData(cacheKey, 60000);
    if (cached && !cached.stale) return cached;

    try {
        const [perp, spot] = await Promise.all([
            fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
            fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
        ]);
        if (perp?.markPrice && spot?.price) {
            const mark = parseFloat(perp.markPrice);
            const spotPrice = parseFloat(spot.price);
            const basis = ((mark - spotPrice) / spotPrice) * 100;
            setCachedData(cacheKey, basis);
            return basis;
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
        const [stable, tvl] = await Promise.all([
            fetchWithRetry('https://stablecoins.llama.fi/stablecoins', {}, 2),
            fetchWithRetry('https://api.llama.fi/charts', {}, 2)
        ]);
        let total = 0;
        stable?.peggedAssets?.forEach(a => total += a.total || 0);
        let tvlVal = 0, tvlChange = 0;
        if (tvl?.length > 1) {
            tvlVal = tvl[tvl.length-1].totalLiquidityUSD;
            const prev = tvl[tvl.length-2].totalLiquidityUSD;
            tvlChange = ((tvlVal - prev) / prev) * 100;
        }
        const result = { totalStable: total/1e9, tvl: tvlVal/1e9, tvlChange };
        setCachedData(cacheKey, result);
        return result;
    } catch(e) { /* ignore */ }
    if (cached) return cached;
    return null;
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
        const
