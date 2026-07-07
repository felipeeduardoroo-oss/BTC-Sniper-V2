// js/indicadores.js – Motor completo com todas as melhorias do Comitê
import { CONFIG } from './config.js';

// ============================================================
// 1. CÁLCULOS TÉCNICOS BASE
// ============================================================

export function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    const result = [ema];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

export function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let tr = 0;
    for (let i = 1; i <= period; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        tr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    return tr / period;
}

export function calculateRSI(candles, period = 14) {
    const closes = candles.map(c => c.close);
    if (closes.length < period + 1) return 50;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gain += diff;
        else loss -= diff;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// ============================================================
// 2. DETECÇÃO DE DIVERGÊNCIA RSI (melhorada)
// ============================================================

export function detectRSIDivergence(candles, rsiValues, lookback = 50) {
    if (candles.length < lookback + 14) return null;
    const priceData = candles.slice(-lookback);
    const rsiData = rsiValues.slice(-lookback);
    
    // Encontrar picos e vales (janela de 5 barras)
    const findPeaks = (arr) => {
        const peaks = [];
        for (let i = 2; i < arr.length - 2; i++) {
            if (arr[i] > arr[i-1] && arr[i] > arr[i-2] && arr[i] > arr[i+1] && arr[i] > arr[i+2]) {
                peaks.push({ index: i, value: arr[i] });
            }
        }
        return peaks;
    };
    const findTroughs = (arr) => {
        const troughs = [];
        for (let i = 2; i < arr.length - 2; i++) {
            if (arr[i] < arr[i-1] && arr[i] < arr[i-2] && arr[i] < arr[i+1] && arr[i] < arr[i+2]) {
                troughs.push({ index: i, value: arr[i] });
            }
        }
        return troughs;
    };
    
    const priceHighs = findPeaks(priceData.map(c => c.high));
    const priceLows = findTroughs(priceData.map(c => c.low));
    const rsiHighs = findPeaks(rsiData);
    const rsiLows = findTroughs(rsiData);
    
    // Divergência regular de alta (preço faz lower low, RSI faz higher low)
    if (priceLows.length >= 2 && rsiLows.length >= 2) {
        const p1 = priceLows[priceLows.length - 2];
        const p2 = priceLows[priceLows.length - 1];
        const r1 = rsiLows[rsiLows.length - 2];
        const r2 = rsiLows[rsiLows.length - 1];
        if (p2.value < p1.value && r2.value > r1.value) {
            return { type: 'BULLISH_REGULAR', strength: (r2.value - r1.value) / r1.value };
        }
    }
    // Divergência regular de baixa (preço faz higher high, RSI faz lower high)
    if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
        const p1 = priceHighs[priceHighs.length - 2];
        const p2 = priceHighs[priceHighs.length - 1];
        const r1 = rsiHighs[rsiHighs.length - 2];
        const r2 = rsiHighs[rsiHighs.length - 1];
        if (p2.value > p1.value && r2.value < r1.value) {
            return { type: 'BEARISH_REGULAR', strength: (r1.value - r2.value) / r1.value };
        }
    }
    // Divergência oculta de alta (preço faz higher low, RSI faz lower low) - não implementada
    return null;
}

// ============================================================
// 3. DETECÇÃO DE VOLUME ANÔMALO
// ============================================================

export function detectVolumeAnomaly(candles, lookback = 20, threshold = 2.0) {
    if (candles.length < lookback) return null;
    const volumes = candles.slice(-lookback).map(c => c.volume);
    const avg = volumes.reduce((a, b) => a + b, 0) / lookback;
    const current = candles[candles.length - 1].volume;
    const ratio = current / avg;
    return {
        isAnomaly: ratio >= threshold,
        ratio,
        current,
        average: avg
    };
}

// ============================================================
// 4. CÁLCULO DE ADX COMPLETO
// ============================================================

export function calculateADX(candles, period = 14) {
    if (candles.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);
    
    let tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < candles.length; i++) {
        const h = high[i], l = low[i], pc = close[i-1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - high[i-1];
        const down = low[i-1] - l;
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    
    // Médias suavizadas (Wilder's smoothing)
    let atr = tr.slice(0, period).reduce((a,b) => a+b, 0) / period;
    let plus = plusDM.slice(0, period).reduce((a,b) => a+b, 0) / period;
    let minus = minusDM.slice(0, period).reduce((a,b) => a+b, 0) / period;
    
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        plus = (plus * (period - 1) + plusDM[i]) / period;
        minus = (minus * (period - 1) + minusDM[i]) / period;
    }
    
    const plusDI = (plus / atr) * 100;
    const minusDI = (minus / atr) * 100;
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    // ADX é a média móvel do DX (últimos periodos)
    let adx = dx;
    if (tr.length >= period * 2) {
        let sum = 0;
        for (let i = tr.length - period; i < tr.length; i++) {
            const p = plusDM[i] || 0;
            const m = minusDM[i] || 0;
            const d = (Math.abs(p - m) / (p + m)) * 100;
            sum += d;
        }
        adx = sum / period;
    }
    return { adx, plusDI, minusDI };
}

