// ================================================================
// js/indicadores.js – Motor de indicadores V2 (OTIMIZADO)
// ================================================================

// ===== FUNÇÕES AUXILIARES BÁSICAS =====

/**
 * Cálculo de EMA (Exponential Moving Average)
 */
export function calcEMA(data, period) {
    if (!data || data.length === 0) return [];
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = data[0];
    result.push(ema);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
        result.push(ema);
    }
    return result;
}

/**
 * Cálculo de ATR (Average True Range) com janela deslizante (lookback)
 */
export function calculateATR(candles, period = 14, lookback = 100) {
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
}

/**
 * Cálculo de VWAP (Volume Weighted Average Price) – janela de 24h
 */
export function calculateVWAP(candles) {
    if (!candles || candles.length === 0) return 0;
    let sum = 0,
        volume = 0;
    for (const c of candles) {
        const typical = (c.high + c.low + c.close) / 3;
        sum += typical * c.volume;
        volume += c.volume;
    }
    return volume > 0 ? sum / volume : 0;
}

// ===== INDICADORES DE TENDÊNCIA E MOMENTUM =====

/**
 * ADX otimizado com janela deslizante (lookback)
 */
export function calculateADX(candles, period = 14, lookback = 50) {
    const data = candles.slice(-Math.max(lookback, period * 2 + 1));
    if (data.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

    const high = data.map(c => c.high);
    const low = data.map(c => c.low);
    const close = data.map(c => c.close);

    const tr = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < data.length; i++) {
        const h = high[i],
            l = low[i],
            pc = close[i - 1];
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
        const startIdx = dxArr.length - period;
        let sum = 0;
        for (let i = startIdx; i < dxArr.length; i++) {
            sum += dxArr[i];
        }
        adx = sum / period;
    } else if (dxArr.length > 0) {
        adx = dxArr.reduce((a, b) => a + b, 0) / dxArr.length;
    }

    const finalPlusDI = atr > 0 ? (plus / atr) * 100 : 0;
    const finalMinusDI = atr > 0 ? (minus / atr) * 100 : 0;

    return { adx, plusDI: finalPlusDI, minusDI: finalMinusDI };
}

/**
 * Divergência RSI otimizada (menos alocações)
 */
export function detectRSIDivergence(candles, rsiValues, lookback = 50) {
    if (candles.length < lookback + 14 || rsiValues.length < lookback) return null;

    const startIdx = candles.length - lookback;

    const findPeaks = (arr, getValue) => {
        const peaks = [];
        for (let i = 2; i < arr.length - 2; i++) {
            const val = getValue(arr[i]);
            const v1 = getValue(arr[i - 1]);
            const v2 = getValue(arr[i - 2]);
            const v3 = getValue(arr[i + 1]);
            const v4 = getValue(arr[i + 2]);
            if (val > v1 && val > v2 && val > v3 && val > v4) {
                peaks.push({ index: i, value: val });
            }
        }
        return peaks;
    };

    const priceSlice = candles.slice(startIdx);
    const rsiSlice = rsiValues.slice(startIdx);

    const priceHighs = findPeaks(priceSlice, c => c.high);
    const priceLows = findPeaks(priceSlice, c => c.low);
    const rsiHighs = findPeaks(rsiSlice, v => v);
    const rsiLows = findPeaks(rsiSlice, v => v);

    // Divergência de baixa (bearish)
    if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
        const p1 = priceHighs[priceHighs.length - 2];
        const p2 = priceHighs[priceHighs.length - 1];
        const r1 = rsiHighs[rsiHighs.length - 2];
        const r2 = rsiHighs[rsiHighs.length - 1];
        if (p2.value > p1.value && r2.value < r1.value) {
            return { type: 'BEARISH_REGULAR', strength: (r1.value - r2.value) / r1.value };
        }
    }

    // Divergência de alta (bullish)
    if (priceLows.length >= 2 && rsiLows.length >= 2) {
        const p1 = priceLows[priceLows.length - 2];
        const p2 = priceLows[priceLows.length - 1];
        const r1 = rsiLows[rsiLows.length - 2];
        const r2 = rsiLows[rsiLows.length - 1];
        if (p2.value < p1.value && r2.value > r1.value) {
            return { type: 'BULLISH_REGULAR', strength: (r2.value - r1.value) / r1.value };
        }
    }
    return null;
}

// ===== ESTRUTURA DE MERCADO (SMC) =====

