// dados_externos.js
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

// ===== Helpers =====
export async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, options);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const text = await resp.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                throw new Error('Resposta não é JSON válido');
            }
        } catch(e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * (i + 1)));
        }
    }
}

export function getCachedData(key) {
    const cached = localStorage.getItem(key);
    if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < CONFIG.CACHE_TTL_MS) return parsed.data;
    }
    return null;
}

export function setCachedData(key, data) {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
}

// ===== Binance (com Fallback Bybit) =====
export async function fetchHistoricalCandles(symbol, interval, limit = 200) {
    const intervalMap = {
        '15m': '15',
        '1h': '60',
        '4h': '240',
        '1d': 'D'
    };

    // 1. Tenta Binance
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await fetchWithRetry(url);
        if (data && data.length > 0) {
            return data.map(k => ({ time: k[0]/1000, open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
        }
    } catch(e) {
        console.warn(`[Binance] ${symbol} ${interval} falhou. Tentando Bybit...`);
    }

    // 2. Fallback Bybit
    try {
        const bybitInterval = intervalMap[interval] || '60';
        const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
        const resp = await fetchWithRetry(url);
        if (resp && resp.result && resp.result.list && resp.result.list.length > 0) {
            // Bybit retorna do mais novo para o mais velho, então inverte
            const list = resp.result.list.reverse();
            return list.map(k => ({ 
                time: parseInt(k[0])/1000, 
                open: parseFloat(k[1]), 
                high: parseFloat(k[2]), 
                low: parseFloat(k[3]), 
                close: parseFloat(k[4]), 
                volume: parseFloat(k[5]) 
            }));
        }
    } catch(e) {
        console.warn(`[Bybit] ${symbol} ${interval}:`, e);
    }

    return [];
}

export async function fetchFundingRate(symbol) {
    // 1. Tenta Binance
    try {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
        const data = await fetchWithRetry(url);
        if (data && data.length > 0) {
            const fr = parseFloat(data[0].fundingRate);
            return { rate: fr, time: data[0].fundingTime };
        }
    } catch(e) { /* ignore */ }

    // 2. Fallback Bybit
    try {
        const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
        const resp = await fetchWithRetry(url);
        if (resp && resp.result && resp.result.list && resp.result.list.length > 0) {
            const item = resp.result.list[0];
            const fr = parseFloat(item.fundingRate);
            return { rate: fr, time: parseInt(item.nextFundingTime) };
        }
    } catch(e) { console.warn('[FundingRate]', e); }
    return null;
}

export async function fetchOpenInterest(symbol) {
    // 1. Tenta Binance
    try {
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=8`;
        const data = await fetchWithRetry(url);
        if (data && data.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[data.length - 1].sumOpenInterest);
            const delta = ((curr - prev) / prev) * 100;
            return { oi: curr, delta };
        }
    } catch(e) { /* ignore */ }

    // 2. Fallback Bybit
    try {
        const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=8`;
        const resp = await fetchWithRetry(url);
        if (resp && resp.result && resp.result.list && resp.result.list.length >= 2) {
            const list = resp.result.list;
            const curr = parseFloat(list[0].openInterest);
            const prev = parseFloat(list[list.length - 1].openInterest);
            const delta = ((curr - prev) / prev) * 100;
            return { oi: curr, delta };
        }
    } catch(e) { console.warn('[OpenInterest]', e); }
    return null;
}

export async function fetchBasis(symbol = 'BTCUSDT') {
    try {
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
        const data = await fetchWithRetry(url);
        if (data && data.basisRate !== undefined) {
            return parseFloat(data.basisRate) * 100;
        }
    } catch(e) { console.warn('[Basis]', e); }
    return null;
}

// ===== Long/Short (CORS bloqueado) =====
export async function fetchLSRatio(symbol = 'BTCUSDT') {
    return null; 
}

// ===== CoinMetrics (via CoinGecko) =====
export async function fetchCoinMetrics() {
    try {
        const gecko = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (gecko && gecko.bitcoin) {
            const price = gecko.bitcoin.usd;
            const result = { price, realized: null, netflow: 0, minerOutflow: 0 };
            setCachedData('coinmetrics_fallback', result);
            return result;
        }
    } catch(e) {
        console.warn('[CoinMetrics] CoinGecko falhou, usando cache', e);
        const cached = getCachedData('coinmetrics_fallback');
        if (cached) return cached;
    }
    return { price: 0, realized: null, netflow: 0, minerOutflow: 0 };
}

// ===== Blockchair =====
export async function fetchBlockchairStats() {
    try {
        const [btcResp, ethResp] = await Promise.all([
            fetchWithRetry('https://api.blockchair.com/bitcoin/stats'),
            fetchWithRetry('https://api.blockchair.com/ethereum/stats')
        ]);
        return {
            activeAddresses: btcResp?.data?.addresses_count || 0,
            ethGas: (ethResp?.data?.gas_price || 0) / 1e9
        };
    } catch(e) { console.warn('[Blockchair]', e); }
    return null;
}

// ===== Mempool =====
export async function fetchHashrate() {
    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1w');
        if (data && data.hashesPerSecond) {
            return data.hashesPerSecond / 1e18;
        }
    } catch(e) { console.warn('[Hashrate]', e); }
    return null;
}

// ===== ETF Data (via Yahoo Finance) =====
export async function fetchETFData() {
    try {
        const cached = getCachedData('etf_fallback');
        if (cached) return cached;

        const proxy = CONFIG.PROXY_URL;
        const fetchYahooChange = async (ticker) => {
            const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`)}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                const meta = data.chart.result[0].meta;
                const prev = meta.chartPreviousClose;
                const curr = meta.regularMarketPrice;
                return ((curr - prev) / prev) * 100;
            }
            return 0;
        };

        const [btcChange, ethChange] = await Promise.all([
            fetchYahooChange('IBIT'), 
            fetchYahooChange('ETHA')  
        ]);

        const result = { btcFlow: btcChange, ethFlow: ethChange };
        setCachedData('etf_fallback', result);
        return result;
    } catch(e) { 
        console.warn('[ETF]', e); 
        return getCachedData('etf_fallback') || { btcFlow: 0, ethFlow: 0 };
    }
}

// ===== Deribit =====
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
    } catch(e) { console.warn('[PutCall]', e); }
    return null;
}

// ===== DefiLlama =====
export async function fetchDeFiData() {
    try {
        const [stableData, tvlData] = await Promise.all([
            fetchWithRetry('https://stablecoins.llama.fi/stablecoins'),
            fetchWithRetry('https://api.llama.fi/charts')
        ]);
        let totalStable = 0;
        if (stableData.peggedAssets) {
            stableData.peggedAssets.forEach(a => totalStable += a.total || 0);
        }
        let tvl = 0, tvlChange = 0;
        if (tvlData && tvlData.length > 1) {
            tvl = tvlData[tvlData.length-1].totalLiquidityUSD;
            const prev = tvlData[tvlData.length-2].totalLiquidityUSD;
            tvlChange = ((tvl - prev) / prev) * 100;
        }
        const result = { totalStable: totalStable / 1e9, tvl: tvl / 1e9, tvlChange };
        setCachedData('defi_fallback', result);
        return result;
    } catch(e) {
        console.warn('[DeFi]', e);
        return getCachedData('defi_fallback') || null;
    }
}

// ===== Tether Premium (Real via CoinGecko) =====
export async function fetchTetherPremium() {
    const cached = getCachedData('tether_premium_fallback');
    if (cached !== null) return cached;

    try {
        const [cryptoData, fiatData] = await Promise.all([
            fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl'),
            fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
        ]);

        const usdtBrl = cryptoData?.tether?.brl;
        const usdBrl = fiatData?.rates?.BRL;

        if (usdtBrl && usdBrl) {
            const premium = ((usdtBrl / usdBrl) - 1) * 100;
            setCachedData('tether_premium_fallback', premium);
            return premium;
        }
    } catch(e) {
        console.warn('[TetherPremium]', e);
    }
    return null;
}

// ===== Fear & Greed =====
export async function fetchFearGreed() {
    try {
        const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1');
        const v = parseInt(data.data[0].value);
        return { value: v, classification: data.data[0].value_classification };
    } catch(e) { console.warn('[FearGreed]', e); }
    return null;
}

// ===== MACRO (via Yahoo Finance) =====
export async function fetchMacroStatic() {
    try {
        const cached = getCachedData('macro_fallback');
        if (cached) return cached;

        const proxy = CONFIG.PROXY_URL;
        const tickers = {
            dxy: 'DX-Y.NYB',
            us10y: '^TNX',
            vix: '^VIX',
            sp: '^GSPC',
            nasdaq: '^NDX'
        };

        const fetchYahoo = async (ticker) => {
            const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`)}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.chart && data.chart.result && data.chart.result[0].meta) {
                const meta = data.chart.result[0].meta;
                const prev = meta.chartPreviousClose;
                const curr = meta.regularMarketPrice;
                return { current: curr, change: ((curr - prev) / prev) * 100 };
            }
            return null;
        };

        const [dxy, us10y, vix, sp, nasdaq] = await Promise.all([
            fetchYahoo(tickers.dxy),
            fetchYahoo(tickers.us10y),
            fetchYahoo(tickers.vix),
            fetchYahoo(tickers.sp),
            fetchYahoo(tickers.nasdaq)
        ]);

        const result = {
            dxy: dxy?.current || 0,
            us10y: us10y?.current || 0,
            vix: vix?.current || 0,
            spChange: sp?.change || 0,
            nasdaqChange: nasdaq?.change || 0
        };

        setCachedData('macro_fallback', result);
        return result;
    } catch(e) { 
        console.warn('[Macro]', e); 
        return getCachedData('macro_fallback') || null;
    }
}

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
            if (ema20[last] > ema50[last] && candles[last].close > ema20[last]) {
                directions.push({ tf, dir: 'BULL' });
            } else if (ema20[last] < ema50[last] && candles[last].close < ema20[last]) {
                directions.push({ tf, dir: 'BEAR' });
            } else {
                directions.push({ tf, dir: 'NEUTRO' });
            }
        } catch(e) {
            directions.push({ tf, dir: 'ERROR' });
        }
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
