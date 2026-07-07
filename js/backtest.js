// js/backtest.js – Backtest com o MESMO motor do live (Corrigido)
import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic,
    fetchFearGreed,
    fetchFundingRate
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
    isHighImpactEventNow,
    detectRSIDivergence
} from './indicadores.js';

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

// ===== BUSCA DE DADOS HISTÓRICOS =====
async function fetchHistoricalFunding(symbol, startTime, endTime) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.fundingTime, rate: parseFloat(d.fundingRate) }));
        }
        return [];
    } catch (e) { return []; }
}

async function fetchHistoricalOI(symbol, startTime, endTime) {
    const adjustedStart = Math.max(startTime, endTime - 1000 * 60 * 60 * 1000); // Max 1000h
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&startTime=${adjustedStart}&endTime=${endTime}&limit=1000`;
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) }));
        }
        return [];
    } catch (e) { return []; }
}

// ===== FUNÇÃO PRINCIPAL =====
export async function runBacktest(symbol = 'BTCUSDT', days = 30) {
    logDebug(`Iniciando backtest REAL para ${symbol} (${days} dias)`);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    try {
        // 1. Buscar candles (limitado a 1000 para evitar erro de API)
        const candles1h = (await fetchHistoricalCandles(symbol, '1h', Math.min(days * 24, 1000))) || [];
        const candles4h = (await fetchHistoricalCandles(symbol, '4h', 200)) || [];
        
        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado.' } };
        }

        // 2. Dados complementares
        const fundingHist = (await fetchHistoricalFunding(symbol, startTime, endTime)) || [];
        const oiHist = (await fetchHistoricalOI(symbol, startTime, endTime)) || [];
        const macroData = await fetchMacroStatic();
        const fgData = await fetchFearGreed(); // Usa o atual como proxy

        // 3. Estado do ativo
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
            fearGreedData: fgData,
            liqMap: { longs: 0, shorts: 0 }
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0, lossCount = 0;

        // 4. Atualização de Indicadores (Corrigida)
        function updateIndicators(candles) {
            if (candles.length < 14) return;
            const closes = candles.map(c => c.close);
            state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
            state.atr_1H = calculateATR(candles, 14);
            state.atrHistory.push(state.atr_1H);
            if (state.atrHistory.length > 100) state.atrHistory.shift();

            // RSI simplificado
            let avgGain = 0, avgLoss = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
                const diff = closes[i] - closes[i - 1];
                if (diff > 0) avgGain += diff;
                else avgLoss += Math.abs(diff);
            }
            avgGain /= 14; avgLoss /= 14;
            state.rsi_1H = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

            state.adx = calculateADX(candles).adx || 0;

            // CORREÇÃO: VWAP apenas nas últimas 24 velas (24h)
            state.vwap = calculateVWAP(candles.slice(-24));
            state.volumeAnomaly = detectVolumeAnomaly(candles, 20, 2.0);

            updateSwingPoints(state);
            if (state.candles4H.length > 50) {
                state.htfStructure = detectHTFStructure(state, state.candles4H);
            }

            // CORREÇÃO: MTF Confluence simulada (1h e 4h)
            const ema20_1h = calcEMA(closes, 20).slice(-1)[0];
            const dir1h = (ema20_1h > state.ema50_1H && state.price > ema20_1h) ? 'BULL' : 
                          (ema20_1h < state.ema50_1H && state.price < ema20_1h) ? 'BEAR' : 'NEUTRO';
            
            let dir4h = 'NEUTRO';
            if (state.candles4H.length >= 50) {
                const closes4h = state.candles4H.map(c => c.close);
                const ema20_4h = calcEMA(closes4h, 20).slice(-1)[0];
                const ema50_4h = calcEMA(closes4h, 50).slice(-1)[0];
                dir4h = (ema20_4h > ema50_4h && state.price > ema20_4h) ? 'BULL' : 
                        (ema20_4h < ema50_4h && state.price < ema20_4h) ? 'BEAR' : 'NEUTRO';
            }
            state.mtfConfluence = {
                directions: [{tf:'1h', dir:dir1h}, {tf:'4h', dir:dir4h}],
                alinhado: dir1h === dir4h && dir1h !== 'NEUTRO'
            };

            // CORREÇÃO: Divergência RSI reativada
            const rsiVals = closes.map((c, i, arr) => {
                if (i < 14) return 50;
                let g = 0, l = 0;
                for (let j = i - 13; j <= i; j++) {
                    const diff = arr[j] - arr[j-1];
                    if (diff > 0) g += diff; else l += Math.abs(diff);
                }
                return l === 0 ? 100 : 100 - (100 / (1 + (g/14) / (l/14)));
            });
            state.divergence = detectRSIDivergence(candles, rsiVals, 50);
        }

        // 5. Loop principal
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

            const macroCheck = await isHighImpactEventNow();
            state.macroBlackout = macroCheck.isBlackout && macroCheck.impact === 'HIGH';

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H);
            } else {
                continue;
            }

            const simAssets = {
                [symbol]: {
                    price: state.price,
                    candles1H: state.candles1H,
                    candles4H: state.candles4H,
                    ema50_1H: state.ema50_1H,
                    rsi_1H: state.rsi_1H,
                    atr_1H: state.atr_1H,
                    swingHighs: state.swingHighs,
                    swingLows: state.swingLows,
                    mtfConfluence: state.mtfConfluence,
                    adx: state.adx,
                    divergence: state.divergence,
                    volumeAnomaly: state.volumeAnomaly,
                    macroBlackout: state.macroBlackout,
                    vwap: state.vwap,
                    htfStructure: state.htfStructure,
                    fundingRate: state.fundingRate,
                    oiDelta: state.oiDelta,
                    fearGreedData: state.fearGreedData
                }
            };

            const scoreData = computeScore(symbol, simAssets, { [symbol]: { longs: 0, shorts: 0 } });
            const bosConfirmed = scoreData.direction !== 'NEUTRAL' && findSMCSetup(state, scoreData.direction);
            state.currentBOS = bosConfirmed ? 'BOS' : 'NEUTRAL';

            const confidence = calculateConfidenceScore({
                mtfAligned: simAssets[symbol].mtfConfluence?.alinhado || false,
                adx: state.adx,
                volumeAnomaly: state.volumeAnomaly,
                fundingRate: state.fundingRate,
                openInterestTrend: state.oiDelta > 0 ? 'INCREASING' : 'DECREASING',
                divergence: state.divergence,
                macroBlackout: state.macroBlackout,
                smcStructure: state.currentBOS,
                direction: scoreData.direction
            });

            const score = confidence.score;
            let blockReason = scoreData.blockReason;

            if (state.adx < 25 && !blockReason) blockReason = 'ADX < 25 (lateral)';
            if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';
            
            const primaryDirection = (score >= 70) ? 'LONG' : (score <= 30) ? 'SHORT' : null;
            if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason) blockReason = 'Preço abaixo do VWAP';
            else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason) blockReason = 'Preço acima do VWAP';

            if (primaryDirection === 'LONG' && state.htfStructure.bias === 'BEARISH' && !blockReason) blockReason = 'HTF 4H Bearish';
            if (primaryDirection === 'SHORT' && state.htfStructure.bias === 'BULLISH' && !blockReason) blockReason = 'HTF 4H Bullish';

            if (!blockReason) {
                const derivCheck = checkDerivativesFilter(state.fundingRate, state.oiDelta);
                if (!derivCheck.allow) blockReason = derivCheck.reason;
            }

            // ===== GERENCIAR POSIÇÃO (P&L CORRIGIDO) =====
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
                        position.sizeUsd *= 0.5; // Fecha metade
                        position.trailingStop = Math.max(position.trailingStop, position.entryPrice + state.atr_1H * 0.1);
                    }
                } else {
                    if (low <= position.tp2) { exitPrice = position.tp2; closed = true; reason = 'TP2'; } 
                    else if (high >= position.trailingStop) { exitPrice = position.trailingStop; closed = true; reason = 'Trailing Stop'; } 
                    else if (low <= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeUsd *= 0.5; // Fecha metade
                        position.trailingStop = Math.min(position.trailingStop, position.entryPrice - state.atr_1H * 0.1);
                    }
                }

                if (closed) {
                    const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
                    // CORREÇÃO: P&L calculado sobre o tamanho da posição em USD
                    const pnlUsd = position.sizeUsd * (pnlPct / 100);
                    equity += pnlUsd;
                    if (equity > highWaterMark) highWaterMark = equity;
                    
                    trades.push({
                        entryTime: new Date(position.entryTime).toISOString(),
                        exitTime: new Date(candle.time * 1000).toISOString(),
                        symbol, direction: position.type,
                        entryPrice: position.entryPrice,
                        exitPrice, pnlPct: pnlPct.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        durationHours: ((candle.time - position.entryTime / 1000) / 3600).toFixed(1),
                        reason
                    });
                    if (pnlUsd > 0) winCount++; else lossCount++;
                    position = null;
                } else {
                    if (position.type === 'LONG') {
                        const newStop = Math.min(...state.swingLows) - state.atr_1H * 0.2;
                        if (newStop > position.trailingStop) position.trailingStop = newStop;
                    } else {
                        const newStop = Math.max(...state.swingHighs) + state.atr_1H * 0.2;
                        if (newStop < position.trailingStop) position.trailingStop = newStop;
                    }
                }
            }

            // ===== ENTRADA =====
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);
                const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
                let retestConfirmed = (primaryDirection === 'LONG') ? 
                    (state.price <= ema20 * 1.005 && state.price >= ema20 * 0.995) : 
                    (state.price >= ema20 * 0.995 && state.price <= ema20 * 1.005);

                if (findSMCSetup(state, primaryDirection) && retestConfirmed) {
                    let stop, tp1, tp2;
                    if (primaryDirection === 'LONG') {
                        stop = Math.min(Math.min(...state.swingLows) - (atr * 0.3), state.price - atr * 1.5);
                        tp1 = state.price + (atr * 2);
                        tp2 = state.price + (atr * 4);
                    } else {
                        stop = Math.max(Math.max(...state.swingHighs) + (atr * 0.3), state.price + atr * 1.5);
                        tp1 = state.price - (atr * 2);
                        tp2 = state.price - (atr * 4);
                    }
                    const rr1 = primaryDirection === 'LONG' ? (tp1 - state.price) / (state.price - stop) : (state.price - tp1) / (stop - state.price);
                    if (rr1 < 1.5) continue;

                    const winRate = (winCount + lossCount) > 0 ? winCount / (winCount + lossCount) : 0.5;
                    const riskPct = KellyPositionSize(winRate, rr1); // Ex: 0.02 (2%)
                    
                    // CORREÇÃO: Position Sizing baseado no risco e distância do stop
                    const stopLossPct = Math.abs((state.price - stop) / state.price);
                    const positionSizeUsd = (equity * riskPct) / stopLossPct;

                    position = {
                        type: primaryDirection,
                        entryPrice: state.price,
                        stop, tp1, tp2,
                        trailingStop: stop,
                        partialTaken: false,
                        entryTime: candle.time * 1000,
                        sizeUsd: positionSizeUsd
                    };
                }
            }
        }

        // Fechar posição remanescente
        if (position) {
            const lastCandle = filteredCandles[filteredCandles.length - 1];
            const exitPrice = lastCandle.close;
            const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
            const pnlUsd = position.sizeUsd * (pnlPct / 100);
            equity += pnlUsd;
            trades.push({
                entryTime: new Date(position.entryTime).toISOString(),
                exitTime: new Date(lastCandle.time * 1000).toISOString(),
                symbol, direction: position.type,
                entryPrice: position.entryPrice, exitPrice,
                pnlPct: pnlPct.toFixed(2), pnlUsd: pnlUsd.toFixed(2),
                reason: 'Fechamento forçado'
            });
            if (pnlUsd > 0) winCount++; else lossCount++;
        }

        // Estatísticas
        const closedTrades = trades.filter(t => t.exitTime !== null);
        const totalTrades = closedTrades.length;
        const wins = closedTrades.filter(t => parseFloat(t.pnlUsd) > 0).length;
        const winrate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
        const totalPnlUsd = closedTrades.reduce((s, t) => s + parseFloat(t.pnlUsd), 0);
        const totalPnlPct = ((equity - 10000) / 10000) * 100;
        const maxDrawdown = highWaterMark > 0 ? ((highWaterMark - equity) / highWaterMark * 100) : 0;

        return { 
            trades, 
            summary: {
                totalTrades, wins, losses: totalTrades - wins,
                winrate, totalPnlPct, totalPnlUsd,
                maxDrawdown, initialEquity: 10000, finalEquity: equity
            }
        };

    } catch (error) {
        logDebug('ERRO FATAL no backtest:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
