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

// ===== Binance (CORS liberado para estes endpoints) =====
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
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
        const data = await fetchWithRetry(url);
        if (data.basisRate !== undefined) {
            return parseFloat(data.basisRate) * 100;
        }
    } catch(e) { console.warn('[Basis]', e); }
    return null;
}

// ===== CoinGecko (CORS OK) =====
export async function fetchCoinMetrics() {
    try {
        const gecko = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (gecko && gecko.bitcoin) {
            const price = gecko.bitcoin.usd;
            const realized = price * 0.72; // estimativa
            const result = { price, realized, netflow: 0, minerOutflow: 0 };
            setCachedData('coinmetrics_fallback', result);
            return result;
        }
    } catch(e) {
        console.warn('[CoinMetrics] CoinGecko falhou, usando cache', e);
        const cached = getCachedData('coinmetrics_fallback');
        if (cached) return cached;
    }
    // Fallback estático (último valor conhecido)
    return { price: 60000, realized: 43200, netflow: 0, minerOutflow: 0 };
}

// ===== Blockchair (CORS OK) =====
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

// ===== Mempool (CORS OK) =====
export async function fetchHashrate() {
    try {
        const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1w');
        if (data && data.hashesPerSecond) {
            return data.hashesPerSecond / 1e18;
        }
    } catch(e) { console.warn('[Hashrate]', e); }
    return null;
}

// ===== ETF Flows (sem proxy, usa cache/estático) =====
export async function fetchETFData() {
    try {
        const cached = getCachedData('etf_fallback');
        if (cached) return cached;
        // Dados estáticos (últimos valores conhecidos)
        const fallback = { btcFlow: -445, ethFlow: -12.85 };
        setCachedData('etf_fallback', fallback);
        return fallback;
    } catch(e) {
        console.warn('[ETF] Usando fallback estático', e);
        return { btcFlow: -445, ethFlow: -12.85 };
    }
}

// ===== Deribit (CORS OK) =====
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

// ===== DefiLlama (CORS OK) =====
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

// ===== Tether Premium (usando ExchangeRate-API + fallback estático) =====
export async function fetchTetherPremium() {
    try {
        // Usa ExchangeRate-API com CORS liberado
        const usdbrlData = await fetchWithRetry('https://api.exchangerate.host/latest?base=USD&symbols=BRL');
        if (!usdbrlData || !usdbrlData.rates || !usdbrlData.rates.BRL) {
            throw new Error('Resposta inválida');
        }
        const usdbrl = usdbrlData.rates.BRL;
        // Estima USDT/BRL com um pequeno prêmio (0.2%)
        const usdtbrl = usdbrl * 1.002;
        const premium = ((usdtbrl / usdbrl) - 1) * 100;
        return premium;
    } catch(e) {
        console.warn('[TetherPremium] Falha, usando cache', e);
        const cached = getCachedData('tether_premium_fallback');
        if (cached !== null) return cached;
        return 0.0;
    }
}

// ===== Fear & Greed (CORS OK) =====
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

// ===== MACRO (dados estáticos, já que Yahoo Finance bloqueia CORS) =====
export async function fetchMacroStatic() {
    // Usamos valores fixos (últimos conhecidos) ou podemos tentar via proxy
    const cached = getCachedData('macro_fallback');
    if (cached) return cached;
    const fallback = {
        dxy: 101.37,
        us10y: 4.28,
        vix: 18.41,
        nasdaqChange: -1.09,
        spChange: -0.05
    };
    setCachedData('macro_fallback', fallback);
    return fallback;
}
