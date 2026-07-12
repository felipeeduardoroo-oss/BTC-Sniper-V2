// ================================================================
// js/backtest.js – Backtest com dados reais (SINCRONIZADO + LOGS)
// ================================================================

import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic,
    fetchFearGreed
} from './dados_externos.js';
import {
    calculateADX,
    calculateATR,
    calcEMA,
    updateSwingPoints,
    detectHTFStructure,
    computeScore,
    calculateConfidenceScore,
    findSMCSetup,
    checkDerivativesFilter,
    KellyPositionSize,
    detectVolumeAnomaly,
    calculateVWAP,
    detectRSIDivergence,
    checkPortfolioExposure
} from './indicadores.js';

// ===== CONSTANTE UNIFICADA =====
const SWING_LOOKBACK = 3; // mesmo valor usado no live

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

// ===== FUNÇÃO UNIFICADA DE BOS E RETEST =====
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

// ===== MTF HISTÓRICO =====
function getMTFAlignmentAtTime(candles1H, candles4H, currentTime) {
    const relevant1H = candles1H.filter(c => c.time <= currentTime).slice(-50);
    const relevant4H = candles4H.filter(c => c.time <= currentTime).slice(-50);
    
    if (relevant1H.length < 20 || relevant4H.length < 10) {
        return { alinhado: false, score: 0, directions: [] };
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
    const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
    const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;

    return {
        directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
        score: bulls - bears,
        alinhado: bulls === 2 || bears === 2
    };
}

// ===== BUSCA DE DADOS HISTÓRICOS =====
async function fetchHistoricalFunding(symbol, startTime, endTime) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=500`;
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.fundingTime, rate: parseFloat(d.fundingRate) }));
        }
        return [];
    } catch (e) { return []; }
}

async function fetchHistoricalOI(symbol, startTime, endTime) {
    const adjustedStart = Math.max(startTime, endTime - 500 * 60 * 60 * 1000);
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&startTime=${adjustedStart}&endTime=${endTime}&limit=500`;
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) }));
        }
        return [];
    } catch (e) { return []; }
}

