// indicadores.js
import { CONFIG } from './config.js';

// ===== Utilitários =====
export function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

export function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i-1] * (1 - k));
    }
    return ema;
}

export function updateStatefulEMA(prevEMA, newPrice, period) {
    if (!prevEMA) return newPrice;
    const k = 2 / (period + 1);
    return (newPrice * k) + (prevEMA * (1 - k));
}

export function updateStatefulRSI(prevState, newPrice, prevPrice, period = 14) {
    if (!prevPrice) return { avgGain: 0, avgLoss: 0, rsi: 50 };
    let diff = newPrice - prevPrice;
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? Math.abs(diff) : 0;
    let avgGain = (prevState.avgGain * (period - 1) + gain) / period;
    let avgLoss = (prevState.avgLoss * (period - 1) + loss) / period;
    let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    return { avgGain, avgLoss, rsi };
}

// ===== ADX =====
export function calculateADX(candles, period = 14) {
    if (candles.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
    let plusDM = [], minusDM = [], tr = [];
    for (let i = 1; i < candles.length; i++) {
        const highDiff = candles[i].high - candles[i-1].high;
        const lowDiff = candles[i-1].low - candles[i].low;
        plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
        minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
        tr.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i-1].close),
            Math.abs(candles[i].low - candles[i-1].close)
        ));
    }
    const smooth = (arr, p) => {
        let sum = arr.slice(0, p).reduce((a,b) => a+b, 0);
        let result = [sum];
        for (let i = p; i < arr.length; i++) {
            sum = sum - sum/p + arr[i];
            result.push(sum);
        }
        return result;
    };
    const sTR = smooth(tr, period);
    const sPDM = smooth(plusDM, period);
    const sMDM = smooth(minusDM, period);
    const plusDI = sPDM.map((v, i) => sTR[i] ? (v / sTR[i]) * 100 : 0);
    const minusDI = sMDM.map((v, i) => sTR[i] ? (v / sTR[i]) * 100 : 0);
    let dx = plusDI.map((p, i) => {
        const sum = p + minusDI[i];
        return sum ? (Math.abs(p - minusDI[i]) / sum) * 100 : 0;
    });
    let adx = [0];
    for (let i = 1; i < dx.length; i++) {
        adx.push((adx[i-1] * (period - 1) + dx[i]) / period);
    }
    const last = adx.length - 1;
    return { adx: adx[last], plusDI: plusDI[last], minusDI: minusDI[last] };
}

export function adxFilter(candles) {
    const { adx, plusDI, minusDI } = calculateADX(candles);
    if (adx < 20) return { pass: false, reason: 'MERCADO LATERAL (ADX < 20)', adx };
    if (adx > 55) return { pass: false, reason: 'SOBRE-EXTENSÃO (ADX > 55)', adx };
    return { pass: true, trend: plusDI > minusDI ? 'ALTA' : 'BAIXA', adx, plusDI, minusDI };
}

// ===== RSI Divergence =====
export function detectRSIDivergence(candles, rsiValues, lookback = 5) {
    if (candles.length < lookback * 2 + 1) return null;
    const recentCandles = candles.slice(-lookback * 2);
    const recentRSI = rsiValues.slice(-lookback * 2);
    let bottoms = [];
    for (let i = lookback; i < recentCandles.length; i++) {
        const window = recentCandles.slice(i - lookback, i + 1);
        const minIdx = window.findIndex(c => c.low === Math.min(...window.map(w => w.low)));
        if (minIdx === Math.floor(lookback / 2)) {
            bottoms.push({ priceIdx: i - lookback + minIdx, low: window[minIdx].low, rsi: recentRSI[i - lookback + minIdx] });
        }
    }
    if (bottoms.length >= 2) {
        const last = bottoms[bottoms.length - 1];
        const prev = bottoms[bottoms.length - 2];
        if (last.low < prev.low && last.rsi > prev.rsi && last.rsi < 40) {
            return { type: 'BULLISH_DIVERGENCE', strength: Math.min((last.rsi - prev.rsi) * 2, 100).toFixed(0) };
        }
    }
    let tops = [];
    for (let i = lookback; i < recentCandles.length; i++) {
        const window = recentCandles.slice(i - lookback, i + 1);
        const maxIdx = window.findIndex(c => c.high === Math.max(...window.map(w => w.high)));
        if (maxIdx === Math.floor(lookback / 2)) {
            tops.push({ priceIdx: i - lookback + maxIdx, high: window[maxIdx].high, rsi: recentRSI[i - lookback + maxIdx] });
        }
    }
    if (tops.length >= 2) {
        const lastTop = tops[tops.length - 1];
        const prevTop = tops[tops.length - 2];
        if (lastTop.high > prevTop.high && lastTop.rsi < prevTop.rsi && lastTop.rsi > 60) {
            return { type: 'BEARISH_DIVERGENCE', strength: Math.min((prevTop.rsi - lastTop.rsi) * 2, 100).toFixed(0) };
        }
    }
    return null;
}