// ============================================================
// 5. GESTÃO DE SAÍDA COM TRAILING STOP E TP PARCIAL
// ============================================================

export function generateTrailingStopParams(candles, entryPrice, direction, atrMultiplier = 2.0) {
    const atr = calculateATR(candles, 14) || (entryPrice * 0.02);
    let stop, tp1, tp2, tp3, trailingActivation, trailingDistance;
    
    if (direction === 'LONG') {
        stop = entryPrice - atr * 1.5;
        tp1 = entryPrice + atr * 1.5;
        tp2 = entryPrice + atr * 3.0;
        tp3 = entryPrice + atr * 5.0;
        trailingActivation = entryPrice + atr * 1.0;
        trailingDistance = atr * atrMultiplier;
    } else {
        stop = entryPrice + atr * 1.5;
        tp1 = entryPrice - atr * 1.5;
        tp2 = entryPrice - atr * 3.0;
        tp3 = entryPrice - atr * 5.0;
        trailingActivation = entryPrice - atr * 1.0;
        trailingDistance = atr * atrMultiplier;
    }
    
    return { stopLoss: stop, tp1, tp2, tp3, trailingActivation, trailingDistance, atr };
}

// ============================================================
// 6. SCORE DE CONFIANÇA BASEADO EM CONFLUÊNCIA (Melhoria 10)
// ============================================================

export function calculateConfidenceScore(symbolData) {
    let score = 0;
    const reasons = [];
    const weights = {
        mtfAlignment: 0.20,
        adxTrend: 0.15,
        volumeAnomaly: 0.15,
        fundingRate: 0.10,
        openInterest: 0.10,
        rsiDivergence: 0.15,
        macroFilter: 0.05,
        smcStructure: 0.10
    };
    
    if (symbolData.mtfAligned) { score += weights.mtfAlignment; reasons.push('MTF_ALIGNED'); }
    if (symbolData.adx > 25) { score += weights.adxTrend; reasons.push('ADX_STRONG'); }
    if (symbolData.volumeAnomaly?.isAnomaly) { score += weights.volumeAnomaly; reasons.push('VOLUME_SPIKE'); }
    if (symbolData.fundingRate < -0.0001) { score += weights.fundingRate; reasons.push('FUNDING_NEGATIVE'); }
    else if (symbolData.fundingRate > 0.0001) { score -= weights.fundingRate * 0.5; reasons.push('FUNDING_POSITIVE'); }
    if (symbolData.openInterestTrend === 'INCREASING') { score += weights.openInterest; reasons.push('OI_RISING'); }
    if (symbolData.divergence) {
        if ((symbolData.direction === 'LONG' && symbolData.divergence.type === 'BULLISH_REGULAR') ||
            (symbolData.direction === 'SHORT' && symbolData.divergence.type === 'BEARISH_REGULAR')) {
            score += weights.rsiDivergence;
            reasons.push('DIVERGENCE_CONFIRMED');
        } else {
            score -= weights.rsiDivergence * 0.7;
            reasons.push('DIVERGENCE_CONTRADICT');
        }
    }
    if (!symbolData.macroBlackout) { score += weights.macroFilter; reasons.push('MACRO_CLEAR'); }
    if (symbolData.smcStructure === 'BOS') { score += weights.smcStructure; reasons.push('SMC_BOS'); }
    
    const level = score >= 0.8 ? 'VERY_HIGH' :
                  score >= 0.6 ? 'HIGH' :
                  score >= 0.4 ? 'MEDIUM' :
                  score >= 0.2 ? 'LOW' : 'VERY_LOW';
    
    return {
        score: Math.min(100, Math.max(0, score * 100)),
        level,
        reasons,
        direction: score >= 0.4 ? (symbolData.direction || 'NEUTRO') : 'NEUTRO'
    };
}

// ============================================================
// 7. FILTRO MACRO (calendário de eventos)
// ============================================================

