// ============================================================
// novas_secoes.js – 3 Gráficos de Candlestick (LightweightCharts)
// e Painel On-Chain / Derivativos
// ============================================================

// ===== Funções auxiliares de fetch =====
const fetchWithRetry = async (url, opts = {}, retries = 3) => {
    let delay = 100;
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, opts);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
        }
    }
};

const fetchHistoricalCandles = async (symbol, interval, limit = 200) => {
    const safeLimit = Math.min(limit, 1000);
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}`;
        const data = await fetchWithRetry(url, {}, 3);
        if (data && data.length > 0) {
            return data.map(k => ({
                time: k[0] / 1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
        return [];
    } catch (e) {
        console.warn('Erro ao buscar candles:', e);
        return [];
    }
};

// ===== Funções para o painel on-chain =====
const fetchFundingRate = async (symbol) => {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`, {}, 2);
        if (data && data.length) return parseFloat(data[0].fundingRate);
        return null;
    } catch { return null; }
};

const fetchOpenInterest = async (symbol) => {
    try {
        const data = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`, {}, 2);
        if (data && data.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[1].sumOpenInterest);
            const delta = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
            return { oi: curr, delta };
        }
        return null;
    } catch { return null; }
};

const fetchMVRV = async () => {
    try {
        const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&page_size=1';
        const data = await fetchWithRetry(url, {}, 2);
        const val = data?.data?.[0]?.CapMVRVCur;
        return val !== undefined && val !== null ? parseFloat(val) : null;
    } catch { return null; }
};

const fetchBasis = async (symbol) => {
    try {
        const [perp, spot] = await Promise.all([
            fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {}, 2),
            fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {}, 2)
        ]);
        if (perp?.markPrice && spot?.price) {
            const mark = parseFloat(perp.markPrice);
            const spotPrice = parseFloat(spot.price);
            if (spotPrice > 0) return ((mark - spotPrice) / spotPrice) * 100;
        }
        return null;
    } catch { return null; }
};

const fetchPutCallRatio = async () => {
    try {
        const url = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option';
        const data = await fetchWithRetry(url, {}, 2);
        let putVolume = 0, callVolume = 0;
        data?.result?.forEach(item => {
            if (item.option_type === 'put') putVolume += item.volume || 0;
            if (item.option_type === 'call') callVolume += item.volume || 0;
        });
        return callVolume > 0 ? putVolume / callVolume : 0;
    } catch { return null; }
};

const fetchFearGreed = async () => {
    try {
        const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1', {}, 2);
        if (data?.data?.[0]) {
            return {
                value: parseInt(data.data[0].value),
                classification: data.data[0].value_classification
            };
        }
        return null;
    } catch { return null; }
};

const fetchETFData = async () => {
    try {
        const proxy = 'https://corsproxy.io/?url=';
        const url = proxy + encodeURIComponent('https://farside.co.uk/bitcoin-etf-flow-all-data/');
        const html = await (await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        })).text();
        
        const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
        if (!tableMatch) return null;
        const rows = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        for (let i = rows.length - 1; i >= 0; i--) {
            const cols = rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
            if (cols.length >= 2) {
                const clean = (html) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
                const flowStr = clean(cols[cols.length - 1]).replace(/,/g, '').replace(/-/g, '');
                const flow = parseFloat(flowStr);
                if (!isNaN(flow)) return flow;
            }
        }
        return null;
    } catch { return null; }
};
// ============================================================
// 3 GRÁFICOS DE CANDLESTICK
// ============================================================
let chartInstances = {};
let updateIntervals = {};
let currentTimeframe = '1h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CONTAINER_IDS = { 'BTCUSDT': 'chartBTC', 'ETHUSDT': 'chartETH', 'SOLUSDT': 'chartSOL' };

function createChart(containerId, symbol) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    container.innerHTML = '';
    const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 280,
        layout: { background: { color: '#0f1117' }, textColor: '#e6e8eb' },
        grid: { vertLines: { color: 'rgba(42, 42, 68, 0.3)' }, horzLines: { color: 'rgba(42, 42, 68, 0.3)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        priceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
        upColor: '#00e896',
        downColor: '#ff4d6d',
        borderDownColor: '#ff4d6d',
        borderUpColor: '#00e896',
        wickDownColor: '#ff4d6d',
        wickUpColor: '#00e896',
    });
    return { chart, series };
}

async function loadCandlesAndUpdate(symbol, timeframe) {
    const containerId = CONTAINER_IDS[symbol];
    if (!containerId) return;
    if (chartInstances[symbol]) {
        chartInstances[symbol].chart.remove();
        delete chartInstances[symbol];
    }
    if (updateIntervals[symbol]) {
        clearInterval(updateIntervals[symbol]);
        delete updateIntervals[symbol];
    }
    const chartObj = createChart(containerId, symbol);
    if (!chartObj) return;
    chartInstances[symbol] = chartObj;
    const statusEl = document.getElementById('multiStatus');
    statusEl.textContent = '⏳ Carregando...';
    try {
        const candles = await fetchHistoricalCandles(symbol, timeframe, 200);
        if (candles.length === 0) {
            statusEl.textContent = '❌ Sem dados para ' + symbol;
            return;
        }
        const formatted = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
        chartObj.series.setData(formatted);
        chartObj.chart.timeScale().fitContent();
        statusEl.textContent = '✅ Atualizado ' + new Date().toLocaleTimeString();
        updateIntervals[symbol] = setInterval(async () => {
            try {
                const lastCandles = await fetchHistoricalCandles(symbol, timeframe, 1);
                if (lastCandles.length === 0) return;
                const last = lastCandles[0];
                const currentData = chartObj.series.data();
                const lastTime = currentData.length > 0 ? currentData[currentData.length - 1].time : 0;
                if (last.time > lastTime) {
                    chartObj.series.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
                    chartObj.chart.timeScale().fitContent();
                    statusEl.textContent = '🔄 Atualizado ' + new Date().toLocaleTimeString();
                }
            } catch (e) { /* silencioso */ }
        }, 30000);
    } catch (e) {
        console.error('Erro ao carregar candles para ' + symbol, e);
        statusEl.textContent = '❌ Erro em ' + symbol;
    }
}

export function initMultiCandlestick(timeframe = '1h') {
    currentTimeframe = timeframe;
    const statusEl = document.getElementById('multiStatus');
    statusEl.textContent = '⏳ Carregando gráficos...';
    for (const sym of SYMBOLS) {
        if (updateIntervals[sym]) {
            clearInterval(updateIntervals[sym]);
            delete updateIntervals[sym];
        }
        if (chartInstances[sym]) {
            chartInstances[sym].chart.remove();
            delete chartInstances[sym];
        }
    }
    Promise.all(SYMBOLS.map(sym => loadCandlesAndUpdate(sym, timeframe)))
        .then(() => { statusEl.textContent = '✅ Todos os gráficos ativos (atualização a cada 30s)'; })
        .catch(() => { statusEl.textContent = '⚠️ Alguns gráficos podem não ter carregado'; });
}

// ============================================================
// PAINEL ON-CHAIN
// ============================================================
let onChainInterval = null;

export function initOnChain() {
    updateOnChain();
    if (onChainInterval) clearInterval(onChainInterval);
    onChainInterval = setInterval(updateOnChain, 60000);
}

export function refreshOnChain() {
    updateOnChain();
}

async function updateOnChain() {
    const symbol = 'BTCUSDT';
    try {
        const [mvrv, funding, oi, basis, pcr, fng, etf] = await Promise.all([
            fetchMVRV(),
            fetchFundingRate(symbol),
            fetchOpenInterest(symbol),
            fetchBasis(symbol),
            fetchPutCallRatio(),
            fetchFearGreed(),
            fetchETFData()
        ]);
        // Atualiza cada elemento (código igual ao anterior)
        const mvrvEl = document.getElementById('oc-mvrv');
        const mvrvSub = document.getElementById('oc-mvrv-sub');
        if (mvrv !== null) { mvrvEl.textContent = mvrv.toFixed(2); mvrvSub.textContent = 'On-chain'; }
        else { mvrvEl.textContent = '--'; mvrvSub.textContent = 'Indisponível'; }

        const fundingEl = document.getElementById('oc-funding');
        const fundingSub = document.getElementById('oc-funding-sub');
        if (funding !== null) {
            const pct = (funding * 100).toFixed(3);
            fundingEl.textContent = `${pct}%`;
            fundingEl.className = 'value ' + (funding > 0.0005 ? 'positive' : (funding < -0.0005 ? 'negative' : ''));
            fundingSub.textContent = funding > 0.001 ? 'Longs sobre-apostados' : (funding < -0.001 ? 'Shorts sobre-apostados' : 'Equilibrado');
        } else { fundingEl.textContent = '--'; fundingSub.textContent = 'Indisponível'; }

        const oiEl = document.getElementById('oc-oi');
        const oiDeltaEl = document.getElementById('oc-oi-delta');
        if (oi) {
            oiEl.textContent = `$${(oi.oi / 1e6).toFixed(1)}M`;
            const delta = oi.delta;
            oiDeltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
            oiDeltaEl.className = 'sub ' + (delta > 0 ? 'positive' : 'negative');
        } else { oiEl.textContent = '--'; oiDeltaEl.textContent = '--'; }

        const basisEl = document.getElementById('oc-basis');
        if (basis !== null) {
            basisEl.textContent = `${basis >= 0 ? '+' : ''}${basis.toFixed(2)}%`;
            basisEl.className = 'value ' + (basis > 0.5 ? 'positive' : (basis < -0.5 ? 'negative' : ''));
        } else { basisEl.textContent = '--'; }

        const pcrEl = document.getElementById('oc-pcr');
        if (pcr !== null) {
            pcrEl.textContent = pcr.toFixed(2);
            pcrEl.className = 'value ' + (pcr > 0.7 ? 'negative' : (pcr < 0.3 ? 'positive' : ''));
        } else { pcrEl.textContent = '--'; }

        const fngEl = document.getElementById('oc-fng');
        const fngSub = document.getElementById('oc-fng-sub');
        if (fng) {
            fngEl.textContent = fng.value;
            fngEl.className = 'value ' + (fng.value < 25 ? 'negative' : (fng.value > 75 ? 'positive' : ''));
            fngSub.textContent = fng.classification;
        } else { fngEl.textContent = '--'; fngSub.textContent = 'Indisponível'; }

        const etfEl = document.getElementById('oc-etf');
        if (etf !== null) {
            etfEl.textContent = `$${etf.toFixed(0)}M`;
            etfEl.className = 'value ' + (etf > 0 ? 'positive' : 'negative');
        } else { etfEl.textContent = '--'; }
    } catch (e) {
        console.warn('Erro ao atualizar painel on-chain:', e);
    }
}
