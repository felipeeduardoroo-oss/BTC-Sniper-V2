// ================================================================
// js/backtest.js – Backtest Engine v3.5.2 (refatorado)
// ================================================================

import {
    fetchHistoricalCandles,
    fetchHistoricalFunding,
    fetchHistoricalOI,
    fetchHistoricalMVRV,
    fetchFearGreed,
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
    detectRSIDivergence
} from './indicadores.js';
import {
    checkBOSAndRetest,
    calculateStopAndTargets,
    checkPositionManagement,
    getMTFAlignmentLocal
} from './risk_management.js';

function logDebug(msg, data = null) {
    console.log(`[Backtest v3.5.2] ${msg}`, data || '');
}

function findMostRecent(arr, cond) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (cond(arr[i])) return arr[i];
    }
    return null;
}

export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    const {
        scoreMin = 68,
        scoreMaxShort = 32,
        adxMin = 22,
        rrMin = 1.8,
        retestDistPct = 0.02,
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

    days = Math.min(days, 1000);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    logDebug(`Iniciando backtest ${symbol} (${days} dias)`);

    try {
        const [candles1h, candles4h, fundingHist, oiHist, mvrvHist, fgData] = await Promise.all([
            fetchHistoricalCandles(symbol, '1h', Math.min(days * 24 + 100, 1000)),
            fetchHistoricalCandles(symbol, '4h', Math.min(days * 6 + 50, 500)),
            fetchHistoricalFunding(symbol, startTime, endTime),
            fetchHistoricalOI(symbol, startTime, endTime),
            fetchHistoricalMVRV(new Date(startTime).toISOString().slice(0,10), new Date(endTime).toISOString().slice(0,10)),
            fetchFearGreed()
        ]);

        const filtered = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filtered.length === 0) return { trades: [], summary: { error: 'Sem candles no período.' } };

        const state = {
            candles1H: [],
            candles4H: candles4h || [],
            ema50_1H: 0, ema200_4H: 0, rsi_1H: 50, atr_1H: 0, atrHistory: [],
            swingHighs: [], swingLows: [], currentBOS: 'NEUTRAL',
            htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity },
            mtfConfluence: null, adx: 0, divergence: null, volumeAnomaly: null,
            macroBlackout: false, vwap: 0, price: 0, fundingRate: 0, oiDelta: 0,
            mvrv: null, mvrvHistory: [], fundingHistory: [], oiDeltaHistory: [],
            bandwidthHistory: [], adxRolling: [], volatilityFactor: 1.0,
            fearGreedData: fgData || { value: 50 }
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0, lossCount = 0;
        const blockStats = {};

        const updateIndicators = (candles, currentTime) => {
            if (candles.length < 14) return;
            const closes = candles.map(c => c.close);
            state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
            state.atr_1H = calculateATR(candles, 14);
            state.atrHistory.push(state.atr_1H);
            if (state.atrHistory.length > 100) state.atrHistory.shift();

            let g = 0, l = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
                const d = closes[i] - closes[i - 1];
                if (d > 0) g += d; else l += Math.abs(d);
            }
            state.rsi_1H = l === 0 ? 100 : 100 - (100 / (1 + (g/14) / (l/14)));

            const adxData = calculateADX(candles);
            state.adx = adxData;
            state.vwap = calculateVWAP(candles.slice(-24));
            state.volumeAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
            updateSwingPoints(state);

            const relevant4H = state.candles4H.filter(c => c.time <= currentTime);
            if (relevant4H.length >= 20) {
                state.htfStructure = detectHTFStructure(state, relevant4H);
            }

            // Divergência RSI
            let rsiArr = [];
            let gg = 0, ll = 0;
            for (let i = 1; i < closes.length; i++) {
                const d = closes[i] - closes[i - 1];
                if (i <= 14) {
                    if (d >= 0) gg += d; else ll -= d;
                    if (i === 14) {
                        let ag = gg / 14, al = ll / 14;
                        rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                    }
                } else {
                    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
                    const prev = rsiArr[rsiArr.length - 1];
                    const ag = (prev * 13 + gain) / 14;
                    const al = (prev * 13 + loss) / 14;
                    rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
                }
            }
            if (rsiArr.length > 20) {
                state.divergence = detectRSIDivergence(candles, rsiArr);
            }
        };

        for (let i = 0; i < filtered.length; i++) {
            const candle = filtered[i];
            state.price = candle.close;
            state.candles1H.push(candle);
            if (state.candles1H.length > 200) state.candles1H.shift();

            // Dados históricos
            const fAt = findMostRecent(fundingHist, f => f.time <= candle.time * 1000);
            state.fundingRate = fAt ? fAt.rate : 0;
            state.fundingHistory.push(state.fundingRate);
            if (state.fundingHistory.length > 100) state.fundingHistory.shift();

            const oiAt = findMostRecent(oiHist, o => o.time <= candle.time * 1000);
            if (oiAt) {
                const oi24 = findMostRecent(oiHist, o => o.time <= (candle.time - 86400) * 1000);
                state.oiDelta = oi24 ? ((oiAt.oi - oi24.oi) / oi24.oi * 100) : 0;
            }
            state.oiDeltaHistory.push(state.oiDelta);
            if (state.oiDeltaHistory.length > 100) state.oiDeltaHistory.shift();

            const mvAt = findMostRecent(mvrvHist, m => m.time <= candle.time);
            state.mvrv = mvAt ? mvAt.value : null;
            if (state.mvrv !== null) {
                state.mvrvHistory.push(state.mvrv);
                if (state.mvrvHistory.length > 90) state.mvrvHistory.shift();
            }

            // MTF local
            state.mtfConfluence = getMTFAlignmentLocal(state.candles1H, state.candles4H, candle.time, { htfBullishVelas, htfBearishVelas });

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H, candle.time);
            } else continue;

            // Filtros de banda
            const closes = state.candles1H.slice(-20).map(c => c.close);
            if (closes.length >= 20) {
                const sma = closes.reduce((a,b) => a+b,0)/20;
                const varian = closes.reduce((s,v) => s + (v-sma)**2,0)/20;
                const bw = (2 * Math.sqrt(varian)) / sma;
                state.bandwidthHistory.push(bw);
                if (state.bandwidthHistory.length >= 20) {
                    const avgBW = state.bandwidthHistory.slice(-20).reduce((a,b) => a+b,0)/20;
                    if (bw < avgBW * 0.6) { blockStats['baixa_volatilidade_bb'] = (blockStats['baixa_volatilidade_bb']||0)+1; continue; }
                }
            }

            // Filtros funding/OI z-score
            if (state.fundingHistory.length >= 20) {
                const mean = state.fundingHistory.reduce((a,b)=>a+b,0)/state.fundingHistory.length;
                const varF = state.fundingHistory.reduce((s,v)=>s+(v-mean)**2,0)/state.fundingHistory.length;
                const std = Math.sqrt(varF);
                if (Math.abs((state.fundingRate - mean)/(std||1)) > zFundingMax) { blockStats[`funding_z`] = (blockStats[`funding_z`]||0)+1; continue; }
            }
            if (state.oiDeltaHistory.length >= 20) {
                const meanO = state.oiDeltaHistory.reduce((a,b)=>a+b,0)/state.oiDeltaHistory.length;
                const varO = state.oiDeltaHistory.reduce((s,v)=>s+(v-meanO)**2,0)/state.oiDeltaHistory.length;
                if (Math.abs((state.oiDelta - meanO)/Math.sqrt(varO||1)) > zOiMax) { blockStats[`oi_z`] = (blockStats[`oi_z`]||0)+1; continue; }
            }

            // Score
            const simAssets = { [symbol]: {
                price: state.price, candles1H: state.candles1H, candles4H: state.candles4H,
                ema50_1H: state.ema50_1H, ema200_4H: state.ema200_4H, rsi_1H: state.rsi_1H,
                atr_1H: state.atr_1H, atrHistory: state.atrHistory, swingHighs: state.swingHighs,
                swingLows: state.swingLows, currentBOS: state.currentBOS, mtfConfluence: state.mtfConfluence,
                adx: state.adx, divergence: state.divergence, volumeAnomaly: state.volumeAnomaly,
                macroBlackout: state.macroBlackout, vwap: state.vwap, htfStructure: state.htfStructure,
                fundingRate: state.fundingRate, oiDelta: state.oiDelta, mvrv: state.mvrv
            }};
            const liqMap = { [symbol]: { longs: 0, shorts: 0 } };
            const scoreData = computeScore(symbol, simAssets, liqMap, adxMin);
            let score = scoreData.score;
            let direction = scoreData.direction;
            let blockReason = scoreData.blockReason;
            const primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

            // Filtros específicos v3.5.2
            if (state.mvrvHistory.length > 0 && primaryDirection === 'SHORT' && !blockReason) {
                const peak = Math.max(...state.mvrvHistory);
                const drop = peak > 0 ? (peak - state.mvrv) / peak : 0;
                if (drop > mvrvDropPercent) blockReason = `MVRV drop ${(drop*100).toFixed(1)}%`;
            }
            if (primaryDirection === 'LONG' && !blockReason && state.htfStructure.bias === 'BEARISH') {
                blockReason = `HTF Bearish (${htfBullishVelas} velas)`;
            }
            if (primaryDirection === 'SHORT' && !blockReason && state.htfStructure.bias === 'BULLISH') {
                blockReason = `HTF Bullish (${htfBearishVelas} velas)`;
            }
            if (primaryDirection === 'LONG' && !blockReason && (state.adx.plusDI - state.adx.minusDI) < diDiffMinLong) {
                blockReason = `DI diff < ${diDiffMinLong}`;
            }
            if (primaryDirection === 'SHORT' && !blockReason && (state.adx.minusDI - state.adx.plusDI) < diDiffMinShort) {
                blockReason = `DI diff < ${diDiffMinShort}`;
            }

            // BOS
            const prevCandle = state.candles1H.length > 1 ? state.candles1H[state.candles1H.length - 2] : null;
            const lastSH = state.swingHighs.length > 0 ? state.swingHighs[state.swingHighs.length - 1] : null;
            const lastSL = state.swingLows.length > 0 ? state.swingLows[state.swingLows.length - 1] : null;
            const refH = lastSH || (prevCandle ? prevCandle.high : null);
            const refL = lastSL || (prevCandle ? prevCandle.low : null);
            const bosBull = primaryDirection === 'LONG' && refH !== null && candle.close > refH;
            const bosBear = primaryDirection === 'SHORT' && refL !== null && candle.close < refL;
            state.currentBOS = (bosBull || bosBear) ? 'BOS' : 'NEUTRAL';

            const adxVal = typeof state.adx === 'object' ? state.adx.adx : state.adx;
            state.adxRolling.push(adxVal);
            if (state.adxRolling.length >= 20) {
                const avgAdx = state.adxRolling.reduce((a,b)=>a+b,0)/state.adxRolling.length;
                if (adxVal < Math.max(avgAdx * 0.8 + 5, 18) && !blockReason) blockReason = `ADX ${adxVal.toFixed(1)} < dinâmico`;
            }
            if (adxVal < adxMin && !blockReason) blockReason = `ADX < ${adxMin}`;
            if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';
            if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason) blockReason = 'Abaixo VWAP';
            if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason) blockReason = 'Acima VWAP';
            if (!blockReason) {
                const deriv = checkDerivativesFilter(state.fundingRate, state.oiDelta);
                if (!deriv.allow) blockReason = deriv.reason;
            }

            // Gerenciar posição existente
            if (position) {
                const result = checkPositionManagement(position, state, candle, {
                    tp1Pct, tp2Pct, runnerPct, trailLong, trailShort, maxHoldHours
                });
                if (result.closed) {
                    const pnlPct = result.totalPnlPct || 0;
                    const pnlUsd = result.totalPnlUsd || 0;
                    equity += pnlUsd;
                    if (equity > highWaterMark) highWaterMark = equity;
                    trades.push({
                        entryTime: new Date(result.entryTime).toISOString(),
                        exitTime: new Date(candle.time * 1000).toISOString(),
                        symbol, direction: result.type,
                        entryPrice: result.entryPrice,
                        stopLoss: position.stop,
                        takeProfit1: position.tp1,
                        exitPrice: result.exitPrice,
                        pnlPct: pnlPct.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        durationHours: ((candle.time - result.entryTime/1000) / 3600).toFixed(1),
                        reason: result.reason
                    });
                    if (pnlUsd > 0) winCount++; else lossCount++;
                    position = null;
                } else {
                    position = result.position;
                }
            }

            // Nova entrada
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);
                let smcSetup = false, sweepSetup = false, retestConfirmed = false, brokenLevel = null;
                const recentHighs = state.swingHighs.slice(-3);
                const recentLows = state.swingLows.slice(-3);

                if (primaryDirection === 'LONG') {
                    const broken = recentHighs.filter(h => h < state.price);
                    if (broken.length > 0) {
                        brokenLevel = Math.max(...broken);
                        smcSetup = true;
                        retestConfirmed = Math.abs(state.price - brokenLevel) / (atr || state.price*0.01) < retestDistPct;
                    }
                } else {
                    const broken = recentLows.filter(l => l > state.price);
                    if (broken.length > 0) {
                        brokenLevel = Math.min(...broken);
                        smcSetup = true;
                        retestConfirmed = Math.abs(state.price - brokenLevel) / (atr || state.price*0.01) < retestDistPct;
                    }
                }

                if (!retestConfirmed && emaRetest) {
                    const ema20 = calcEMA(state.candles1H.map(c=>c.close),20).slice(-1)[0] || state.price;
                    retestConfirmed = Math.abs(state.price - ema20) / (atr || state.price*0.01) < 0.5;
                    if (retestConfirmed) smcSetup = true;
                }

                if (requireSweep) {
                    const lastSH = state.swingHighs.length > 0 ? state.swingHighs[state.swingHighs.length - 1] : null;
                    const lastSL = state.swingLows.length > 0 ? state.swingLows[state.swingLows.length - 1] : null;
                    if (primaryDirection === 'SHORT' && lastSH !== null && candle.high > lastSH && candle.close < lastSH) {
                        sweepSetup = true; retestConfirmed = true; brokenLevel = lastSH;
                    } else if (primaryDirection === 'LONG' && lastSL !== null && candle.low < lastSL && candle.close > lastSL) {
                        sweepSetup = true; retestConfirmed = true; brokenLevel = lastSL;
                    }
                }

                const bosPassed = !ignoreBOS ? smcSetup : true;
                const retestPassed = !ignoreRetest ? retestConfirmed : true;
                const structOk = (bosPassed && retestPassed) || (sweepSetup && retestPassed);

                const volAvg = state.candles1H.slice(-20).reduce((s,c)=>s+c.volume,0)/20;
                const volOk = smcSetup ? state.candles1H[state.candles1H.length - 1].volume >= volAvg * 1.3 : true;
                const closeOk = (primaryDirection === 'LONG' && candle.close > brokenLevel) ||
                                (primaryDirection === 'SHORT' && candle.close < brokenLevel);
                if ((smcSetup && !volOk) || (smcSetup && !closeOk)) blockReason = 'volume/fechamento fraco';

                const body = Math.abs(candle.close - candle.open);
                if (candle.high - candle.low > 0 && body / (candle.high - candle.low) < 0.5) blockReason = 'corpo fraco';

                let reasonKey = blockReason || (primaryDirection ? 'passou_filtros' : 'score_neutro');
                blockStats[reasonKey] = (blockStats[reasonKey]||0) + 1;

                if (structOk && !blockReason) {
                    const levels = calculateStopAndTargets(state, primaryDirection, {
                        stopLong, stopShort, tp1Long, tp1Short, tp2Dist, rrMin
                    });
                    if (levels.rrPonderado < rrMin) continue;

                    const totalTrades = winCount + lossCount;
                    const winRate = totalTrades > 0 ? winCount / totalTrades : 0.5;
                    const kelly = KellyPositionSize(winRate, levels.rrPonderado);
                    const riskFrac = Math.min(kelly, 0.05);
                    const stopDist = primaryDirection === 'LONG' ? (state.price - levels.stop) / state.price : (levels.stop - state.price) / state.price;
                    const sizeUSD = (riskFrac * equity) / stopDist;
                    const sizeMult = Math.min(sizeUSD / equity, 1.0);

                    position = {
                        type: primaryDirection,
                        entryPrice: state.price,
                        stop: levels.stop,
                        tp1: levels.tp1,
                        tp2: levels.tp2,
                        trailingStop: levels.stop,
                        partialTaken: false,
                        tp2Taken: false,
                        sizeRemaining: sizeMult,
                        partialPnlUsd: 0,
                        partialPnlPct: 0,
                        maxProfitPrice: state.price,
                        entryTime: candle.time * 1000,
                        movedToBE: false,
                        initialEquity: equity,
                        symbol: symbol
                    };
                }
            }
        }

        // Fechamento forçado final
        if (position) {
            const last = filtered[filtered.length - 1];
            const exitPrice = last.close;
            const invested = position.initialEquity * position.sizeRemaining;
            const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice)/position.entryPrice*100 : (position.entryPrice - exitPrice)/position.entryPrice*100;
            const pnlUsd = invested * (pnlPct/100);
            equity += pnlUsd;
            const totalPnlUsd = pnlUsd + (position.partialPnlUsd||0);
            const totalPnlPct = (pnlPct * position.sizeRemaining) + (position.partialPnlPct||0);
            trades.push({
                entryTime: new Date(position.entryTime).toISOString(),
                exitTime: new Date(last.time*1000).toISOString(),
                symbol, direction: position.type,
                entryPrice: position.entryPrice,
                stopLoss: position.stop,
                takeProfit1: position.tp1,
                exitPrice,
                pnlPct: totalPnlPct.toFixed(2),
                pnlUsd: totalPnlUsd.toFixed(2),
                durationHours: ((last.time - position.entryTime/1000)/3600).toFixed(1),
                reason: 'Forçado'
            });
            if (totalPnlUsd > 0) winCount++; else lossCount++;
            position = null;
        }

        // Estatísticas
        const closed = trades.filter(t => t.exitTime && t.pnlPct !== null);
        const total = closed.length;
        const wins = closed.filter(t => parseFloat(t.pnlPct) > 0).length;
        const winrate = total > 0 ? (wins/total*100) : 0;
        const totalPnlPct = closed.reduce((s,t) => s + parseFloat(t.pnlPct), 0);
        const totalPnlUsd = closed.reduce((s,t) => s + parseFloat(t.pnlUsd||0), 0);
        const avgWin = wins > 0 ? closed.filter(t=>parseFloat(t.pnlPct)>0).reduce((s,t)=>s+parseFloat(t.pnlPct),0)/wins : 0;
        const avgLoss = (total - wins) > 0 ? Math.abs(closed.filter(t=>parseFloat(t.pnlPct)<0).reduce((s,t)=>s+parseFloat(t.pnlPct),0)/(total-wins)) : 0;
        const pf = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
        const dd = highWaterMark > 0 ? ((highWaterMark - equity)/highWaterMark*100) : 0;
        const ann = totalPnlPct !== 0 ? (Math.pow(1 + totalPnlPct/100, 365/days) - 1) * 100 : 0;

        return {
            trades,
            summary: {
                totalTrades: total,
                wins, losses: total - wins,
                winrate, totalPnlPct, totalPnlUsd,
                avgWin, avgLoss, profitFactor: pf,
                maxDrawdown: dd, annualizedReturn: ann,
                initialEquity: 10000, finalEquity: equity,
                blockStats, totalCandlesProcessed: filtered.length,
                disclaimer: "v3.5.2 com risk_management.js"
            }
        };
    } catch (e) {
        logDebug('Erro:', e.message);
        return { trades: [], summary: { error: e.message } };
    }
}