export function updateSwingPoints(state) {
    const candles = state.candles1H || [];
    if (candles.length < 5) return;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!last || !prev) return;

    // Swing High: high > previous high and high > next high
    if (candles.length >= 5) {
        const c1 = candles[candles.length - 5];
        const c2 = candles[candles.length - 4];
        const c3 = candles[candles.length - 3];
        const c4 = candles[candles.length - 2];
        const c5 = candles[candles.length - 1];
        if (c3.high > c2.high && c3.high > c4.high) {
            state.swingHighs.push(c3.high);
            if (state.swingHighs.length > 20) state.swingHighs.shift();
        }
        if (c3.low < c2.low && c3.low < c4.low) {
            state.swingLows.push(c3.low);
            if (state.swingLows.length > 20) state.swingLows.shift();
        }
    }
}

export function detectHTFStructure(state, candles4H) {
    if (!candles4H || candles4H.length < 20) return { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity };
    const closes = candles4H.map(c => c.close);
    const ema200 = calcEMA(closes, 200).slice(-1)[0] || closes[closes.length - 1];
    const last = closes[closes.length - 1];
    const bias = last > ema200 ? 'BULLISH' : (last < ema200 ? 'BEARISH' : 'NEUTRAL');
    return { bias, lastSwingHigh: Math.max(...candles4H.map(c => c.high)), lastSwingLow: Math.min(...candles4H.map(c => c.low)) };
}

export function findSMCSetup(state, direction) {
    if (direction === 'LONG') {
        const recentLows = state.swingLows.slice(-3);
        if (recentLows.length === 0) return false;
        const lastLow = Math.min(...recentLows);
        return state.price > lastLow;
    } else if (direction === 'SHORT') {
        const recentHighs = state.swingHighs.slice(-3);
        if (recentHighs.length === 0) return false;
        const lastHigh = Math.max(...recentHighs);
        return state.price < lastHigh;
    }
    return false;
}

export function checkLateralMarket(adxValue, threshold = 25) {
    return adxValue < threshold;
}

// ===== FILTROS DE RISCO E CONDIÇÕES =====

export function checkOnChainFilter(mvrv, direction) {
    // Exemplo: MVRV baixo favorece LONG, MVRV alto favorece SHORT
    if (mvrv === null || mvrv === undefined) return { allow: true, reason: 'MVRV indisponível' };
    if (direction === 'LONG' && mvrv < 1.0) return { allow: true, reason: 'MVRV baixo (favorável)' };
    if (direction === 'SHORT' && mvrv > 1.5) return { allow: true, reason: 'MVRV alto (favorável)' };
    return { allow: false, reason: 'MVRV desfavorável' };
}

export function checkDerivativesFilter(fundingRate, oiDelta) {
    // Funding extremo: evitar LONG com funding > 0.05% ou SHORT com funding < -0.05%
    if (fundingRate > 0.0005) return { allow: false, reason: 'Funding muito positivo (overbought em futuros)' };
    if (fundingRate < -0.0005) return { allow: false, reason: 'Funding muito negativo (oversold em futuros)' };
    // OI Delta: se estiver crescendo muito rápido, evitar seguir a manada
    if (Math.abs(oiDelta) > 10) return { allow: false, reason: 'OI Delta extremo' };
    return { allow: true, reason: 'Derivativos OK' };
}

export function checkPortfolioExposure(activePositions, direction) {
    const count = Object.keys(activePositions).length;
    if (count >= 1) return { blocked: true, reason: 'Já há posição aberta' };
    // Pode adicionar lógica de exposição máxima
    return { blocked: false, reason: 'Portfólio disponível' };
}

export function isSafeToTrade() {
    // Pode adicionar verificações de horário, volatilidade, etc.
    return true;
}

export function KellyPositionSize(winRate, rr) {
    if (winRate <= 0 || winRate >= 1) return 0.02;
    if (rr <= 0) return 0.02;
    const k = (winRate * (rr + 1) - 1) / rr;
    return Math.min(Math.max(k, 0.01), 0.1);
}

// ===== ANOMALIAS DE VOLUME =====

export function detectVolumeAnomaly(candles, period = 20, threshold = 2.0) {
    if (candles.length < period) return null;
    const volumes = candles.map(c => c.volume);
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const last = volumes[volumes.length - 1];
    const ratio = avg > 0 ? last / avg : 1;
    if (ratio > threshold) {
        return { type: 'HIGH', ratio };
    } else if (ratio < 1 / threshold) {
        return { type: 'LOW', ratio };
    }
    return null;
}

