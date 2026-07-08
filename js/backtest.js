// js/backtest.js – Backtest com dados reais dos últimos 30 dias (CORRIGIDO)
import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic,
    getMTFConfluence,
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
    isHighImpactEventNow,
    detectRSIDivergence,
    checkPortfolioExposure
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
        // 1. Buscar candles (1h e 4h) – máximo 1000 velas
        const candles1h = (await fetchHistoricalCandles(symbol, '1h', 800)) || [];
        const candles4h = (await fetchHistoricalCandles(symbol, '4h', 200)) || [];
        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado.' } };
        }

        // 2. Dados complementares (históricos)
        const fundingHist = (await fetchHistoricalFunding(symbol, startTime, endTime)) || [];
        const oiHist = (await fetchHistoricalOI(symbol, startTime, endTime)) || [];
        const mvrvHist = (await fetchHistoricalMVRV(startDateStr, endDateStr)) || [];
        const macroData = await fetchMacroStatic();

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
            mtfConfluence: null,    // ← será atualizado
            adx: 0,
            divergence: null,       // ← será atualizado
            volumeAnomaly: null,
            macroBlackout: false,
            vwap: 0,
            price: 0,
            fundingRate: 0,
            oiDelta: 0,
            mvrv: null,
            fearGreedData: null
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;
        let winCount = 0,
            lossCount = 0;

        // ===== FUNÇÃO UPDATE INDICADORES =====
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
            state.adx = adxData;

            // ---- VWAP em janela de 24h (últimas 24 velas) ----
            const last24Candles = candles.slice(-24);
            state.vwap = calculateVWAP(last24Candles);

            const volAnomaly = detectVolumeAnomaly(candles, 20, 2.0);
            state.volumeAnomaly = volAnomaly;

            updateSwingPoints(state);
            if (state.candles4H.length > 50) {
                state.htfStructure = detectHTFStructure(state, state.candles4H);
            }

            // ---- Divergência RSI (CORREÇÃO #3) ----
            let rsiForDiv = [];
            let g = 0,
                l = 0;
            for (let i = 1; i < closes.length; i++) {
                const d = closes[i] - closes[i - 1];
                if (i <= 14) {
                    if (d >= 0) g += d;
                    else l -= d;
                    if (i === 14) {
                        let ag = g / 14,
                            al = l / 14;
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

        // ===== LOOP PRINCIPAL =====
        // Cache para MTF Confluence (atualizar a cada 6 horas para evitar chamadas excessivas)
        let mtfCache = { data: null, lastUpdate: 0 };

        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];
            state.price = candle.close;
            state.candles1H.push(candle);
            if (state.candles1H.length > 200) state.candles1H.shift();

            // --- Dados históricos com findMostRecent ---
            const fundingAtTime = findMostRecent(fundingHist, f => f.time <= candle.time * 1000) || fundingHist[0];
            state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;

            const oiAtTime = findMostRecent(oiHist, o => o.time <= candle.time * 1000) || oiHist[0];
            if (oiAtTime) {
                const oi24h = findMostRecent(oiHist, o => o.time <= (candle.time - 86400) * 1000);
                state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
            }

            const mvrvAtTime = findMostRecent(mvrvHist, m => m.time <= candle.time);
            state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;

            // Macro blackout
            const macroCheck = await isHighImpactEventNow();
            state.macroBlackout = macroCheck.isBlackout && macroCheck.impact === 'HIGH';

            // Fear & Greed estático (pode ser melhorado com histórico)
            state.fearGreedData = { value: 50, classification: 'NEUTRO' };

            // ---- MTF Confluence (CORREÇÃO #2) ----
            // Atualiza a cada 6 horas (6 candles de 1h)
            if (i === 0 || (i % 6 === 0) || state.mtfConfluence === null) {
                try {
                    state.mtfConfluence = await getMTFConfluence(symbol);
                } catch(e) {
                    // Fallback: mantém o último valor
                }
            }

            if (state.candles1H.length >= 50) {
                updateIndicators(state.candles1H);
            } else {
                continue;
            }

            // ===== USAR O MESMO MOTOR DO LIVE =====
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

            const adxValue = typeof state.adx === 'object' ? state.adx.adx : state.adx;
            if (adxValue < 25 && !blockReason) blockReason = 'ADX < 25 (lateral)';
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
                    // P&L em percentual sobre o valor investido (não sobre o equity total)
                    // sizeRemaining já é o multiplicador do risco (ex: 0.01 para 1%)
                    const invested = equity * position.sizeRemaining;
                    const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
                    // O P&L em USD = invested * (pnlPct/100)
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
                        pnlPct: (pnlPct * position.sizeRemaining).toFixed(2), // P&L % sobre equity total
                        pnlUsd: pnlUsd.toFixed(2),
                        durationHours: ((candle.time - position.entryTime / 1000) / 3600).toFixed(1),
                        reason
                    });
                    if (pnlUsd > 0) winCount++;
                    else lossCount++;
                    position = null;
                } else {
                    // Atualizar trailing
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

            // ===== ENTRADA (CORREÇÃO #1: Position Sizing) =====
            if (!position && !blockReason && primaryDirection) {
                const atr = state.atr_1H || (state.price * 0.02);
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

                    // ---- Cálculo do tamanho da posição ----
                    const totalTrades = winCount + lossCount;
                    const winRate = totalTrades > 0 ? winCount / totalTrades : 0.5;
                    const kellyPct = KellyPositionSize(winRate, rr1);
                    const fgMultiplier = 1; // Poderia usar fearGreedFilter
                    const riskFraction = Math.min(kellyPct * fgMultiplier, 0.05); // máximo 5%

                    // Tamanho da posição em USD: risco (frações da equity) * equity / distância do stop (em %)
                    const stopDistancePct = primaryDirection === 'LONG' ? (state.price - stop) / state.price : (stop - state.price) / state.price;
                    // O tamanho da posição (em USD) que resulta em perda de riskFraction * equity se o stop for atingido
                    const positionSizeUSD = (riskFraction * equity) / stopDistancePct;
                    // O P&L será calculado sobre o equity investido (positionSizeUSD)
                    // Mas para simplificar, vamos armazenar o multiplicador que será aplicado ao P&L percentual.
                    // Multiplicador = positionSizeUSD / equity (pois pnlUsd = equity * (pnlPct/100) * multiplicador)
                    const sizeMultiplier = positionSizeUSD / equity;
                    // Limitar a 10x para evitar alavancagem excessiva (ajuste)
                    const cappedMultiplier = Math.min(sizeMultiplier, 1.0); // máximo 100% do equity

                    // Abrir posição
                    position = {
                        type: primaryDirection,
                        entryPrice: state.price,
                        stop: stop,
                        tp1: tp1,
                        tp2: tp2,
                        trailingStop: stop,
                        partialTaken: false,
                        sizeRemaining: cappedMultiplier, // multiplicador para P&L
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
        };

        logDebug('Backtest REAL concluído!', summary);
        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL no backtest:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