// ===== ATR =====
export function calculateATR(candles, period = 14) {
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        trs.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i-1].close),
            Math.abs(candles[i].low - candles[i-1].close)
        ));
    }
    return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
}

// ===== Choppiness =====
export function computeChoppiness(data) {
    const c = data.candles1H.slice(-14);
    if (c.length < 14) return 50;
    const highs = c.map(k=>k.high), lows = c.map(k=>k.low);
    const trs = [];
    for (let i=1; i<c.length; i++) {
        trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
    }
    const avgTR = trs.slice(-14).reduce((a,b)=>a+b,0)/14;
    const trueRange = avgTR * 14;
    const range = Math.max(...highs) - Math.min(...lows);
    if (range === 0) return 100;
    const chop = 100 * Math.log10(trueRange / range) / Math.log10(14);
    return clamp(chop, 0, 100);
}

// ===== Bollinger Bands =====
export function calculateBB(data, period = 20, multiplier = 2) {
    const candles = data.candles1H;
    if (candles.length < period) return { bbWidth: 0.1, upper: 0, lower: 0 };
    const closes = candles.slice(-period).map(c => c.close);
    const sma = closes.reduce((a,b)=>a+b,0)/period;
    const variance = closes.reduce((a,b)=>a+Math.pow(b-sma,2),0)/period;
    const std = Math.sqrt(variance);
    const upper = sma + multiplier*std;
    const lower = sma - multiplier*std;
    const bbWidth = (upper - lower) / sma;
    return { bbWidth, upper, lower };
}

// ===== SMC helpers =====
export function detectHTFStructure(data, htfCandles) {
    if (!htfCandles || htfCandles.length < 20) return { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity };
    let highs = [], lows = [];
    for (let i = 5; i < htfCandles.length - 5; i++) {
        if (htfCandles[i].high > htfCandles[i-1].high && htfCandles[i].high > htfCandles[i+1].high) highs.push(htfCandles[i].high);
        if (htfCandles[i].low < htfCandles[i-1].low && htfCandles[i].low < htfCandles[i+1].low) lows.push(htfCandles[i].low);
    }
    const lastSwingHigh = highs.length > 0 ? highs[highs.length-1] : 0;
    const lastSwingLow = lows.length > 0 ? lows[lows.length-1] : Infinity;
    const lastClose = htfCandles[htfCandles.length-1].close;
    let bias = 'NEUTRAL';
    if (lastClose > lastSwingHigh) bias = 'BULLISH';
    else if (lastClose < lastSwingLow) bias = 'BEARISH';
    return { bias, lastSwingHigh, lastSwingLow };
}

export function updateSwingPoints(data) {
    const c1H = data.candles1H;
    if (c1H.length < 10) return;
    let recentHighs = [], recentLows = [];
    const avgVol = c1H.slice(-11, -1).reduce((s,k) => s + k.volume, 0) / 10;
    for (let i = c1H.length - 10; i < c1H.length - 1; i++) {
        const volConfirm = c1H[i].volume > avgVol * 1.3;
        if (c1H[i].high > c1H[i-1].high && c1H[i].high > c1H[i+1].high && volConfirm) recentHighs.push(c1H[i].high);
        if (c1H[i].low < c1H[i-1].low && c1H[i].low < c1H[i+1].low && volConfirm) recentLows.push(c1H[i].low);
    }
    data.swingHighs = recentHighs.slice(-3);
    data.swingLows = recentLows.slice(-3);
    const lastCandle = c1H[c1H.length - 1];
    if (!lastCandle) return;
    
    // CORREÇÃO: Tratar arrays vazios para evitar Infinity
    const lastHigh = data.swingHighs.length > 0 ? Math.max(...data.swingHighs) : null;
    const lastLow = data.swingLows.length > 0 ? Math.min(...data.swingLows) : null;
    
    if (lastHigh !== null && lastCandle.close > lastHigh) data.currentBOS = 'BULLISH';
    else if (lastLow !== null && lastCandle.close < lastLow) data.currentBOS = 'BEARISH';
    else data.currentBOS = 'NEUTRAL';
}

