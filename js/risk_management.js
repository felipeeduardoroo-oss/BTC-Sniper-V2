// ================================================================
// js/risk_management.js – Lógica unificada para backtest e live
// ================================================================

import { calcEMA, calculateATR, updateSwingPoints, detectHTFStructure } from './indicadores.js';

// ===== CONSTANTES =====
const SWING_LOOKBACK = 3;

// ===== 1. BOS E RETEST =====
export function checkBOSAndRetest(state, direction, retestDistPct) {
    const recentHighs = state.swingHighs.slice(-SWING_LOOKBACK);
    const recentLows = state.swingLows.slice(-SWING_LOOKBACK);

    if (direction === 'LONG') {
        const brokenLevel = recentHighs.length ? Math.max(...recentHighs) : null;
        if (!brokenLevel) return { bos: false, retest: false, level: null };
        const bos = state.price > brokenLevel;
        const retest = bos && Math.abs(state.price - brokenLevel) / brokenLevel < retestDistPct;
        return { bos, retest, level: brokenLevel };
    } else if (direction === 'SHORT') {
        const brokenLevel = recentLows.length ? Math.min(...recentLows) : null;
        if (!brokenLevel) return { bos: false, retest: false, level: null };
        const bos = state.price < brokenLevel;
        const retest = bos && Math.abs(state.price - brokenLevel) / brokenLevel < retestDistPct;
        return { bos, retest, level: brokenLevel };
    }
    return { bos: false, retest: false, level: null };
}

// ===== 2. CÁLCULO DE STOP, ALVOS E RR PONDERADO =====
export function calculateStopAndTargets(state, direction, params) {
    const {
        stopLong = 1.5,
        stopShort = 2.0,
        tp1Long = 2.0,
        tp1Short = 1.5,
        tp2Dist = 4.0,
        rrMin = 1.8
    } = params;

    const atr = state.atr_1H || (state.price * 0.02);
    const volatilityAtr = atr * (1 + (state.volatilityFactor || 1.0) * 0.5);
    let stop, tp1, tp2, tp3;

    if (direction === 'LONG') {
        const recentLows = state.swingLows.slice(-3);
        const structLevel = (recentLows.length ? Math.min(...recentLows) : state.price * 0.98) - (atr * 0.3);
        const atrStop = state.price - atr * stopLong;
        stop = (recentLows.length && (state.price - structLevel) <= atr * 2.5) ? structLevel : atrStop;
        tp1 = state.price + (volatilityAtr * tp1Long);
        tp2 = state.price + (volatilityAtr * tp2Dist);
        tp3 = state.price + (volatilityAtr * 7.0);
    } else { // SHORT
        const recentHighs = state.swingHighs.slice(-3);
        const structLevel = (recentHighs.length ? Math.max(...recentHighs) : state.price * 1.02) + (atr * 0.3);
        const atrStopShort = state.price + atr * stopShort;
        stop = (recentHighs.length && (structLevel - state.price) <= atr * 2.5) ? structLevel : atrStopShort;
        tp1 = state.price - (volatilityAtr * tp1Short);
        tp2 = state.price - (volatilityAtr * tp2Dist);
        tp3 = state.price - (volatilityAtr * 7.0);
    }

    // RR Ponderado (50/30/20)
    let rrPonderado;
    if (direction === 'LONG') {
        const ganhoPonderado = (tp1 - state.price) * 0.5 + (tp2 - state.price) * 0.3 + (tp3 - state.price) * 0.2;
        rrPonderado = (state.price - stop) > 0 ? ganhoPonderado / (state.price - stop) : 0;
    } else {
        const ganhoPonderado = (state.price - tp1) * 0.5 + (state.price - tp2) * 0.3 + (state.price - tp3) * 0.2;
        rrPonderado = (stop - state.price) > 0 ? ganhoPonderado / (stop - state.price) : 0;
    }

    return { stop, tp1, tp2, tp3, rrPonderado, atr };
}

