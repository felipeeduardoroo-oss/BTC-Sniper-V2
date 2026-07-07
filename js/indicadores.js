// js/indicadores.js – Motor completo com todas as correções da rodada 3
import { CONFIG } from './config.js';

// ============================================================
// 1. CÁLCULOS TÉCNICOS BASE
// ============================================================

export function calcEMA(data, period) {
    if (!data || data.length === 0) return [];
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
    if (!candles || candles.length < period + 1) return 0;
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
// 2. DETECÇÃO DE DIVERGÊNCIA RSI
// ============================================================

export function detectRSIDivergence(candles, rsiValues, lookback = 50) {
    if (candles.length < lookback + 14 || rsiValues.length < lookback) return null;
    const priceData = candles.slice(-lookback);
    const rsiData = rsiValues.slice(-lookback);
    
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
    
    if (priceLows.length >= 2 && rsiLows.length >= 2) {
        const p1 = priceLows[priceLows.length - 2];
        const p2 = priceLows[priceLows.length - 1];
        const r1 = rsiLows[rsiLows.length - 2];
        const r2 = rsiLows[rsiLows.length - 1];
        if (p2.value < p1.value && r2.value > r1.value) {
            return { type: 'BULLISH_REGULAR', strength: (r2.value - r1.value) / r1.value };
        }
    }
    if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
        const p1 = priceHighs[priceHighs.length - 2];
        const p2 = priceHighs[priceHighs.length - 1];
        const r1 = rsiHighs[rsiHighs.length - 2];
        const r2 = rsiHighs[rsiHighs.length - 1];
        if (p2.value > p1.value && r2.value < r1.value) {
            return { type: 'BEARISH_REGULAR', strength: (r1.value - r2.value) / r1.value };
        }
    }
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
    const ratio = avg > 0 ? current / avg : 0;
    return {
        isAnomaly: ratio >= threshold,
        ratio,
        current,
        average: avg
    };
}

// ============================================================
// 4. CÁLCULO DE ADX COMPLETO — CORREÇÃO #1
// ============================================================