// ===== SCORE E CONFIANÇA =====

export function calculateConfidenceScore({ mtfAligned, adx, volumeAnomaly, fundingRate, openInterestTrend, divergence, macroBlackout, smcStructure, direction }) {
    let score = 50;
    const reasons = [];

    // MTF alinhado: +20
    if (mtfAligned) {
        score += 20;
        reasons.push('MTF alinhado');
    } else {
        reasons.push('MTF desalinhado');
    }

    // ADX: quanto maior, mais tendência
    const adxVal = typeof adx === 'object' ? adx.adx : adx;
    if (adxVal >= 25) {
        score += 15;
        reasons.push(`ADX ${adxVal.toFixed(1)} (tendência)`);
    } else {
        score -= 10;
        reasons.push(`ADX ${adxVal.toFixed(1)} (lateral)`);
    }

    // Volume anômalo: alto volume confirma direção
    if (volumeAnomaly) {
        if (volumeAnomaly.type === 'HIGH' && direction === 'LONG') {
            score += 10;
            reasons.push('Volume alto confirma alta');
        } else if (volumeAnomaly.type === 'LOW') {
            score -= 5;
            reasons.push('Volume baixo');
        }
    }

    // Funding: extremos penalizam
    if (fundingRate > 0.01) {
        score -= 10;
        reasons.push('Funding muito positivo');
    } else if (fundingRate < -0.01) {
        score += 10;
        reasons.push('Funding negativo (favorável para LONG)');
    }

    // Divergência: +10 se favorável
    if (divergence) {
        if (divergence.type === 'BULLISH_REGULAR' && direction === 'LONG') {
            score += 10;
            reasons.push('Divergência de alta');
        } else if (divergence.type === 'BEARISH_REGULAR' && direction === 'SHORT') {
            score += 10;
            reasons.push('Divergência de baixa');
        }
    }

    // Macro blackout: penaliza
    if (macroBlackout) {
        score -= 20;
        reasons.push('Macro blackout');
    }

    // Estrutura SMC: +5 se confirmada
    if (smcStructure === 'BOS') {
        score += 5;
        reasons.push('BOS confirmado');
    }

    // Open Interest trend
    if (openInterestTrend === 'INCREASING' && direction === 'LONG') {
        score += 5;
        reasons.push('OI crescente (LONG)');
    } else if (openInterestTrend === 'DECREASING' && direction === 'SHORT') {
        score += 5;
        reasons.push('OI decrescente (SHORT)');
    }

    // Normaliza entre 0 e 100
    score = Math.min(100, Math.max(0, score));

    let level = 'MEDIUM';
    if (score >= 75) level = 'VERY_HIGH';
    else if (score >= 60) level = 'HIGH';
    else if (score >= 40) level = 'MEDIUM';
    else if (score >= 20) level = 'LOW';
    else level = 'VERY_LOW';

    // Direção final (se score >= 60 -> LONG, se <= 40 -> SHORT)
    let finalDirection = 'NEUTRO';
    if (score >= 60) finalDirection = 'LONG';
    else if (score <= 40) finalDirection = 'SHORT';

    return {
        score,
        level,
        direction: finalDirection,
        reasons
    };
}

export function computeScore(symbol, assetsData, liqMap) {
    const data = assetsData[symbol];
    if (!data) return { score: 50, direction: 'NEUTRAL', components: {}, blockReason: 'Sem dados' };
    
    const base = 50;
    const mtfScore = data.mtfConfluence?.score || 0;
    
    const adxRaw = data.adx;
    const adxValue = typeof adxRaw === 'object' ? (adxRaw?.adx || 0) : (adxRaw || 0);
    
    const rsi = data.rsi_1H || 50;
    let score = base + mtfScore * 5;
    
    // ADX apenas confirma a tendência (não força direção)
    if (adxValue > 25) {
        score += (mtfScore > 0 ? 10 : (mtfScore < 0 ? -10 : 0));
    }
    
    // CORREÇÃO: RSI alinhado com tendência (trend‑following)
    if (rsi > 70) score += 15;   // Sobrecompra → força altista → favorece LONG
    if (rsi < 30) score -= 15;   // Sobrevenda → força baixista → favorece SHORT
    
    const clamped = Math.max(0, Math.min(100, score));
    return {
        score: clamped,
        direction: clamped >= 60 ? 'LONG' : clamped <= 40 ? 'SHORT' : 'NEUTRAL',
        components: {
            mtf: mtfScore > 0 ? 'ALINHADO' : 'NEUTRO',
            smc: 'NEUTRO',
            mom: adxValue > 25 ? 'FORTE' : 'FRACO',
            of: 'NEUTRO',
            macro: 'NEUTRO',
            oi: data.oiDelta > 0 ? 'CRESCENDO' : 'DIMINUINDO'
        },
        blockReason: null
    };
}

    const blockReason = null; // pode ser preenchido com base em filtros externos

    const components = {
        mtf: mtfAligned ? '✅' : '❌',
        smc: smcStructure === 'BOS' ? '✅' : '❌',
        mom: adxVal >= 25 ? 'Forte' : 'Fraco',
        of: data.volumeAnomaly ? (data.volumeAnomaly.type === 'HIGH' ? '✅' : '⚠️') : 'ℹ️',
        macro: macroBlackout ? '⚠️' : '✅',
        oi: data.oiDelta > 5 ? '🟢' : (data.oiDelta < -5 ? '🔴' : 'ℹ️')
    };

    return {
        score: confidence.score,
        direction: confidence.direction,
        blockReason,
        components
    };


