// dados_externos.js
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

// ===== Helpers =====
export async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, options);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await resp.json();
        } catch(e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * (i + 1)));
        }
    }
}

export async function proxyFetch(url) {
    const proxy = 'https://api.allorigins.win/raw?url=';
    const resp = await fetch(proxy + encodeURIComponent(url));
    if (!resp.ok) throw new Error('Proxy fetch failed');
    return resp.json();
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

// ===== Binance =====
export async function fetchHistoricalCandles(symbol, interval, limit = 200) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await fetchWithRetry(url);
        return data.map(k => ({ time: k[0]/1000, open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
    } catch(e) {
        console.warn(`[Binance] ${symbol} ${interval}:`, e);
        return [];
    }
}

export async function fetchFundingRate(symbol) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
        const data = await fetchWithRetry(url);
        if (data.length > 0) {
            const fr = parseFloat(data[0].fundingRate);
            return { rate: fr, time: data[0].fundingTime };
        }
    } catch(e) { console.warn('[FundingRate]', e); }
    return null;
}

export async function fetchOpenInterest(symbol) {
    try {
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=8`;
        const data = await fetchWithRetry(url);
        if (data.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[data.length - 1].sumOpenInterest);
            const delta = ((curr - prev) / prev) * 100;
            return { oi: curr, delta };
        }
    } catch(e) { console.warn('[OpenInterest]', e); }
    return null;
}

export async function fetchBasis(symbol = 'BTCUSDT') {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (data.basisRate !== undefined) {
            return parseFloat(data.basisRate) * 100;
        }
    } catch(e) { console.warn('[Basis]', e); }
    return null;
}

export async function fetchLSRatio(symbol = 'BTCUSDT') {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/topLongShortPositionRatio?symbol=${symbol}&period=24h`);
        if (data && data.length > 0) {
            const latest = data[data.length-1];
            return { long: parseFloat(latest.longRatio) * 100, short: parseFloat(latest.shortRatio) * 100 };
        }
    } catch(e) { console.warn('[LSRatio]', e); }
    return null;
}

// ===== CoinMetrics =====
export async function fetchCoinMetrics() {
    try {
        const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?metrics=PriceUSD,RealizedPriceUSD,Netflow,MinerOutflow&assets=BTC&limit=1';
        const data = await fetchWithRetry(url);
        if (data && data.data && data.data.length > 0) {
            const latest = data.data[0];
            return {
                price: parseFloat(latest.PriceUSD),
                realized: parseFloat(latest.RealizedPriceUSD),
                netflow: parseFloat(latest.Netflow || 0),
                minerOutflow: parseFloat(latest.MinerOutflow || 0)
            };
        }
    } catch(e) { console.warn('[CoinMetrics]', e); }
    return null;
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

export async function fetchWhaleTxs() {
    try {
        const data = await fetchWithRetry('https://api.blockchair.com/bitcoin/transactions?limit=3&order_by=size_desc');
        if (data && data.data) {
            return data.data.slice(0, 3).map(tx => ({
                hash: tx.hash,
                valueBTC: (tx.output_total || 0) / 1e8,
                valueUSD: ((tx.output_total || 0) / 1e8) * 60000 // preço aproximado
            }));
        }
    } catch(e) { console.warn('[WhaleTxs]', e); }
    return null;
}

// ===== Mempool =====
export async function fetchHashrate() {
    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1w');
        if (data && data.hashesPerSecond) {
            return data.hashesPerSecond / 1e18; // EH/s
        }
    } catch(e) { console.warn('[Hashrate]', e); }
    return null;
}

// ===== Farside (ETF) via proxy =====
export async function fetchETFData() {
    try {
        const data = await proxyFetch('https://farside.co.uk/api/etf/flow/');
        if (data.btc && data.btc.flow !== undefined) {
            return {
                btcFlow: data.btc.flow / 1e6,
                ethFlow: data.eth?.flow / 1e6
            };
        }
    } catch(e) { console.warn('[ETF]', e); }
    return null;
}

// ===== Yahoo Finance =====
export async function fetchYahoo(symbol) {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
        const data = await fetchWithRetry(url);
        const result = data.chart.result[0];
        const meta = result.meta;
        const price = meta.regularMarketPrice;
        const prevClose = meta.regularMarketPreviousClose || price;
        const change = ((price - prevClose) / prevClose) * 100;
        return { price, change };
    } catch(e) { console.warn('[Yahoo]', symbol, e); }
    return null;
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
        return { totalStable: totalStable / 1e9, tvl: tvl / 1e9, tvlChange };
    } catch(e) { console.warn('[DeFi]', e); }
    return null;
}

// ===== Tether Premium (ExchangeRate + Mercado Bitcoin) =====
export async function fetchTetherPremium() {
    try {
        const [usdbrlData, tickerData] = await Promise.all([
            fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD'),
            fetchWithRetry('https://api.mercadobitcoin.net/api/v4/ticker/USDT')
        ]);
        const usdbrl = usdbrlData.rates.BRL;
        const usdtbrl = parseFloat(tickerData.last);
        return ((usdtbrl / usdbrl) - 1) * 100;
    } catch(e) { console.warn('[TetherPremium]', e); }
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
