// js/backtest.js – Backtest com o MESMO motor do live
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

// ===== BUSCA DE DADOS HISTÓRICOS (corrigida) =====
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
export async function runBacktest(symbol = 'BTCUSDT', days = 30) {
    logDebug(`Iniciando backtest REAL para ${symbol} (${days} dias)`);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);

    try {
        // 1. Buscar candles (1h e 4h)
        const candles1h = (await fetchHistoricalCandles(symbol, '1h', 800)) || [];
        const candles4h = (await fetchHistoricalCandles(symbol, '4h', 200)) || [];
        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado.' } };
        }

        // 2. Dados complementares
        const fundingHist = (await fetchHistoricalFunding(symbol, startTime, endTime)) || [];
        const oiHist = (await fetchHistoricalOI(symbol, startTime, endTime)) || [];
        const mvrvHist = (await fetchHistoricalMVRV(startDateStr, endDateStr)) || [];
        const macroData = await fetchMacroStatic(); // estático para o período, ok

        // 3. Estado do ativo (espelhando assetsData)
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
            fearGreedData: null,
            liqMap: { longs: 0, shorts: 0 }
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0,
            lossCount = 0;
        const stats = { wins: 0, losses: 0 };

        // 4. Função que atualiza os indicadores (igual ao live)
        function updateIndicators(candles) {
            if (candles.length < 14) return;
            const closes = candles.map(c => c.close);
            state.ema50_1H = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
            state.atr_1H = calculateATR(candles, 14);
            state.atrHistory.push(state.atr_1H);
            if (state.atrHistory.length > 100) state.atrHistory.shift();

            let avgGain = 0,
                avgLoss = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
                const diff = closes[i] - closes[i - 1];
                if (diff > 0) avgGain += diff;
                else avgLoss += Math.abs(diff);
            }
            avgGain /= 14;
            avgLoss /= 14;
            state.rsi_1H = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

            const adxData = calculateADX(candles);
            state.adx = adxData.adx || 0;

            state.vwap = calculateVWAP(candles);
            const volAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
            state.volumeAnomaly = volAnomaly;

            updateSwingPoints(state);
            if (state.candles4H.length > 50) {
                state.htfStructure = detectHTFStructure(state, state.candles4H);
            }

            // Divergência RSI
            let rsiValues = [];
            for (let i = 14; i < closes.length; i++) {
                // cálculo simplificado para divergência, pode ser o mesmo do live
            }
            // Para simplificar, usamos a função existente:
            // const divergence = detectRSIDivergence(candles, rsiValues);
            // state.divergence = divergence;
        }

        // 5. Loop principal
        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];
            state.price = candle.close;
            state.candles1H.push(candle);
            if (state.candles1H.length > 200) state.candles1H.shift();

            // Atualizar dados históricos com findMostRecent (corrigido)
            const fundingAtTime = findMostRecent(fundingHist, f => f.time <= candle.time * 1000) || fundingHist[0];
            state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;

            const oiAtTime = findMostRecent(oiHist, o => o.time <= candle.time * 1000) || oiHist[0];
            if (oiAtTime) {
                const oi24h = findMostRecent(oiHist, o => o.time <= (candle.time - 86400) * 1000);
                state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
            }

            const mvrvAtTime = findMostRecent(mvrvHist, m => m.time <= candle.time);
            state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;

            // Macro blackout (usando o mesmo do live)
            const macroCheck = await isHighImpactEventNow();
            state.macroBlackout = macroCheck.isBlackout && macroCheck.impact === 'HIGH';

            // Fear & Greed (simulado com estático, ou poderíamos buscar histórico via API)
            // Para o backtest, usamos o valor do dia (pode ser melhorado)
            // Aqui pegamos um valor estático ou buscamos da API se quiser
            // Vamos usar um valor médio: 50
            state.fearGreedData = { value: 50, classification: 'NEUTRO' };

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H);
            } else {
                continue;
            }

            // ===== USAR O MESMO MOTOR DO LIVE =====
            // Precisamos de um assetsData simulado para computeScore
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
            // Atualiza BOS real
            const bosConfirmed = scoreData.direction !== 'NEUTRAL' && findSMCSetup(state, scoreData.direction);
            state.currentBOS = bosConfirmed ? 'BOS' : 'NEUTRAL';

            const confidence = calculateConfidenceScore({
                mtfAligned: simAssets[symbol].mtfConfluence?.alinhado || false,
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

            // Filtros (idênticos ao live)
            if (state.adx < 25 && !blockReason) blockReason = 'ADX < 25 (lateral)';
            if (state.macroBlackout && !blockReason) blockReason = 'Macro blackout';
            const primaryDirection = (score >= 70) ? 'LONG' : (score <= 30) ? 'SHORT' : null;
            if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason)
                blockReason = 'Preço abaixo do VWAP';
            else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason)
                blockReason = 'Preço acima do VWAP';

            if (primaryDirection === 'LONG' && state.htfStructure.bias === 'BEARISH' && !blockReason)
                blockReason = 'HTF 4H Bearish';
            if (primaryDirection === 'SHORT' && state.htfStructure.bias === 'BULLISH' && !blockReason)
                blockReason = 'HTF 4H Bullish';

            if (!blockReason) {
                const derivCheck = checkDerivativesFilter(state.fundingRate, state.oiDelta);
                if (!derivCheck.allow) blockReason = derivCheck.reason;
            }

            // ===== GERENCIAR POSIÇÃO =====
            if (position) {
                const high = candle.high;
                const low = candle.low;
                let closed = false;
                let exitPrice = 0;
                let reason = '';

                if (position.type === 'LONG') {
                    if (high >= position.tp2) { exitPrice = position.tp2;
                        closed = true;
                        reason = 'TP2'; } else if (low <= position.trailingStop) { exitPrice = position.trailingStop;
                        closed = true;
                        reason = 'Trailing Stop'; } else if (high >= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeRemaining = 0.5;
                        position.trailingStop = Math.max(position.trailingStop, position.entryPrice + state.atr_1H * 0.1);
                    }
                } else {
                    if (low <= position.tp2) { exitPrice = position.tp2;
                        closed = true;
                        reason = 'TP2'; } else if (high >= position.trailingStop) { exitPrice = position.trailingStop;
                        closed = true;
                        reason = 'Trailing Stop'; } else if (low <= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeRemaining = 0.5;
                        position.trailingStop = Math.min(position.trailingStop, position.entryPrice - state.atr_1H * 0.1);
                    }
                }

                if (closed) {
                    const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
                    const pnlUsd = equity * (pnlPct / 100) * position.sizeRemaining;
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
                    if (pnlPct > 0) winCount++;
                    else lossCount++;
                    position = null;
                } else {
                    // Atualizar trailing
                    if (position.type === 'LONG') {
                        const newLow = Math.min(...state.swingLows);
                        const newStop = newLow - state.atr_1H * 0.2;
                        if (newStop > position.trailingStop) position.trailingStop = newStop;
                    } else {
                        const newHigh = Math.max(...state.swingHighs);
                        const newStop = newHigh + state.atr_1H * 0.2;
                        if (newStop < position.trailingStop) position.trailingStop = newStop;
                    }
                }
            }

            // ===== ENTRADA (usando as mesmas condições do live) =====
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);
                // Verificar reteste de EMA20
                const ema20 = calcEMA(state.candles1H.map(c => c.close), 20).slice(-1)[0] || state.price;
                let retestConfirmed = false;
                if (primaryDirection === 'LONG') {
                    if (state.price <= ema20 * 1.005 && state.price >= ema20 * 0.995) retestConfirmed = true;
                } else {
                    if (state.price >= ema20 * 0.995 && state.price <= ema20 * 1.005) retestConfirmed = true;
                }

                const smcSetup = findSMCSetup(state, primaryDirection);

                if (smcSetup && retestConfirmed) {
                    let stop, tp1, tp2;
                    if (primaryDirection === 'LONG') {
                        const structLevel = Math.min(...state.swingLows) - (atr * 0.3);
                        stop = Math.min(structLevel, state.price - atr * 1.5);
                        tp1 = state.price + (atr * 2);
                        tp2 = state.price + (atr * 4);
                    } else {
                        const structLevel = Math.max(...state.swingHighs) + (atr * 0.3);
                        stop = Math.max(structLevel, state.price + atr * 1.5);
                        tp1 = state.price - (atr * 2);
                        tp2 = state.price - (atr * 4);
                    }
                    const rr1 = primaryDirection === 'LONG' ? (tp1 - state.price) / (state.price - stop) : (state.price - tp1) / (stop - state.price);
                    if (rr1 < 1.5) continue;

                    // Kelly (usa winrate do próprio backtest)
                    const totalTrades = winCount + lossCount;
                    const winRate = totalTrades > 0 ? winCount / totalTrades : 0.5;
                    const kellyPct = KellyPositionSize(winRate, rr1);
                    // Aplicar multiplicador do Fear & Greed (aqui usamos estático, mas pode ser dinâmico)
                    const fgMultiplier = 1; // no live usa fearGreedFilter
                    const riskPct = kellyPct * fgMultiplier;

                    // Abrir posição (usando o mesmo sizing fracionado)
                    position = {
                        type: primaryDirection,
                        entryPrice: state.price,
                        stop: stop,
                        tp1: tp1,
                        tp2: tp2,
                        trailingStop: stop,
                        partialTaken: false,
                        sizeRemaining: 1,
                        entryTime: candle.time * 1000,
                        riskPct: riskPct
                    };
                    // Para simular o sizing fracionado, ajustamos o impacto no P&L
                    // Vamos aplicar o riskPct no fechamento
                    // Por simplicidade, ajustamos a variação percentual pelo riskPct
                    // (no fechamento já multiplicamos pelo riskPct via position.sizeRemaining)
                    // Mas como temos riskPct, podemos usar 1 e depois aplicar no P&L final
                    // Melhor: armazenar o riskPct e aplicar no P&L
                    // Vamos modificar a lógica de fechamento para usar o riskPct
                    // Para não complicar, mantemos sizeRemaining=1 e depois ajustamos o P&L no fechamento multiplicando por riskPct
                    // Mas como já temos pnlPct * sizeRemaining, podemos fazer sizeRemaining = riskPct
                    position.sizeRemaining = riskPct; // agora o impacto é proporcional ao risco
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
            const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
            const pnlUsd = equity * (pnlPct / 100) * position.sizeRemaining;
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
            if (pnlPct * position.sizeRemaining > 0) winCount++;
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
        const annualizedReturn = totalPnlPct !== 0 ? (Math.pow(1 + totalPnlPct / 100, 365 / days) - 1) * 100 : 0;

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
        };

        logDebug('Backtest REAL concluído!', summary);
        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL no backtest:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
