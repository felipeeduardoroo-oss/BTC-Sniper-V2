// ================================================================
// js/backtest.js – Motor SMC+MTF v3.5.2 (Backtest + Live unificados)
// ================================================================

import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic,
    fetchFearGreed,
    fetchHistoricalFunding,
    fetchHistoricalOI,
    fetchHistoricalMVRV,
    getMTFConfluence,
    sleep
} from './dados_externos.js';
import {
    calculateADX,
    calculateATR,
    calcEMA,
    updateSwingPoints,
    detectHTFStructure,
    computeScore,
    calculateConfidenceScore,
    checkDerivativesFilter,
    KellyPositionSize,
    detectVolumeAnomaly,
    calculateVWAP,
    detectRSIDivergence,
    checkPortfolioExposure,
    clamp
} from './indicadores.js';

// ===== HELPERS =====
function logDebug(message, data = null) {
    console.log(`[Backtest v3.5.2] ${message}`, data || '');
}

function findMostRecent(arr, cond) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (cond(arr[i])) return arr[i];
    }
    return null;
}

const SWING_LOOKBACK = 3;

// ===== BOS E RETEST =====
function checkBOSAndRetest(state, direction, retestDistPct) {
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

// ===== MTF (assíncrono) =====
async function getMTFAlignmentAtTime(symbol, currentTime) {
    const mtfData = await getMTFConfluence(symbol);
    if (!mtfData || !mtfData.directions) {
        return { alinhado: false, score: 0, directions: [] };
    }
    return {
        directions: mtfData.directions,
        score: mtfData.score || 0,
        alinhado: mtfData.alinhado || false
    };
}

// ================================================================
// FUNÇÃO PRINCIPAL – processCandle (Live + Backtest)
// ================================================================
export async function processCandle(
    state,
    candle,
    symbol,
    options = {}
) {
    // Parâmetros com fallback (valores do relatório)
    const {
        scoreMin = 50,
        scoreMaxShort = 49,
        adxMin = 17,
        rrMin = 1.5,
        retestDistPct = 0.04,
        emaRetest = false,
        mtfRequired = false,
        ignoreBOS = false,
        ignoreRetest = false,
        requireSweep = false,
        maxHoldHours = 72,
        htfBullishVelas = 3,
        diDiffMinLong = 0,
        mvrvDropPercent = 0.15,
        htfBearishVelas = 4,
        diDiffMinShort = 10,
        stopLong = 2.0,
        stopShort = 2.0,
        tp1Long = 0.5,
        tp1Short = 0.5,
        tp2Dist = 4.0,
        trailLong = 0,
        trailShort = 0,
        tp1Pct = 0,
        tp2Pct = 0,
        runnerPct = 1.0,
        zFundingMax = 1.5,
        zOiMax = 1.5
    } = options;

    // Inicializa estado se necessário
    if (!state.candles1H) state.candles1H = [];
    if (!state.candles4H) state.candles4H = [];
    if (!state.atrHistory) state.atrHistory = [];
    if (!state.swingHighs) state.swingHighs = [];
    if (!state.swingLows) state.swingLows = [];
    if (!state.fundingHistory) state.fundingHistory = [];
    if (!state.oiDeltaHistory) state.oiDeltaHistory = [];
    if (!state.bandwidthHistory) state.bandwidthHistory = [];
    if (!state.adxRolling) state.adxRolling = [];
    if (!state.mvrvHistory) state.mvrvHistory = [];
    if (!state.position) state.position = null;
    if (!state.equity) state.equity = 10000;
    if (!state.highWaterMark) state.highWaterMark = state.equity;
    if (!state.winCount) state.winCount = 0;
    if (!state.lossCount) state.lossCount = 0;
    if (!state.blockStats) state.blockStats = {};

    // Atualiza preço e adiciona candle ao histórico
    state.price = candle.close;
    state.candles1H.push(candle);
    if (state.candles1H.length > 200) state.candles1H.shift();

    // ---- Atualiza indicadores ----
    if (state.candles1H.length >= 50) {
        const closes = state.candles1H.map(c => c.close);
        state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
        state.atr_1H = calculateATR(state.candles1H, 14);
        state.atrHistory.push(state.atr_1H);
        if (state.atrHistory.length > 100) state.atrHistory.shift();

        // RSI
        let avgGain = 0, avgLoss = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) avgGain += diff;
            else avgLoss += Math.abs(diff);
        }
        avgGain /= 14;
        avgLoss /= 14;
        state.rsi_1H = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

        const adxData = calculateADX(state.candles1H);
        state.adx = adxData;

        const last24 = state.candles1H.slice(-24);
        state.vwap = calculateVWAP(last24);

        const volAnomaly = detectVolumeAnomaly(state.candles1H, 20, 2.0);
        state.volumeAnomaly = volAnomaly;

        updateSwingPoints(state);

        const relevant4H = state.candles4H.filter(c => c.time <= candle.time);
        if (relevant4H.length >= 20) {
            state.htfStructure = detectHTFStructure(state, relevant4H);
        }

        // Divergência RSI
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
            const div = detectRSIDivergence(state.candles1H, rsiForDiv);
            state.divergence = div;
        }
    } else {
        return { action: 'waiting', reason: 'Aguardando candles suficientes' };
    }

    // ---- Filtros de bandwidth, funding, OI ----
    const closes = state.candles1H.slice(-20).map(c => c.close);
    if (closes.length >= 20) {
        const sma = closes.reduce((a, b) => a + b, 0) / 20;
        const variance = closes.reduce((s, v) => s + (v - sma) ** 2, 0) / 20;
        const stdBB = Math.sqrt(variance);
        const bandwidth = (2 * stdBB) / sma;
        state.bandwidthHistory.push(bandwidth);
        if (state.bandwidthHistory.length > 50) state.bandwidthHistory.shift();
        if (state.bandwidthHistory.length >= 20) {
            const avgBW = state.bandwidthHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
            if (bandwidth < avgBW * 0.6) {
                state.blockStats['baixa_volatilidade_bb'] = (state.blockStats['baixa_volatilidade_bb'] || 0) + 1;
                return { action: 'blocked', reason: 'Baixa volatilidade (bandwidth)' };
            }
        }
    }

    if (state.fundingHistory.length >= 20) {
        const mean = state.fundingHistory.reduce((a, b) => a + b, 0) / state.fundingHistory.length;
        const variance = state.fundingHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / state.fundingHistory.length;
        const std = Math.sqrt(variance);
        const z = (state.fundingRate - mean) / (std || 1);
        if (Math.abs(z) > zFundingMax) {
            state.blockStats[`funding_extremo_z${z.toFixed(2)}`] = (state.blockStats[`funding_extremo_z${z.toFixed(2)}`] || 0) + 1;
            return { action: 'blocked', reason: `Funding extremo (z=${z.toFixed(2)})` };
        }
    }
    if (state.oiDeltaHistory.length >= 20) {
        const meanO = state.oiDeltaHistory.reduce((a, b) => a + b, 0) / state.oiDeltaHistory.length;
        const varO = state.oiDeltaHistory.reduce((s, v) => s + (v - meanO) ** 2, 0) / state.oiDeltaHistory.length;
        const stdO = Math.sqrt(varO);
        const zO = (state.oiDelta - meanO) / (stdO || 1);
        if (Math.abs(zO) > zOiMax) {
            state.blockStats[`oi_extremo_z${zO.toFixed(2)}`] = (state.blockStats[`oi_extremo_z${zO.toFixed(2)}`] || 0) + 1;
            return { action: 'blocked', reason: `OI extremo (z=${zO.toFixed(2)})` };
        }
    }

    // ---- Score e direção ----
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
    const primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

    // Filtros adicionais
    if (state.mvrvHistory.length > 0 && primaryDirection === 'SHORT' && !blockReason) {
        const mvrvPeak90d = Math.max(...state.mvrvHistory);
        const mvrvDrop = mvrvPeak90d > 0 ? (mvrvPeak90d - state.mvrv) / mvrvPeak90d : 0;
        if (mvrvDrop > mvrvDropPercent) {
            blockReason = `MVRV caiu ${(mvrvDrop * 100).toFixed(1)}% do pico de 90d`;
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

    // BOS em tempo real
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
        const avgAdx = state.adxRolling.reduce((a, b) => a + b, 0) / state.adxRolling.length;
        const dynamicAdxThreshold = Math.max(avgAdx * 0.8 + 5, 18);
        if (adxValNow < dynamicAdxThreshold && !blockReason) {
            blockReason = `ADX ${adxValNow.toFixed(1)} < dinâmico ${dynamicAdxThreshold.toFixed(1)}`;
        }
    }
    if (adxValNow < adxMin && !blockReason) blockReason = `ADX < ${adxMin}`;
    if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';

    if (primaryDirection === 'LONG' && (state.adx.plusDI - state.adx.minusDI) < 0 && !blockReason) {
        blockReason = 'DI- > DI+ (Força Bearish)';
    }
    if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason) {
        blockReason = 'Preço abaixo do VWAP';
    } else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason) {
        blockReason = 'Preço acima do VWAP';
    }

    if (!blockReason) {
        const derivCheck = checkDerivativesFilter(state.fundingRate, state.oiDelta);
        if (!derivCheck.allow) blockReason = derivCheck.reason;
    }

    // ===== GESTÃO DE POSIÇÃO =====
    let action = 'none';
    let positionClosed = false;
    let tradeClosed = null;

    if (state.position) {
        const pos = state.position;
        const high = candle.high, low = candle.low;
        let closed = false, exitPrice = 0, reason = '';
        const volatilityFactor = state.volatilityFactor || 1.0;

        const dynamicMaxHold = (adxValNow > 30) ? maxHoldHours * 1.5 : maxHoldHours;
        const holdHours = (candle.time - pos.entryTime) / 3600;
        if (holdHours >= dynamicMaxHold) {
            exitPrice = candle.close;
            closed = true;
            reason = 'Tempo máximo excedido';
        }

        if (!closed) {
            if (pos.type === 'LONG') {
                if (high >= pos.tp2 && !pos.tp2Taken) {
                    pos.tp2Taken = true;
                    const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                    const closeSize = pos.sizeRemaining * closeFractionTP2;
                    const partialPnlPct = (pos.tp2 - pos.entryPrice) / pos.entryPrice * 100;
                    pos.partialPnlUsd += (state.equity * closeSize) * (partialPnlPct / 100);
                    pos.partialPnlPct += partialPnlPct * closeSize;
                    state.equity += (state.equity * closeSize) * (partialPnlPct / 100);
                    if (state.equity > state.highWaterMark) state.highWaterMark = state.equity;
                    pos.sizeRemaining -= closeSize;
                    pos.trailingStop = Math.max(pos.trailingStop, pos.tp1);
                } else if (!pos.partialTaken && low <= pos.stop) {
                    exitPrice = pos.stop; closed = true; reason = 'Stop Loss';
                } else if (high >= pos.tp1 && !pos.partialTaken) {
                    pos.partialTaken = true;
                    const closeSize = pos.sizeRemaining * tp1Pct;
                    const partialPnlPct = (pos.tp1 - pos.entryPrice) / pos.entryPrice * 100;
                    pos.partialPnlUsd = (state.equity * closeSize) * (partialPnlPct / 100);
                    pos.partialPnlPct = partialPnlPct * closeSize;
                    state.equity += pos.partialPnlUsd;
                    if (state.equity > state.highWaterMark) state.highWaterMark = state.equity;
                    pos.sizeRemaining -= closeSize;
                    pos.trailingStop = Math.max(pos.entryPrice, pos.entryPrice + state.atr_1H * volatilityFactor * trailLong);
                    pos.maxProfitPrice = high;
                } else if (pos.partialTaken) {
                    pos.maxProfitPrice = Math.max(pos.maxProfitPrice || pos.entryPrice, high);
                    const newStop = pos.maxProfitPrice - (state.atr_1H * volatilityFactor * trailLong);
                    if (newStop > pos.trailingStop) pos.trailingStop = newStop;
                    if (low <= pos.trailingStop) {
                        exitPrice = pos.trailingStop; closed = true; reason = 'Chandelier Exit';
                    }
                }
            } else { // SHORT
                if (low <= pos.tp2 && !pos.tp2Taken) {
                    pos.tp2Taken = true;
                    const closeFractionTP2 = tp2Pct / (tp2Pct + runnerPct);
                    const closeSize = pos.sizeRemaining * closeFractionTP2;
                    const partialPnlPct = (pos.entryPrice - pos.tp2) / pos.entryPrice * 100;
                    pos.partialPnlUsd += (state.equity * closeSize) * (partialPnlPct / 100);
                    pos.partialPnlPct += partialPnlPct * closeSize;
                    state.equity += (state.equity * closeSize) * (partialPnlPct / 100);
                    if (state.equity > state.highWaterMark) state.highWaterMark = state.equity;
                    pos.sizeRemaining -= closeSize;
                    pos.trailingStop = Math.min(pos.trailingStop, pos.tp1);
                } else if (!pos.partialTaken && high >= pos.stop) {
                    exitPrice = pos.stop; closed = true; reason = 'Stop Loss';
                } else if (low <= pos.tp1 && !pos.partialTaken) {
                    pos.partialTaken = true;
                    const closeSize = pos.sizeRemaining * tp1Pct;
                    const partialPnlPct = (pos.entryPrice - pos.tp1) / pos.entryPrice * 100;
                    pos.partialPnlUsd = (state.equity * closeSize) * (partialPnlPct / 100);
                    pos.partialPnlPct = partialPnlPct * closeSize;
                    state.equity += pos.partialPnlUsd;
                    if (state.equity > state.highWaterMark) state.highWaterMark = state.equity;
                    pos.sizeRemaining -= closeSize;
                    pos.trailingStop = Math.min(pos.entryPrice, pos.entryPrice - state.atr_1H * volatilityFactor * trailShort);
                    pos.maxProfitPrice = low;
                } else if (pos.partialTaken) {
                    pos.maxProfitPrice = Math.min(pos.maxProfitPrice || pos.entryPrice, low);
                    const newStop = pos.maxProfitPrice + (state.atr_1H * volatilityFactor * trailShort);
                    if (newStop < pos.trailingStop) pos.trailingStop = newStop;
                    if (high >= pos.trailingStop) {
                        exitPrice = pos.trailingStop; closed = true; reason = 'Chandelier Exit';
                    }
                }
            }
        }

        if (closed) {
            const invested = state.equity * pos.sizeRemaining;
            const pnlPct = pos.type === 'LONG'
                ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100
                : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
            const pnlUsd = invested * (pnlPct / 100);
            state.equity += pnlUsd;
            if (state.equity > state.highWaterMark) state.highWaterMark = state.equity;

            const totalPnlUsd = pnlUsd + (pos.partialPnlUsd || 0);
            const totalPnlPct = (pnlPct * pos.sizeRemaining) + (pos.partialPnlPct || 0);

            tradeClosed = {
                entryTime: new Date(pos.entryTime * 1000).toISOString(),
                exitTime: new Date(candle.time * 1000).toISOString(),
                symbol,
                direction: pos.type,
                entryPrice: pos.entryPrice,
                stopLoss: pos.stop,
                takeProfit1: pos.tp1,
                exitPrice,
                pnlPct: totalPnlPct.toFixed(2),
                pnlUsd: totalPnlUsd.toFixed(2),
                durationHours: ((candle.time - pos.entryTime) / 3600).toFixed(1),
                reason
            };
            if (totalPnlUsd > 0) state.winCount++;
            else state.lossCount++;
            state.position = null;
            positionClosed = true;
            action = 'closed';
        }
    }

    // ===== ENTRADA =====
    let newPosition = null;
    if (!state.position && !blockReason && primaryDirection) {
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

        if (!blockReason) state.blockStats['passou_filtros'] = (state.blockStats['passou_filtros'] || 0) + 1;
        else state.blockStats[blockReason] = (state.blockStats[blockReason] || 0) + 1;

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

            if (rrPonderado >= rrMin) {
                const totalTrades = state.winCount + state.lossCount;
                const winRate = totalTrades > 0 ? state.winCount / totalTrades : 0.5;
                const kellyPct = KellyPositionSize(winRate, rrPonderado);
                const riskFraction = Math.min(kellyPct, 0.05);
                const stopDistancePct = primaryDirection === 'LONG' ? (state.price - stop) / state.price : (stop - state.price) / state.price;
                const positionSizeUSD = (riskFraction * state.equity) / stopDistancePct;
                const sizeMultiplier = Math.min(positionSizeUSD / state.equity, 1.0);

                newPosition = {
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
                action = 'opened';
            }
        }
    }

    if (newPosition) {
        state.position = newPosition;
    }

    return {
        action,
        tradeClosed,
        newPosition,
        score: scoreData.score,
        direction: primaryDirection,
        blockReason,
        state
    };
}

