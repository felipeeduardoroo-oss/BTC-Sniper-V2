// ============================================================
// backtest_engine.js – Motor completo de backtest, UI e robô
// ============================================================

// ===== VARIÁVEIS GLOBAIS =====
let cachedData = {
    candles1h: [],
    candles4h: [],
    funding: [],
    oi: [],
    mvrv: []
};
let cachedSymbol = null;
let lastResult = null;
let lastParams = null;
let liveInterval = null;

// ============================================================
// FUNÇÕES DO INDICADOR
// ============================================================
const calcEMA = (data, period) => {
    if (!data || data.length === 0) return [];
    const result = [];
    const mult = 2 / (period + 1);
    let ema = data[0];
    result.push(ema);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * mult + ema;
        result.push(ema);
    }
    return result;
};

const calculateATR = (candles, period = 14, lookback = 100) => {
    const data = candles.slice(-Math.max(lookback, period + 1));
    if (data.length < period + 1) return 0;
    const tr = [];
    for (let i = 1; i < data.length; i++) {
        const high = data[i].high;
        const low = data[i].low;
        const prevClose = data[i - 1].close;
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
};

const calculateVWAP = (candles) => {
    if (!candles || candles.length === 0) return 0;
    let sum = 0, vol = 0;
    for (const c of candles) {
        const typical = (c.high + c.low + c.close) / 3;
        sum += typical * c.volume;
        vol += c.volume;
    }
    return vol > 0 ? sum / vol : 0;
};

const calculateADX = (candles, period = 14, lookback = 50) => {
    const data = candles.slice(-Math.max(lookback, period * 2 + 1));
    if (data.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    const high = data.map(c => c.high);
    const low = data.map(c => c.low);
    const close = data.map(c => c.close);
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < data.length; i++) {
        const h = high[i], l = low[i], pc = close[i - 1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - high[i - 1];
        const down = low[i - 1] - l;
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let plus = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
    let minus = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
    const dxArr = [];
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        plus = (plus * (period - 1) + plusDM[i]) / period;
        minus = (minus * (period - 1) + minusDM[i]) / period;
        const plusDI = atr > 0 ? (plus / atr) * 100 : 0;
        const minusDI = atr > 0 ? (minus / atr) * 100 : 0;
        const sum = plusDI + minusDI;
        const dx = sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0;
        dxArr.push(dx);
    }
    let adx = 0;
    if (dxArr.length >= period) {
        const start = dxArr.length - period;
        let sum = 0;
        for (let i = start; i < dxArr.length; i++) sum += dxArr[i];
        adx = sum / period;
    } else if (dxArr.length > 0) adx = dxArr.reduce((a, b) => a + b, 0) / dxArr.length;
    const finalPlusDI = atr > 0 ? (plus / atr) * 100 : 0;
    const finalMinusDI = atr > 0 ? (minus / atr) * 100 : 0;
    return { adx, plusDI: finalPlusDI, minusDI: finalMinusDI };
};

const detectRSIDivergence = (candles, rsiValues, lookback = 50) => {
    if (candles.length < lookback + 14 || rsiValues.length < lookback) return null;
    const startIdx = candles.length - lookback;
    const findPeaks = (arr, getValue) => {
        const peaks = [];
        for (let i = 2; i < arr.length - 2; i++) {
            const val = getValue(arr[i]);
            const v1 = getValue(arr[i - 1]), v2 = getValue(arr[i - 2]);
            const v3 = getValue(arr[i + 1]), v4 = getValue(arr[i + 2]);
            if (val > v1 && val > v2 && val > v3 && val > v4) peaks.push({ index: i, value: val });
        }
        return peaks;
    };
    const findTroughs = (arr, getValue) => {
        const troughs = [];
        for (let i = 2; i < arr.length - 2; i++) {
            const val = getValue(arr[i]);
            const v1 = getValue(arr[i - 1]), v2 = getValue(arr[i - 2]);
            const v3 = getValue(arr[i + 1]), v4 = getValue(arr[i + 2]);
            if (val < v1 && val < v2 && val < v3 && val < v4) troughs.push({ index: i, value: val });
        }
        return troughs;
    };
    const priceSlice = candles.slice(startIdx);
    const rsiSlice = rsiValues.slice(startIdx);
    const priceHighs = findPeaks(priceSlice, c => c.high);
    const priceLows = findTroughs(priceSlice, c => c.low);
    const rsiHighs = findPeaks(rsiSlice, v => v);
    const rsiLows = findTroughs(rsiSlice, v => v);
    if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
        const p1 = priceHighs[priceHighs.length - 2];
        const p2 = priceHighs[priceHighs.length - 1];
        const r1 = rsiHighs[rsiHighs.length - 2];
        const r2 = rsiHighs[rsiHighs.length - 1];
        const drop = r1.value - r2.value;
        if (p2.value > p1.value && r2.value < r1.value && drop >= 5 && r1.value > 55) {
            return { type: 'BEARISH_REGULAR', strength: drop / r1.value };
        }
    }
    if (priceLows.length >= 2 && rsiLows.length >= 2) {
        const p1 = priceLows[priceLows.length - 2];
        const p2 = priceLows[priceLows.length - 1];
        const r1 = rsiLows[rsiLows.length - 2];
        const r2 = rsiLows[rsiLows.length - 1];
        const rise = r2.value - r1.value;
        if (p2.value < p1.value && r2.value > r1.value && rise >= 5 && r1.value < 45) {
            return { type: 'BULLISH_REGULAR', strength: rise / r1.value };
        }
    }
    return null;
};

const updateSwingPoints = (state) => {
    const candles = state.candles1H || [];
    if (candles.length < 7) return;
    const c1 = candles[candles.length - 7];
    const c2 = candles[candles.length - 6];
    const c3 = candles[candles.length - 5];
    const c4 = candles[candles.length - 4];
    const c5 = candles[candles.length - 3];
    const c6 = candles[candles.length - 2];
    const c7 = candles[candles.length - 1];
    if (c4.high > c1.high && c4.high > c2.high && c4.high > c3.high && 
        c4.high > c5.high && c4.high > c6.high && c4.high > c7.high) {
        state.swingHighs.push(c4.high);
        if (state.swingHighs.length > 20) state.swingHighs.shift();
    }
    if (c4.low < c1.low && c4.low < c2.low && c4.low < c3.low && 
        c4.low < c5.low && c4.low < c6.low && c4.low < c7.low) {
        state.swingLows.push(c4.low);
        if (state.swingLows.length > 20) state.swingLows.shift();
    }
};

const detectHTFStructure = (candles4H, bullishVelas = 3, bearishVelas = 6) => {
    if (!candles4H || candles4H.length < 55) return { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity };
    const closes = candles4H.map(c => c.close);
    const ema200Arr = calcEMA(closes, 200);
    const lastBull = closes.slice(-bullishVelas);
    const lastBear = closes.slice(-bearishVelas);
    const ema200Bull = ema200Arr.slice(-bullishVelas);
    const ema200Bear = ema200Arr.slice(-bearishVelas);
    const allAbove = lastBull.every((c, i) => c > ema200Bull[i]);
    const allBelow = lastBear.every((c, i) => c < ema200Bear[i]);
    let bias = 'NEUTRAL';
    if (allBelow) bias = 'BEARISH';
    else if (allAbove) bias = 'BULLISH';
    return { bias, lastSwingHigh: Math.max(...candles4H.map(c => c.high)), lastSwingLow: Math.min(...candles4H.map(c => c.low)) };
};

const checkLateralMarket = (adxValue, threshold = 20) => adxValue < threshold;

const checkDerivativesFilter = (fundingRate, oiDelta) => {
    if (fundingRate > 0.0020) return { allow: false, reason: 'Funding extremamente positivo (>0.2%)' };
    if (fundingRate < -0.0020) return { allow: false, reason: 'Funding extremamente negativo (<-0.2%)' };
    if (Math.abs(oiDelta) > 20) return { allow: false, reason: 'OI Delta extremo (>20%)' };
    return { allow: true, reason: 'OK' };
};

const detectVolumeAnomaly = (candles, period = 20, threshold = 1.5) => {
    if (candles.length < period) return null;
    const volumes = candles.map(c => c.volume);
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const last = volumes[volumes.length - 1];
    const ratio = avg > 0 ? last / avg : 1;
    if (ratio > threshold) return { type: 'HIGH', ratio };
    if (ratio < 1 / threshold) return { type: 'LOW', ratio };
    return null;
};

const KellyPositionSize = (winRate, rr) => {
    if (winRate <= 0 || winRate >= 1) return 0.02;
    if (rr <= 0) return 0.02;
    const k = (winRate * (rr + 1) - 1) / rr;
    return Math.min(Math.max(k, 0.01), 0.1);
};

const computeScore = (symbol, assetsData, liqMap, adxThreshold) => {
    const data = assetsData[symbol];
    if (!data) return { score: 50, direction: 'NEUTRAL', components: {}, blockReason: 'Sem dados' };
    const base = 50;
    const mtfScore = data.mtfConfluence?.score || 0;
    const adxRaw = data.adx;
    const adxValue = typeof adxRaw === 'object' ? (adxRaw?.adx || 0) : (adxRaw || 0);
    const rsi = data.rsi_1H || 50;
    let score = base;
    if (mtfScore > 0) score += 15;
    else if (mtfScore < 0) score -= 15;
    if (adxValue > adxThreshold) {
        score += (mtfScore > 0 ? 10 : (mtfScore < 0 ? -10 : 0));
    }
    if (rsi > 75) score -= 15;
    if (rsi < 25) score += 15;
    let clamped = Math.max(0, Math.min(100, score));
    const isLateral = checkLateralMarket(adxValue, adxThreshold);
    let blockReason = null;
    if (isLateral) {
        clamped = Math.max(40, Math.min(60, clamped));
        blockReason = 'Lateralização detectada';
    }
    return {
        score: clamped,
        direction: clamped >= 60 ? 'LONG' : clamped <= 40 ? 'SHORT' : 'NEUTRAL',
        components: { mtf: mtfScore > 0 ? 'ALINHADO' : 'NEUTRO', smc: 'NEUTRO', mom: adxValue > adxThreshold ? 'FORTE' : 'FRACO', of: 'NEUTRO', macro: 'NEUTRO', oi: data.oiDelta > 0 ? 'CRESCENDO' : 'DIMINUINDO' },
        blockReason
    };
};

// ============================================================
// FETCH FUNCTIONS
// ============================================================
const fetchWithRetry = async (url, opts = {}, retries = 5) => {
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

const fetchHistoricalCandlesPaged = async (symbol, interval, startTime, endTime, limit = 1000) => {
    let all = [];
    let currentStart = startTime;
    let attempt = 0;
    while (currentStart < endTime && attempt < 30) {
        attempt++;
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=${limit}`;
        try {
            const data = await fetchWithRetry(url, {}, 3);
            if (!data || data.length === 0) break;
            const mapped = data.map(k => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            all = all.concat(mapped);
            const lastTime = mapped[mapped.length - 1].time;
            if (lastTime >= endTime) break;
            currentStart = lastTime + 1;
            const callCount = Math.ceil((currentStart - startTime) / (limit * 24 * 60 * 60 * 1000));
            const delay = Math.min(100 + callCount * 30, 500);
            await new Promise(r => setTimeout(r, delay));
        } catch (e) {
            console.warn(`Falha na paginação (${attempt}), tentando fallback...`);
            try {
                const fallbackUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
                const fallbackData = await fetchWithRetry(fallbackUrl, {}, 3);
                if (fallbackData && fallbackData.length > 0) {
                    const mapped = fallbackData.map(k => ({
                        time: k[0],
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4]),
                        volume: parseFloat(k[5])
                    }));
                    const filtered = mapped.filter(c => c.time >= startTime && c.time <= endTime);
                    all = all.concat(filtered);
                    console.log(`Fallback obteve ${filtered.length} velas.`);
                }
            } catch (fb) { /* ignora */ }
            break;
        }
    }
    return all;
};

const fetchHistoricalFunding = async (symbol, startTime, endTime) => {
    let all = [];
    let currentStart = startTime;
    const limit = 1000;
    while (currentStart < endTime) {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${currentStart}&endTime=${endTime}&limit=${limit}`;
        try {
            const data = await fetchWithRetry(url, {}, 3);
            if (!data || data.length === 0) break;
            const mapped = data.map(d => ({ time: d.fundingTime, rate: parseFloat(d.fundingRate) }));
            all = all.concat(mapped);
            const lastTime = mapped[mapped.length - 1].time;
            if (lastTime >= endTime) break;
            currentStart = lastTime + 1;
            const delay = Math.min(100 + Math.ceil((currentStart - startTime) / (limit * 8 * 60 * 60 * 1000)) * 30, 500);
            await new Promise(r => setTimeout(r, delay));
        } catch (e) { break; }
    }
    return all;
};

const fetchHistoricalOI = async (symbol, startTime, endTime) => {
    let all = [];
    let currentStart = startTime;
    const limit = 500;
    while (currentStart < endTime) {
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&startTime=${currentStart}&endTime=${endTime}&limit=${limit}`;
        try {
            const data = await fetchWithRetry(url, {}, 3);
            if (!data || data.length === 0) break;
            const mapped = data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) }));
            all = all.concat(mapped);
            const lastTime = mapped[mapped.length - 1].time;
            if (lastTime >= endTime) break;
            currentStart = lastTime + 1;
            const delay = Math.min(100 + Math.ceil((currentStart - startTime) / (limit * 60 * 60 * 1000)) * 30, 500);
            await new Promise(r => setTimeout(r, delay));
        } catch (e) { break; }
    }
    return all;
};

const fetchHistoricalMVRV = async (startDate, endDate) => {
    const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=${startDate}&end_time=${endDate}&page_size=1000`;
    try {
        const data = await fetchWithRetry(url, {}, 3);
        return data?.data?.map(d => ({ time: new Date(d.time).getTime() / 1000, value: parseFloat(d.CapMVRVCur) })) || [];
    } catch (e) {
        console.warn('Falha ao obter MVRV, usando valor padrão 2.0');
        return [{ time: new Date(startDate).getTime() / 1000, value: 2.0 }];
    }
};

const findMostRecent = (arr, cond) => {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (cond(arr[i])) return arr[i];
    }
    return null;
};

// ============================================================
// IMPORTAÇÃO / EXPORTAÇÃO DE DADOS
// ============================================================
async function fetchRawData(symbol = 'BTCUSDT') {
    const days = 1000;
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;
    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);
    console.log(`[FetchRaw] Buscando ${days} dias para ${symbol}...`);
    const [candles1h, candles4h, funding, oi, mvrv] = await Promise.all([
        fetchHistoricalCandlesPaged(symbol, '1h', startTime, endTime, 1000),
        fetchHistoricalCandlesPaged(symbol, '4h', startTime, endTime, 1000),
        fetchHistoricalFunding(symbol, startTime, endTime),
        fetchHistoricalOI(symbol, startTime, endTime),
        fetchHistoricalMVRV(startDateStr, endDateStr)
    ]);
    return { candles1h, candles4h, funding, oi, mvrv };
}

function exportData() {
    const datasets = {
        candles1h: cachedData.candles1h,
        candles4h: cachedData.candles4h,
        funding: cachedData.funding,
        oi: cachedData.oi,
        mvrv: cachedData.mvrv
    };
    let exportedCount = 0;
    for (const [key, data] of Object.entries(datasets)) {
        if (data.length === 0) continue;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${key}_${new Date().toISOString().slice(0,10)}_bruto.json`;
        a.click();
        URL.revokeObjectURL(url);
        exportedCount++;
    }
    if (exportedCount === 0) {
        alert('Nenhum dado em cache para exportar.');
    } else {
        alert(`${exportedCount} arquivo(s) exportado(s).`);
    }
}

async function fetchAndExport() {
    const symbol = document.getElementById('symbolSelect').value;
    const status = document.getElementById('status');
    status.textContent = '⏳ Buscando dados de 1000 dias...';
    try {
        const data = await fetchRawData(symbol);
        cachedData.candles1h = data.candles1h;
        cachedData.candles4h = data.candles4h;
        cachedData.funding = data.funding;
        cachedData.oi = data.oi;
        cachedData.mvrv = data.mvrv;
        cachedSymbol = symbol;
        console.log(`Dados armazenados: 1h=${data.candles1h.length}, 4h=${data.candles4h.length}, funding=${data.funding.length}, OI=${data.oi.length}, MVRV=${data.mvrv.length}`);
        status.textContent = `✅ Dados de 1000 dias coletados. Exportando...`;
        exportData();
        status.textContent = `✅ Dados de 1000 dias exportados com sucesso!`;
    } catch (err) {
        console.error(err);
        status.textContent = `❌ Erro na coleta: ${err.message}`;
    }
}

function importData(files) {
    const fileMap = {
        'candles1h': 'candles1h',
        'candles4h': 'candles4h',
        'funding': 'funding',
        'oi': 'oi',
        'mvrv': 'mvrv'
    };
    const promises = [];
    for (const file of files) {
        const name = file.name.split('_')[0];
        if (fileMap[name]) {
            const p = file.text().then(text => {
                try {
                    const data = JSON.parse(text);
                    if (Array.isArray(data)) {
                        cachedData[fileMap[name]] = data;
                        console.log(`✅ ${name} importado: ${data.length} registros`);
                    }
                } catch(e) { console.warn(`Erro ao importar ${name}`, e); }
            });
            promises.push(p);
        } else {
            console.warn(`Arquivo ${file.name} ignorado.`);
        }
    }
    return Promise.all(promises);
}

// ============================================================
// BACKTEST COMPLETO
// ============================================================
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    const {
        scoreMin = 51,
        scoreMaxShort = 49,
        adxMin = 17,
        rrMin = 1.2,
        retestDistPct = 2.0,
        emaRetest = false,
        mtfRequired = true,
        ignoreBOS = false,
        ignoreRetest = false,
        requireSweep = false,
        zFundingMax = 2.0,
        zOiMax = 2.0,
        maxHoldHours = 72,
        htfBullishVelas = 3,
        diDiffMinLong = 0,
        mvrvDropPercent = 0.25,
        htfBearishVelas = 3,
        diDiffMinShort = 5,
        stopLong = 2.0,
        stopShort = 2.0,
        tp1Long = 0,
        tp1Short = 0,
        tp2Dist = 4.0,
        trailLong = 0,
        trailShort = 0,
        tp1Pct = 0,
        tp2Pct = 0,
        runnerPct = 1
    } = options;

    days = Math.min(days, 1000);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;
    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);

    console.log(`[Backtest] ${symbol} - ${days} dias`);

    let candles1h = cachedData.candles1h;
    let candles4h = cachedData.candles4h;
    let fundingHist = cachedData.funding;
    let oiHist = cachedData.oi;
    let mvrvHist = cachedData.mvrv;

    const needFetch = candles1h.length === 0 || cachedSymbol !== symbol;

    if (needFetch) {
        console.log(`Cache para ${symbol} não encontrado. Buscando dados da API...`);
        try {
            [candles1h, candles4h, fundingHist, oiHist, mvrvHist] = await Promise.all([
                fetchHistoricalCandlesPaged(symbol, '1h', startTime, endTime, 1000),
                fetchHistoricalCandlesPaged(symbol, '4h', startTime, endTime, 1000),
                fetchHistoricalFunding(symbol, startTime, endTime),
                fetchHistoricalOI(symbol, startTime, endTime),
                fetchHistoricalMVRV(startDateStr, endDateStr)
            ]);
            cachedData.candles1h = candles1h;
            cachedData.candles4h = candles4h;
            cachedData.funding = fundingHist;
            cachedData.oi = oiHist;
            cachedData.mvrv = mvrvHist;
            cachedSymbol = symbol;
            console.log(`✅ Dados para ${symbol} armazenados em cache.`);
        } catch (e) {
            return { trades: [], summary: { error: `Erro ao buscar dados: ${e.message}` } };
        }
    } else {
        console.log(`Usando dados do cache para ${symbol} (${candles1h.length} candles).`);
    }

    if (mvrvHist.length > 0) {
        const values = mvrvHist.map(m => m.value);
        console.log('📊 MVRV — min:', Math.min(...values).toFixed(2),
                    'max:', Math.max(...values).toFixed(2),
                    'média:', (values.reduce((a,b)=>a+b,0)/values.length).toFixed(2));
    } else {
        console.warn('⚠️ Nenhum dado MVRV disponível para diagnóstico.');
    }

    const filteredCandles = candles1h.filter(c => c.time >= startTime && c.time <= endTime);
    console.log(`Filtrados para o período: ${filteredCandles.length} candles`);

    const minCandles = (days >= 2) ? 50 : 20;
    if (filteredCandles.length < minCandles) {
        let msg = `Dados insuficientes: obtidos ${filteredCandles.length} velas no período, necessário ${minCandles}.`;
        if (!needFetch && cachedData.candles1h.length > 0) {
            const lastTime = cachedData.candles1h[cachedData.candles1h.length - 1]?.time;
            if (lastTime) {
                const lastDate = new Date(lastTime).toLocaleDateString();
                msg += ` O dado mais recente no cache é de ${lastDate}. `;
            }
            msg += `Por favor, clique em "Buscar e Exportar Dados Brutos (1000 dias)" para obter dados atualizados, ou reduza o número de dias.`;
        }
        return { trades: [], summary: { error: msg } };
    }

    const state = {
        candles1H: [], candles4H: candles4h || [], ema50_1H: 0, ema200_4H: 0,
        rsi_1H: 50, atr_1H: 0, atrHistory: [], swingHighs: [], swingLows: [],
        currentBOS: 'NEUTRAL', htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity },
        mtfConfluence: null, adx: 0, divergence: null, divergence4H: null,
        volumeAnomaly: null, macroBlackout: false, vwap: 0, price: 0,
        fundingRate: 0, oiDelta: 0, mvrv: null,
        mvrvHistory: [],
        fundingHistory: [], oiDeltaHistory: [], bandwidthHistory: [],
        adxRolling: [],
        volatilityFactor: 1.0
    };

    let position = null;
    let trades = [];
    let equity = 10000;
    let highWaterMark = equity;
    let winCount = 0, lossCount = 0;
    const blockStats = {};
    let totalCandlesProcessed = 0;

    // ----- UPDATE INDICADORES -----
    const updateIndicators = (candles, currentTime, bullishVelas, bearishVelas) => {
        if (candles.length < 14) return;
        const closes = candles.map(c => c.close);
        state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
        state.atr_1H = calculateATR(candles, 14);
        state.atrHistory.push(state.atr_1H);
        if (state.atrHistory.length > 100) state.atrHistory.shift();

        let avgGain = 0, avgLoss = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) avgGain += diff;
            else avgLoss += Math.abs(diff);
        }
        avgGain /= 14;
        avgLoss /= 14;
        state.rsi_1H = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

        const adxData = calculateADX(candles);
        state.adx = adxData;

        const last24 = candles.slice(-24);
        state.vwap = calculateVWAP(last24);

        const volAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
        state.volumeAnomaly = volAnomaly;

        updateSwingPoints(state);

        const relevant4H = state.candles4H.filter(c => c.time <= currentTime);
        if (relevant4H.length >= 20) {
            state.htfStructure = detectHTFStructure(relevant4H, bullishVelas, bearishVelas);
        }

        let rsiForDiv = [];
        let g = 0, l = 0;
        for (let i = 1; i < closes.length; i++) {
            const d = closes[i] - closes[i - 1];
            if (i <= 14) {
                if (d >= 0) g += d;
                else l -= d;
                if (i === 14) {
                    let ag = g / 14, al = l / 14;
                    rsiForDiv.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                }
            } else {
                const gain = d > 0 ? d : 0;
                const loss = d < 0 ? -d : 0;
                const prevR = rsiForDiv[rsiForDiv.length - 1];
                const ag = (prevR * 13 + gain) / 14;
                const al = (prevR * 13 + loss) / 14;
                rsiForDiv.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
            }
        }
        if (rsiForDiv.length > 20) {
            const div = detectRSIDivergence(candles, rsiForDiv);
            state.divergence = div;
        }

        if (relevant4H.length >= 30) {
            const closes4H = relevant4H.map(c => c.close);
            let rsi4H = [];
            let g4 = 0, l4 = 0;
            for (let i = 1; i < closes4H.length; i++) {
                const d = closes4H[i] - closes4H[i-1];
                if (i <= 14) {
                    if (d >= 0) g4 += d;
                    else l4 -= d;
                    if (i === 14) {
                        let ag = g4 / 14, al = l4 / 14;
                        rsi4H.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                    }
                } else {
                    const gain = d > 0 ? d : 0;
                    const loss = d < 0 ? -d : 0;
                    const prevR = rsi4H[rsi4H.length - 1];
                    const ag = (prevR * 13 + gain) / 14;
                    const al = (prevR * 13 + loss) / 14;
                    rsi4H.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                }
            }
            if (rsi4H.length > 20) {
                const div4H = detectRSIDivergence(relevant4H, rsi4H);
                state.divergence4H = div4H;
            }
        }

        const returns30 = candles.slice(-30).map(c => (c.close - c.open) / c.open);
        if (returns30.length > 0) {
            const std = Math.sqrt(returns30.reduce((s, r) => s + r * r, 0) / returns30.length);
            state.volatilityFactor = Math.min(Math.max(std * 2, 0.5), 2.0);
        } else {
            state.volatilityFactor = 1.0;
        }
    };

    // ----- MTF -----
    const getMTFAlignmentAtTime = (currentTime) => {
        const relevant1H = state.candles1H.filter(c => c.time <= currentTime).slice(-50);
        const relevant4H = state.candles4H.filter(c => c.time <= currentTime).slice(-50);
        if (relevant1H.length < 20 || relevant4H.length < 10) return { alinhado: false, score: 0, directions: [], alinhadoParcial: false };
        
        const getDir = (candles) => {
            if (candles.length < 20) return 'NEUTRO';
            const closes = candles.map(c => c.close);
            const ema20Arr = calcEMA(closes, 20);
            const ema50Arr = calcEMA(closes, 50);
            const ema20 = ema20Arr.slice(-1)[0];
            const ema50 = ema50Arr.slice(-1)[0];
            const ema20Prev = ema20Arr.slice(-4, -3)[0] || ema20;
            const last = closes[closes.length - 1];
            const isBull = ema20 > ema50 && last > ema20;
            const isBear = ema20 < ema50 && last < ema20;
            const slopeUp = ema20 > ema20Prev;
            const slopeDown = ema20 < ema20Prev;
            if (isBull && slopeUp) return 'BULL';
            if (isBear && slopeDown) return 'BEAR';
            return 'NEUTRO';
        };
        const dir1H = getDir(relevant1H);
        const dir4H = getDir(relevant4H);
        const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
        const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;
        const alinhadoForte = bulls === 2 || bears === 2;
        const alinhadoParcial = (dir4H === 'BULL' && dir1H !== 'BEAR') || (dir4H === 'BEAR' && dir1H !== 'BULL');
        return {
            directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
            score: bulls - bears,
            alinhado: alinhadoForte,
            alinhadoParcial: alinhadoParcial
        };
    };

    // ===== LOOP PRINCIPAL =====
    for (let i = 0; i < filteredCandles.length; i++) {
        const candle = filteredCandles[i];
        state.price = candle.close;
        state.candles1H.push(candle);
        if (state.candles1H.length > 200) state.candles1H.shift();

        const fundingAtTime = findMostRecent(fundingHist, f => f.time <= candle.time * 1000) || fundingHist[0];
        state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;
        state.fundingHistory.push(state.fundingRate);
        if (state.fundingHistory.length > 100) state.fundingHistory.shift();

        const oiAtTime = findMostRecent(oiHist, o => o.time <= candle.time * 1000) || oiHist[0];
        if (oiAtTime) {
            const oi24h = findMostRecent(oiHist, o => o.time <= (candle.time - 86400) * 1000);
            state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
        }
        state.oiDeltaHistory.push(state.oiDelta);
        if (state.oiDeltaHistory.length > 100) state.oiDeltaHistory.shift();

        const mvrvAtTime = findMostRecent(mvrvHist, m => m.time <= candle.time);
        state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;
        state.macroBlackout = false;

        if (state.mvrv !== null) {
            state.mvrvHistory.push(state.mvrv);
            if (state.mvrvHistory.length > 90) state.mvrvHistory.shift();
        }

        state.mtfConfluence = getMTFAlignmentAtTime(candle.time);

        if (state.candles1H.length >= 20) {
            updateIndicators(state.candles1H, candle.time, htfBullishVelas, htfBearishVelas);
        } else {
            continue;
        }

        // ----- FILTROS -----
        const closes = state.candles1H.slice(-20).map(c => c.close);
        if (closes.length >= 20) {
            const sma = closes.reduce((a,b) => a+b, 0) / 20;
            const variance = closes.reduce((s, v) => s + (v-sma)**2, 0) / 20;
            const stdBB = Math.sqrt(variance);
            const bandwidth = (2 * stdBB) / sma;
            state.bandwidthHistory.push(bandwidth);
            if (state.bandwidthHistory.length > 50) state.bandwidthHistory.shift();
            if (state.bandwidthHistory.length >= 20) {
                const avgBW = state.bandwidthHistory.slice(-20).reduce((a,b) => a+b, 0) / 20;
                const adxValNow = typeof state.adx === 'object' ? state.adx.adx : state.adx;
                // Filtro de mercado lateral reforçado: bloqueia se bandwidth muito baixo ou se comprimido com ADX baixo
                // Mercado lateral: ADX < 18 e bandwidth < 0.4 da média
if (bandwidth < avgBW * 0.3 || (bandwidth < avgBW * 0.4 && adxValNow < 18)) {
    blockStats['baixa_volatilidade_bb'] = (blockStats['baixa_volatilidade_bb'] || 0) + 1;
    continue;
}
                }
            }
        }

        if (state.fundingHistory.length >= 20) {
            const mean = state.fundingHistory.reduce((a,b) => a+b, 0) / state.fundingHistory.length;
            const variance = state.fundingHistory.reduce((s, v) => s + (v-mean)**2, 0) / state.fundingHistory.length;
            const std = Math.sqrt(variance);
            const z = (state.fundingRate - mean) / (std || 1);
            if (Math.abs(z) > zFundingMax) {
                blockStats[`funding_extremo_z${z.toFixed(2)}`] = (blockStats[`funding_extremo_z${z.toFixed(2)}`] || 0) + 1;
                continue;
            }
        }

        if (state.oiDeltaHistory.length >= 20) {
            const meanO = state.oiDeltaHistory.reduce((a,b) => a+b, 0) / state.oiDeltaHistory.length;
            const varO = state.oiDeltaHistory.reduce((s, v) => s + (v-meanO)**2, 0) / state.oiDeltaHistory.length;
            const stdO = Math.sqrt(varO);
            const zO = (state.oiDelta - meanO) / (stdO || 1);
            if (Math.abs(zO) > zOiMax) {
                blockStats[`oi_extremo_z${zO.toFixed(2)}`] = (blockStats[`oi_extremo_z${zO.toFixed(2)}`] || 0) + 1;
                continue;
            }
        }

        const simAssets = {
            [symbol]: {
                price: state.price,
                candles1H: state.candles1H,
                candles4H: state.candles4H,
                ema50_1H: state.ema50_1H,
                ema200_4H: state.ema200_4H,
                rsi_1H: state.rsi_1H,
                atr_1H: state.atr_1H,
                atrHistory: state.atrHistory,
                swingHighs: state.swingHighs,
                swingLows: state.swingLows,
                currentBOS: state.currentBOS,
                mtfConfluence: state.mtfConfluence,
                adx: state.adx,
                divergence: state.divergence,
                volumeAnomaly: state.volumeAnomaly,
                macroBlackout: state.macroBlackout,
                vwap: state.vwap,
                htfStructure: state.htfStructure,
                fundingRate: state.fundingRate,
                oiDelta: state.oiDelta,
                mvrv: state.mvrv
            }
        };
        const liqMap = { [symbol]: { longs: 0, shorts: 0 } };

        const scoreData = computeScore(symbol, simAssets, liqMap, adxMin);
        let score = scoreData.score;
        let direction = scoreData.direction;
        let blockReason = scoreData.blockReason;
        let primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

        // Ajuste de score flexível com divergência (permite LONG 55-60 com divergência bullish e volume)
        if (!primaryDirection && score >= 55 && score < 60 && state.divergence?.type === 'BULLISH_REGULAR' && state.volumeAnomaly?.type !== 'LOW') {
            primaryDirection = 'LONG';
        } else if (!primaryDirection && score > 40 && score <= 45 && state.divergence?.type === 'BEARISH_REGULAR' && state.volumeAnomaly?.type !== 'LOW') {
            primaryDirection = 'SHORT';
        }

        if (state.mvrvHistory.length > 0 && primaryDirection === 'SHORT' && !blockReason) {
            const mvrvPeak90d = Math.max(...state.mvrvHistory);
            const mvrvDrop = mvrvPeak90d > 0 ? (mvrvPeak90d - state.mvrv) / mvrvPeak90d : 0;
            if (mvrvDrop > mvrvDropPercent) {
                blockReason = `MVRV caiu ${(mvrvDrop*100).toFixed(1)}% do pico de 90d (limite ${(mvrvDropPercent*100).toFixed(0)}%)`;
            }
        }

        if (primaryDirection === 'LONG' && !blockReason && state.htfStructure.bias === 'BEARISH') {
            blockReason = `HTF 4H Bearish (${htfBullishVelas} velas bullish necessárias)`;
        }
        if (primaryDirection === 'SHORT' && !blockReason && state.htfStructure.bias === 'BULLISH') {
            blockReason = `HTF 4H Bullish (${htfBearishVelas} velas bearish necessárias)`;
        }

        if (primaryDirection === 'LONG' && !blockReason) {
            if ((state.adx.plusDI - state.adx.minusDI) < diDiffMinLong) {
                blockReason = `Momentum bullish insuficiente (DI+ - DI- < ${diDiffMinLong})`;
            }
        }

        if (primaryDirection === 'SHORT' && !blockReason) {
            if ((state.adx.minusDI - state.adx.plusDI) < diDiffMinShort) {
                blockReason = `Momentum bearish insuficiente (DI- - DI+ < ${diDiffMinShort})`;
            }
        }

        const prevCandle = state.candles1H.length > 1 ? state.candles1H[state.candles1H.length - 2] : null;
        const lastSwingHigh = state.swingHighs.length > 0 ? state.swingHighs[state.swingHighs.length - 1] : null;
        const lastSwingLow = state.swingLows.length > 0 ? state.swingLows[state.swingLows.length - 1] : null;
        const refHigh = lastSwingHigh || (prevCandle ? prevCandle.high : null);
        const refLow = lastSwingLow || (prevCandle ? prevCandle.low : null);
        
        const bosBull = primaryDirection === 'LONG' && refHigh !== null && candle.close > refHigh;
        const bosBear = primaryDirection === 'SHORT' && refLow !== null && candle.close < refLow;
        state.currentBOS = (bosBull || bosBear) ? 'BOS' : 'NEUTRAL';

        const adxValNow = typeof state.adx === 'object' ? state.adx.adx : state.adx;
        state.adxRolling.push(adxValNow);
        if (state.adxRolling.length > 50) state.adxRolling.shift();
        // filtro adx dinâmico
    

        if (adxValNow < adxMin && !blockReason) blockReason = `ADX < ${adxMin}`;
        if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';

        if (primaryDirection === 'LONG' && (state.adx.plusDI - state.adx.minusDI) < 0 && !blockReason) {
            blockReason = 'DI- > DI+ (Força Bearish)';
        }

        if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason)
            blockReason = 'Preço abaixo do VWAP';
        else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason)
            blockReason = 'Preço acima do VWAP';

        if (!blockReason) {
            const derivCheck = checkDerivativesFilter(state.fundingRate, state.oiDelta);
            if (!derivCheck.allow) blockReason = derivCheck.reason;
        }

        // ----- GESTÃO DE POSIÇÃO -----
        if (position) {
            const high = candle.high, low = candle.low;
            let closed = false, exitPrice = 0, reason = '';
            const volatilityFactor = state.volatilityFactor || 1.0;

            const dynamicMaxHold = (adxValNow > 30) ? maxHoldHours * 1.5 : maxHoldHours;
            const holdHours = (candle.time - position.entryTime) / 3600000;
            if (holdHours >= dynamicMaxHold) {
                exitPrice = candle.close;
                closed = true;
                reason = 'Tempo máximo excedido';
            }

            if (!closed) {
                if (position.type === 'LONG') {
                    if (high >= position.tp2 && !position.tp2Taken) {
                        position.tp2Taken = true;
                        const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                        const closeSize = position.sizeRemaining * closeFractionTP2;
                        const partialPnlPct = (position.tp2 - position.entryPrice) / position.entryPrice * 100;
                        position.partialPnlUsd += (equity * closeSize) * (partialPnlPct / 100);
                        position.partialPnlPct += partialPnlPct * closeSize;
                        equity += (equity * closeSize) * (partialPnlPct / 100);
                        if (equity > highWaterMark) highWaterMark = equity;
                        position.sizeRemaining -= closeSize;
                        position.trailingStop = Math.max(position.trailingStop, position.tp1);
                    }
                    else if (!position.partialTaken && low <= position.stop) {
                        exitPrice = position.stop; closed = true; reason = 'Stop Loss';
                    }
                    else if (high >= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        const closeSize = position.sizeRemaining * tp1Pct;
                        const partialPnlPct = (position.tp1 - position.entryPrice) / position.entryPrice * 100;
                        position.partialPnlUsd = (equity * closeSize) * (partialPnlPct / 100);
                        position.partialPnlPct = partialPnlPct * closeSize;
                        equity += position.partialPnlUsd;
                        if (equity > highWaterMark) highWaterMark = equity;
                        position.sizeRemaining -= closeSize;
                        position.trailingStop = Math.max(position.entryPrice, position.entryPrice + state.atr_1H * volatilityFactor * trailLong);
                        position.maxProfitPrice = high;
                    }
                    else if (position.partialTaken) {
                        position.maxProfitPrice = Math.max(position.maxProfitPrice || position.entryPrice, high);
                        const newStop = position.maxProfitPrice - (state.atr_1H * volatilityFactor * trailLong);
                        if (newStop > position.trailingStop) position.trailingStop = newStop;
                        if (low <= position.trailingStop) {
                            exitPrice = position.trailingStop; closed = true; reason = 'Chandelier Exit';
                        }
                    }
                } else { // SHORT
                    if (low <= position.tp2 && !position.tp2Taken) {
                        position.tp2Taken = true;
                        const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                        const closeSize = position.sizeRemaining * closeFractionTP2;
                        const partialPnlPct = (position.entryPrice - position.tp2) / position.entryPrice * 100;
                        position.partialPnlUsd += (equity * closeSize) * (partialPnlPct / 100);
                        position.partialPnlPct += partialPnlPct * closeSize;
                        equity += (equity * closeSize) * (partialPnlPct / 100);
                        if (equity > highWaterMark) highWaterMark = equity;
                        position.sizeRemaining -= closeSize;
                        position.trailingStop = Math.min(position.trailingStop, position.tp1);
                    }
                    else if (!position.partialTaken && high >= position.stop) {
                        exitPrice = position.stop; closed = true; reason = 'Stop Loss';
                    }
                    else if (low <= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        const closeSize = position.sizeRemaining * tp1Pct;
                        const partialPnlPct = (position.entryPrice - position.tp1) / position.entryPrice * 100;
                        position.partialPnlUsd = (equity * closeSize) * (partialPnlPct / 100);
                        position.partialPnlPct = partialPnlPct * closeSize;
                        equity += position.partialPnlUsd;
                        if (equity > highWaterMark) highWaterMark = equity;
                        position.sizeRemaining -= closeSize;
                        position.trailingStop = Math.min(position.entryPrice, position.entryPrice - state.atr_1H * volatilityFactor * trailShort);
                        position.maxProfitPrice = low;
                    }
                    else if (position.partialTaken) {
                        position.maxProfitPrice = Math.min(position.maxProfitPrice || position.entryPrice, low);
                        const newStop = position.maxProfitPrice + (state.atr_1H * volatilityFactor * trailShort);
                        if (newStop < position.trailingStop) position.trailingStop = newStop;
                        if (high >= position.trailingStop) {
                            exitPrice = position.trailingStop; closed = true; reason = 'Chandelier Exit';
                        }
                    }
                }
            }

            if (closed) {
                const invested = equity * position.sizeRemaining;
                const pnlPct = position.type === 'LONG'
                    ? (exitPrice - position.entryPrice) / position.entryPrice * 100
                    : (position.entryPrice - exitPrice) / position.entryPrice * 100;
                const pnlUsd = invested * (pnlPct / 100);
                equity += pnlUsd;
                if (equity > highWaterMark) highWaterMark = equity;
                
                const totalPnlUsd = pnlUsd + (position.partialPnlUsd || 0);
                const totalPnlPct = (pnlPct * position.sizeRemaining) + (position.partialPnlPct || 0);
                
                trades.push({
                    entryTime: new Date(position.entryTime).toISOString(),
                    exitTime: new Date(candle.time).toISOString(),
                    symbol,
                    direction: position.type,
                    entryPrice: position.entryPrice,
                    stopLoss: position.stop,
                    takeProfit1: position.tp1,
                    exitPrice,
                    pnlPct: totalPnlPct.toFixed(2),
                    pnlUsd: totalPnlUsd.toFixed(2),
                    durationHours: ((candle.time - position.entryTime) / 3600000).toFixed(1),
                    reason
                });
                if (totalPnlUsd > 0) winCount++;
                else lossCount++;
                position = null;
            }
        }

        // ----- ENTRADA -----
        if (!position && !blockReason && primaryDirection) {
            const atr = state.atr_1H || (state.price * 0.02);
            let smcSetup = false, sweepSetup = false, retestConfirmed = false, brokenLevel = null;
            const recentHighs = state.swingHighs.slice(-3);
            const recentLows = state.swingLows.slice(-3);

            const retestDistPctEffective = primaryDirection === 'SHORT' ? retestDistPct * 0.6 : retestDistPct;

            if (primaryDirection === 'LONG') {
                const brokenHighs = recentHighs.filter(h => h < state.price);
                if (brokenHighs.length > 0) {
                    brokenLevel = Math.max(...brokenHighs);
                    smcSetup = true;
                    const distInAtr = Math.abs(state.price - brokenLevel) / (state.atr_1H || (state.price * 0.01));
                    retestConfirmed = distInAtr < retestDistPctEffective;
                }
            } else {
                const brokenLows = recentLows.filter(l => l > state.price);
                if (brokenLows.length > 0) {
                    brokenLevel = Math.min(...brokenLows);
                    smcSetup = true;
                    const distInAtr = Math.abs(state.price - brokenLevel) / (state.atr_1H || (state.price * 0.01));
                    retestConfirmed = distInAtr < retestDistPctEffective;
                }
            }

            if (!retestConfirmed && emaRetest) {
                const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
                const emaDist = Math.abs(state.price - ema20) / (state.atr_1H || (state.price * 0.01));
                retestConfirmed = emaDist < 0.5;
                if (retestConfirmed) smcSetup = true;
            }

            if (requireSweep) {
                const lastSwingHigh = state.swingHighs.length > 0 ? state.swingHighs[state.swingHighs.length - 1] : null;
                const lastSwingLow = state.swingLows.length > 0 ? state.swingLows[state.swingLows.length - 1] : null;

                if (primaryDirection === 'SHORT' && lastSwingHigh !== null) {
                    const wickAbove = candle.high > lastSwingHigh;
                    const closeBelow = candle.close < lastSwingHigh;
                    const strongBearBody = candle.close < candle.open;
                    if (wickAbove && closeBelow && strongBearBody) {
                        sweepSetup = true;
                        brokenLevel = lastSwingHigh;
                        retestConfirmed = true;
                    }
                } else if (primaryDirection === 'LONG' && lastSwingLow !== null) {
                    const wickBelow = candle.low < lastSwingLow;
                    const closeAbove = candle.close > lastSwingLow;
                    const strongBullBody = candle.close > candle.open;
                    if (wickBelow && closeAbove && strongBullBody) {
                        sweepSetup = true;
                        brokenLevel = lastSwingLow;
                        retestConfirmed = true;
                    }
                }
            }

            const bosRequired = !ignoreBOS;
            const retestRequired = !ignoreRetest;
            const bosPassed = bosRequired ? smcSetup : true;
            const retestPassed = retestRequired ? retestConfirmed : true;
            let structureOk = (bosPassed && retestPassed) || (sweepSetup && retestPassed);

            // NOVO FILTRO: Força da vela de entrada (confirmação de microestrutura)
            if (structureOk && !blockReason) {
                const lastCandle = state.candles1H[state.candles1H.length - 1];
                const body = Math.abs(lastCandle.close - lastCandle.open);
                const range = lastCandle.high - lastCandle.low;
                const bodyRatio = range > 0 ? body / range : 0;
                const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
                const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
                
                if (primaryDirection === 'LONG') {
                    if (lastCandle.close <= lastCandle.open || bodyRatio < 0.5 || lowerWick > 0.3 * range) {
                        structureOk = false;
                        blockReason = 'Vela de entrada fraca para LONG';
                    }
                } else if (primaryDirection === 'SHORT') {
                    if (lastCandle.close >= lastCandle.open || bodyRatio < 0.5 || upperWick > 0.3 * range) {
                        structureOk = false;
                        blockReason = 'Vela de entrada fraca para SHORT';
                    }
                }
            }

            // Volume threshold dinâmico (percentil 25) + exigência extra para reteste
            const volumes = state.candles1H.slice(-20).map(c => c.volume).sort((a,b) => a - b);
            const volumeThreshold = volumes[Math.floor(0.25 * volumes.length)] || 0;
            const lastVolume = state.candles1H[state.candles1H.length - 1].volume;
            const avgVol = volumes.reduce((a,b)=>a+b,0)/volumes.length;
            const volumeOk = smcSetup ? (lastVolume >= volumeThreshold && lastVolume >= avgVol * 1.3) : true;
            const closeBreakOk = (primaryDirection === 'LONG' && candle.close > brokenLevel) ||
                                 (primaryDirection === 'SHORT' && candle.close < brokenLevel);
            if ((smcSetup && !volumeOk) || (smcSetup && !closeBreakOk)) {
                blockReason = 'volume_insuficiente_ou_fechamento_fraco';
            }

            const body = Math.abs(candle.close - candle.open);
            const range = candle.high - candle.low;
            if (range > 0 && body / range < 0.1) {
                blockReason = 'corpo_fraco_doji';
            }

            totalCandlesProcessed++;
            let reasonKey = blockReason;
            if (!blockReason && primaryDirection) {
                if (!bosPassed && !sweepSetup && !retestPassed) reasonKey = 'sem_BOS_e_retest';
                else if (!bosPassed && !sweepSetup) reasonKey = 'sem_BOS';
                else if (!retestPassed) reasonKey = 'sem_retest';
                else if (sweepSetup && !bosPassed) reasonKey = 'sweep';
                else reasonKey = 'passou_filtros';
            } else if (!blockReason && !primaryDirection) {
                reasonKey = 'score_neutro';
            }
            blockStats[reasonKey] = (blockStats[reasonKey] || 0) + 1;

            if (state.divergence4H) {
                if ((state.divergence4H.type === 'BULLISH_REGULAR' && primaryDirection === 'LONG') ||
                    (state.divergence4H.type === 'BEARISH_REGULAR' && primaryDirection === 'SHORT')) {
                    score += 8;
                }
            }

            if (structureOk && !blockReason) {
                let stop, tp1, tp2, tp3;
                const volatilityAtr = state.atr_1H * (1 + state.volatilityFactor * 0.5);

                const stopMultiplier = primaryDirection === 'LONG' ? stopLong : stopShort;
                const tp1Multiplier = primaryDirection === 'LONG' ? tp1Long : tp1Short;

                if (primaryDirection === 'LONG') {
                    const recentLows = state.swingLows.slice(-3);
                    const structLevel = (recentLows.length ? Math.min(...recentLows) : state.price * 0.98) - (atr * 0.3);
                    const atrStop = state.price - atr * stopMultiplier;
                    stop = (recentLows.length && (state.price - structLevel) <= atr * 2.5) ? structLevel : atrStop;
                    tp1 = state.price + (volatilityAtr * tp1Multiplier);
                    tp2 = state.price + (volatilityAtr * tp2Dist);
                    tp3 = state.price + (volatilityAtr * 7.0);
                } else {
                    const recentHighs = state.swingHighs.slice(-3);
                    const structLevel = (recentHighs.length ? Math.max(...recentHighs) : state.price * 1.02) + (atr * 0.3);
                    const atrStopShort = state.price + atr * stopMultiplier;
                    stop = (recentHighs.length && (structLevel - state.price) <= atr * 2.5) ? structLevel : atrStopShort;
                    tp1 = state.price - (volatilityAtr * tp1Multiplier);
                    tp2 = state.price - (volatilityAtr * tp2Dist);
                    tp3 = state.price - (volatilityAtr * 7.0);
                }

                let rrPonderado;
                if (primaryDirection === 'LONG') {
                    const ganhoPonderado = (tp1 - state.price) * 0.5 + (tp2 - state.price) * 0.3 + (tp3 - state.price) * 0.2;
                    rrPonderado = (state.price - stop) > 0 ? ganhoPonderado / (state.price - stop) : 0;
                } else {
                    const ganhoPonderado = (state.price - tp1) * 0.5 + (state.price - tp2) * 0.3 + (state.price - tp3) * 0.2;
                    rrPonderado = (stop - state.price) > 0 ? ganhoPonderado / (stop - state.price) : 0;
                }

                // R:R mínimo adaptativo: permite RR menor se stop muito apertado (< 1 ATR)
                let rrMinEffective = rrMin;
                const stopDistAtr = primaryDirection === 'LONG' ? (state.price - stop) / atr : (stop - state.price) / atr;
                if (stopDistAtr < 1.0) {
                    rrMinEffective = Math.min(rrMin, 0.8);
                }
                if (rrPonderado < rrMinEffective) continue;

                const totalTrades = winCount + lossCount;
                const winRate = totalTrades > 0 ? winCount / totalTrades : 0.5;
                const kellyPct = KellyPositionSize(winRate, rrPonderado);
                const riskFraction = Math.min(kellyPct, 0.05);
                const stopDistancePct = primaryDirection === 'LONG' ? (state.price - stop) / state.price : (stop - state.price) / state.price;
                const positionSizeUSD = (riskFraction * equity) / stopDistancePct;
                const sizeMultiplier = Math.min(positionSizeUSD / equity, 1.0);

                position = {
                    type: primaryDirection,
                    entryPrice: state.price,
                    stop: stop,
                    tp1: tp1,
                    tp2: tp2,
                    trailingStop: stop,
                    partialTaken: false,
                    tp2Taken: false,
                    sizeRemaining: sizeMultiplier,
                    partialPnlUsd: 0,
                    partialPnlPct: 0,
                    maxProfitPrice: state.price,
                    entryTime: candle.time
                };
            }
        }
    }

    // Fechamento forçado
    if (position) {
        const lastCandle = filteredCandles[filteredCandles.length - 1];
        const exitPrice = lastCandle.close;
        const invested = equity * position.sizeRemaining;
        const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        const pnlUsd = invested * (pnlPct / 100);
        equity += pnlUsd;
        const totalPnlUsd = pnlUsd + (position.partialPnlUsd || 0);
        const totalPnlPct = (pnlPct * position.sizeRemaining) + (position.partialPnlPct || 0);
        trades.push({
            entryTime: new Date(position.entryTime).toISOString(),
            exitTime: new Date(lastCandle.time).toISOString(),
            symbol,
            direction: position.type,
            entryPrice: position.entryPrice,
            stopLoss: position.stop,
            takeProfit1: position.tp1,
            exitPrice,
            pnlPct: totalPnlPct.toFixed(2),
            pnlUsd: totalPnlUsd.toFixed(2),
            durationHours: ((lastCandle.time - position.entryTime) / 3600000).toFixed(1),
            reason: 'Fechamento forçado'
        });
        if (totalPnlUsd > 0) winCount++;
        else lossCount++;
        position = null;
    }

    // Estatísticas
    const closedTrades = trades.filter(t => t.exitTime !== null && t.pnlPct !== null);
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter(t => parseFloat(t.pnlPct) > 0).length;
    const losses = totalTrades - wins;
    const winrate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const totalPnlPct = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlPct), 0);
    const totalPnlUsd = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlUsd || 0), 0);

    const grossProfit = closedTrades.filter(t => parseFloat(t.pnlPct) > 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0);
    const grossLoss = Math.abs(closedTrades.filter(t => parseFloat(t.pnlPct) < 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0));
    const profitFactor = grossLoss !== 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;

    const maxDrawdown = highWaterMark > 0 ? ((highWaterMark - equity) / highWaterMark * 100) : 0;
    const annualizedReturn = totalPnlPct !== 0 && !isNaN(totalPnlPct) ? (Math.pow(1 + totalPnlPct / 100, 365 / days) - 1) * 100 : 0;
    const equityCurve = [10000];
    let eq = 10000;
    const equityPoints = [{ x: 0, y: 10000 }];
    for (const t of trades) {
        if (t.pnlUsd !== null) {
            eq += parseFloat(t.pnlUsd);
            equityPoints.push({ x: equityPoints.length, y: eq });
        }
    }

    const summary = {
        totalTrades,
        wins,
        losses,
        winrate,
        totalPnlPct,
        totalPnlUsd,
        avgWin,
        avgLoss,
        profitFactor,
        maxDrawdown,
        annualizedReturn,
        initialEquity: 10000,
        finalEquity: equity,
        blockStats,
        totalCandlesProcessed,
        equityCurve: equityPoints
    };

    return { trades, summary };
}

// ============================================================
// GERAR RELATÓRIO
// ============================================================
function generateReport(trades, summary, symbol, days, params) {
    if (!trades || trades.length === 0) {
        alert('Nenhum trade para gerar relatório. Execute o backtest primeiro.');
        return;
    }

    const closed = trades.filter(t => t.exitTime !== null && t.pnlPct !== null);
    if (closed.length === 0) {
        alert('Nenhum trade fechado para gerar relatório.');
        return;
    }

    const winrate = summary.winrate;
    const totalPnlPct = summary.totalPnlPct;
    const totalPnlUsd = summary.totalPnlUsd;
    const profitFactor = summary.profitFactor;
    const maxDrawdown = summary.maxDrawdown;
    const annualizedReturn = summary.annualizedReturn;

    const longs = closed.filter(t => t.direction === 'LONG');
    const shorts = closed.filter(t => t.direction === 'SHORT');
    const longWins = longs.filter(t => parseFloat(t.pnlPct) > 0).length;
    const shortWins = shorts.filter(t => parseFloat(t.pnlPct) > 0).length;
    const longWinrate = longs.length > 0 ? (longWins / longs.length * 100) : 0;
    const shortWinrate = shorts.length > 0 ? (shortWins / shorts.length * 100) : 0;
    const longPnl = longs.reduce((s, t) => s + parseFloat(t.pnlPct), 0);
    const shortPnl = shorts.reduce((s, t) => s + parseFloat(t.pnlPct), 0);

    const stopLossByDirection = {
        LONG: closed.filter(t => t.direction === 'LONG' && t.reason === 'Stop Loss').length,
        SHORT: closed.filter(t => t.direction === 'SHORT' && t.reason === 'Stop Loss').length
    };
    const totalByDirection = {
        LONG: longs.length,
        SHORT: shorts.length
    };
    const stopLossRate = {
        LONG: totalByDirection.LONG > 0 ? (stopLossByDirection.LONG / totalByDirection.LONG * 100) : 0,
        SHORT: totalByDirection.SHORT > 0 ? (stopLossByDirection.SHORT / totalByDirection.SHORT * 100) : 0
    };

    const reasons = {};
    closed.forEach(t => {
        const r = t.reason || 'Desconhecido';
        reasons[r] = (reasons[r] || 0) + 1;
    });

    const monthly = {};
    closed.forEach(t => {
        const month = new Date(t.entryTime).toISOString().slice(0, 7);
        if (!monthly[month]) monthly[month] = { wins: 0, losses: 0, pnl: 0, count: 0 };
        const pnl = parseFloat(t.pnlPct);
        monthly[month].pnl += pnl;
        monthly[month].count++;
        if (pnl > 0) monthly[month].wins++;
        else monthly[month].losses++;
    });
    const monthlyData = Object.entries(monthly).map(([month, data]) => ({
        month,
        pnl: data.pnl,
        count: data.count,
        winrate: data.count > 0 ? (data.wins / data.count * 100) : 0
    })).sort((a, b) => a.month.localeCompare(b.month));

    const durations = closed.map(t => parseFloat(t.durationHours)).filter(d => d > 0);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
    const minDuration = durations.length > 0 ? Math.min(...durations) : 0;

    const blockStats = summary.blockStats || {};
    const totalBlocks = Object.values(blockStats).reduce((a, b) => a + b, 0) || 1;
    const filterEffectiveness = Object.entries(blockStats)
        .map(([filter, count]) => ({ filter, count, pct: (count / totalBlocks * 100) }))
        .sort((a, b) => b.count - a.count);

    const pnlValues = closed.map(t => parseFloat(t.pnlPct));
    const avgPnl = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
    const variance = pnlValues.reduce((s, v) => s + (v - avgPnl) ** 2, 0) / pnlValues.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? avgPnl / stdDev : 0;
    const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

    const p = params || {};

    const reportHTML = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Relatório de Performance - ${symbol}</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #f5f6fa; padding: 30px; color: #2d3436; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        h1 { color: #2d3436; border-bottom: 3px solid #7c3aed; padding-bottom: 10px; }
        h2 { color: #2d3436; margin-top: 30px; border-left: 4px solid #7c3aed; padding-left: 15px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 15px; margin: 20px 0; }
        .card { background: #f8f9fa; padding: 15px; border-radius: 10px; text-align: center; border: 1px solid #e9ecef; }
        .card .label { font-size: 12px; color: #6c757d; text-transform: uppercase; }
        .card .value { font-size: 24px; font-weight: 700; }
        .params-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 10px; background: #f1f2f6; padding: 15px; border-radius: 10px; margin: 15px 0; }
        .params-grid .item { background: white; padding: 8px 12px; border-radius: 6px; border: 1px solid #dfe6e9; }
        .params-grid .item .label { font-size: 11px; color: #6c757d; }
        .params-grid .item .value { font-size: 14px; font-weight: 600; }
        .positive { color: #00b894; }
        .negative { color: #e17055; }
        table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        th, td { padding: 10px; border-bottom: 1px solid #e9ecef; text-align: left; }
        th { background: #f1f2f6; }
        .chart-container { height: 300px; margin: 20px 0; }
        .tag { display: inline-block; padding: 3px 10px; border-radius: 12px; background: #dfe6e9; font-size: 12px; margin: 2px; }
        .tag.pass { background: #d4edda; color: #155724; }
        .tag.block { background: #f8d7da; color: #721c24; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"><\/script>
    </head>
    <body>
    <div class="container">
        <h1>📊 Relatório de Performance — ${symbol}</h1>
        <p><strong>Período:</strong> Últimos ${days} dias (${new Date(Date.now() - days*24*60*60*1000).toLocaleDateString('pt-BR')} a ${new Date().toLocaleDateString('pt-BR')})</p>
        <p><strong>Trades fechados:</strong> ${closed.length}</p>

        <h2>⚙️ Parâmetros do Backtest</h2>
        <div class="params-grid">
            <div class="item"><div class="label">Score mínimo LONG</div><div class="value">${p.scoreMin ?? '--'}</div></div>
            <div class="item"><div class="label">Score máximo SHORT</div><div class="value">${p.scoreMaxShort ?? '--'}</div></div>
            <div class="item"><div class="label">ADX mínimo</div><div class="value">${p.adxMin ?? '--'}</div></div>
            <div class="item"><div class="label">R:R mínimo</div><div class="value">${p.rrMin ?? '--'}</div></div>
            <div class="item"><div class="label">Retest dist (ATR)</div><div class="value">${p.retestDistPct ?? '--'}</div></div>
            <div class="item"><div class="label">Dias</div><div class="value">${days}</div></div>
            <div class="item"><div class="label">Tempo máx. aberto (h)</div><div class="value">${p.maxHoldHours ?? '--'}</div></div>
            <div class="item"><div class="label">MVRV drop % max SHORT</div><div class="value">${p.mvrvDropPercent !== undefined ? (p.mvrvDropPercent*100).toFixed(0)+'%' : '--'}</div></div>
            <div class="item"><div class="label">HTF Bullish Velas</div><div class="value">${p.htfBullishVelas ?? '--'}</div></div>
            <div class="item"><div class="label">DI diff min LONG</div><div class="value">${p.diDiffMinLong ?? '--'}</div></div>
            <div class="item"><div class="label">HTF Bearish Velas</div><div class="value">${p.htfBearishVelas ?? '--'}</div></div>
            <div class="item"><div class="label">DI diff min SHORT</div><div class="value">${p.diDiffMinShort ?? '--'}</div></div>
            <div class="item"><div class="label">Stop LONG</div><div class="value">${p.stopLong ?? '--'}</div></div>
            <div class="item"><div class="label">Stop SHORT</div><div class="value">${p.stopShort ?? '--'}</div></div>
            <div class="item"><div class="label">TP1 LONG</div><div class="value">${p.tp1Long ?? '--'}</div></div>
            <div class="item"><div class="label">TP1 SHORT</div><div class="value">${p.tp1Short ?? '--'}</div></div>
            <div class="item"><div class="label">TP2 (ATR)</div><div class="value">${p.tp2Dist ?? '--'}</div></div>
            <div class="item"><div class="label">Trail LONG</div><div class="value">${p.trailLong ?? '--'}</div></div>
            <div class="item"><div class="label">Trail SHORT</div><div class="value">${p.trailShort ?? '--'}</div></div>
            <div class="item"><div class="label">TP1 %</div><div class="value">${p.tp1Pct !== undefined ? (p.tp1Pct*100).toFixed(0)+'%' : '--'}</div></div>
            <div class="item"><div class="label">TP2 %</div><div class="value">${p.tp2Pct !== undefined ? (p.tp2Pct*100).toFixed(0)+'%' : '--'}</div></div>
            <div class="item"><div class="label">Runner %</div><div class="value">${p.runnerPct !== undefined ? (p.runnerPct*100).toFixed(0)+'%' : '--'}</div></div>
        </div>

        <div class="grid">
            <div class="card"><div class="label">Winrate</div><div class="value ${winrate >= 50 ? 'positive' : 'negative'}">${winrate.toFixed(2)}%</div></div>
            <div class="card"><div class="label">P&L %</div><div class="value ${totalPnlPct >= 0 ? 'positive' : 'negative'}">${(totalPnlPct >= 0 ? '+' : '')}${totalPnlPct.toFixed(2)}%</div></div>
            <div class="card"><div class="label">P&L (USD)</div><div class="value ${totalPnlUsd >= 0 ? 'positive' : 'negative'}">${(totalPnlUsd >= 0 ? '+' : '')}$${totalPnlUsd.toFixed(2)}</div></div>
            <div class="card"><div class="label">Profit Factor</div><div class="value ${profitFactor >= 1 ? 'positive' : 'negative'}">${profitFactor.toFixed(2)}</div></div>
            <div class="card"><div class="label">Max Drawdown</div><div class="value negative">${maxDrawdown.toFixed(2)}%</div></div>
            <div class="card"><div class="label">Retorno Anualizado</div><div class="value ${annualizedReturn >= 0 ? 'positive' : 'negative'}">${(annualizedReturn >= 0 ? '+' : '')}${annualizedReturn.toFixed(2)}%</div></div>
            <div class="card"><div class="label">Sharpe Ratio</div><div class="value">${sharpe.toFixed(2)}</div></div>
            <div class="card"><div class="label">Calmar Ratio</div><div class="value">${calmar.toFixed(2)}</div></div>
        </div>

        <h2>📈 Distribuição por Direção</h2>
        <div class="grid">
            <div class="card"><div class="label">Longs</div><div class="value">${longs.length}</div><div>Winrate: ${longWinrate.toFixed(2)}%</div><div>P&L: ${longPnl.toFixed(2)}%</div></div>
            <div class="card"><div class="label">Shorts</div><div class="value">${shorts.length}</div><div>Winrate: ${shortWinrate.toFixed(2)}%</div><div>P&L: ${shortPnl.toFixed(2)}%</div></div>
        </div>

        <h2>🛑 Stop Loss por Direção</h2>
        <div class="grid">
            <div class="card"><div class="label">LONG Stop Loss</div><div class="value">${stopLossByDirection.LONG}</div><div>Taxa: ${stopLossRate.LONG.toFixed(1)}%</div></div>
            <div class="card"><div class="label">SHORT Stop Loss</div><div class="value">${stopLossByDirection.SHORT}</div><div>Taxa: ${stopLossRate.SHORT.toFixed(1)}%</div></div>
        </div>

        <h2>🕒 Distribuição de Duração</h2>
        <div class="grid">
            <div class="card"><div class="label">Média (h)</div><div class="value">${avgDuration.toFixed(1)}</div></div>
            <div class="card"><div class="label">Mínima (h)</div><div class="value">${minDuration.toFixed(1)}</div></div>
            <div class="card"><div class="label">Máxima (h)</div><div class="value">${maxDuration.toFixed(1)}</div></div>
        </div>

        <h2>📊 Performance Mensal</h2>
        <div class="chart-container"><canvas id="monthlyChart"></canvas></div>
        <table>
            <tr><th>Mês</th><th>Trades</th><th>Winrate</th><th>P&L %</th></tr>
            ${monthlyData.map(m => `<tr><td>${m.month}</td><td>${m.count}</td><td>${m.winrate.toFixed(1)}%</td><td class="${m.pnl >= 0 ? 'positive' : 'negative'}">${(m.pnl >= 0 ? '+' : '')}${m.pnl.toFixed(2)}%</td></tr>`).join('')}
        </table>

        <h2>🔍 Motivos de Saída</h2>
        <div>
            ${Object.entries(reasons).map(([reason, count]) => `<span class="tag">${reason}: ${count}</span>`).join(' ')}
        </div>

        <h2>🧩 Eficácia dos Filtros (Bloqueios)</h2>
        <div>
            ${filterEffectiveness.map(f => `<span class="tag ${f.filter === 'passou_filtros' ? 'pass' : 'block'}">${f.filter}: ${f.count} (${f.pct.toFixed(1)}%)</span>`).join(' ')}
        </div>

        <h2>📋 Tabela de Trades</h2>
        <table>
            <tr><th>Entrada</th><th>Dir</th><th>Preço</th><th>Stop</th><th>TP1</th><th>Saída</th><th>Motivo</th><th>P&L %</th><th>Duração (h)</th></tr>
            ${closed.map(t => `
                <tr>
                    <td>${new Date(t.entryTime).toLocaleDateString('pt-BR')}</td>
                    <td>${t.direction}</td>
                    <td>$${t.entryPrice.toFixed(2)}</td>
                    <td>$${t.stopLoss?.toFixed(2) || '--'}</td>
                    <td>$${t.takeProfit1?.toFixed(2) || '--'}</td>
                    <td>$${t.exitPrice?.toFixed(2) || '--'}</td>
                    <td>${t.reason || '--'}</td>
                    <td class="${parseFloat(t.pnlPct) >= 0 ? 'positive' : 'negative'}">${(parseFloat(t.pnlPct) >= 0 ? '+' : '')}${t.pnlPct}%</td>
                    <td>${t.durationHours || '--'}</td>
                </tr>
            `).join('')}
        </table>

        <p><small>Relatório gerado em ${new Date().toLocaleString('pt-BR')}</small></p>
    </div>
    <script>
        const ctx = document.getElementById('monthlyChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(monthlyData.map(m => m.month))},
                datasets: [{
                    label: 'P&L %',
                    data: ${JSON.stringify(monthlyData.map(m => m.pnl))},
                    backgroundColor: monthlyData.map(m => m.pnl >= 0 ? 'rgba(0,184,148,0.6)' : 'rgba(225,112,85,0.6)'),
                    borderColor: monthlyData.map(m => m.pnl >= 0 ? '#00b894' : '#e17055'),
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { grid: { color: '#dfe6e9' } } }
            }
        });
    <\/script>
    </body>
    </html>
    `;

    const blob = new Blob([reportHTML], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Relatorio_${symbol}_${new Date().toISOString().slice(0,10)}.html`;
    a.click();
    URL.revokeObjectURL(url);

    const csvRows = [
        ['Entrada', 'Direção', 'Preço Entrada', 'Stop', 'TP1', 'Saída', 'Motivo', 'P&L %', 'P&L USD', 'Duração (h)']
    ];
    closed.forEach(t => {
        csvRows.push([
            t.entryTime,
            t.direction,
            t.entryPrice.toFixed(2),
            t.stopLoss?.toFixed(2) || '',
            t.takeProfit1?.toFixed(2) || '',
            t.exitPrice?.toFixed(2) || '',
            t.reason || '',
            t.pnlPct,
            t.pnlUsd || '',
            t.durationHours || ''
        ]);
    });
    const csvContent = csvRows.map(row => row.join(',')).join('\n');
    const csvBlob = new Blob([csvContent], { type: 'text/csv' });
    const csvUrl = URL.createObjectURL(csvBlob);
    const aCsv = document.createElement('a');
    aCsv.href = csvUrl;
    aCsv.download = `Trades_${symbol}_${new Date().toISOString().slice(0,10)}.csv`;
    aCsv.click();
    URL.revokeObjectURL(csvUrl);

    alert(`Relatório HTML e CSV baixados com sucesso!\nTrades: ${closed.length}`);
}

// ================= FIM DA PARTE 1 =================
// ============================================================
// UI – EVENT LISTENERS
// ============================================================
const getParam = (id) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') return el.checked;
    return parseFloat(el.value);
};

document.getElementById('runBtn').addEventListener('click', async () => {
    const btn = document.getElementById('runBtn');
    const status = document.getElementById('status');
    btn.disabled = true;
    status.textContent = '⏳ Preparando...';

    const symbol = document.getElementById('symbolSelect').value;
    let days = parseInt(document.getElementById('days').value) || 999;
    days = Math.min(days, 1000);
    document.getElementById('days').value = days;

    const params = {
        scoreMin: getParam('scoreMin'),
        scoreMaxShort: getParam('scoreMaxShort'),
        adxMin: getParam('adxMin'),
        rrMin: getParam('rrMin'),
        retestDistPct: getParam('retestDist'),
        emaRetest: getParam('emaRetest'),
        requireMTF: getParam('requireMTF'),
        requireBOS: getParam('requireBOS'),
        requireRetest: getParam('requireRetest'),
        requireSweep: getParam('requireSweep'),
        zFundingMax: 1.5,
        zOiMax: 1.5,
        maxHoldHours: getParam('maxHoldHours'),
        htfBullishVelas: getParam('htfBullishVelas'),
        diDiffMinLong: getParam('diDiffMinLong'),
        mvrvDropPercent: getParam('mvrvDropPercent') / 100,
        htfBearishVelas: getParam('htfBearishVelas'),
        diDiffMinShort: getParam('diDiffMinShort'),
        stopLong: getParam('stopLong'),
        stopShort: getParam('stopShort'),
        tp1Long: getParam('tp1Long'),
        tp1Short: getParam('tp1Short'),
        tp2Dist: getParam('tp2Dist'),
        trailLong: getParam('trailLong'),
        trailShort: getParam('trailShort'),
        tp1Pct: getParam('tp1Pct') / 100,
        tp2Pct: getParam('tp2Pct') / 100,
        runnerPct: getParam('runnerPct') / 100
    };

    try {
        const result = await runBacktest(symbol, days, params);
        lastResult = result;
        lastParams = params;
        const { trades, summary } = result;

        if (summary.error) {
            status.textContent = '❌ ' + summary.error;
            btn.disabled = false;
            return;
        }

        document.getElementById('st-trades').textContent = summary.totalTrades;
        document.getElementById('st-winrate').textContent = summary.winrate.toFixed(2) + '%';
        document.getElementById('st-winrate').className = 'value ' + (summary.winrate > 50 ? 'positive' : 'negative');
        document.getElementById('st-pnlpct').textContent = (summary.totalPnlPct >= 0 ? '+' : '') + summary.totalPnlPct.toFixed(2) + '%';
        document.getElementById('st-pnlpct').className = 'value ' + (summary.totalPnlPct >= 0 ? 'positive' : 'negative');
        document.getElementById('st-pnlusd').textContent = (summary.totalPnlUsd >= 0 ? '+' : '') + '$' + summary.totalPnlUsd.toFixed(2);
        document.getElementById('st-pnlusd').className = 'value ' + (summary.totalPnlUsd >= 0 ? 'positive' : 'negative');
        document.getElementById('st-pf').textContent = summary.profitFactor.toFixed(2);
        document.getElementById('st-pf').className = 'value ' + (summary.profitFactor >= 1 ? 'positive' : 'negative');
        document.getElementById('st-dd').textContent = summary.maxDrawdown.toFixed(2) + '%';
        document.getElementById('st-dd').className = 'value negative';
        document.getElementById('st-ann').textContent = summary.annualizedReturn.toFixed(2) + '%';
        document.getElementById('st-ann').className = 'value ' + (summary.annualizedReturn >= 0 ? 'positive' : 'negative');

        const tbody = document.getElementById('tradesBody');
        if (trades.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#6b7280;">Nenhum trade gerado.</td></tr>';
        } else {
            let html = '';
            for (const t of trades) {
                const pnl = t.pnlPct !== null ? parseFloat(t.pnlPct) : 0;
                const pnlClass = pnl > 0 ? 'positive' : (pnl < 0 ? 'negative' : '');
                html += `<tr>
                    <td>${t.entryTime}</td>
                    <td>${t.symbol}</td>
                    <td>${t.direction}</td>
                    <td>$${t.entryPrice.toFixed(2)}</td>
                    <td>$${t.stopLoss?.toFixed(2) || '--'}</td>
                    <td>$${t.takeProfit1?.toFixed(2) || '--'}</td>
                    <td>${t.exitPrice ? '$'+t.exitPrice.toFixed(2) : '--'}</td>
                    <td>${t.reason || '--'}</td>
                    <td class="${pnlClass}">${t.pnlPct !== null ? (pnl > 0 ? '+' : '') + t.pnlPct + '%' : '--'}</td>
                    <td>${t.durationHours ? t.durationHours + 'h' : '--'}</td>
                </tr>`;
            }
            tbody.innerHTML = html;
        }

        const diagDiv = document.getElementById('diagnostic');
        const statsDiv = document.getElementById('blockStats');
        if (summary.blockStats && Object.keys(summary.blockStats).length > 0) {
            diagDiv.style.display = 'block';
            const total = Object.values(summary.blockStats).reduce((a, b) => a + b, 0) || 1;
            statsDiv.innerHTML = Object.entries(summary.blockStats)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => {
                    const pct = ((count / total) * 100).toFixed(1);
                    const isPass = reason === 'passou_filtros';
                    return `<span class="tag ${isPass ? 'pass' : 'block'}">${reason}: ${count} (${pct}%)</span>`;
                }).join('');
        } else {
            diagDiv.style.display = 'none';
        }

        const equityData = summary.equityCurve || [{ x: 0, y: 10000 }];
        const ctx = document.getElementById('equityChart').getContext('2d');
        if (window.equityChartInstance) window.equityChartInstance.destroy();
        window.equityChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: equityData.map((_, i) => i),
                datasets: [{
                    label: 'Equity (USD)',
                    data: equityData.map(p => p.y),
                    borderColor: '#7c3aed',
                    backgroundColor: 'rgba(124, 58, 237, 0.1)',
                    fill: true,
                    tension: 0.2,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#e6e8eb' } } },
                scales: {
                    x: { grid: { color: '#1a1a2e' }, ticks: { color: '#6b7280' } },
                    y: { grid: { color: '#1a1a2e' }, ticks: { color: '#6b7280' } }
                }
            }
        });

        status.textContent = `✅ Concluído em ${new Date().toLocaleTimeString()} (${trades.length} trades, ${summary.totalTrades} fechados)`;

    } catch (e) {
        console.error(e);
        status.textContent = '❌ Erro: ' + e.message;
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('fetchExportBtn').addEventListener('click', fetchAndExport);

document.getElementById('importInput').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files.length === 0) return;
    await importData(files);
    document.getElementById('status').textContent = `✅ ${files.length} arquivo(s) importado(s) com sucesso.`;
    e.target.value = '';
});

document.getElementById('reportBtn').addEventListener('click', () => {
    if (!lastResult) {
        alert('Execute um backtest primeiro para gerar o relatório.');
        return;
    }
    const { trades, summary } = lastResult;
    const symbol = document.getElementById('symbolSelect').value;
    const days = parseInt(document.getElementById('days').value) || 999;
    generateReport(trades, summary, symbol, days, lastParams);
});

document.getElementById('liveModeBtn').addEventListener('click', async () => {
    const btn = document.getElementById('liveModeBtn');
    if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = null;
        btn.textContent = '🔴 Modo Live (15min)';
        btn.className = 'btn-io live';
        document.getElementById('status').textContent = '⏹️ Modo Live desativado.';
        return;
    }
    btn.textContent = '🟢 Live Ativo';
    btn.className = 'btn-io live active';
    document.getElementById('status').textContent = '🔄 Modo Live ativo – atualizando a cada 15 min...';
    
    const updateLive = async () => {
        const symbol = document.getElementById('symbolSelect').value;
        try {
            const endTime = Date.now();
            const startTime = endTime - (100 * 24 * 60 * 60 * 1000);
            const [c1h, c4h] = await Promise.all([
                fetchHistoricalCandlesPaged(symbol, '1h', startTime, endTime, 1000),
                fetchHistoricalCandlesPaged(symbol, '4h', startTime, endTime, 1000)
            ]);
            cachedData.candles1h = c1h;
            cachedData.candles4h = c4h;
            cachedSymbol = symbol;
            document.getElementById('status').textContent = `✅ Dados atualizados: ${new Date().toLocaleTimeString()}`;
        } catch(e) {
            console.error(e);
            document.getElementById('status').textContent = `❌ Erro na atualização: ${e.message}`;
        }
    };
    
    await updateLive();
    liveInterval = setInterval(updateLive, 15 * 60 * 1000);
});

// ============================================================
// ROBÔ DE SINAIS
// ============================================================
const ROBOT_ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SIGNAL_COOLDOWN_MS = 300000;
let signalRobotInterval = null;
let isRobotRunning = false;
let lastSignalTime = {};
let alertLog = JSON.parse(localStorage.getItem('alertLog')) || [];

async function sendTelegramAlert(message) {
    const TELEGRAM_TOKEN = '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k';
    const TELEGRAM_CHAT_ID = '1137196768';
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        return resp.ok;
    } catch (e) {
        console.error('Erro ao enviar Telegram:', e);
        return false;
    }
}

async function sendSignalAlert(symbol, signal) {
    const dir = signal.direction;
    const emoji = dir === 'LONG' ? '🟢' : '🔴';
    let msg = `${emoji} <b>SINAL ${dir} - ${symbol}</b>\n`;
    msg += `Score: ${signal.score}/100\n`;
    msg += `Preço: $${signal.entryPrice.toFixed(2)}\n`;
    msg += `Stop: $${signal.stop.toFixed(2)}\n`;
    const rr1 = dir === 'LONG' ? (signal.tp1 - signal.entryPrice) / (signal.entryPrice - signal.stop) : (signal.entryPrice - signal.tp1) / (signal.stop - signal.entryPrice);
    const rr2 = dir === 'LONG' ? (signal.tp2 - signal.entryPrice) / (signal.entryPrice - signal.stop) : (signal.entryPrice - signal.tp2) / (signal.stop - signal.entryPrice);
    msg += `Alvos:\n  TP1: $${signal.tp1.toFixed(2)} (R:R ${rr1.toFixed(1)})\n  TP2: $${signal.tp2.toFixed(2)} (R:R ${rr2.toFixed(1)})\n`;
    msg += `Estrutura: ${signal.rationale}\n⏰ ${new Date().toLocaleString('pt-BR')}`;
    const ok = await sendTelegramAlert(msg);
    if (ok) {
        alertLog.push({ ts: Date.now(), symbol, direction: dir, price: signal.entryPrice, score: signal.score });
        if (alertLog.length > 50) alertLog.shift();
        localStorage.setItem('alertLog', JSON.stringify(alertLog));
        updateRobotLog(`✅ Sinal ${dir} enviado para ${symbol} (Score: ${signal.score})`);
        
        // ===== ARMAZENA NO JSONBin (nuvem) =====
        await storeSignalToCloud({
            symbol,
            direction: dir,
            entryPrice: signal.entryPrice,
            stop: signal.stop,
            tp1: signal.tp1,
            tp2: signal.tp2,
            rr: signal.rr,
            score: signal.score,
            rationale: signal.rationale,
            timestamp: Date.now()
        });
    } else {
        updateRobotLog(`❌ Falha ao enviar sinal ${dir} para ${symbol}`);
    }
    return ok;
}

function updateRobotLog(message) {
    const logDiv = document.getElementById('robotLog');
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    if (message.includes('SINAL')) entry.className = 'signal';
    else if (message.includes('Falha') || message.includes('Erro')) entry.className = 'error';
    logDiv.prepend(entry);
    if (logDiv.children.length > 20) {
        logDiv.removeChild(logDiv.lastChild);
    }
}

async function checkSignal(symbol) {
    try {
        const now = Date.now();
        const startTime1h = now - 200 * 60 * 60 * 1000;
        const startTime4h = now - 200 * 4 * 60 * 60 * 1000;
        const [candles1h, candles4h, fundingHist, oiHist, mvrvHist] = await Promise.all([
            fetchHistoricalCandlesPaged(symbol, '1h', startTime1h, now, 200),
            fetchHistoricalCandlesPaged(symbol, '4h', startTime4h, now, 200),
            fetchHistoricalFunding(symbol, startTime1h, now),
            fetchHistoricalOI(symbol, startTime1h, now),
            fetchHistoricalMVRV(new Date(startTime1h).toISOString().slice(0,10), new Date(now).toISOString().slice(0,10))
        ]);

        if (candles1h.length < 50) {
            console.warn(`[Robot] Dados insuficientes para ${symbol}`);
            return null;
        }

        const state = {
            candles1H: [],
            candles4H: candles4h,
            ema50_1H: 0,
            ema200_4H: 0,
            rsi_1H: 50,
            atr_1H: 0,
            atrHistory: [],
            swingHighs: [],
            swingLows: [],
            currentBOS: 'NEUTRAL',
            htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity },
            mtfConfluence: null,
            adx: 0,
            divergence: null,
            divergence4H: null,
            volumeAnomaly: null,
            macroBlackout: false,
            vwap: 0,
            price: 0,
            fundingRate: 0,
            oiDelta: 0,
            mvrv: null,
            mvrvHistory: [],
            fundingHistory: [],
            oiDeltaHistory: [],
            bandwidthHistory: [],
            adxRolling: [],
            volatilityFactor: 1.0
        };

        const lastCandle = candles1h[candles1h.length - 1];
        state.price = lastCandle.close;
        state.candles1H = candles1h.slice(-200);

        const updateIndicators = (candles, currentTime, bullishVelas, bearishVelas) => {
            if (candles.length < 14) return;
            const closes = candles.map(c => c.close);
            state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
            state.atr_1H = calculateATR(candles, 14);
            state.atrHistory.push(state.atr_1H);
            if (state.atrHistory.length > 100) state.atrHistory.shift();

            let avgGain = 0, avgLoss = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
                const diff = closes[i] - closes[i - 1];
                if (diff > 0) avgGain += diff;
                else avgLoss += Math.abs(diff);
            }
            avgGain /= 14;
            avgLoss /= 14;
            state.rsi_1H = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

            const adxData = calculateADX(candles);
            state.adx = adxData;

            const last24 = candles.slice(-24);
            state.vwap = calculateVWAP(last24);

            const volAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
            state.volumeAnomaly = volAnomaly;

            updateSwingPoints(state);

            const relevant4H = state.candles4H.filter(c => c.time <= currentTime);
            if (relevant4H.length >= 20) {
                state.htfStructure = detectHTFStructure(relevant4H, bullishVelas, bearishVelas);
            }

            let rsiForDiv = [];
            let g = 0, l = 0;
            for (let i = 1; i < closes.length; i++) {
                const d = closes[i] - closes[i - 1];
                if (i <= 14) {
                    if (d >= 0) g += d;
                    else l -= d;
                    if (i === 14) {
                        let ag = g / 14, al = l / 14;
                        rsiForDiv.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                    }
                } else {
                    const gain = d > 0 ? d : 0;
                    const loss = d < 0 ? -d : 0;
                    const prevR = rsiForDiv[rsiForDiv.length - 1];
                    const ag = (prevR * 13 + gain) / 14;
                    const al = (prevR * 13 + loss) / 14;
                    rsiForDiv.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                }
            }
            if (rsiForDiv.length > 20) {
                const div = detectRSIDivergence(candles, rsiForDiv);
                state.divergence = div;
            }

            if (relevant4H.length >= 30) {
                const closes4H = relevant4H.map(c => c.close);
                let rsi4H = [];
                let g4 = 0, l4 = 0;
                for (let i = 1; i < closes4H.length; i++) {
                    const d = closes4H[i] - closes4H[i-1];
                    if (i <= 14) {
                        if (d >= 0) g4 += d;
                        else l4 -= d;
                        if (i === 14) {
                            let ag = g4 / 14, al = l4 / 14;
                            rsi4H.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                        }
                    } else {
                        const gain = d > 0 ? d : 0;
                        const loss = d < 0 ? -d : 0;
                        const prevR = rsi4H[rsi4H.length - 1];
                        const ag = (prevR * 13 + gain) / 14;
                        const al = (prevR * 13 + loss) / 14;
                        rsi4H.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                    }
                }
                if (rsi4H.length > 20) {
                    const div4H = detectRSIDivergence(relevant4H, rsi4H);
                    state.divergence4H = div4H;
                }
            }

            const returns30 = candles.slice(-30).map(c => (c.close - c.open) / c.open);
            if (returns30.length > 0) {
                const std = Math.sqrt(returns30.reduce((s, r) => s + r * r, 0) / returns30.length);
                state.volatilityFactor = Math.min(Math.max(std * 2, 0.5), 2.0);
            } else {
                state.volatilityFactor = 1.0;
            }
        };

        const getMTFAlignmentAtTime = (currentTime) => {
            const relevant1H = state.candles1H.filter(c => c.time <= currentTime).slice(-50);
            const relevant4H = state.candles4H.filter(c => c.time <= currentTime).slice(-50);
            if (relevant1H.length < 20 || relevant4H.length < 10) return { alinhado: false, score: 0, directions: [], alinhadoParcial: false };
            
            const getDir = (candles) => {
                if (candles.length < 20) return 'NEUTRO';
                const closes = candles.map(c => c.close);
                const ema20Arr = calcEMA(closes, 20);
                const ema50Arr = calcEMA(closes, 50);
                const ema20 = ema20Arr.slice(-1)[0];
                const ema50 = ema50Arr.slice(-1)[0];
                const ema20Prev = ema20Arr.slice(-4, -3)[0] || ema20;
                const last = closes[closes.length - 1];
                const isBull = ema20 > ema50 && last > ema20;
                const isBear = ema20 < ema50 && last < ema20;
                const slopeUp = ema20 > ema20Prev;
                const slopeDown = ema20 < ema20Prev;
                if (isBull && slopeUp) return 'BULL';
                if (isBear && slopeDown) return 'BEAR';
                return 'NEUTRO';
            };
            const dir1H = getDir(relevant1H);
            const dir4H = getDir(relevant4H);
            const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
            const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;
            const alinhadoForte = bulls === 2 || bears === 2;
            const alinhadoParcial = (dir4H === 'BULL' && dir1H !== 'BEAR') || (dir4H === 'BEAR' && dir1H !== 'BULL');
            return {
                directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
                score: bulls - bears,
                alinhado: alinhadoForte,
                alinhadoParcial: alinhadoParcial
            };
        };

        const fundingAtTime = findMostRecent(fundingHist, f => f.time <= lastCandle.time * 1000) || fundingHist[0];
        state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;
        const oiAtTime = findMostRecent(oiHist, o => o.time <= lastCandle.time * 1000) || oiHist[0];
        if (oiAtTime) {
            const oi24h = findMostRecent(oiHist, o => o.time <= (lastCandle.time - 86400) * 1000);
            state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
        }
        const mvrvAtTime = findMostRecent(mvrvHist, m => m.time <= lastCandle.time);
        state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;
        state.mvrvHistory = mvrvHist.map(m => m.value).slice(-90);

        state.mtfConfluence = getMTFAlignmentAtTime(lastCandle.time);

        const params = {
            scoreMin: parseFloat(document.getElementById('scoreMin').value),
            scoreMaxShort: parseFloat(document.getElementById('scoreMaxShort').value),
            adxMin: parseFloat(document.getElementById('adxMin').value),
            rrMin: parseFloat(document.getElementById('rrMin').value),
            retestDistPct: parseFloat(document.getElementById('retestDist').value),
            emaRetest: document.getElementById('emaRetest').checked,
            requireMTF: document.getElementById('requireMTF').checked,
            requireBOS: document.getElementById('requireBOS').checked,
            requireRetest: document.getElementById('requireRetest').checked,
            requireSweep: document.getElementById('requireSweep').checked,
            maxHoldHours: parseFloat(document.getElementById('maxHoldHours').value),
            htfBullishVelas: parseInt(document.getElementById('htfBullishVelas').value),
            diDiffMinLong: parseFloat(document.getElementById('diDiffMinLong').value),
            mvrvDropPercent: parseFloat(document.getElementById('mvrvDropPercent').value) / 100,
            htfBearishVelas: parseInt(document.getElementById('htfBearishVelas').value),
            diDiffMinShort: parseFloat(document.getElementById('diDiffMinShort').value),
            stopLong: parseFloat(document.getElementById('stopLong').value),
            stopShort: parseFloat(document.getElementById('stopShort').value),
            tp1Long: parseFloat(document.getElementById('tp1Long').value),
            tp1Short: parseFloat(document.getElementById('tp1Short').value),
            tp2Dist: parseFloat(document.getElementById('tp2Dist').value),
            trailLong: parseFloat(document.getElementById('trailLong').value),
            trailShort: parseFloat(document.getElementById('trailShort').value),
            tp1Pct: parseFloat(document.getElementById('tp1Pct').value) / 100,
            tp2Pct: parseFloat(document.getElementById('tp2Pct').value) / 100,
            runnerPct: parseFloat(document.getElementById('runnerPct').value) / 100
        };

        updateIndicators(state.candles1H, lastCandle.time, params.htfBullishVelas, params.htfBearishVelas);

        let blockReason = null;
        const adxVal = typeof state.adx === 'object' ? state.adx.adx : state.adx;
        const scoreData = computeScore(symbol, { [symbol]: {
            price: state.price,
            candles1H: state.candles1H,
            candles4H: state.candles4H,
            ema50_1H: state.ema50_1H,
            ema200_4H: state.ema200_4H,
            rsi_1H: state.rsi_1H,
            atr_1H: state.atr_1H,
            atrHistory: state.atrHistory,
            swingHighs: state.swingHighs,
            swingLows: state.swingLows,
            currentBOS: state.currentBOS,
            mtfConfluence: state.mtfConfluence,
            adx: state.adx,
            divergence: state.divergence,
            volumeAnomaly: state.volumeAnomaly,
            macroBlackout: state.macroBlackout,
            vwap: state.vwap,
            htfStructure: state.htfStructure,
            fundingRate: state.fundingRate,
            oiDelta: state.oiDelta,
            mvrv: state.mvrv
        }}, {}, params.adxMin);

        let direction = scoreData.direction;
        let score = scoreData.score;
        blockReason = scoreData.blockReason;

        // Ajuste flexível de score
        if (direction === 'NEUTRAL' && score >= 55 && score < 60 && state.divergence?.type === 'BULLISH_REGULAR' && state.volumeAnomaly?.type !== 'LOW') {
            direction = 'LONG';
        } else if (direction === 'NEUTRAL' && score > 40 && score <= 45 && state.divergence?.type === 'BEARISH_REGULAR' && state.volumeAnomaly?.type !== 'LOW') {
            direction = 'SHORT';
        }

        if (direction === 'LONG' && score < params.scoreMin) blockReason = `Score ${score} < ${params.scoreMin}`;
        else if (direction === 'SHORT' && score > params.scoreMaxShort) blockReason = `Score ${score} > ${params.scoreMaxShort}`;

        if (direction === 'SHORT' && state.mvrvHistory.length > 0 && !blockReason) {
            const mvrvPeak90d = Math.max(...state.mvrvHistory);
            const mvrvDrop = mvrvPeak90d > 0 ? (mvrvPeak90d - state.mvrv) / mvrvPeak90d : 0;
            if (mvrvDrop > params.mvrvDropPercent) {
                blockReason = `MVRV caiu ${(mvrvDrop*100).toFixed(1)}% do pico de 90d`;
            }
        }

        if (direction === 'LONG' && !blockReason && state.htfStructure.bias === 'BEARISH') {
            blockReason = `HTF 4H Bearish (${params.htfBullishVelas} velas bullish necessárias)`;
        }
        if (direction === 'SHORT' && !blockReason && state.htfStructure.bias === 'BULLISH') {
            blockReason = `HTF 4H Bullish (${params.htfBearishVelas} velas bearish necessárias)`;
        }

        if (direction === 'LONG' && !blockReason) {
            if ((state.adx.plusDI - state.adx.minusDI) < params.diDiffMinLong) {
                blockReason = `Momentum bullish insuficiente (DI+ - DI- < ${params.diDiffMinLong})`;
            }
        }
        if (direction === 'SHORT' && !blockReason) {
            if ((state.adx.minusDI - state.adx.plusDI) < params.diDiffMinShort) {
                blockReason = `Momentum bearish insuficiente (DI- - DI+ < ${params.diDiffMinShort})`;
            }
        }

        const recentHighs = state.swingHighs.slice(-3);
        const recentLows = state.swingLows.slice(-3);
        let smcSetup = false, retestConfirmed = false;
        let brokenLevel = null;
        if (direction === 'LONG') {
            const brokenHighs = recentHighs.filter(h => h < state.price);
            if (brokenHighs.length > 0) {
                brokenLevel = Math.max(...brokenHighs);
                smcSetup = true;
                const distInAtr = Math.abs(state.price - brokenLevel) / (state.atr_1H || state.price*0.01);
                retestConfirmed = distInAtr < params.retestDistPct;
            }
        } else if (direction === 'SHORT') {
            const brokenLows = recentLows.filter(l => l > state.price);
            if (brokenLows.length > 0) {
                brokenLevel = Math.min(...brokenLows);
                smcSetup = true;
                const distInAtr = Math.abs(state.price - brokenLevel) / (state.atr_1H || state.price*0.01);
                retestConfirmed = distInAtr < params.retestDistPct;
            }
        }
        if (!retestConfirmed && params.emaRetest) {
            const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
            const emaDist = Math.abs(state.price - ema20) / (state.atr_1H || state.price*0.01);
            retestConfirmed = emaDist < 0.5;
            if (retestConfirmed) smcSetup = true;
        }

        let sweepSetup = false;
        if (params.requireSweep) {
            const lastSwingHigh = state.swingHighs.length > 0 ? state.swingHighs[state.swingHighs.length - 1] : null;
            const lastSwingLow = state.swingLows.length > 0 ? state.swingLows[state.swingLows.length - 1] : null;
            if (direction === 'SHORT' && lastSwingHigh !== null) {
                const wickAbove = lastCandle.high > lastSwingHigh;
                const closeBelow = lastCandle.close < lastSwingHigh;
                const strongBearBody = lastCandle.close < lastCandle.open;
                if (wickAbove && closeBelow && strongBearBody) {
                    sweepSetup = true;
                    retestConfirmed = true;
                }
            } else if (direction === 'LONG' && lastSwingLow !== null) {
                const wickBelow = lastCandle.low < lastSwingLow;
                const closeAbove = lastCandle.close > lastSwingLow;
                const strongBullBody = lastCandle.close > lastCandle.open;
                if (wickBelow && closeAbove && strongBullBody) {
                    sweepSetup = true;
                    retestConfirmed = true;
                }
            }
        }

        const bosPassed = params.requireBOS ? smcSetup : true;
        const retestPassed = params.requireRetest ? retestConfirmed : true;
        let structureOk = (bosPassed && retestPassed) || (sweepSetup && retestPassed);

        // Filtro de força da vela (confirmação de microestrutura)
        // NOVO FILTRO: Força da vela de entrada (confirmação de microestrutura)
if (structureOk && !blockReason) {
    const lastCandle = state.candles1H[state.candles1H.length - 1];
    const body = Math.abs(lastCandle.close - lastCandle.open);
    const range = lastCandle.high - lastCandle.low;
    const bodyRatio = range > 0 ? body / range : 0;
    const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
    
    if (primaryDirection === 'LONG') {
        if (lastCandle.close <= lastCandle.open || bodyRatio < 0.5 || lowerWick > 0.3 * range) {
            structureOk = false;
            blockReason = 'Vela de entrada fraca para LONG';
        }
    } else if (primaryDirection === 'SHORT') {
        if (lastCandle.close >= lastCandle.open || bodyRatio < 0.5 || upperWick > 0.3 * range) {
            structureOk = false;
            blockReason = 'Vela de entrada fraca para SHORT';
        }
    }
}

        if (!structureOk && !blockReason) {
            blockReason = 'Estrutura SMC não confirmada (BOS/Retest)';
        }

        if (!blockReason && smcSetup) {
            const volumesArr = state.candles1H.slice(-20).map(c => c.volume).sort((a,b)=>a-b);
            const volumeThreshold = volumesArr[Math.floor(0.25 * volumesArr.length)] || 0;
            const lastVol = state.candles1H[state.candles1H.length - 1].volume;
            const avgVol = volumesArr.reduce((a,b)=>a+b,0)/volumesArr.length;
            const volumeOk = lastVol >= volumeThreshold && lastVol >= avgVol * 1.2;
            const closeBreakOk = (direction === 'LONG' && lastCandle.close > brokenLevel) ||
                                 (direction === 'SHORT' && lastCandle.close < brokenLevel);
            if (!volumeOk) blockReason = 'Volume insuficiente';
            else if (!closeBreakOk) blockReason = 'Fechamento fraco';
        }

        const body = Math.abs(lastCandle.close - lastCandle.open);
        const range = lastCandle.high - lastCandle.low;
        if (range > 0 && body / range < 0.1 && !blockReason) {
            blockReason = 'Corpo fraco (doji)';
        }

        if (blockReason) {
            console.log(`[Robot] ${symbol} bloqueado: ${blockReason}`);
            return null;
        }

        const atr = state.atr_1H || state.price * 0.02;
        const volatilityAtr = atr * (1 + state.volatilityFactor * 0.5);
        let stop, tp1, tp2;
        if (direction === 'LONG') {
            const recentLows = state.swingLows.slice(-3);
            const structLevel = (recentLows.length ? Math.min(...recentLows) : state.price * 0.98) - (atr * 0.3);
            const atrStop = state.price - atr * params.stopLong;
            stop = (recentLows.length && (state.price - structLevel) <= atr * 2.5) ? structLevel : atrStop;
            tp1 = state.price + volatilityAtr * params.tp1Long;
            tp2 = state.price + volatilityAtr * params.tp2Dist;
        } else {
            const recentHighs = state.swingHighs.slice(-3);
            const structLevel = (recentHighs.length ? Math.max(...recentHighs) : state.price * 1.02) + (atr * 0.3);
            const atrStop = state.price + atr * params.stopShort;
            stop = (recentHighs.length && (structLevel - state.price) <= atr * 2.5) ? structLevel : atrStop;
            tp1 = state.price - volatilityAtr * params.tp1Short;
            tp2 = state.price - volatilityAtr * params.tp2Dist;
        }

        let rr;
        if (direction === 'LONG') {
            rr = (tp1 - state.price) / (state.price - stop);
        } else {
            rr = (state.price - tp1) / (stop - state.price);
        }
        // R:R adaptativo
        const stopDistAtr = direction === 'LONG' ? (state.price - stop) / atr : (stop - state.price) / atr;
        const rrMinEffective = stopDistAtr < 1.0 ? Math.min(params.rrMin, 0.8) : params.rrMin;
        if (rr < rrMinEffective) {
            console.log(`[Robot] ${symbol} R:R ${rr.toFixed(2)} < ${rrMinEffective}`);
            return null;
        }

        let rationale = '';
        if (sweepSetup) rationale = 'Liquidity Sweep + Retest';
        else if (smcSetup && retestConfirmed) rationale = 'BOS + Retest';
        else if (params.emaRetest && retestConfirmed) rationale = 'EMA Retest';
        else rationale = 'Estrutura SMC';

        return {
            direction,
            entryPrice: state.price,
            stop,
            tp1,
            tp2,
            rr,
            score,
            rationale
        };

    } catch (e) {
        console.error(`[Robot] Erro ao verificar ${symbol}:`, e);
        return null;
    }
}

async function runRobotCycle() {
    if (!isRobotRunning) return;

    updateRobotLog('🔍 Verificando sinais...');
    for (const symbol of ROBOT_ASSETS) {
        const now = Date.now();
        const lastTime = lastSignalTime[symbol] || 0;
        if (now - lastTime < SIGNAL_COOLDOWN_MS) {
            continue;
        }
        const signal = await checkSignal(symbol);
        if (signal) {
            const sent = await sendSignalAlert(symbol, signal);
            if (sent) {
                lastSignalTime[symbol] = now;
            }
        }
    }
    updateRobotLog('⏳ Próxima verificação em 15 minutos.');
}

async function startRobot() {
    if (isRobotRunning) return;
    isRobotRunning = true;
    document.getElementById('robotLed').className = 'led on';
    document.getElementById('robotStatusText').textContent = 'Robô ativo';
    document.getElementById('robotToggleBtn').textContent = '⏹️ Parar Robô';
    document.getElementById('robotToggleBtn').classList.add('active');
    updateRobotLog('🚀 Robô iniciado.');
    await runRobotCycle();
    signalRobotInterval = setInterval(runRobotCycle, 15 * 60 * 1000);
}

function stopRobot() {
    if (!isRobotRunning) return;
    isRobotRunning = false;
    if (signalRobotInterval) {
        clearInterval(signalRobotInterval);
        signalRobotInterval = null;
    }
    document.getElementById('robotLed').className = 'led off';
    document.getElementById('robotStatusText').textContent = 'Robô parado';
    document.getElementById('robotToggleBtn').textContent = '🤖 Iniciar Robô de Sinais';
    document.getElementById('robotToggleBtn').classList.remove('active');
    updateRobotLog('⏹️ Robô parado.');
}

document.getElementById('robotToggleBtn').addEventListener('click', () => {
    if (isRobotRunning) {
        stopRobot();
    } else {
        startRobot();
    }
});

setInterval(() => {
    if (!isRobotRunning) {
        document.getElementById('robotCooldown').textContent = '--';
        return;
    }
    const now = Date.now();
    let minCooldown = Infinity;
    for (const symbol of ROBOT_ASSETS) {
        const last = lastSignalTime[symbol] || 0;
        const elapsed = now - last;
        const remaining = Math.max(0, SIGNAL_COOLDOWN_MS - elapsed);
        if (remaining < minCooldown) minCooldown = remaining;
    }
    if (minCooldown === Infinity) {
        document.getElementById('robotCooldown').textContent = 'Pronto';
    } else {
        const seconds = Math.ceil(minCooldown / 1000);
        document.getElementById('robotCooldown').textContent = `${seconds}s`;
    }
}, 1000);

(function initRobotLog() {
    const logDiv = document.getElementById('robotLog');
    const alerts = JSON.parse(localStorage.getItem('alertLog')) || [];
    alerts.slice(-10).reverse().forEach(a => {
        const entry = document.createElement('div');
        entry.className = 'signal';
        entry.textContent = `[${new Date(a.ts).toLocaleTimeString()}] SINAL ${a.direction} ${a.symbol} (Score: ${a.score})`;
        logDiv.appendChild(entry);
    });
})();

// ============================================================
// TESTE DO TELEGRAM
// ============================================================
async function testTelegram() {
    const led = document.getElementById('telegramTestLed');
    const status = document.getElementById('telegramTestStatus');
    const log = document.getElementById('telegramTestLog');
    
    led.style.background = '#ffd60a';
    status.textContent = 'Enviando...';
    log.textContent = '⏳ Aguarde...';
    
    try {
        const TELEGRAM_TOKEN = '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k';
        const TELEGRAM_CHAT_ID = '1137196768';
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const message = `🧪 Teste de conexão do Telegram\n⏰ ${new Date().toLocaleString('pt-BR')}\n✅ Mensagem enviada com sucesso!`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        if (resp.ok) {
            led.style.background = '#00e896';
            status.textContent = '✅ Conectado';
            log.textContent = '✅ Mensagem enviada com sucesso!';
        } else {
            led.style.background = '#ff4d6d';
            status.textContent = '❌ Falha';
            log.textContent = `❌ Erro HTTP ${resp.status}`;
        }
    } catch (e) {
        led.style.background = '#ff4d6d';
        status.textContent = '❌ Erro';
        log.textContent = `❌ ${e.message}`;
    }
}

document.getElementById('telegramTestBtn').addEventListener('click', testTelegram);

// ============================================================
// ARMAZENAMENTO EM NUVEM (JSONBin)
// ============================================================
const JSONBIN_MASTER_KEY = '$2a$10$mbH27dVmnT4JyX.5MAbxM.KknNujEyPzfTW1Z2LnkK7Ga6rXqUE4C';
const JSONBIN_BIN_ID = '6a4c4be6da38895dfe3841c9';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

export async function storeSignalToCloud(signalData) {
    try {
        const getResp = await fetch(JSONBIN_URL, {
            headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
        });
        if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
        const current = await getResp.json();
        let signals = current?.record?.signals || [];
        signals.push({
            ...signalData,
            storedAt: new Date().toISOString()
        });
        if (signals.length > 100) signals = signals.slice(-100);
        const putResp = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_MASTER_KEY
            },
            body: JSON.stringify({ signals })
        });
        if (!putResp.ok) throw new Error(`HTTP ${putResp.status}`);
        console.log('✅ Sinal armazenado no JSONBin');
        return true;
    } catch (e) {
        console.warn('❌ Falha ao armazenar no JSONBin:', e.message);
        try {
            const localSignals = JSON.parse(localStorage.getItem('cloudSignals') || '[]');
            localSignals.push(signalData);
            localStorage.setItem('cloudSignals', JSON.stringify(localSignals.slice(-100)));
        } catch(e2) { /* ignore */ }
        return false;
    }
}

export async function fetchSignalsFromCloud() {
    try {
        const resp = await fetch(JSONBIN_URL, {
            headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return data?.record?.signals || [];
    } catch (e) {
        console.warn('❌ Falha ao buscar sinais do JSONBin:', e.message);
        return JSON.parse(localStorage.getItem('cloudSignals') || '[]');
    }
}

// ============================================================
// PERSISTÊNCIA DOS PARÂMETROS (localStorage + JSONBin)
// ============================================================
function saveParamsLocal() {
    const params = {};
    document.querySelectorAll('.params-grid input, .params-grid select').forEach(el => {
        if (el.type === 'checkbox') {
            params[el.id] = el.checked;
        } else {
            params[el.id] = el.value;
        }
    });
    localStorage.setItem('backtestParams', JSON.stringify(params));
}

function loadParamsLocal() {
    const saved = localStorage.getItem('backtestParams');
    if (!saved) return;
    try {
        const params = JSON.parse(saved);
        document.querySelectorAll('.params-grid input, .params-grid select').forEach(el => {
            if (el.id && params[el.id] !== undefined) {
                if (el.type === 'checkbox') {
                    el.checked = params[el.id];
                } else {
                    el.value = params[el.id];
                }
            }
        });
    } catch(e) { /* ignore */ }
}

async function syncParamsToCloud() {
    const params = {};
    document.querySelectorAll('.params-grid input, .params-grid select').forEach(el => {
        if (el.id) {
            if (el.type === 'checkbox') params[el.id] = el.checked;
            else params[el.id] = el.value;
        }
    });
    try {
        const getResp = await fetch(JSONBIN_URL, {
            headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
        });
        if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
        const current = await getResp.json();
        const record = current.record || {};
        record.params = params;
        const putResp = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_MASTER_KEY
            },
            body: JSON.stringify(record)
        });
        if (!putResp.ok) throw new Error(`HTTP ${putResp.status}`);
        console.log('✅ Parâmetros sincronizados com a nuvem');
    } catch (e) {
        console.warn('❌ Falha ao sincronizar parâmetros:', e.message);
    }
}

async function loadParamsFromCloud() {
    try {
        const resp = await fetch(JSONBIN_URL, {
            headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const params = data?.record?.params || {};
        document.querySelectorAll('.params-grid input, .params-grid select').forEach(el => {
            if (el.id && params[el.id] !== undefined) {
                if (el.type === 'checkbox') el.checked = params[el.id];
                else el.value = params[el.id];
            }
        });
        console.log('✅ Parâmetros carregados da nuvem');
    } catch (e) {
        console.warn('⚠️ Usando parâmetros locais');
        loadParamsLocal();
    }
}

// Inicialização: carrega parâmetros da nuvem e configura eventos de salvamento
document.addEventListener('DOMContentLoaded', async () => {
    await loadParamsFromCloud();
    document.querySelectorAll('.params-grid input, .params-grid select').forEach(el => {
        el.addEventListener('change', syncParamsToCloud);
        el.addEventListener('input', syncParamsToCloud);
        el.addEventListener('change', saveParamsLocal);
        el.addEventListener('input', saveParamsLocal);
    });
    document.getElementById('runBtn').addEventListener('click', syncParamsToCloud);
});

console.log('✅ Módulo backtest_engine.js carregado com sucesso.');