// ===== FILTROS PARA O COMITÊ E MOTOR DE ENTRADA =====

export function adxFilter(candles, threshold = 25) {
    const adxData = calculateADX(candles);
    const adx = adxData.adx;
    if (adx < threshold) return { pass: false, reason: `ADX ${adx.toFixed(1)} < ${threshold}` };
    return { pass: true, reason: `ADX ${adx.toFixed(1)}` };
}

export function fundingFilter(fundingData, direction) {
    if (!fundingData || fundingData.rate === undefined) return { pass: true, reason: 'Fundind indisponível' };
    const rate = fundingData.rate;
    if (direction === 'LONG' && rate > 0.01) {
        return { pass: false, reason: `Funding ${(rate * 100).toFixed(2)}% muito positivo` };
    }
    if (direction === 'SHORT' && rate < -0.01) {
        return { pass: false, reason: `Funding ${(rate * 100).toFixed(2)}% muito negativo` };
    }
    return { pass: true, reason: `Funding ${(rate * 100).toFixed(2)}% OK` };
}

export function orderBookFilter(obData, direction) {
    if (!obData || !obData.bids || !obData.asks) return { pass: true, reason: 'Order Book indisponível' };
    // Exemplo: se houver grande desbalanceamento, pode rejeitar
    const totalBid = obData.bids.reduce((s, b) => s + b.qty, 0);
    const totalAsk = obData.asks.reduce((s, a) => s + a.qty, 0);
    const ratio = totalAsk > 0 ? totalBid / totalAsk : 1;
    if (direction === 'LONG' && ratio < 0.8) {
        return { pass: false, reason: 'Order book com mais vendedores' };
    }
    if (direction === 'SHORT' && ratio > 1.2) {
        return { pass: false, reason: 'Order book com mais compradores' };
    }
    return { pass: true, reason: 'Order book OK' };
}

export function fearGreedFilter(fgData, direction) {
    if (!fgData || fgData.value === undefined) return { pass: true, reason: 'Fear & Greed indisponível', multiplier: 1 };
    const value = fgData.value;
    // Se extremo medo, favorece LONG (menor risco); se extrema ganância, favorece SHORT
    let multiplier = 1;
    if (direction === 'LONG' && value < 25) {
        return { pass: true, reason: `Fear & Greed ${value} (medo extremo)`, multiplier: 1.2 };
    } else if (direction === 'SHORT' && value > 75) {
        return { pass: true, reason: `Fear & Greed ${value} (ganância extrema)`, multiplier: 1.2 };
    } else if (direction === 'LONG' && value > 75) {
        return { pass: false, reason: `Fear & Greed ${value} (ganância extrema)`, multiplier: 0.8 };
    } else if (direction === 'SHORT' && value < 25) {
        return { pass: false, reason: `Fear & Greed ${value} (medo extremo)`, multiplier: 0.8 };
    }
    return { pass: true, reason: `Fear & Greed ${value} (neutro)`, multiplier: 1 };
}

// ===== TRAILING STOP E GERAÇÃO DE PARÂMETROS =====