export function findSMCSetup(data, direction) {
    const recent = data.candles1H.slice(-3);
    const lastClose = data.candles1H.length > 0 ? data.candles1H[data.candles1H.length - 1].close : 0;
    if (!lastClose || data.swingLows.length === 0 || data.swingHighs.length === 0) return false;
    
    if (direction === 'LONG' && data.currentBOS === 'BULLISH') {
        const swingLow = Math.min(...data.swingLows);
        const sweep = recent.some(c => c.low < swingLow) && lastClose > swingLow;
        return sweep && data.price < data.ema50_1H;
    }
    if (direction === 'SHORT' && data.currentBOS === 'BEARISH') {
        const swingHigh = Math.max(...data.swingHighs);
        const sweep = recent.some(c => c.high > swingHigh) && lastClose < swingHigh;
        return sweep && data.price > data.ema50_1H;
    }
    return false;
}

export function getSMCZones(data) {
    const zones = [];
    if (data.swingHighs.length > 0) zones.push({ type: 'resistance', level: Math.max(...data.swingHighs) });
    if (data.swingLows.length > 0) zones.push({ type: 'support', level: Math.min(...data.swingLows) });
    return zones;
}

// ===== Filtros =====
export function checkLateralMarket(data, currentPrice) {
    const atr = data.atr_1H || 0;
    const atrPercent = atr / currentPrice;
    const bbWidth = data.bbWidth || 0.1;
    const isRanging = atrPercent < 0.02 && bbWidth < 0.05;
    if (isRanging) {
        return { blocked: true, reason: `Lateral: ATR% ${(atrPercent*100).toFixed(2)} < 2%, BB ${(bbWidth*100).toFixed(1)}% < 5%` };
    }
    return { blocked: false, bonus: 0 };
}

export function checkHTFAlignment(data, ltfDirection) {
    const htf = data.htfStructure;
    if (htf.bias === 'NEUTRAL') return { passed: true, penalty: 0 };
    if (ltfDirection === 'LONG' && htf.bias === 'BULLISH') return { passed: true, bonus: 10 };
    if (ltfDirection === 'SHORT' && htf.bias === 'BEARISH') return { passed: true, bonus: 10 };
    return { passed: false, penalty: 30, reason: `HTF ${htf.bias} não alinhado com LTF ${ltfDirection}` };
}

export function checkOnChainFilter(data, symbol) {
    const currentPrice = data.price || 0;
    if (symbol === 'BTCUSDT') {
        const mvrv = data.mvrv; 
        const sopr = data.sopr; 
        const realizedPrice = data.realizedPrice; 
        
        if (mvrv && mvrv > 3.5) return { allow: false, reason: `MVRV extremo (${mvrv.toFixed(2)}) - zona de distribuição` };
        if (sopr && sopr < 0.75) return { allow: false, reason: `SOPR < 0.75 (${sopr.toFixed(2)}) - capitulação extrema` };
        if (mvrv && sopr && mvrv < 1.0 && sopr < 1) return { allow: true, bonus: 15, reason: 'MVRV/SOPR indicam capitulação' };
        if (realizedPrice && currentPrice < realizedPrice) return { allow: true, bonus: 10, reason: 'Preço abaixo do valor realizado' };
        return { allow: true, bonus: 0 };
    } else {
        const ema200 = data.ema200_4H || data.price;
        if (!ema200) return { allow: true, bonus: 0 };
        const ratio = currentPrice / ema200;
        if (ratio > 2.5) return { allow: false, reason: `Preço ${ratio.toFixed(2)}x acima da média 200 - extremo` };
        if (ratio < 0.7) return { allow: true, bonus: 10, reason: 'Preço descontado vs média 200' };
        return { allow: true, bonus: 0 };
    }
}