// ================================================================
// FUNÇÃO DE BACKTEST (usa processCandle)
// ================================================================
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    logDebug(`Iniciando backtest para ${symbol} (${days} dias)`);

    try {
        const [candles1h, candles4h, fundingHist, oiHist, mvrvHist] = await Promise.all([
            fetchHistoricalCandles(symbol, '1h', Math.min(days * 24 + 100, 1000)),
            fetchHistoricalCandles(symbol, '4h', Math.min(days * 6 + 50, 500)),
            fetchHistoricalFunding(symbol, startTime, endTime),
            fetchHistoricalOI(symbol, startTime, endTime),
            fetchHistoricalMVRV(
                new Date(startTime).toISOString().slice(0,10),
                new Date(endTime).toISOString().slice(0,10)
            )
        ]);

        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado no período.' } };
        }

        const state = {
            candles1H: [],
            candles4H: candles4h || [],
            equity: 10000,
            highWaterMark: 10000,
            winCount: 0,
            lossCount: 0,
            blockStats: {},
            position: null,
            fundingHistory: [],
            oiDeltaHistory: [],
            bandwidthHistory: [],
            adxRolling: [],
            mvrvHistory: [],
            swingHighs: [],
            swingLows: [],
            atrHistory: [],
            price: 0,
            atr_1H: 0,
            rsi_1H: 50,
            ema50_1H: 0,
            vwap: 0,
            fundingRate: 0,
            oiDelta: 0,
            mvrv: null,
            macroBlackout: false,
            volatilityFactor: 1.0,
            mtfConfluence: null,
            adx: 0,
            divergence: null,
            volumeAnomaly: null,
            currentBOS: 'NEUTRAL',
            htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity }
        };

        const trades = [];

        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];

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
            if (state.mvrv !== null) {
                state.mvrvHistory.push(state.mvrv);
                if (state.mvrvHistory.length > 90) state.mvrvHistory.shift();
            }
            state.macroBlackout = false;

            state.mtfConfluence = await getMTFAlignmentAtTime(symbol, candle.time);

            const result = await processCandle(state, candle, symbol, options);

            if (result.tradeClosed) {
                trades.push(result.tradeClosed);
            }
        }

        if (state.position) {
            const lastCandle = filteredCandles[filteredCandles.length - 1];
            const pos = state.position;
            const exitPrice = lastCandle.close;
            const invested = state.equity * pos.sizeRemaining;
            const pnlPct = pos.type === 'LONG' ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
            const pnlUsd = invested * (pnlPct / 100);
            state.equity += pnlUsd;
            const totalPnlUsd = pnlUsd + (pos.partialPnlUsd || 0);
            const totalPnlPct = (pnlPct * pos.sizeRemaining) + (pos.partialPnlPct || 0);
            trades.push({
                entryTime: new Date(pos.entryTime * 1000).toISOString(),
                exitTime: new Date(lastCandle.time * 1000).toISOString(),
                symbol,
                direction: pos.type,
                entryPrice: pos.entryPrice,
                stopLoss: pos.stop,
                takeProfit1: pos.tp1,
                exitPrice,
                pnlPct: totalPnlPct.toFixed(2),
                pnlUsd: totalPnlUsd.toFixed(2),
                durationHours: ((lastCandle.time - pos.entryTime) / 3600).toFixed(1),
                reason: 'Fechamento forçado'
            });
            if (totalPnlUsd > 0) state.winCount++;
            else state.lossCount++;
        }

        const closedTrades = trades.filter(t => t.exitTime !== null && t.pnlPct !== null);
        const totalTrades = closedTrades.length;
        const wins = closedTrades.filter(t => parseFloat(t.pnlPct) > 0).length;
        const losses = totalTrades - wins;
        const winrate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
        const totalPnlPct = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlPct), 0);
        const totalPnlUsd = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlUsd || 0), 0);
        const avgWin = wins > 0 ? closedTrades.filter(t => parseFloat(t.pnlPct) > 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0) / wins : 0;
        const avgLoss = losses > 0 ? Math.abs(closedTrades.filter(t => parseFloat(t.pnlPct) < 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0) / losses) : 0;
        const profitFactor = avgLoss !== 0 ? (avgWin / avgLoss) : (avgWin > 0 ? Infinity : 0);
        const maxDrawdown = state.highWaterMark > 0 ? ((state.highWaterMark - state.equity) / state.highWaterMark * 100) : 0;
        const annualizedReturn = totalPnlPct !== 0 && !isNaN(totalPnlPct) ? (Math.pow(1 + totalPnlPct / 100, 365 / days) - 1) * 100 : 0;

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
            finalEquity: state.equity,
            blockStats: state.blockStats,
            totalCandlesProcessed: filteredCandles.length,
            disclaimer: "Motor SMC+MTF v3.5.2 unificado"
        };

        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