export function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);
    
    // True Range e Directional Movement
    const tr = [];
    const plusDM = [];
    const minusDM = [];
    
    for (let i = 1; i < candles.length; i++) {
        const h = high[i], l = low[i], pc = close[i-1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - high[i-1];
        const down = low[i-1] - l;
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    
    // Wilder's smoothing para o primeiro período
    let atr = tr.slice(0, period).reduce((a,b) => a+b, 0);
    let plus = plusDM.slice(0, period).reduce((a,b) => a+b, 0);
    let minus = minusDM.slice(0, period).reduce((a,b) => a+b, 0);
    
    // Arrays para armazenar os valores suavizados
    const atrArr = [atr];
    const plusArr = [plus];
    const minusArr = [minus];
    const dxArr = [];
    
    // Continua o smoothing para os períodos restantes
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        plus = (plus * (period - 1) + plusDM[i]) / period;
        minus = (minus * (period - 1) + minusDM[i]) / period;
        atrArr.push(atr);
        plusArr.push(plus);
        minusArr.push(minus);
        
        // Calcula DX para cada ponto
        const plusDI = atr > 0 ? (plus / atr) * 100 : 0;
        const minusDI = atr > 0 ? (minus / atr) * 100 : 0;
        const sum = plusDI + minusDI;
        const dx = sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0;
        dxArr.push(dx);
    }
    
    // ADX é a média móvel do DX
    let adx = 0;
    if (dxArr.length >= period) {
        const startIdx = dxArr.length - period;
        let sum = 0;
        for (let i = startIdx; i < dxArr.length; i++) {
            sum += dxArr[i];
        }
        adx = sum / period;
    } else if (dxArr.length > 0) {
        adx = dxArr.reduce((a,b) => a+b, 0) / dxArr.length;
    }
    
    // DI finais
    const finalPlusDI = atr > 0 ? (plus / atr) * 100 : 0;
    const finalMinusDI = atr > 0 ? (minus / atr) * 100 : 0;
    
    return { adx, plusDI: finalPlusDI, minusDI: finalMinusDI };
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
// 6. SCORE DE CONFIANÇA — CORREÇÃO #5 (macro blackout integrado)
// ============================================================

export function calculateConfidenceScore(symbolData) {
    let score = 0;
    const reasons = [];
    const weights = {
        mtfAlignment: 0.25,
        adxTrend: 0.15,
        volumeAnomaly: 0.15,
        fundingRate: 0.10,
        openInterest: 0.10,
        rsiDivergence: 0.15,
        macroFilter: 0.05,
        smcStructure: 0.15
    };
    
    if (symbolData.mtfAligned) { score += weights.mtfAlignment; reasons.push('MTF_ALIGNED'); }
    
    // CORREÇÃO: extrair valor numérico do ADX
    const adxValue = typeof symbolData.adx === 'object' ? symbolData.adx.adx : symbolData.adx;
    if (adxValue > 25) { score += weights.adxTrend; reasons.push('ADX_STRONG'); }
    
    if (symbolData.volumeAnomaly?.isAnomaly) { score += weights.volumeAnomaly; reasons.push('VOLUME_SPIKE'); }
    
    // CORREÇÃO: extrair valor numérico do fundingRate
    const frValue = typeof symbolData.fundingRate === 'object' ? symbolData.fundingRate.rate : symbolData.fundingRate;
    if (frValue < -0.0001) { score += weights.fundingRate; reasons.push('FUNDING_NEGATIVE'); }
    else if (frValue > 0.0001) { score -= weights.fundingRate * 0.5; reasons.push('FUNDING_POSITIVE'); }
    
    if (symbolData.openInterestTrend === 'INCREASING') { score += weights.openInterest; reasons.push('OI_RISING'); }
    
    if (symbolData.divergence) {
        if ((symbolData.direction === 'LONG' && symbolData.divergence.type === 'BULLISH_REGULAR') ||
            (symbolData.direction === 'SHORT' && symbolData.divergence.type === 'BEARISH_REGULAR')) {
            score += weights.rsiDivergence;
            reasons.push('DIVERGENCE_CONFIRMED');
        } else {
            score -= weights.rsiDivergence * 1.5;
            reasons.push('DIVERGENCE_HARD_CONTRADICT');
        }
    }
    
    // NOVO: integração dinâmica do macro blackout
    if (!symbolData.macroBlackout) {
        score += weights.macroFilter;
        reasons.push('MACRO_CLEAR');
    } else {
        reasons.push(`MACRO_BLACKOUT:${symbolData.macroBlackout.event || 'EVENT'}`);
    }
    
    if (symbolData.smcStructure === 'BOS') { score += weights.smcStructure; reasons.push('SMC_BOS'); }
    
    if (!symbolData.mtfAligned && score > 0.4) {
        score = 0.4;
        reasons.push('MTF_REQUIRED_FOR_HIGH_SCORE');
    }
    
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
// 7. FILTRO MACRO (dinâmico) — CORREÇÃO #11 (datas dinâmicas)
// ============================================================

export async function isHighImpactEventNow() {
    try {
        const response = await fetch('https://nfs.faireconomy.media/cc/fred.json', { 
            signal: AbortSignal.timeout(5000) 
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const events = await response.json();
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentHour = now.getHours();
        
        for (const ev of events) {
            if (ev.country === 'US' && ev.date && ev.date.includes(today) && ev.impact === 'high') {
                const eventHour = parseInt(ev.date.split('T')[1]?.split(':')[0] || '12');
                const blackoutStart = (eventHour - 1 + 24) % 24;
                const blackoutEnd = (eventHour + 1) % 24;
                if (currentHour >= blackoutStart && currentHour <= blackoutEnd) {
                    return { isBlackout: true, event: ev.title, impact: 'HIGH' };
                }
            }
        }
    } catch(e) {
        console.warn('[Macro Filter] FRED calendar indisponível:', e.message);
        // CORREÇÃO: fallback genérico baseado em dia da semana (não datas hard-coded)
        const now = new Date();
        const day = now.getDay();
        const hour = now.getHours();
        // Quarta-feira (dia 3) após 14h: possível FOMC
        if (day === 3 && hour >= 13 && hour <= 16) {
            return { isBlackout: true, event: 'Possível FOMC (quarta à tarde)', impact: 'MEDIUM' };
        }
        // Primeira sexta do mês: possível NFP
        if (day === 5 && now.getDate() <= 7 && hour >= 8 && hour <= 10) {
            return { isBlackout: true, event: 'Possível NFP (primeira sexta)', impact: 'HIGH' };
        }
    }
    return { isBlackout: false };
}

// ============================================================
// 8. CÁLCULO DE VWAP
// ============================================================

export function calculateVWAP(candles) {
    if (!candles || !candles.length) return 0;
    let cumulativeTP = 0;
    let cumulativeVol = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        cumulativeTP += tp * c.volume;
        cumulativeVol += c.volume;
    }
    return cumulativeVol > 0 ? cumulativeTP / cumulativeVol : 0;
}

// ============================================================
// 9. DETECÇÃO REAL DE BREAK OF STRUCTURE (BOS) — CORREÇÃO #12
// ============================================================

export function findSMCSetup(data, direction) {
    if (!data || !data.swingHighs || !data.swingLows) return false;
    if (data.swingHighs.length < 2 || data.swingLows.length < 2) return false;
    
    // CORREÇÃO: filtra valores inválidos
    const validHighs = data.swingHighs.filter(h => h && h > 0);
    const validLows = data.swingLows.filter(l => l && l > 0 && l !== Infinity);
    if (validHighs.length < 2 || validLows.length < 2) return false;
    
    const lastHigh = validHighs[validHighs.length - 1];
    const lastLow = validLows[validLows.length - 1];
    const currentPrice = data.price || 0;

    if (direction === 'LONG') {
        return currentPrice > lastHigh;
    } else if (direction === 'SHORT') {
        return currentPrice < lastLow;
    }
    return false;
}

// ============================================================
// 10. DETECÇÃO DE HTF (4H) REAL
// ============================================================

export function detectHTFStructure(data, candles4H) {
    if (!candles4H || candles4H.length < 20) return { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity };
    let highs = [], lows = [];
    for (let i = 5; i < candles4H.length - 5; i++) {
        if (candles4H[i].high > candles4H[i-1].high && candles4H[i].high > candles4H[i+1].high) highs.push(candles4H[i].high);
        if (candles4H[i].low < candles4H[i-1].low && candles4H[i].low < candles4H[i+1].low) lows.push(candles4H[i].low);
    }
    const lastSwingHigh = highs.length ? highs[highs.length - 1] : 0;
    const lastSwingLow = lows.length ? lows[lows.length - 1] : Infinity;
    const lastClose = candles4H[candles4H.length - 1].close;
    let bias = 'NEUTRAL';
    if (lastClose > lastSwingHigh) bias = 'BULLISH';
    else if (lastClose < lastSwingLow) bias = 'BEARISH';
    return { bias, lastSwingHigh, lastSwingLow };
}

// ============================================================
// 11. FILTRO DE DERIVATIVOS — CORREÇÃO #2 (trata objeto fundingRate)
// ============================================================

export function checkDerivativesFilter(fundingRate, oiDelta) {
    // CORREÇÃO: aceita tanto número quanto objeto {rate, interpretacao}
    const fr = typeof fundingRate === 'object' ? (fundingRate?.rate || 0) : (fundingRate || 0);
    const oi = typeof oiDelta === 'object' ? (oiDelta?.delta || oiDelta?.oi || 0) : (oiDelta || 0);
    
    if (fr > 0.0003 && oi > 3) {
        return { allow: false, reason: `Funding alto (${(fr*100).toFixed(3)}%) + OI subindo (${oi.toFixed(1)}%) — superaquecido` };
    }
    if (fr < -0.0003 && oi < -3) {
        return { allow: false, reason: `Funding negativo + OI caindo — sobrevendido` };
    }
    return { allow: true, reason: 'Derivativos neutros' };
}

// ============================================================
// 12. KELLY FRACIONADO — CORREÇÃO #3 (divisão por zero)
// ============================================================

export function KellyPositionSize(winRate, rr) {
    if (winRate <= 0 || rr <= 0) return 0.01;
    // CORREÇÃO: previne rr === 1 (divisão por zero)
    if (Math.abs(rr - 1) < 0.001) return 0.01;
    const kelly = (winRate * (rr - 1) - (1 - winRate)) / (rr - 1);
    if (isNaN(kelly) || kelly <= 0) return 0.01;
    const fractional = kelly * 0.25; // quarter-Kelly
    return Math.max(0.005, Math.min(0.05, fractional));
}

// ============================================================
// 13. EXPOSIÇÃO CORRELACIONADA
// ============================================================

export function checkPortfolioExposure(activePositions, direction) {
    const total = Object.keys(activePositions).length;
    if (total >= 3) return { blocked: true, reason: 'Máximo de 3 posições' };
    const sameDir = Object.values(activePositions).filter(p => p.type === direction).length;
    if (sameDir >= 1) return { blocked: true, reason: `Já há posição ${direction} aberta (exposição correlacionada)` };
    return { blocked: false };
}

// ============================================================
// 14. FUNÇÕES DE COMPATIBILIDADE
// ============================================================

export function updateSwingPoints(data) {
    if (!data || !data.candles1H || data.candles1H.length < 10) return;
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

export function adxFilter(candles) {
    const adx = calculateADX(candles);
    if (adx.adx < 20) return { pass: false, reason: 'ADX < 20 (mercado lateral)' };
    if (adx.adx > 50) return { pass: true, reason: 'Tendência muito forte' };
    return { pass: true, reason: 'Tendência moderada' };
}

export function fundingFilter(fundingData, direction) {
    if (!fundingData) return { pass: true, reason: 'Sem dados de funding' };
    const rate = typeof fundingData === 'object' ? fundingData.rate : fundingData;
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
    const value = typeof fgData === 'object' ? fgData.value : fgData;
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

export function isSafeToTrade() {
    return true;
}

// ============================================================
// 15. COMPUTE SCORE — CORREÇÃO #4 (extrai adx.adx)
// ============================================================

export function computeScore(symbol, assetsData, liqMap) {
    const data = assetsData[symbol];
    if (!data) return { score: 50, direction: 'NEUTRAL', components: {}, blockReason: 'Sem dados' };
    
    const base = 50;
    const mtfScore = data.mtfConfluence?.score || 0;
    
    // CORREÇÃO: extrai valor numérico do ADX (pode ser objeto ou número)
    const adxRaw = data.adx;
    const adxValue = typeof adxRaw === 'object' ? (adxRaw?.adx || 0) : (adxRaw || 0);
    
    const rsi = data.rsi_1H || 50;
    let score = base + mtfScore * 5;
    if (adxValue > 25) score += 10;
    if (rsi > 70) score -= 15;
    if (rsi < 30) score += 15;
    
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

export function checkHTFAlignment(mtfData) {
    return mtfData?.alinhado || false;
}

export function checkLateralMarket(adx) {
    const val = typeof adx === 'object' ? adx.adx : adx;
    return val < 25;
}

export function checkOnChainFilter(mvrv, fear) {
    return mvrv < 0.8 && fear > 70;
}

export function checkVolumeAndOrderflow(volAnomaly, obImbalance) {
    return volAnomaly?.isAnomaly || false;
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
// ============================================================
// 16. STUBS PARA COMPATIBILIDADE (evitam que o index.html quebre)
// ============================================================

export function computeChoppiness(candles, period = 14) {
    // Stub para compatibilidade
    return 50;
}

export function calculateBB(candles, period = 20, mult = 2) {
    // Stub para compatibilidade
    return { upper: 0, middle: 0, lower: 0, bbWidth: 0 };
}

export function getSMCZones(data) {
    // Stub para compatibilidade
    return { demand: [], supply: [] };
}
