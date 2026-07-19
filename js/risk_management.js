// js/risk_management.js – Motor SMC + MTF v3.5.2 (Unificado)
// ============================================================
// Este arquivo contém TODAS as funções do Backtest Engine v3.5.2
// para garantir que robô ao vivo e backtest usem a mesma lógica.
// ============================================================

import { calcEMA, calculateATR, calculateVWAP, calculateADX, updateSwingPoints } from './indicadores.js';

// ===== CONSTANTE UNIFICADA (v3.5.2) =====
const SWING_LOOKBACK = 3;

// ===== MTF CONFLUENCE (v3.5.2) =====
export function getMTFAlignmentLocal(candles1H, candles4H, currentTime, options = {}) {
    const { htfBullishVelas = 3, htfBearishVelas = 6 } = options;
    const relevant1H = candles1H.filter(c => c.time <= currentTime).slice(-50);
    const relevant4H = candles4H.filter(c => c.time <= currentTime).slice(-50);
    if (relevant1H.length < 20 || relevant4H.length < 10) {
        return { alinhado: false, score: 0, directions: [], bias: 'NEUTRAL' };
    }

    const getDir = (candles) => {
        if (candles.length < 20) return 'NEUTRO';
        const closes = candles.map(c => c.close);
        const ema20 = calcEMA(closes, 20).slice(-1)[0];
        const ema50 = calcEMA(closes, 50).slice(-1)[0];
        const last = closes[closes.length - 1];
        if (ema20 > ema50 && last > ema20) return 'BULL';
        if (ema20 < ema50 && last < ema20) return 'BEAR';
        return 'NEUTRO';
    };

    const dir1H = getDir(relevant1H);
    const dir4H = getDir(relevant4H);
    const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
    const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;

    // HTF bias baseado em velas consecutivas (v3.5.2)
    let bias = 'NEUTRAL';
    if (relevant4H.length >= htfBullishVelas + htfBearishVelas) {
        const closes4H = relevant4H.map(c => c.close);
        const ema200 = calcEMA(closes4H, 200);
        const lastBull = closes4H.slice(-htfBullishVelas);
        const lastBear = closes4H.slice(-htfBearishVelas);
        const ema200Bull = ema200.slice(-htfBullishVelas);
        const ema200Bear = ema200.slice(-htfBearishVelas);
        const allAbove = lastBull.every((c, i) => c > ema200Bull[i]);
        const allBelow = lastBear.every((c, i) => c < ema200Bear[i]);
        if (allBelow) bias = 'BEARISH';
        else if (allAbove) bias = 'BULLISH';
    }

    return {
        directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
        score: bulls - bears,
        alinhado: bulls === 2 || bears === 2,
        bias: bias,
        alinhadoParcial: (dir4H === 'BULL' && dir1H !== 'BEAR') || (dir4H === 'BEAR' && dir1H !== 'BULL')
    };
}

// ===== BOS E RETEST (v3.5.2) =====
export function checkBOSAndRetest(state, direction, retestDistPct = 2.0) {
    // retestDistPct é a distância em ATR (ex: 2.0)
    const recentHighs = state.swingHighs.slice(-SWING_LOOKBACK);
    const recentLows = state.swingLows.slice(-SWING_LOOKBACK);
    const atr = state.atr_1H || (state.price * 0.02);

    if (direction === 'LONG') {
        const brokenLevel = recentHighs.length ? Math.max(...recentHighs) : null;
        if (!brokenLevel) return { bos: false, retest: false, level: null };
        const bos = state.price > brokenLevel;
        const distInAtr = Math.abs(state.price - brokenLevel) / atr;
        const retest = bos && distInAtr < retestDistPct;
        return { bos, retest, level: brokenLevel };
    } else if (direction === 'SHORT') {
        const brokenLevel = recentLows.length ? Math.min(...recentLows) : null;
        if (!brokenLevel) return { bos: false, retest: false, level: null };
        const bos = state.price < brokenLevel;
        const distInAtr = Math.abs(state.price - brokenLevel) / atr;
        const retest = bos && distInAtr < retestDistPct;
        return { bos, retest, level: brokenLevel };
    }
    return { bos: false, retest: false, level: null };
}

