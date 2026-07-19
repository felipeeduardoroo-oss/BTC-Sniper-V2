// js/backtest.js – Backtest com dados reais (v3.5.2 UNIFICADO)
// ================================================================

import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic,
    fetchFearGreed,
    fetchHistoricalFunding,
    fetchHistoricalOI,
    fetchHistoricalMVRV
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
    checkPortfolioExposure
} from './indicadores.js';

// IMPORTA O MOTOR UNIFICADO v3.5.2
import {
    getMTFAlignmentLocal,
    checkBOSAndRetest,
    calculateStopAndTargets,
    checkPositionManagement
} from './risk_management.js';

// ===== CONSTANTE UNIFICADA =====
const SWING_LOOKBACK = 3;

// ===== HELPERS =====
function logDebug(message, data = null) {
    console.log(`[Backtest] ${message}`, data || '');
}

function findMostRecent(arr, cond) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (cond(arr[i])) return arr[i];
    }
    return null;
}

// ===== BUSCA DE DADOS HISTÓRICOS (já existente) =====
// ... (mantenha as funções fetchHistoricalFunding, fetchHistoricalOI, fetchHistoricalMVRV já existentes no seu arquivo)
// Se não estiverem, copie do dados_externos.js ou mantenha as importações.

// ===== FUNÇÃO PRINCIPAL =====
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    const {
        scoreMin = 68,
        scoreMaxShort = 32,
        adxMin = 22,
        retestDistPct = 2.0, // em ATR
        rrMin = 1.8,
        emaRetest = false,
        mtfRequired = false,
        ignoreBOS = false,
        ignoreRetest = false,
        requireSweep = false,
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
        runnerPct = 0.2,
        zFundingMax = 1.5,
        zOiMax = 1.5
    } = options;

    logDebug(`Iniciando backtest para ${symbol} (${days} dias)`);
    logDebug('Parâmetros:', options);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);

    try {
        const candles1h = (await fetchHistoricalCandles(symbol, '1h', 800)) || [];
        const candles4h = (await fetchHistoricalCandles(symbol, '4h', 200)) || [];
        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado.' } };
        }

        const fundingHist = (await fetchHistoricalFunding(symbol, startTime, endTime)) || [];
        const oiHist = (await fetchHistoricalOI(symbol, startTime, endTime)) || [];
        const mvrvHist = (await fetchHistoricalMVRV(startDateStr, endDateStr)) || [];
        const fgData = await fetchFearGreed();

        const state = {
            candles1H: [],
            candles4H: candles4h || [],
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
            volumeAnomaly: null,
            macroBlackout: false,
            vwap: 0,
            price: 0,
            fundingRate: 0,
            oiDelta: 0,
            mvrv: null,
            fearGreedData: fgData || { value: 50, classification: 'NEUTRO' },
            volatilityFactor: 1.0,
            mvrvHistory: []
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0, lossCount = 0;
        const blockStats = {};
        let totalCandlesProcessed = 0;
        let currentEquity = 10000; // usado para gestão

        function updateIndicators(candles, currentTime) {
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

            const last24Candles = candles.slice(-24);
            state.vwap = calculateVWAP(last24Candles);

            const volAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
            state.volumeAnomaly = volAnomaly;

            updateSwingPoints(state);

            // HTF via função unificada (já que detectHTFStructure do indicadores pode não ter todos os params)
            const relevant4H = state.candles4H.filter(c => c.time <= currentTime);
            if (relevant4H.length >= 20) {
                state.htfStructure = detectHTFStructure(state, relevant4H);
            }

            // RSI Divergence (mantido do original)
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

            // Volatility factor
            const rets = candles.slice(-30).map(c => (c.close - c.open) / c.open);
            if (rets.length > 0) {
                const std = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length);
                state.volatilityFactor = Math.min(Math.max(std * 2, 0.5), 2.0);
            }
        }

        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];
            state.price = candle.close;
            state.candles1H.push(candle);
            if (state.candles1H.length > 200) state.candles1H.shift();

            const fundingAtTime = findMostRecent(fundingHist, f => f.time <= candle.time * 1000) || fundingHist[0];
            state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;

            const oiAtTime = findMostRecent(oiHist, o => o.time <= candle.time * 1000) || oiHist[0];
            if (oiAtTime) {
                const oi24h = findMostRecent(oiHist, o => o.time <= (candle.time - 86400) * 1000);
                state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
            }

            const mvrvAtTime = findMostRecent(mvrvHist, m => m.time <= candle.time);
            state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;
            state.macroBlackout = false;
            if (state.mvrv !== null) {
                state.mvrvHistory.push(state.mvrv);
                if (state.mvrvHistory.length > 90) state.mvrvHistory.shift();
            }

            // MTF UNIFICADO (v3.5.2)
            const mtf = getMTFAlignmentLocal(state.candles1H, state.candles4H, candle.time, {
                htfBullishVelas,
                htfBearishVelas
            });
            state.mtfConfluence = mtf;

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H, candle.time);
            } else {
                continue;
            }

            // Filtros de volatilidade, funding, OI (mantidos)
            const closes = state.candles1H.slice(-20).map(c => c.close);
            if (closes.length >= 20) {
                const sma = closes.reduce((a, b) => a + b, 0) / 20;
                const variance = closes.reduce((s, v) => s + (v - sma) ** 2, 0) / 20;
                const stdBB = Math.sqrt(variance);
                const bandwidth = (2 * stdBB) / sma;
                if (state.atrHistory.length >= 20) {
                    const avgATR = state.atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
                    if (state.atr_1H < avgATR * 0.6) {
                        blockStats['baixa_volatilidade'] = (blockStats['baixa_volatilidade'] || 0) + 1;
                        continue;
                    }
                }
            }

            // Funding Z-score
            if (state.fundingHistory?.length >= 20) {
                const mean = state.fundingHistory.reduce((a, b) => a + b, 0) / state.fundingHistory.length;
                const variance = state.fundingHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / state.fundingHistory.length;
                const std = Math.sqrt(variance);
                const z = (state.fundingRate - mean) / (std || 1);
                if (Math.abs(z) > zFundingMax) {
                    blockStats[`funding_z${z.toFixed(2)}`] = (blockStats[`funding_z${z.toFixed(2)}`] || 0) + 1;
                    continue;
                }
            }

            // Score e direção
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
                    mvrv: state.mvrv,
                    fearGreedData: state.fearGreedData
                }
            };
            const liqMap = { [symbol]: { longs: 0, shorts: 0 } };

            const scoreData = computeScore(symbol, simAssets, liqMap, adxMin);
            const mtfAligned = mtfRequired ? mtf.alinhado : true;
            const confidence = calculateConfidenceScore({
                mtfAligned: mtfAligned,
                adx: state.adx,
                volumeAnomaly: state.volumeAnomaly,
                fundingRate: state.fundingRate,
                openInterestTrend: state.oiDelta > 0 ? 'INCREASING' : (state.oiDelta < 0 ? 'DECREASING' : 'NEUTRAL'),
                divergence: state.divergence,
                macroBlackout: state.macroBlackout,
                smcStructure: state.currentBOS || 'NEUTRAL',
                direction: scoreData.direction,
                scoreMinLong: scoreMin,
                scoreMaxShort: scoreMaxShort
            });

            let score = confidence.score;
            let blockReason = scoreData.blockReason;
            const adxVal = typeof state.adx === 'object' ? state.adx.adx : state.adx;
            const primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

            // Filtros adicionais (v3.5.2)
            if (adxVal < adxMin && !blockReason) blockReason = `ADX < ${adxMin}`;
            if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';
            if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason) blockReason = 'Preço abaixo do VWAP';
            else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason) blockReason = 'Preço acima do VWAP';
            if (primaryDirection === 'LONG' && !blockReason && (state.adx.plusDI - state.adx.minusDI) < diDiffMinLong) {
                blockReason = `DI diff < ${diDiffMinLong}`;
            }
            if (primaryDirection === 'SHORT' && !blockReason && (state.adx.minusDI - state.adx.plusDI) < diDiffMinShort) {
                blockReason = `DI diff < ${diDiffMinShort}`;
            }
            if (primaryDirection === 'LONG' && !blockReason && mtf.bias === 'BEARISH') {
                blockReason = `HTF 4H Bearish (${htfBullishVelas} velas)`;
            }
            if (primaryDirection === 'SHORT' && !blockReason && mtf.bias === 'BULLISH') {
                blockReason = `HTF 4H Bullish (${htfBearishVelas} velas)`;
            }
            if (primaryDirection === 'SHORT' && !blockReason && state.mvrvHistory.length > 0) {
                const peak = Math.max(...state.mvrvHistory);
                const drop = peak > 0 ? (peak - state.mvrv) / peak : 0;
                if (drop > mvrvDropPercent) blockReason = `MVRV drop ${(drop*100).toFixed(1)}%`;
            }
            if (!blockReason) {
                const deriv = checkDerivativesFilter(state.fundingRate, state.oiDelta);
                if (!deriv.allow) blockReason = deriv.reason;
            }

            // GESTÃO DE POSIÇÃO (UNIFICADA)
            if (position) {
                const candleObj = {
                    time: candle.time,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    open: candle.open
                };
                const mgmtConfig = {
                    tp1Pct,
                    tp2Pct,
                    runnerPct,
                    trailLong,
                    trailShort,
                    maxHoldHours
                };
                // Adiciona adx ao state para a função
                state.adx = adxVal;
                const result = checkPositionManagement(position, state, candleObj, mgmtConfig);
                if (result.closed) {
                    const pnlUsd = result.totalPnlUsd || 0;
                    const pnlPct = result.totalPnlPct || 0;
                    currentEquity += pnlUsd;
                    trades.push({
                        entryTime: new Date(position.entryTime).toISOString(),
                        exitTime: new Date(candle.time * 1000).toISOString(),
                        symbol,
                        direction: position.type,
                        entryPrice: position.entryPrice,
                        stopLoss: position.stop,
                        takeProfit1: position.tp1,
                        exitPrice: result.exitPrice,
                        pnlPct: pnlPct.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        durationHours: ((candle.time - position.entryTime / 1000) / 3600).toFixed(1),
                        reason: result.reason
                    });
                    if (pnlUsd > 0) winCount++;
                    else lossCount++;
                    position = null;
                } else {
                    position = result.position;
                }
            }

            // ENTRADA (UNIFICADA)
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);
                const structure = checkBOSAndRetest(state, primaryDirection, retestDistPct);
                const smcSetup = structure.bos;
                let retestConfirmed = structure.retest;

                if (!retestConfirmed && emaRetest) {
                    const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
                    const emaDist = Math.abs(state.price - ema20) / ema20;
                    retestConfirmed = emaDist < 0.005;
                    if (retestConfirmed) smcSetup = true;
                }

                // Sweep (opcional)
                let sweepSetup = false;
                if (requireSweep) {
                    const lastSwingHigh = state.swingHighs.length ? state.swingHighs[state.swingHighs.length - 1] : null;
                    const lastSwingLow = state.swingLows.length ? state.swingLows[state.swingLows.length - 1] : null;
                    if (primaryDirection === 'SHORT' && lastSwingHigh !== null && candle.high > lastSwingHigh && candle.close < lastSwingHigh) {
                        sweepSetup = true;
                    } else if (primaryDirection === 'LONG' && lastSwingLow !== null && candle.low < lastSwingLow && candle.close > lastSwingLow) {
                        sweepSetup = true;
                    }
                }

                const bosPassed = ignoreBOS ? true : (smcSetup || sweepSetup);
                const retestPassed = ignoreRetest ? true : retestConfirmed;
                const structureOk = bosPassed && retestPassed;

                totalCandlesProcessed++;
                let reasonKey = blockReason;
                if (!blockReason && primaryDirection) {
                    if (!bosPassed && !retestPassed) reasonKey = 'sem_BOS_e_retest';
                    else if (!bosPassed) reasonKey = 'sem_BOS';
                    else if (!retestPassed) reasonKey = 'sem_retest';
                    else reasonKey = 'passou_filtros';
                }
                blockStats[reasonKey] = (blockStats[reasonKey] || 0) + 1;

                if (structureOk) {
                    // Cálculo unificado de Stop e Targets
                    const levels = calculateStopAndTargets(state, primaryDirection, {
                        stopLong,
                        stopShort,
                        tp1Long,
                        tp1Short,
                        tp2Dist
                    });

                    if (levels.rrPonderado >= rrMin) {
                        const totalTrades = winCount + lossCount;
                        const winRate = totalTrades > 0 ? winCount / totalTrades : 0.5;
                        const riskPct = KellyPositionSize(winRate, levels.rrPonderado);
                        const stopDist = primaryDirection === 'LONG' ? (state.price - levels.stop) / state.price : (levels.stop - state.price) / state.price;
                        const sizeUSD = (riskPct * currentEquity) / stopDist;
                        const sizeMult = Math.min(sizeUSD / currentEquity, 1.0);

                        position = {
                            type: primaryDirection,
                            entryPrice: state.price,
                            stop: levels.stop,
                            tp1: levels.tp1,
                            tp2: levels.tp2,
                            tp3: levels.tp3,
                            trailingStop: levels.stop,
                            partialTaken: false,
                            tp2Taken: false,
                            sizeRemaining: sizeMult,
                            partialPnlUsd: 0,
                            partialPnlPct: 0,
                            maxProfitPrice: state.price,
                            entryTime: candle.time * 1000,
                            movedToBE: false,
                            initialEquity: currentEquity,
                            symbol: symbol
                        };
                        // Adiciona trade aberto ao log (opcional)
                    }
                }
            }
        }

        // Fechamento forçado da posição remanescente
        if (position) {
            const lastCandle = filteredCandles[filteredCandles.length - 1];
            const exitPrice = lastCandle.close;
            const invested = currentEquity * position.sizeRemaining;
            const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
            const pnlUsd = invested * (pnlPct / 100);
            currentEquity += pnlUsd;
            trades.push({
                entryTime: new Date(position.entryTime).toISOString(),
                exitTime: new Date(lastCandle.time * 1000).toISOString(),
                symbol,
                direction: position.type,
                entryPrice: position.entryPrice,
                stopLoss: position.stop,
                takeProfit1: position.tp1,
                exitPrice,
                pnlPct: (pnlPct * position.sizeRemaining + (position.partialPnlPct || 0)).toFixed(2),
                pnlUsd: (pnlUsd + (position.partialPnlUsd || 0)).toFixed(2),
                durationHours: ((lastCandle.time - position.entryTime / 1000) / 3600).toFixed(1),
                reason: 'Fechamento forçado'
            });
            if (pnlUsd > 0) winCount++;
            else lossCount++;
            position = null;
        }

        // Estatísticas finais
        const closedTrades = trades.filter(t => t.exitTime !== null && t.pnlPct !== null);
        const totalTrades = closedTrades.length;
        const wins = closedTrades.filter(t => parseFloat(t.pnlPct) > 0).length;
        const losses = totalTrades - wins;
        const winrate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
        const totalPnlPct = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlPct), 0);
        const totalPnlUsd = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlUsd || 0), 0);
        const avgWin = wins > 0 ? closedTrades.filter(t => parseFloat(t.pnlPct) > 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0) / wins : 0;
        const avgLoss = losses > 0 ? closedTrades.filter(t => parseFloat(t.pnlPct) < 0).reduce((s, t) => s + parseFloat(t.pnlPct), 0) / losses : 0;
        const profitFactor = avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)) : 0;
        const maxDrawdown = highWaterMark > 0 ? ((highWaterMark - currentEquity) / highWaterMark * 100) : 0;
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
            finalEquity: currentEquity,
            blockStats: blockStats,
            totalCandlesProcessed: totalCandlesProcessed,
            disclaimer: "Unificado v3.5.2 - MTF, BOS/retest com dist ATR, RR ponderado 50/30/20."
        };

        logDebug('Backtest concluído!', summary);
        console.log('[blockStats FINAL]', blockStats);
        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