// ===== 3. ATUALIZAÇÃO DE TRAILING STOP (CHANDELIER EXIT) =====
export function updateTrailingStop(position, state, direction, params) {
    const { trailLong = 1.2, trailShort = 1.5 } = params;
    const atr = state.atr_1H || (state.price * 0.02);
    const volatilityFactor = state.volatilityFactor || 1.0;

    if (direction === 'LONG') {
        if (state.swingLows.length > 0) {
            const lastSwingLow = Math.min(...state.swingLows.slice(-3));
            let newTrail = lastSwingLow - (atr * 0.2);
            // Ajuste por volatilidade
            if (state.atrHistory && state.atrHistory.length > 20) {
                const avgATR = state.atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
                if (atr > avgATR * 1.5) newTrail -= atr * 0.1;
                else if (atr < avgATR * 0.7) newTrail += atr * 0.1;
            }
            if (newTrail > position.trailingStop) {
                position.trailingStop = newTrail;
                return true; // atualizou
            }
        }
        // Trail baseado em ATR se não houver swing
        const baseTrail = position.entryPrice + (atr * volatilityFactor * trailLong);
        if (baseTrail > position.trailingStop) {
            position.trailingStop = baseTrail;
            return true;
        }
    } else { // SHORT
        if (state.swingHighs.length > 0) {
            const lastSwingHigh = Math.max(...state.swingHighs.slice(-3));
            let newTrail = lastSwingHigh + (atr * 0.2);
            if (state.atrHistory && state.atrHistory.length > 20) {
                const avgATR = state.atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
                if (atr > avgATR * 1.5) newTrail += atr * 0.1;
                else if (atr < avgATR * 0.7) newTrail -= atr * 0.1;
            }
            if (newTrail < position.trailingStop) {
                position.trailingStop = newTrail;
                return true;
            }
        }
        const baseTrail = position.entryPrice - (atr * volatilityFactor * trailShort);
        if (baseTrail < position.trailingStop) {
            position.trailingStop = baseTrail;
            return true;
        }
    }
    return false;
}

// ===== 4. GESTÃO COMPLETA DA POSIÇÃO (CHAMADA A CADA CANDLE) =====
export function checkPositionManagement(position, state, candle, params) {
    if (!position) return { closed: false, position };

    const {
        tp1Pct = 0.4,
        tp2Pct = 0.4,
        runnerPct = 0.2,
        trailLong = 1.2,
        trailShort = 1.5,
        maxHoldHours = 72
    } = params;

    const high = candle.high;
    const low = candle.low;
    let closed = false;
    let exitPrice = 0;
    let reason = '';
    let equity = 10000; // será passado como argumento na prática, mas aqui usamos referência

    // Tempo máximo
    const holdHours = (candle.time - position.entryTime / 1000) / 3600;
    if (holdHours >= maxHoldHours) {
        exitPrice = candle.close;
        closed = true;
        reason = 'Tempo máximo excedido';
    }

    if (!closed) {
        if (position.type === 'LONG') {
            // Verifica TP2 (runner)
            if (high >= position.tp2 && !position.tp2Taken) {
                position.tp2Taken = true;
                const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                const closeSize = position.sizeRemaining * closeFractionTP2;
                const partialPnlPct = (position.tp2 - position.entryPrice) / position.entryPrice * 100;
                position.partialPnlUsd += (position.initialEquity * closeSize) * (partialPnlPct / 100);
                position.partialPnlPct += partialPnlPct * closeSize;
                position.sizeRemaining -= closeSize;
                position.trailingStop = Math.max(position.trailingStop, position.tp1);
            }
            // Stop Loss
            else if (!position.partialTaken && low <= position.stop) {
                exitPrice = position.stop;
                closed = true;
                reason = 'Stop Loss';
            }
            // TP1 Parcial
            else if (high >= position.tp1 && !position.partialTaken) {
                position.partialTaken = true;
                const closeSize = position.sizeRemaining * tp1Pct;
                const partialPnlPct = (position.tp1 - position.entryPrice) / position.entryPrice * 100;
                position.partialPnlUsd = (position.initialEquity * closeSize) * (partialPnlPct / 100);
                position.partialPnlPct = partialPnlPct * closeSize;
                position.sizeRemaining -= closeSize;
                position.trailingStop = Math.max(position.entryPrice, position.entryPrice + state.atr_1H * trailLong);
                position.maxProfitPrice = high;
                position.movedToBE = true;
            }
            // Trailing (Chandelier)
            else if (position.partialTaken || position.movedToBE) {
                position.maxProfitPrice = Math.max(position.maxProfitPrice || position.entryPrice, high);
                // Atualiza trailing via função auxiliar
                const updated = updateTrailingStop(position, state, 'LONG', params);
                if (low <= position.trailingStop) {
                    exitPrice = position.trailingStop;
                    closed = true;
                    reason = 'Chandelier Exit';
                }
            }
        } else { // SHORT
            if (low <= position.tp2 && !position.tp2Taken) {
                position.tp2Taken = true;
                const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                const closeSize = position.sizeRemaining * closeFractionTP2;
                const partialPnlPct = (position.entryPrice - position.tp2) / position.entryPrice * 100;
                position.partialPnlUsd += (position.initialEquity * closeSize) * (partialPnlPct / 100);
                position.partialPnlPct += partialPnlPct * closeSize;
                position.sizeRemaining -= closeSize;
                position.trailingStop = Math.min(position.trailingStop, position.tp1);
            }
            else if (!position.partialTaken && high >= position.stop) {
                exitPrice = position.stop;
                closed = true;
                reason = 'Stop Loss';
            }
            else if (low <= position.tp1 && !position.partialTaken) {
                position.partialTaken = true;
                const closeSize = position.sizeRemaining * tp1Pct;
                const partialPnlPct = (position.entryPrice - position.tp1) / position.entryPrice * 100;
                position.partialPnlUsd = (position.initialEquity * closeSize) * (partialPnlPct / 100);
                position.partialPnlPct = partialPnlPct * closeSize;
                position.sizeRemaining -= closeSize;
                position.trailingStop = Math.min(position.entryPrice, position.entryPrice - state.atr_1H * trailShort);
                position.maxProfitPrice = low;
                position.movedToBE = true;
            }
            else if (position.partialTaken || position.movedToBE) {
                position.maxProfitPrice = Math.min(position.maxProfitPrice || position.entryPrice, low);
                const updated = updateTrailingStop(position, state, 'SHORT', params);
                if (high >= position.trailingStop) {
                    exitPrice = position.trailingStop;
                    closed = true;
                    reason = 'Chandelier Exit';
                }
            }
        }
    }

    if (closed) {
        // Calcula P&L final considerando parciais
        const invested = position.initialEquity * position.sizeRemaining;
        const pnlPctFinal = position.type === 'LONG'
            ? (exitPrice - position.entryPrice) / position.entryPrice * 100
            : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        const pnlUsdFinal = invested * (pnlPctFinal / 100);
        const totalPnlUsd = pnlUsdFinal + (position.partialPnlUsd || 0);
        const totalPnlPct = (pnlPctFinal * position.sizeRemaining) + (position.partialPnlPct || 0);

        return {
            closed: true,
            position: null,
            exitPrice,
            reason,
            totalPnlUsd,
            totalPnlPct,
            entryPrice: position.entryPrice,
            type: position.type,
            entryTime: position.entryTime,
            symbol: position.symbol
        };
    }

    return { closed: false, position };
}