// ===== CÁLCULO DE STOP E TARGETS (v3.5.2) =====
export function calculateStopAndTargets(state, direction, config) {
    const atr = state.atr_1H || (state.price * 0.02);
    const volatilityAtr = atr * (1 + (state.volatilityFactor || 1.0) * 0.5);
    const recentHighs = state.swingHighs.slice(-SWING_LOOKBACK);
    const recentLows = state.swingLows.slice(-SWING_LOOKBACK);

    let stop, tp1, tp2, tp3, structLevel;

    if (direction === 'LONG') {
        const structLevelCandidates = recentLows.length ? Math.min(...recentLows) : state.price * 0.98;
        structLevel = structLevelCandidates - (atr * 0.3);
        const atrStop = state.price - atr * config.stopLong;
        stop = (recentLows.length && (state.price - structLevelCandidates) <= atr * 2.5) ? structLevelCandidates : atrStop;
        tp1 = state.price + (volatilityAtr * config.tp1Long);
        tp2 = state.price + (volatilityAtr * config.tp2Dist);
        tp3 = state.price + (volatilityAtr * 7.0);
    } else { // SHORT
        const structLevelCandidates = recentHighs.length ? Math.max(...recentHighs) : state.price * 1.02;
        structLevel = structLevelCandidates + (atr * 0.3);
        const atrStop = state.price + atr * config.stopShort;
        stop = (recentHighs.length && (structLevelCandidates - state.price) <= atr * 2.5) ? structLevelCandidates : atrStop;
        tp1 = state.price - (volatilityAtr * config.tp1Short);
        tp2 = state.price - (volatilityAtr * config.tp2Dist);
        tp3 = state.price - (volatilityAtr * 7.0);
    }

    // RR Ponderado (50/30/20) – v3.5.2
    let rrPonderado;
    if (direction === 'LONG') {
        const ganhoPonderado = (tp1 - state.price) * 0.5 + (tp2 - state.price) * 0.3 + (tp3 - state.price) * 0.2;
        const risco = state.price - stop;
        rrPonderado = risco > 0 ? ganhoPonderado / risco : 0;
    } else {
        const ganhoPonderado = (state.price - tp1) * 0.5 + (state.price - tp2) * 0.3 + (state.price - tp3) * 0.2;
        const risco = stop - state.price;
        rrPonderado = risco > 0 ? ganhoPonderado / risco : 0;
    }

    return { stop, tp1, tp2, tp3, rrPonderado };
}

