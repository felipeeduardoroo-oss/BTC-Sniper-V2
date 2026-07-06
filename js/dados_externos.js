// dados_externos.js – versão com cache avançado, backoff e fallbacks robustos
import { CONFIG } from './config.js';
import { calcEMA, calculateATR, detectHTFStructure } from './indicadores.js';

const BACKEND_URL = CONFIG.BACKEND_URL || 'https://twelvedata-backend.onrender.com';

// ===== URL DO PROXY REPLIT (ROTA CORRETA) =====
const REPLIT_CM_URL = 'https://0f6c32ea-14f2-4470-9a55-e9fb37eeb395-00-2u2zgtjsl1c44.picard.replit.dev/api/coinmetrics/assets';

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

export async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES || 3) {
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
            try {
                return JSON.parse(text);
            } catch(e) {
                return text;
            }
        } catch(e) {
            lastError = e;
            if (i === retries - 1) break;
            const wait = CONFIG.RETRY_DELAY_MS * Math.pow(2, i) + 500 + Math.random() * 300;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastError || new Error(`Falha ao buscar ${url}`);
}

// ===== PROXY COM FALLBACK =====
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
setInterval(() => {
    if (getBackendStatus() === 'sleeping' || getBackendStatus() === 'checking') {
        warmupBackend().catch(() => {});
    }
}, 30000);

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
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch(e) { /* ignore */ }
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
    } catch (e) { console.warn('[GasPrice publicnode] falhou:', e); }

    try {
        const url = `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
        const data = await fetchWithRetry(url, {}, 2);
        if (data && data.status === '1' && data.result) {
            const gasPrice = parseFloat(data.result.ProposeGasPrice);
            setCachedData(cacheKey, gasPrice);
            return gasPrice;
        }
    } catch (e) { console.warn('[GasPrice Etherscan V2] falhou:', e); }

    if (cached) return cached;
    return 5;
};

// ============================================================
// 2. MACRO
// ============================================================
export const fetchMacroStatic = async () => {
    const cacheKey = 'macroData';
    const cached = getCachedData(cacheKey, 300000);
    if (cached && !cached.stale) return cached;

    try {
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
            dxy: dxy?.current || 0, us10y: us10y?.current || 0, vix: vix?.current || 0,
            spChange: sp?.change || 0, nasdaqChange: nasdaq?.change || 0
        };
        if (macro.dxy && macro.vix) { setCachedData(cacheKey, macro); return macro; }
    } catch (e) { console.warn('[Macro Yahoo] falhou:', e); }

    try {
        const fetchTD = async (symbol) => {
            const url = `${BACKEND_URL}/api/quote?symbol=${symbol}`;
            const data = await fetchWithRetry(url, {}, 2);
            if (data && data.close && data.previous_close) {
                return {
                    current: parseFloat(data.close),
                    change: ((parseFloat(data.close) - parseFloat(data.previous_close)) / parseFloat(data.previous_close)) * 100
                };
            }
            return null;
        };
        const [dxy, us10y, vix, sp, nasdaq] = await Promise.all([
            fetchTD('DXY'), fetchTD('DGS10'), fetchTD('VIX'), fetchTD('SPX'), fetchTD('NDX')
        ]);
        const macro = {
            dxy: dxy?.current || 0, us10y: us10y?.current || 0, vix: vix?.current || 0,
            spChange: sp?.change || 0, nasdaqChange: nasdaq?.change || 0
        };
        if (macro.dxy && macro.vix) { setCachedData(cacheKey, macro); return macro; }
    } catch (e) { console.warn('[Macro TwelveData] falhou:', e); }

    if (cached) return cached;
    return { dxy: 101.5, us10y: 4.28, vix: 20.5, spChange: -0.5, nasdaqChange: -0.8 };
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
    } catch (e) { console.warn('[FedRate AlphaVantage] falhou:', e); }

    try {
        const csv = await fetchViaProxy('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS', 2);
        if (csv && typeof csv === 'string') {
            const lastLine = csv.trim().split('\n').pop();
            const rate = parseFloat(lastLine.split(',')[1]);
            if (!isNaN(rate) && rate > 0) { setCachedData(cacheKey, rate); return rate; }
        }
    } catch (e) { console.warn('[FedRate CSV] falhou:', e); }

    if (cached) return cached;
    return 4.33;
};

// ============================================================
// 4. ON-CHAIN – CoinMetrics Community + Replit proxy
// ============================================================
const CM_BASE = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';

function fetchCMWithCache(metric, cacheKey, maxAge = 300000) {
    return async () => {
        const cached = getCachedData(cacheKey, maxAge);