const macroEvents = [
    { date: '2026-07-10', time: '14:00', event: 'FOMC Minutes', impact: 'HIGH' },
    { date: '2026-07-12', time: '08:30', event: 'CPI Data', impact: 'HIGH' },
    { date: '2026-07-15', time: '10:00', event: 'Fed Chair Speech', impact: 'MEDIUM' }
];

export function isHighImpactEventNow() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    for (const ev of macroEvents) {
        if (ev.date === today) {
            const [h, m] = ev.time.split(':').map(Number);
            const eventHour = h; // assume 24h
            const blackoutStart = (eventHour - 1 + 24) % 24;
            const blackoutEnd = (eventHour + 1) % 24;
            const currentHour = now.getHours();
            if (currentHour >= blackoutStart && currentHour <= blackoutEnd) {
                return { isBlackout: true, event: ev.event, impact: ev.impact };
            }
        }
    }
    return { isBlackout: false };
}

// ============================================================
// 8. FUNÇÕES EXISTENTES (mantidas para compatibilidade)
// ============================================================

export function updateSwingPoints(data) {
    if (data.candles1H.length < 10) return;
    const closes = data.candles1H.map(c => c.close);
    data.swingHighs = [];
    data.swingLows = [];
    for (let i = 2; i < closes.length - 2; i++) {
        if (closes[i] > closes[i-1] && closes[i] > closes[i-2] && 
            closes[i] > closes[i+1] && closes[i] > closes[i+2]) {
            data.swingHighs.push(closes[i]);
        }
        if (closes[i] < closes[i-1] && closes[i] < closes[i-2] && 
            closes[i] < closes[i+1] && closes[i] < closes[i+2]) {
            data.swingLows.push(closes[i]);
        }
    }
}

export function findSMCSetup(data, direction) {
    // Simulação: sempre retorna true para não bloquear
    return true;
}