// ===== GESTÃO DE POSIÇÃO (v3.5.2) =====
export function checkPositionManagement(pos, state, candle, config) {
    // pos: objeto com type, entryPrice, stop, tp1, tp2, trailingStop, partialTaken, tp2Taken, sizeRemaining, partialPnlUsd, partialPnlPct, maxProfitPrice, entryTime
    // state: { atr_1H, atrHistory, swingHighs, swingLows, volatilityFactor, price }
    // candle: { high, low, close, time }
    // config: { tp1Pct, tp2Pct, runnerPct, trailLong, trailShort, maxHoldHours }

    const { type, entryPrice, stop, tp1, tp2, trailingStop } = pos;
    const high = candle.high;
    const low = candle.low;
    const currentPrice = candle.close;
    const atr = state.atr_1H || (currentPrice * 0.02);
    const volFactor = state.volatilityFactor || 1.0;
    let closed = false;
    let exitPrice = 0;
    let reason = '';
    let totalPnlPct = 0;
    let totalPnlUsd = 0;

    // Atualiza maxProfitPrice
    if (type === 'LONG') {
        pos.maxProfitPrice = Math.max(pos.maxProfitPrice || entryPrice, high);
    } else {
        pos.maxProfitPrice = Math.min(pos.maxProfitPrice || entryPrice, low);
    }

    // Time-based exit
    const holdHours = (candle.time - pos.entryTime / 1000) / 3600;
    const dynamicMaxHold = (state.adx > 30) ? config.maxHoldHours * 1.5 : config.maxHoldHours;
    if (holdHours >= dynamicMaxHold) {
        exitPrice = currentPrice;
        closed = true;
        reason = 'Tempo máximo excedido';
    }

    if (!closed) {
        if (type === 'LONG') {
            // TP2
            if (high >= tp2 && !pos.tp2Taken) {
                pos.tp2Taken = true;
                const closeFractionTP2 = config.tp2Pct / (config.tp2Pct + config.runnerPct);
                const closeSize = pos.sizeRemaining * closeFractionTP2;
                const partialPnlPct = (tp2 - entryPrice) / entryPrice * 100;
                pos.partialPnlUsd += (10000 * closeSize) * (partialPnlPct / 100); // usando 10000 como equity base
                pos.partialPnlPct += partialPnlPct * closeSize;
                pos.sizeRemaining -= closeSize;
                pos.trailingStop = Math.max(pos.trailingStop, tp1);
            }
            // Stop Loss (antes do parcial)
            else if (!pos.partialTaken && low <= stop) {
                exitPrice = stop;
                closed = true;
                reason = 'Stop Loss';
            }
            // TP1 parcial
            else if (high >= tp1 && !pos.partialTaken) {
                pos.partialTaken = true;
                const closeSize = pos.sizeRemaining * config.tp1Pct;
                const partialPnlPct = (tp1 - entryPrice) / entryPrice * 100;
                pos.partialPnlUsd = (10000 * closeSize) * (partialPnlPct / 100);
                pos.partialPnlPct = partialPnlPct * closeSize;
                pos.sizeRemaining -= closeSize;
                pos.trailingStop = Math.max(entryPrice, entryPrice + atr * volFactor * config.trailLong);
            }
            // Trailing Stop (Chandelier Exit)
            else if (pos.partialTaken) {
                const newStop = pos.maxProfitPrice - (atr * volFactor * config.trailLong);
                if (newStop > pos.trailingStop) pos.trailingStop = newStop;
                if (low <= pos.trailingStop) {
                    exitPrice = pos.trailingStop;
                    closed = true;
                    reason = 'Chandelier Exit';
                }
            }
        } else { // SHORT
            if (low <= tp2 && !pos.tp2Taken) {
                pos.tp2Taken = true;
                const closeFractionTP2 = config.tp2Pct / (config.tp2Pct + config.runnerPct);
                const closeSize = pos.sizeRemaining * closeFractionTP2;
                const partialPnlPct = (entryPrice - tp2) / entryPrice * 100;
                pos.partialPnlUsd += (10000 * closeSize) * (partialPnlPct / 100);
                pos.partialPnlPct += partialPnlPct * closeSize;
                pos.sizeRemaining -= closeSize;
                pos.trailingStop = Math.min(pos.trailingStop, tp1);
            } else if (!pos.partialTaken && high >= stop) {
                exitPrice = stop;
                closed = true;
                reason = 'Stop Loss';
            } else if (low <= tp1 && !pos.partialTaken) {
                pos.partialTaken = true;
                const closeSize = pos.sizeRemaining * config.tp1Pct;
                const partialPnlPct = (entryPrice - tp1) / entryPrice * 100;
                pos.partialPnlUsd = (10000 * closeSize) * (partialPnlPct / 100);
                pos.partialPnlPct = partialPnlPct * closeSize;
                pos.sizeRemaining -= closeSize;
                pos.trailingStop = Math.min(entryPrice, entryPrice - atr * volFactor * config.trailShort);
            } else if (pos.partialTaken) {
                const newStop = pos.maxProfitPrice + (atr * volFactor * config.trailShort);
                if (newStop < pos.trailingStop) pos.trailingStop = newStop;
                if (high >= pos.trailingStop) {
                    exitPrice = pos.trailingStop;
                    closed = true;
                    reason = 'Chandelier Exit';
                }
            }
        }
    }

    if (closed) {
        const invested = 10000 * pos.sizeRemaining;
        const pnlPct = type === 'LONG'
            ? (exitPrice - entryPrice) / entryPrice * 100
            : (entryPrice - exitPrice) / entryPrice * 100;
        const pnlUsd = invested * (pnlPct / 100);
        totalPnlPct = pnlPct * pos.sizeRemaining + (pos.partialPnlPct || 0);
        totalPnlUsd = pnlUsd + (pos.partialPnlUsd || 0);
        // Atualiza a posição para fechamento
        pos.exitPrice = exitPrice;
        pos.closed = true;
        pos.reason = reason;
        pos.sizeRemaining = 0; // zera para evitar reutilização
        return { closed: true, exitPrice, reason, totalPnlPct, totalPnlUsd, position: pos };
    }

    // Retorna a posição atualizada (ainda aberta)
    return { closed: false, position: pos };
}
