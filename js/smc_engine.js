// js/smc_engine.js – Motor SMC+MTF v3.5.2 (Unificado)
// ============================================================
// Extraído do Backtest Engine v3.5.2 – todas as funções originais.
// ============================================================

// ----- FUNÇÕES DO INDICADOR (idênticas ao v3.5.2) -----
export const calcEMA = (data, period) => {
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

export const calculateATR = (candles, period = 14, lookback = 100) => {
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

export const calculateVWAP = (candles) => {
    if (!candles || candles.length === 0) return 0;
    let sum = 0, vol = 0;
    for (const c of candles) {
        const typical = (c.high + c.low + c.close) / 3;
        sum += typical * c.volume;
        vol += c.volume;
    }
    return vol > 0 ? sum / vol : 0;
};

export const calculateADX = (candles, period = 14, lookback = 50) => {
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

export const detectRSIDivergence = (candles, rsiValues, lookback = 50) => {
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

// ----- Fractais de Ordem 3 (versão 7 velas) -----
export const updateSwingPoints = (state) => {
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

// ----- HTF com persistência configurável -----
export const detectHTFStructure = (candles4H, bullishVelas = 3, bearishVelas = 6) => {
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
    return { 
        bias, 
        lastSwingHigh: Math.max(...candles4H.map(c => c.high)), 
        lastSwingLow: Math.min(...candles4H.map(c => c.low)) 
    };
};

export const checkLateralMarket = (adxValue, threshold = 20) => adxValue < threshold;

export const checkDerivativesFilter = (fundingRate, oiDelta) => {
    if (fundingRate > 0.0020) return { allow: false, reason: 'Funding extremamente positivo (>0.2%)' };
    if (fundingRate < -0.0020) return { allow: false, reason: 'Funding extremamente negativo (<-0.2%)' };
    if (Math.abs(oiDelta) > 20) return { allow: false, reason: 'OI Delta extremo (>20%)' };
    return { allow: true, reason: 'OK' };
};

export const detectVolumeAnomaly = (candles, period = 20, threshold = 1.5) => {
    if (candles.length < period) return null;
    const volumes = candles.map(c => c.volume);
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const last = volumes[volumes.length - 1];
    const ratio = avg > 0 ? last / avg : 1;
    if (ratio > threshold) return { type: 'HIGH', ratio };
    if (ratio < 1 / threshold) return { type: 'LOW', ratio };
    return null;
};

export const KellyPositionSize = (winRate, rr) => {
    if (winRate <= 0 || winRate >= 1) return 0.02;
    if (rr <= 0) return 0.02;
    const k = (winRate * (rr + 1) - 1) / rr;
    return Math.min(Math.max(k, 0.01), 0.1);
};

// ----- COMPUTE SCORE (v3.5.2) -----
export const computeScore = (symbol, assetsData, liqMap, adxThreshold) => {
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

// ----- CALCULATE CONFIDENCE SCORE (v3.5.2) -----
export const calculateConfidenceScore = ({ 
    mtfAligned, mtfAlignedParcial, adx, volumeAnomaly, fundingRate, 
    openInterestTrend, divergence, macroBlackout, smcStructure, 
    direction, scoreMinLong = 60, scoreMaxShort = 40 
}) => {
    let score = 50;
    const reasons = [];
    const sign = direction === 'SHORT' ? -1 : 1;
    if (mtfAligned) { score += sign * 18; reasons.push('MTF alinhado'); }
    else if (mtfAlignedParcial) { score += sign * 8; reasons.push('MTF parcialmente alinhado'); }
    else { score -= sign * 12; reasons.push('MTF desalinhado'); }
    const adxVal = typeof adx === 'object' ? adx.adx : adx;
    if (adxVal >= 25) { score += sign * 15; reasons.push(`ADX ${adxVal.toFixed(1)} forte`); }
    else if (adxVal >= 20) { score += sign * 7; reasons.push(`ADX ${adxVal.toFixed(1)} formando`); }
    else { score -= sign * 15; reasons.push(`ADX ${adxVal.toFixed(1)} lateral/fraco`); }
    if (volumeAnomaly) {
        if (volumeAnomaly.type === 'HIGH') { score += sign * 10; reasons.push('Volume alto'); }
        else if (volumeAnomaly.type === 'LOW') { score -= sign * 5; reasons.push('Volume baixo'); }
    }
    if (smcStructure === 'BOS') { score += sign * 5; reasons.push('BOS confirmado'); }
    const FUNDING_PENALTY = 18;
    const FUNDING_BONUS = 8;
    if (direction === 'LONG') {
        if (fundingRate > 0.0006) { score -= FUNDING_PENALTY; reasons.push('Funding elevado (LONG)'); }
        else if (fundingRate < 0) { score += FUNDING_BONUS; reasons.push('Funding negativo (LONG)'); }
    } else if (direction === 'SHORT') {
        if (fundingRate < -0.0006) { score -= FUNDING_PENALTY; reasons.push('Funding negativo (SHORT)'); }
        else if (fundingRate > 0) { score += FUNDING_BONUS; reasons.push('Funding positivo (SHORT)'); }
    }
    if (divergence) {
        if (divergence.type === 'BULLISH_REGULAR' && direction === 'LONG') { score += 15; reasons.push('Divergência RSI altista confirmada'); }
        else if (divergence.type === 'BEARISH_REGULAR' && direction === 'SHORT') { score += 15; reasons.push('Divergência RSI baixista confirmada'); }
    }
    if (macroBlackout) { score -= 20; reasons.push('Macro blackout'); }
    if (openInterestTrend === 'INCREASING' && direction === 'LONG') { score += 5; reasons.push('OI crescente LONG'); }
    else if (openInterestTrend === 'DECREASING' && direction === 'SHORT') { score += 5; reasons.push('OI decrescente SHORT'); }
    score = Math.min(100, Math.max(0, score));
    let level = 'MEDIUM';
    if (score >= 75) level = 'VERY_HIGH';
    else if (score >= 60) level = 'HIGH';
    else if (score >= 40) level = 'MEDIUM';
    else if (score >= 20) level = 'LOW';
    else level = 'VERY_LOW';
    let finalDirection = 'NEUTRO';
    if (score >= scoreMinLong) finalDirection = 'LONG';
    else if (score <= scoreMaxShort) finalDirection = 'SHORT';
    return { score, level, direction: finalDirection, reasons };
};

// ----- MTF com Slope (versão v3.5.2) -----
export const getMTFAlignmentAtTime = (candles1H, candles4H, currentTime) => {
    const relevant1H = candles1H.filter(c => c.time <= currentTime).slice(-50);
    const relevant4H = candles4H.filter(c => c.time <= currentTime).slice(-50);
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

// ===== FUNÇÃO DE BACKTEST (completa, do v3.5.2) =====
// Esta função espera que os dados já estejam em cache (cachedData).
// Para integração, vamos adaptar para receber os dados como parâmetro.
export async function runBacktestEngine(symbol, days, options, cachedData) {
    const {
        scoreMin = 68,
        scoreMaxShort = 32,
        adxMin = 22,
        rrMin = 1.8,
        retestDistPct = 2.0,
        emaRetest = false,
        mtfRequired = true,
        ignoreBOS = false,
        ignoreRetest = false,
        requireSweep = false,
        zFundingMax = 1.5,
        zOiMax = 1.5,
        maxHoldHours = 72,
        htfBullishVelas = 3,
        diDiffMinLong = 0,
        mvrvDropPercent = 0.15,
        htfBearishVelas = 6,
        diDiffMinShort = 5,
        stopLong = 1.5,
        stopShort = 2.0,
        tp1Long = 2.0,
        tp1Short = 1.5,
        tp2Dist = 4.0,
        trailLong = 1.2,
        trailShort = 1.5,
        tp1Pct = 0.4,
        tp2Pct = 0.4,
        runnerPct = 0.2
    } = options;

    days = Math.min(days, 1000);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;
    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);

    console.log(`[Backtest] ${symbol} - ${days} dias`);

    let candles1h = cachedData.candles1h || [];
    let candles4h = cachedData.candles4h || [];
    let fundingHist = cachedData.funding || [];
    let oiHist = cachedData.oi || [];
    let mvrvHist = cachedData.mvrv || [];

    // Se não houver dados em cache, buscar da API (aqui você pode chamar funções de fetch)
    // Para simplificar, assumimos que os dados já estão carregados.
    // Se necessário, adicione a lógica de busca aqui.

    const filteredCandles = candles1h.filter(c => c.time >= startTime && c.time <= endTime);
    console.log(`Filtrados para o período: ${filteredCandles.length} candles`);

    const minCandles = (days >= 2) ? 50 : 20;
    if (filteredCandles.length < minCandles) {
        return { trades: [], summary: { error: `Dados insuficientes: ${filteredCandles.length} velas, necessário ${minCandles}.` } };
    }

    // ===== ESTADO =====
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

    // ===== UPDATE INDICADORES (v3.5.2) =====
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

    // ===== LOOP PRINCIPAL =====
    const findMostRecent = (arr, cond) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (cond(arr[i])) return arr[i];
        }
        return null;
    };

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

        state.mtfConfluence = getMTFAlignmentAtTime(state.candles1H, state.candles4H, candle.time);

        if (state.candles1H.length >= 20) {
            updateIndicators(state.candles1H, candle.time, htfBullishVelas, htfBearishVelas);
        } else {
            continue;
        }

        // ----- FILTROS (bandwidth, funding, OI) -----
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
                if (bandwidth < avgBW * 0.6) {
                    blockStats['baixa_volatilidade_bb'] = (blockStats['baixa_volatilidade_bb'] || 0) + 1;
                    continue;
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

        // ===== SCORE E DECLARAÇÕES =====
        const scoreData = computeScore(symbol, simAssets, liqMap, adxMin);
        let score = scoreData.score;
        let direction = scoreData.direction;
        let blockReason = scoreData.blockReason;
        const primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

        // ===== MVRV (queda do pico de 90 dias) =====
        if (state.mvrvHistory.length > 0 && primaryDirection === 'SHORT' && !blockReason) {
            const mvrvPeak90d = Math.max(...state.mvrvHistory);
            const mvrvDrop = mvrvPeak90d > 0 ? (mvrvPeak90d - state.mvrv) / mvrvPeak90d : 0;
            if (mvrvDrop > mvrvDropPercent) {
                blockReason = `MVRV caiu ${(mvrvDrop*100).toFixed(1)}% do pico de 90d (limite ${(mvrvDropPercent*100).toFixed(0)}%)`;
            }
        }

        // ===== HTF UNIFICADO =====
        if (primaryDirection === 'LONG' && !blockReason && state.htfStructure.bias === 'BEARISH') {
            blockReason = `HTF 4H Bearish (${htfBullishVelas} velas bullish necessárias)`;
        }
        if (primaryDirection === 'SHORT' && !blockReason && state.htfStructure.bias === 'BULLISH') {
            blockReason = `HTF 4H Bullish (${htfBearishVelas} velas bearish necessárias)`;
        }

        // ===== DI diff =====
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

        // ===== BOS EM TEMPO REAL =====
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

        if (state.adxRolling.length >= 20) {
            const avgAdx = state.adxRolling.reduce((a,b) => a+b, 0) / state.adxRolling.length;
            const dynamicAdxThreshold = Math.max(avgAdx * 0.8 + 5, 18);
            if (adxValNow < dynamicAdxThreshold) {
                blockReason = `ADX ${adxValNow.toFixed(1)} < dinâmico ${dynamicAdxThreshold.toFixed(1)}`;
            }
        }

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

        // ===== GESTÃO DE POSIÇÃO (Chandelier Exit) =====
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

        // ----- ENTRADA (com Liquidity Sweep) -----
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
            const structureOk = (bosPassed && retestPassed) || (sweepSetup && retestPassed);

            const volumeAvg = state.candles1H.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
            const volumeOk = smcSetup ? state.candles1H[state.candles1H.length - 1].volume >= volumeAvg * 1.3 : true;
            const closeBreakOk = (primaryDirection === 'LONG' && candle.close > brokenLevel) ||
                                 (primaryDirection === 'SHORT' && candle.close < brokenLevel);
            if ((smcSetup && !volumeOk) || (smcSetup && !closeBreakOk)) {
                blockReason = 'volume_insuficiente_ou_fechamento_fraco';
            }

            const body = Math.abs(candle.close - candle.open);
            const range = candle.high - candle.low;
            if (range > 0 && body / range < 0.5) {
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

                if (rrPonderado < rrMin) continue;

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

    // ===== FECHAMENTO FORÇADO =====
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

    // ===== ESTATÍSTICAS =====
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