export function checkVolumeAndOrderflow(data, direction) {
    const currentVol = data.currentVolume || 0;
    const avgVol = data.volumeAvg || 1;
    if (avgVol === 0) return { volumeConfirmed: false, bonus: 0, blocked: false };
    const ratio = currentVol / avgVol;
    const volumeSpike = ratio > 2.5;
    const candles = data.candles1H;
    let cvdDelta = 0;
    if (candles.length > 2) {
        const lastClose = candles[candles.length - 1].close;
        const prevClose = candles[candles.length - 2].close;
        cvdDelta = (lastClose - prevClose) / prevClose;
    }
    const cvdSpike = Math.abs(cvdDelta) > 0.01;
    let fvgConfluence = false;
    if (candles.length > 3) {
        const c1 = candles[candles.length - 3];
        const c2 = candles[candles.length - 2];
        const c3 = candles[candles.length - 1];
        if (direction === 'LONG' && c1.low > c2.high && c3.close > c2.high) fvgConfluence = true;
        if (direction === 'SHORT' && c1.high < c2.low && c3.close < c2.low) fvgConfluence = true;
    }
    
    if (!fvgConfluence) {
        return { volumeConfirmed: volumeSpike, orderflowConfirmed: cvdSpike, fvgConfluence: false, bonus: 0, blocked: false };
    }
    let bonus = 0;
    if (volumeSpike && cvdSpike) bonus += 25;
    if (fvgConfluence) bonus += 15;
    return { volumeConfirmed: volumeSpike, orderflowConfirmed: cvdSpike, fvgConfluence: true, bonus, blocked: false };
}

export function checkDerivativesFilter(data, direction) {
    const fr = data.fundingRate || 0;
    const oiDelta = data.oiDelta || 0;
    const frThreshold = 0.0001;
    const oiThreshold = 3;
    if (fr > frThreshold && oiDelta > oiThreshold) {
        return { allow: false, reason: `Funding alto (${(fr*100).toFixed(3)}%) e OI subindo (${oiDelta.toFixed(1)}%) - superaquecido` };
    }
    if (fr < -frThreshold && oiDelta < -oiThreshold) {
        return { allow: false, reason: `Funding negativo (${(fr*100).toFixed(3)}%) e OI caindo (${oiDelta.toFixed(1)}%) - sobrevendido` };
    }
    if (Math.abs(fr) < 0.00005 && oiDelta > 2) {
        return { allow: true, bonus: 8, reason: 'Funding neutro e OI subindo - tendência saudável' };
    }
    if (fr > 0.00005 && oiDelta < -2) {
        return { allow: true, bonus: 8, reason: 'Funding positivo e OI caindo - correção provável' };
    }
    return { allow: true, bonus: 0 };
}

export function checkPortfolioExposure(activePositions, direction) {
    const sameDir = Object.values(activePositions).filter(p => p.type === direction).length;
    if (sameDir >= 1) {
        return { blocked: true, reason: `Exposição correlacionada: já há ${sameDir} posição(oes) ${direction}` };
    }
    return { blocked: false };
}

export function checkMTFAlignment(data, direction) {
    const conf = data.mtfConfluence;
    if (!conf) return { passed: true, alignedCount: 0 };
    const wantDir = direction === 'LONG' ? 'BULL' : 'BEAR';
    const aligned = conf.directions.filter(d => d.dir === wantDir).length;
    if (aligned === 0) return { passed: false, reason: `Sem confirmação MTF (${conf.confluencia})` };
    return { passed: true, alignedCount: aligned };
}