export function checkMTFAlignment(mtfData) {
    if (!mtfData) return { aligned: false, trend: 'NEUTRAL' };
    return {
        aligned: mtfData.alinhado,
        trend: mtfData.directions?.find(d => d.dir !== 'NEUTRO')?.dir || 'NEUTRAL'
    };
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// ===== FUNÇÕES DE FILTRO (usadas no motor) =====

export function adxFilter(candles) {
    const adx = calculateADX(candles);
    if (adx.adx < 20) return { pass: false, reason: 'ADX < 20 (mercado lateral)' };
    if (adx.adx > 50) return { pass: true, reason: 'Tendência muito forte' };
    return { pass: true, reason: 'Tendência moderada' };
}

export function fundingFilter(fundingData, direction) {
    if (!fundingData) return { pass: true, reason: 'Sem dados de funding' };
    const rate = fundingData.rate;
    if (direction === 'LONG' && rate > 0.01) {
        return { pass: false, reason: 'Funding muito positivo (longs caros)' };
    }
    if (direction === 'SHORT' && rate < -0.01) {
        return { pass: false, reason: 'Funding muito negativo (shorts caros)' };
    }
    return { pass: true, reason: 'Funding neutro' };
}

export function orderBookFilter(obData, direction) {
    if (!obData) return { pass: true, reason: 'Sem dados de book' };
    const imbalance = obData.imbalance;
    if (direction === 'LONG' && imbalance < -20) {
        return { pass: false, reason: 'Order book com pressão vendedora' };
    }
    if (direction === 'SHORT' && imbalance > 20) {
        return { pass: false, reason: 'Order book com pressão compradora' };
    }
    return { pass: true, reason: 'Book equilibrado' };
}

export function fearGreedFilter(fgData, direction) {
    if (!fgData) return { pass: true, reason: 'Sem dados F&G', multiplier: 1 };
    const value = fgData.value;
    if (direction === 'LONG' && value < 20) {
        return { pass: true, reason: 'Extreme Fear (oportunidade)', multiplier: 1.5 };
    }
    if (direction === 'LONG' && value > 80) {
        return { pass: false, reason: 'Extreme Greed (perigoso)', multiplier: 0.5 };
    }
    if (direction === 'SHORT' && value > 80) {
        return { pass: true, reason: 'Extreme Greed (oportunidade)', multiplier: 1.5 };
    }
    if (direction === 'SHORT' && value < 20) {
        return { pass: false, reason: 'Extreme Fear (perigoso)', multiplier: 0.5 };
    }
    return { pass: true, reason: 'F&G neutro', multiplier: 1 };
}

export function checkPortfolioExposure(activePositions, direction) {
    const total = Object.keys(activePositions).length;
    if (total >= 3) return { blocked: true, reason: 'Máximo de 3 posições' };
    const sameDir = Object.values(activePositions).filter(p => p.type === direction).length;
    if (sameDir >= 2) return { blocked: true, reason: `Máximo de 2 posições ${direction}` };
    return { blocked: false };
}

export function isSafeToTrade() {
    // Pode adicionar verificações de horário, etc.
    return true;
}

export function KellyPositionSize(winRate, rr) {
    if (winRate <= 0 || rr <= 0) return 0.02;
    const b = rr - 1;
    const p = winRate;
    const q = 1 - p;
    const kelly = (p * b - q) / b;
    return Math.max(0.01, Math.min(0.1, kelly));
}

export function computeScore(symbol, assetsData, liqMap) {
    const data = assetsData[symbol];
    // Score simplificado – na prática usa o confidence score
    const base = 50;
    const mtfScore = data.mtfConfluence?.score || 0;
    const adx = data.adx || 0;
    const rsi = data.rsi_1H || 50;
    let score = base + mtfScore * 5;
    if (adx > 25) score += 10;
    if (rsi > 70) score -= 15;
    if (rsi < 30) score += 15;
    const clamped = Math.max(0, Math.min(100, score));
    return {
        score: clamped,
        direction: clamped >= 60 ? 'LONG' : clamped <= 40 ? 'SHORT' : 'NEUTRAL',
        components: {
            mtf: mtfScore > 0 ? 'ALINHADO' : 'NEUTRO',
            smc: 'NEUTRO',
            mom: adx > 25 ? 'FORTE' : 'FRACO',
            of: 'NEUTRO',
            macro: 'NEUTRO',
            oi: data.oiDelta > 0 ? 'CRESCENDO' : 'DIMINUINDO'
        },
        blockReason: null
    };
}

export function checkHTFAlignment(mtfData) {
    return mtfData?.alinhado || false;
}

export function checkLateralMarket(adx) {
    return adx < 25;
}

export function checkOnChainFilter(mvrv, fear) {
    return mvrv < 0.8 && fear > 70;
}

export function checkVolumeAndOrderflow(volAnomaly, obImbalance) {
    return volAnomaly?.isAnomaly || false;
}

export function checkDerivativesFilter(funding, oiDelta) {
    return funding < 0.01 && oiDelta > 0;
}

export function detectHTFStructure(data, candles4H) {
    return { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity };
}

export function updateStatefulEMA(prevEma, price, period) {
    const k = 2 / (period + 1);
    return price * k + prevEma * (1 - k);
}

export function updateStatefulRSI(state, price, prevPrice) {
    const diff = price - prevPrice;
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? -diff : 0;
    const avgGain = (state.avgGain * 13 + gain) / 14;
    const avgLoss = (state.avgLoss * 13 + loss) / 14;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    return { avgGain, avgLoss, rsi };
}

export function calculateSignalScore(indicators) {
    // Função legada para o comitê
    let score = 50;
    const reasons = [];
    if (indicators.rsi > 70) { score -= 10; reasons.push('RSI sobrecompra'); }
    else if (indicators.rsi < 30) { score += 10; reasons.push('RSI sobrevenda'); }
    if (indicators.ema20 > indicators.ema50) { score += 5; reasons.push('EMA20 > EMA50'); }
    else { score -= 5; reasons.push('EMA20 < EMA50'); }
    if (indicators.adx > 25) { score += 5; reasons.push('ADX > 25'); }
    else { score -= 5; reasons.push('ADX < 25'); }
    if (indicators.fundingRate < -0.0001) { score += 5; reasons.push('Funding negativo'); }
    else if (indicators.fundingRate > 0.0001) { score -= 5; reasons.push('Funding positivo'); }
    if (indicators.volumeRatio > 1.5) { score += 5; reasons.push('Volume anômalo'); }
    if (indicators.divergence === 'BULLISH_REGULAR') { score += 10; reasons.push('Divergência de alta'); }
    else if (indicators.divergence === 'BEARISH_REGULAR') { score -= 10; reasons.push('Divergência de baixa'); }
    const clamped = Math.max(0, Math.min(100, score));
    const direction = clamped >= 55 ? 'LONG' : clamped <= 45 ? 'SHORT' : 'NEUTRO';
    const label = clamped >= 70 ? 'MUITO FORTE' : clamped >= 55 ? 'FORTE' : clamped >= 45 ? 'MODERADO' : clamped >= 30 ? 'MODERADO CONTRA' : 'FORTE CONTRA';
    return { score: clamped, direction, label, reasons };
}