// ===== 5. MTF ALINHAMENTO HISTÓRICO (LOCAL) =====
export function getMTFAlignmentLocal(candles1H, candles4H, currentTime, params = {}) {
    const { htfBullishVelas = 3, htfBearishVelas = 6 } = params;
    const relevant1H = candles1H.filter(c => c.time <= currentTime).slice(-50);
    const relevant4H = candles4H.filter(c => c.time <= currentTime).slice(-50);

    if (relevant1H.length < 20 || relevant4H.length < 10) {
        return { alinhado: false, score: 0, directions: [], bias: 'NEUTRO' };
    }

    const getDirection = (candles) => {
        if (candles.length < 20) return 'NEUTRO';
        const closes = candles.map(c => c.close);
        const ema20 = calcEMA(closes, 20).slice(-1)[0];
        const ema50 = calcEMA(closes, 50).slice(-1)[0];
        const last = closes[closes.length - 1];
        if (ema20 > ema50 && last > ema20) return 'BULL';
        if (ema20 < ema50 && last < ema20) return 'BEAR';
        return 'NEUTRO';
    };

    const dir1H = getDirection(relevant1H);
    const dir4H = getDirection(relevant4H);

    // HTF Bias com velas
    let htfBias = 'NEUTRAL';
    if (relevant4H.length >= 50) {
        const closes4H = relevant4H.map(c => c.close);
        const ema200 = calcEMA(closes4H, 200).slice(-1)[0] || closes4H[closes4H.length - 1];
        const lastBull = closes4H.slice(-htfBullishVelas);
        const lastBear = closes4H.slice(-htfBearishVelas);
        const allAbove = lastBull.every(c => c > ema200);
        const allBelow = lastBear.every(c => c < ema200);
        if (allBelow) htfBias = 'BEARISH';
        else if (allAbove) htfBias = 'BULLISH';
    }

    const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
    const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;

    return {
        directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
        score: bulls - bears,
        alinhado: bulls === 2 || bears === 2,
        bias: htfBias
    };
}