// ===== Score principal =====
export function computeScore(symbol, assetsData, liqMap) {
    const data = assetsData[symbol];
    if (!data || data.price === 0) return { score: 50, components: {}, blockReason: null };
    let score = 50, blockReason = null, scoreBonus = 0;
    let smcScore = 50;
    if (data.currentBOS === 'BULLISH') smcScore = 80;
    else if (data.currentBOS === 'BEARISH') smcScore = 20;
    const primaryDirection = data.currentBOS === 'BULLISH' ? 'LONG' : (data.currentBOS === 'BEARISH' ? 'SHORT' : null);
    let mtfPassed = true, mtfAlignedCount = 0;
    if (primaryDirection) {
        const mtfCheck = checkMTFAlignment(data, primaryDirection);
        mtfPassed = mtfCheck.passed;
        mtfAlignedCount = mtfCheck.alignedCount || 0;
        if (!mtfPassed) blockReason = mtfCheck.reason;
        else scoreBonus += mtfAlignedCount * 5;
    }
    if (primaryDirection) {
        const htfCheck = checkHTFAlignment(data, primaryDirection);
        if (!htfCheck.passed) blockReason = htfCheck.reason || 'HTF não alinhado';
        else scoreBonus += htfCheck.bonus || 0;
    }
    let momScore = clamp(data.rsi_1H, 0, 100);
    if (primaryDirection === 'LONG') {
        if (data.rsi_1H > 75) momScore *= 0.6;
        else if (data.rsi_1H >= 35 && data.rsi_1H <= 55) momScore = 85;
    }
    if (primaryDirection === 'SHORT') {
        if (data.rsi_1H < 25) momScore = 100 - momScore;
        else if (data.rsi_1H >= 45 && data.rsi_1H <= 65) momScore = 85;
    }
    let ofScore = 50;
    const liq = liqMap[symbol] || { longs: 0, shorts: 0 };
    if (primaryDirection === 'LONG' && liq.shorts > 50000) ofScore = 80;
    else if (primaryDirection === 'LONG' && liq.longs > 50000) ofScore = 20;
    else if (primaryDirection === 'SHORT' && liq.longs > 50000) ofScore = 80;
    else if (primaryDirection === 'SHORT' && liq.shorts > 50000) ofScore = 20;
    const macroSafe = isSafeToTrade(assetsData) ? 100 : 0;
    let oiScore = clamp(50 + (data.oiDelta * 2), 0, 100);
    const lateralCheck = checkLateralMarket(data, data.price);
    if (lateralCheck.blocked) blockReason = lateralCheck.reason;
    else if (lateralCheck.bonus) scoreBonus += lateralCheck.bonus;
    if (primaryDirection) {
        const volCheck = checkVolumeAndOrderflow(data, primaryDirection);
        if (volCheck.blocked) blockReason = volCheck.reason || 'FVG não confluente';
        else {
            scoreBonus += volCheck.bonus || 0;
        }
    }
    if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT' || symbol === 'SOLUSDT') {
        const ocCheck = checkOnChainFilter(data, symbol);
        if (!ocCheck.allow) blockReason = ocCheck.reason;
        else scoreBonus += ocCheck.bonus || 0;
    }
    if (primaryDirection) {
        const derivCheck = checkDerivativesFilter(data, primaryDirection);
        if (!derivCheck.allow) blockReason = derivCheck.reason;
        else scoreBonus += derivCheck.bonus || 0;
    }
    if (blockReason) {
        return { score: 50, components: { mtf: '50', smc: '50', mom: '50', of: '50', macro: '50', oi: '50' }, blockReason };
    }
    let rawScore = (smcScore * 0.25) + (momScore * 0.15) + (ofScore * 0.10) + (macroSafe * 0.10) + (oiScore * 0.05);
    if (mtfPassed && primaryDirection) rawScore += 10;
    const chop = computeChoppiness(data);
    data.chopIndex = chop;
    if (chop > 61) rawScore = 50 + (rawScore - 50) * 0.3;
    rawScore += scoreBonus;
    let finalScore = Math.round(clamp(rawScore, 0, 100));
    data.mtfTrend = (finalScore >= 55) ? 'LONG' : (finalScore <= 45 ? 'SHORT' : 'NEUTRAL');
    return {
        score: finalScore,
        components: {
            mtf: (mtfPassed ? 'OK' : 'FAIL'),
            smc: smcScore.toFixed(0),
            mom: momScore.toFixed(0),
            of: ofScore.toFixed(0),
            macro: macroSafe.toFixed(0),
            oi: oiScore.toFixed(0)
        },
        blockReason: null,
        action: finalScore >= 70 ? 'COMPRA' : (finalScore <= 30 ? 'VENDA' : 'NEUTRO')
    };
}

// ===== Safe to Trade (horários) =====
export function isSafeToTrade(assetsData) {
    const now = new Date();
    const hourUTC = now.getUTCHours();
    const minUTC = now.getUTCMinutes();
    const day = now.getUTCDay(); 
    if (day >= 1 && day <= 5 && ((hourUTC === 12 && minUTC >= 20) || (hourUTC === 13 && minUTC <= 40))) {
        return false;
    }
    return true;
}

// ===== Kelly =====
export function KellyPositionSize(winRate, rrRatio) {
    if (winRate <= 0 || rrRatio <= 0) return 0.01;
    const W = winRate;
    const R = rrRatio;
    const kelly = ((W * R) - (1 - W)) / R;
    const fraction = Math.max(kelly * 0.25, 0.005);
    return Math.min(fraction, 0.05);
}