async function fetchHistoricalMVRV(startDate, endDate) {
    const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=${startDate}&end_time=${endDate}&page_size=100`;
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (data?.data && Array.isArray(data.data)) {
            return data.data.map(d => ({ time: new Date(d.time).getTime() / 1000, value: parseFloat(d.CapMVRVCur) }));
        }
        return [];
    } catch (e) { return []; }
}

// ===== FUNÇÃO PRINCIPAL =====
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    // Parâmetros padrão alinhados com o live (index.html)
    const {
        scoreMin = 60,
        scoreMaxShort = 40,          // <-- ajustado para 40 (simétrico ao scoreMin)
        adxMin = 18,                 // <-- ajustado para 18
        retestDistPct = 0.02,
        rrMin = 1.42,
        emaRetest = false,
        mtfRequired = false,
        ignoreBOS = false,
        ignoreRetest = false
    } = options;

    // Log dos parâmetros recebidos (diagnóstico)
    console.log(`[Backtest] Parâmetros para ${symbol}:`, { scoreMin, scoreMaxShort, adxMin, rrMin, retestDistPct, emaRetest, mtfRequired, ignoreBOS, ignoreRetest });

    logDebug(`Iniciando backtest para ${symbol} (${days} dias)`);
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
            fearGreedData: fgData || { value: 50, classification: 'NEUTRO' }
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0, lossCount = 0;
        const blockStats = {};
        let totalCandlesProcessed = 0;

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

            const relevant4H = state.candles4H.filter(c => c.time <= currentTime);
            if (relevant4H.length >= 20) {
                state.htfStructure = detectHTFStructure(state, relevant4H);
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

            state.mtfConfluence = getMTFAlignmentAtTime(state.candles1H, state.candles4H, candle.time);

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H, candle.time);
            } else {
                continue;
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
                    mvrv: state.mvrv,
                    fearGreedData: state.fearGreedData
                }
            };
            const liqMap = { [symbol]: { longs: 0, shorts: 0 } };

            const scoreData = computeScore(symbol, simAssets, liqMap);
            const bosConfirmed = scoreData.direction !== 'NEUTRAL' && findSMCSetup(state, scoreData.direction);
            state.currentBOS = bosConfirmed ? 'BOS' : 'NEUTRAL';

            const mtfAligned = mtfRequired ? (simAssets[symbol].mtfConfluence?.alinhado || false) : true;

            const confidence = calculateConfidenceScore({
                mtfAligned: mtfAligned,
                adx: state.adx,
                volumeAnomaly: state.volumeAnomaly,
                fundingRate: state.fundingRate,
                openInterestTrend: state.oiDelta > 0 ? 'INCREASING' : (state.oiDelta < 0 ? 'DECREASING' : 'NEUTRAL'),
                divergence: state.divergence,
                macroBlackout: state.macroBlackout,
                smcStructure: state.currentBOS || 'NEUTRAL',
                direction: scoreData.direction
            });

            const score = confidence.score;
            let blockReason = scoreData.blockReason;

            const adxValue = typeof state.adx === 'object' ? state.adx.adx : state.adx;
            if (adxValue < adxMin && !blockReason) blockReason = `ADX < ${adxMin} (lateral)`;
            if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';

            const primaryDirection = (score >= scoreMin) ? 'LONG' : (score <= scoreMaxShort ? 'SHORT' : null);

            if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason)
                blockReason = 'Preço abaixo do VWAP';
            else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason)
                blockReason = 'Preço acima do VWAP';

            if (primaryDirection === 'LONG' && state.htfStructure.bias === 'BEARISH' && !blockReason)
                blockReason = 'HTF 4H Bearish (histórico)';
            if (primaryDirection === 'SHORT' && state.htfStructure.bias === 'BULLISH' && !blockReason)
                blockReason = 'HTF 4H Bullish (histórico)';

            if (!blockReason) {
                const derivCheck = checkDerivativesFilter(state.fundingRate, state.oiDelta);
                if (!derivCheck.allow) blockReason = derivCheck.reason;
            }

            // ===== LOG DE DIAGNÓSTICO (a cada 10 candles e quando score ≤ scoreMaxShort + 5) =====
            if (i % 10 === 0 || score <= scoreMaxShort + 5) {
                console.log(`[Backtest ${symbol}] Candle ${i}:`);
                console.log(`  score=${score.toFixed(1)}, scoreMin=${scoreMin}, scoreMaxShort=${scoreMaxShort}`);
                console.log(`  primaryDirection=${primaryDirection}, blockReason=${blockReason || 'nenhum'}`);
                console.log(`  price=${state.price.toFixed(2)}, vwap=${state.vwap.toFixed(2)}, adx=${adxValue.toFixed(1)}`);
                console.log(`  swingHighs=${state.swingHighs.length}, swingLows=${state.swingLows.length}`);
                console.log(`  mtfAligned=${mtfAligned}, htfBias=${state.htfStructure.bias}`);
                console.log(`  funding=${state.fundingRate.toFixed(6)}, oiDelta=${state.oiDelta.toFixed(2)}`);
            }

            // ===== GERENCIAR POSIÇÃO =====
            if (position) {
                const high = candle.high;
                const low = candle.low;
                let closed = false;
                let exitPrice = 0;
                let reason = '';

                if (position.type === 'LONG') {
                    if (high >= position.tp2) { exitPrice = position.tp2; closed = true; reason = 'TP2'; }
                    else if (low <= position.trailingStop) { exitPrice = position.trailingStop; closed = true; reason = 'Trailing Stop'; }
                    else if (high >= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeRemaining = 0.5;
                        position.trailingStop = Math.max(position.trailingStop, position.entryPrice + state.atr_1H * 0.1);
                    }
                } else {
                    if (low <= position.tp2) { exitPrice = position.tp2; closed = true; reason = 'TP2'; }
                    else if (high >= position.trailingStop) { exitPrice = position.trailingStop; closed = true; reason = 'Trailing Stop'; }
                    else if (low <= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeRemaining = 0.5;
                        position.trailingStop = Math.min(position.trailingStop, position.entryPrice - state.atr_1H * 0.1);
                    }
                }

                if (closed) {
                    const invested = equity * position.sizeRemaining;
                    const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
                    const pnlUsd = invested * (pnlPct / 100);
                    equity += pnlUsd;
                    if (equity > highWaterMark) highWaterMark = equity;
                    trades.push({
                        entryTime: new Date(position.entryTime).toISOString(),
                        exitTime: new Date(candle.time * 1000).toISOString(),
                        symbol,
                        direction: position.type,
                        entryPrice: position.entryPrice,
                        stopLoss: position.stop,
                        takeProfit1: position.tp1,
                        exitPrice,
                        pnlPct: (pnlPct * position.sizeRemaining).toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        durationHours: ((candle.time - position.entryTime / 1000) / 3600).toFixed(1),
                        reason
                    });
                    if (pnlUsd > 0) winCount++;
                    else lossCount++;
                    position = null;
                } else {
                    if (position.type === 'LONG') {
                        if (state.swingLows.length > 0) {
                            const newLow = Math.min(...state.swingLows);
                            const newStop = newLow - state.atr_1H * 0.2;
                            if (newStop > position.trailingStop) position.trailingStop = newStop;
                        }
                    } else {
                        if (state.swingHighs.length > 0) {
                            const newHigh = Math.max(...state.swingHighs);
                            const newStop = newHigh + state.atr_1H * 0.2;
                            if (newStop < position.trailingStop) position.trailingStop = newStop;
                        }
                    }
                }
            }

            // ===== ENTRADA (CORRIGIDO) =====
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);

                let smcSetup = false;
                let retestConfirmed = false;
                let brokenLevel = null;

                // Usa SWING_LOOKBACK = 3 (sincronizado com o live)
                const recentHighs = state.swingHighs.slice(-SWING_LOOKBACK);
                const recentLows = state.swingLows.slice(-SWING_LOOKBACK);

                if (primaryDirection === 'LONG') {
                    const brokenHighs = recentHighs.filter(h => h < state.price);
                    if (brokenHighs.length > 0) {
                        brokenLevel = Math.max(...brokenHighs);
                        smcSetup = true;
                        const distPct = Math.abs(state.price - brokenLevel) / brokenLevel;
                        retestConfirmed = distPct < retestDistPct;
                    }
                } else if (primaryDirection === 'SHORT') {
                    const brokenLows = recentLows.filter(l => l > state.price);
                    if (brokenLows.length > 0) {
                        brokenLevel = Math.min(...brokenLows);
                        smcSetup = true;
                        const distPct = Math.abs(state.price - brokenLevel) / brokenLevel;
                        retestConfirmed = distPct < retestDistPct;
                    }
                }

                if (!retestConfirmed && emaRetest) {
                    const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
                    const emaDist = Math.abs(state.price - ema20) / ema20;
                    retestConfirmed = emaDist < 0.005;
                    if (retestConfirmed) smcSetup = true;
                }

                const bosRequired = !ignoreBOS;
                const retestRequired = !ignoreRetest;
                const bosPassed = bosRequired ? smcSetup : true;
                const retestPassed = retestRequired ? retestConfirmed : true;
                const structureOk = bosPassed && retestPassed;

                totalCandlesProcessed++;
                let reasonKey = blockReason;
                if (!blockReason && primaryDirection) {
                    if (!bosPassed && !retestPassed) reasonKey = 'sem_BOS_e_retest';
                    else if (!bosPassed) reasonKey = 'sem_BOS';
                    else if (!retestPassed) reasonKey = 'sem_retest';
                    else reasonKey = 'passou_filtros';
                } else if (!blockReason && !primaryDirection) {
                    reasonKey = 'score_neutro';
                }
                blockStats[reasonKey] = (blockStats[reasonKey] || 0) + 1;

                if (structureOk) {
                    let stop, tp1, tp2, tp3;  // <-- adicionado tp3 para RR ponderado 50/30/20
                    if (primaryDirection === 'LONG') {
                        const recentLows = state.swingLows.slice(-SWING_LOOKBACK);
                        const structLevel = (recentLows.length ? Math.min(...recentLows) : state.price * 0.98) - (atr * 0.3);
                        // Melhoria: escolhe o stop mais próximo se a estrutura estiver perto
                        const atrStop = state.price - atr * 1.5;
                        stop = (recentLows.length && (state.price - structLevel) <= atr * 2.5) ? structLevel : atrStop;
                        tp1 = state.price + (atr * 2.2);
                        tp2 = state.price + (atr * 4.5);
                        tp3 = state.price + (atr * 7);    // <-- tp3 igual ao live
                    } else {
                        const recentHighs = state.swingHighs.slice(-SWING_LOOKBACK);
                        const structLevel = (recentHighs.length ? Math.max(...recentHighs) : state.price * 1.02) + (atr * 0.3);
                        const atrStopShort = state.price + atr * 1.5;
                        stop = (recentHighs.length && (structLevel - state.price) <= atr * 2.5) ? structLevel : atrStopShort;
                        tp1 = state.price - (atr * 2.2);
                        tp2 = state.price - (atr * 4.5);
                        tp3 = state.price - (atr * 7);
                    }

                    // ==== RR PONDERADO 50/30/20 (igual ao live) ====
                    let rrPonderado;
                    if (primaryDirection === 'LONG') {
                        const ganhoPonderado = (tp1 - state.price) * 0.5 + (tp2 - state.price) * 0.3 + (tp3 - state.price) * 0.2;
                        const risco = state.price - stop;
                        rrPonderado = risco > 0 ? ganhoPonderado / risco : 0;
                    } else {
                        const ganhoPonderado = (state.price - tp1) * 0.5 + (state.price - tp2) * 0.3 + (state.price - tp3) * 0.2;
                        const risco = stop - state.price;
                        rrPonderado = risco > 0 ? ganhoPonderado / risco : 0;
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
                        sizeRemaining: sizeMultiplier,
                        entryTime: candle.time * 1000
                    };
                    trades.push({
                        entryTime: new Date(candle.time * 1000).toISOString(),
                        exitTime: null,
                        symbol,
                        direction: primaryDirection,
                        entryPrice: state.price,
                        stopLoss: stop,
                        takeProfit1: tp1,
                        exitPrice: null,
                        pnlPct: null,
                        pnlUsd: null,
                        durationHours: null,
                        reason: 'Aberta'
                    });
                }
            }
        }

        // Fechar posição remanescente
        if (position) {
            const lastCandle = filteredCandles[filteredCandles.length - 1];
            const exitPrice = lastCandle.close;
            const invested = equity * position.sizeRemaining;
            const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
            const pnlUsd = invested * (pnlPct / 100);
            equity += pnlUsd;
            const lastTrade = trades[trades.length - 1];
            if (lastTrade && lastTrade.exitTime === null) {
                lastTrade.exitTime = new Date(lastCandle.time * 1000).toISOString();
                lastTrade.exitPrice = exitPrice;
                lastTrade.pnlPct = (pnlPct * position.sizeRemaining).toFixed(2);
                lastTrade.pnlUsd = pnlUsd.toFixed(2);
                lastTrade.durationHours = ((lastCandle.time - position.entryTime / 1000) / 3600).toFixed(1);
                lastTrade.reason = 'Fechamento forçado';
            }
            if (pnlUsd > 0) winCount++;
            else lossCount++;
            position = null;
        }

        // Estatísticas
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
        const maxDrawdown = highWaterMark > 0 ? ((highWaterMark - equity) / highWaterMark * 100) : 0;
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
            finalEquity: equity,
            blockStats: blockStats,
            totalCandlesProcessed: totalCandlesProcessed,
            disclaimer: "MTF histórico, BOS/retest com os 3 últimos swings (sincronizado com live). RR ponderado 50/30/20."
        };

        logDebug('Backtest concluído!', summary);
        console.log('[blockStats FINAL]', blockStats);
        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