export function generateTrailingStopParams(candles, currentPrice, direction) {
    const atr = calculateATR(candles, 14);
    if (atr === 0) return null;
    const multiplier = 2;
    const stopDistance = atr * multiplier;
    const trailingActivation = currentPrice + (direction === 'LONG' ? stopDistance * 1.5 : -stopDistance * 1.5);
    const trailingDistance = atr * 1.0;

    let stopLoss, tp1, tp2, tp3;
    if (direction === 'LONG') {
        stopLoss = currentPrice - stopDistance;
        tp1 = currentPrice + atr * 2;
        tp2 = currentPrice + atr * 4;
        tp3 = currentPrice + atr * 6;
    } else {
        stopLoss = currentPrice + stopDistance;
        tp1 = currentPrice - atr * 2;
        tp2 = currentPrice - atr * 4;
        tp3 = currentPrice - atr * 6;
    }
    return {
        stopLoss,
        tp1,
        tp2,
        tp3,
        trailingActivation,
        trailingDistance,
        atr
    };
}

// ===== SCORE DE SINAL PARA O COMITÊ =====

export function calculateSignalScore(indicators) {
    // Função usada pelo comitê (runCommittee) para gerar score rápido
    let score = 50;
    const reasons = [];
    const { close, ema20, ema50, rsi, adx, trend, divergence, mtfScore, fundingRate, volumeRatio, macdHist, macdHistPrev } = indicators;

    // EMA cross
    if (ema20 > ema50) {
        score += 10;
        reasons.push('EMA20 > EMA50 (alta)');
    } else {
        score -= 10;
        reasons.push('EMA20 < EMA50 (baixa)');
    }

    // Preço vs EMA20
    if (close > ema20) {
        score += 5;
        reasons.push('Preço acima EMA20');
    } else {
        score -= 5;
        reasons.push('Preço abaixo EMA20');
    }

    // RSI
    if (rsi > 70) {
        score -= 10;
        reasons.push('RSI sobrecompra');
    } else if (rsi < 30) {
        score += 10;
        reasons.push('RSI sobrevenda');
    } else {
        reasons.push(`RSI ${rsi.toFixed(1)}`);
    }

    // ADX
    if (adx > 25) {
        score += 10;
        reasons.push(`ADX ${adx.toFixed(1)} (tendência)`);
    } else {
        score -= 5;
        reasons.push(`ADX ${adx.toFixed(1)} (lateral)`);
    }

    // Divergência
    if (divergence) {
        if (divergence.type === 'BULLISH_REGULAR') {
            score += 10;
            reasons.push('Divergência de alta');
        } else if (divergence.type === 'BEARISH_REGULAR') {
            score -= 10;
            reasons.push('Divergência de baixa');
        }
    }

    // MTF
    if (mtfScore > 0) {
        score += mtfScore * 5;
        reasons.push('MTF favorável');
    } else {
        score -= 5;
        reasons.push('MTF desfavorável');
    }

    // Volume
    if (volumeRatio > 1.5) {
        score += 5;
        reasons.push('Volume acima da média');
    } else if (volumeRatio < 0.5) {
        score -= 5;
        reasons.push('Volume abaixo da média');
    }

    // Funding
    if (fundingRate > 0.01) {
        score -= 5;
        reasons.push('Funding positivo');
    } else if (fundingRate < -0.01) {
        score += 5;
        reasons.push('Funding negativo');
    }

    // Normaliza
    score = Math.min(100, Math.max(0, score));

    let direction = 'NEUTRO';
    if (score >= 60) direction = 'LONG';
    else if (score <= 40) direction = 'SHORT';

    let label = 'NEUTRO';
    if (score >= 75) label = 'MUITO FORTE';
    else if (score >= 60) label = 'FORTE';
    else if (score >= 45) label = 'MODERADO';
    else if (score >= 30) label = 'MODERADO CONTRA';
    else label = 'FORTE CONTRA';

    return { score, direction, label, reasons };
}

// ===== FUNÇÕES DE ESTADO (RSI, EMA) =====

export function updateStatefulEMA(state, candles, period) {
    if (!candles || candles.length < period) return;
    const closes = candles.map(c => c.close);
    const ema = calcEMA(closes, period);
    if (ema.length > 0) state.ema = ema[ema.length - 1];
}

export function updateStatefulRSI(state, candles, period = 14) {
    if (!candles || candles.length < period + 1) return;
    const closes = candles.map(c => c.close);
    let gains = 0,
        losses = 0;
    for (let i = 1; i < period + 1; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    state.rsi = rsi;
}

// ===== FUNÇÃO DE CLAMP =====

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// ===== REMOVIDO: isHighImpactEventNow (agora em dados_externos.js) =====
// A função foi movida para dados_externos.js com cache (getMacroBlackoutStatus).
