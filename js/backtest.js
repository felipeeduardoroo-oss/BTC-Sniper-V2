// js/backtest.js – Backtest com dados reais dos últimos 30 dias
import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchWithRetry,
    fetchMacroStatic
} from './dados_externos.js';
import {
    calculateADX,
    calculateATR,
    calcEMA,
    updateSwingPoints,
    detectHTFStructure
} from './indicadores.js';

// ===== HELPERS DE DEBUG =====
function logDebug(message, data = null) {
    console.log(`[Backtest] ${message}`, data || '');
}

// ===== BUSCAR FUNDING RATE HISTÓRICO =====
async function fetchHistoricalFunding(symbol, startTime, endTime) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=500`;
    logDebug('Buscando Funding Rate:', url);
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.fundingTime, rate: parseFloat(d.fundingRate) }));
        }
        return [];
    } catch (e) {
        logDebug('Erro ao buscar Funding Rate:', e.message);
        return [];
    }
}

// ===== BUSCAR OI HISTÓRICO (limitado a 500 registros para evitar 400) =====
async function fetchHistoricalOI(symbol, startTime, endTime) {
    // A Binance limita a 500 registros para period=1h, então pegamos os últimos 500 pontos
    // Ajustamos o startTime para ser apenas os últimos 500 * 60 * 60 * 1000 ms = 500 horas atrás
    const adjustedStart = Math.max(startTime, endTime - 500 * 60 * 60 * 1000);
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&startTime=${adjustedStart}&endTime=${endTime}&limit=500`;
    logDebug('Buscando OI Histórico (limitado):', url);
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (Array.isArray(data)) {
            return data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) }));
        }
        return [];
    } catch (e) {
        logDebug('Erro ao buscar OI Histórico:', e.message);
        return [];
    }
}

// ===== BUSCAR MVRV HISTÓRICO (CoinMetrics) =====
async function fetchHistoricalMVRV(startDate, endDate) {
    const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=${startDate}&end_time=${endDate}&page_size=100`;
    logDebug('Buscando MVRV Histórico:', url);
    try {
        const data = await fetchWithRetry(url, {}, 2);
        if (data?.data && Array.isArray(data.data)) {
            return data.data.map(d => ({ time: new Date(d.time).getTime() / 1000, value: parseFloat(d.CapMVRVCur) }));
        }
        return [];
    } catch (e) {
        logDebug('Erro ao buscar MVRV Histórico:', e.message);
        return [];
    }
}

// ===== FUNÇÃO PRINCIPAL =====
export async function runBacktest(symbol = 'BTCUSDT', days = 30) {
    logDebug(`Iniciando backtest para ${symbol} (${days} dias)`);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);
    logDebug(`Período: ${startDateStr} a ${endDateStr}`);

    try {
        // 1. Buscar candles
        logDebug('Buscando candles 1h...');
        const candles1h = (await fetchHistoricalCandles(symbol, '1h', 800)) || [];
        logDebug(`Candles 1h obtidos: ${candles1h.length}`);

        logDebug('Buscando candles 4h...');
        const candles4h = (await fetchHistoricalCandles(symbol, '4h', 200)) || [];
        logDebug(`Candles 4h obtidos: ${candles4h.length}`);

        const filteredCandles = candles1h.filter(c => c.time >= startTime / 1000 && c.time <= endTime / 1000);
        logDebug(`Candles filtrados no período: ${filteredCandles.length}`);
        if (filteredCandles.length === 0) {
            return { trades: [], summary: { error: 'Nenhum candle encontrado no período. Verifique as datas.' } };
        }

        // 2. Buscar dados complementares
        logDebug('Buscando Funding Rate...');
        const fundingHist = (await fetchHistoricalFunding(symbol, startTime, endTime)) || [];
        logDebug(`Funding obtido: ${fundingHist.length} registros`);

        logDebug('Buscando Open Interest...');
        const oiHist = (await fetchHistoricalOI(symbol, startTime, endTime)) || [];
        logDebug(`OI obtido: ${oiHist.length} registros`);

        logDebug('Buscando MVRV...');
        const mvrvHist = (await fetchHistoricalMVRV(startDateStr, endDateStr)) || [];
        logDebug(`MVRV obtido: ${mvrvHist.length} registros`);

        logDebug('Buscando Macro (estático)...');
        const macroData = await fetchMacroStatic();
        logDebug('Macro obtido com sucesso');

        // ===== SIMULAÇÃO =====
        const state = {
            candles1h: [],
            candles4h: candles4h || [],
            ema20_1h: 0,
            ema50_1h: 0,
            ema200_4h: 0,
            rsiState: { avgGain: 0, avgLoss: 0, rsi: 50 },
            atr_1h: 0,
            atrHistory: [],
            swingHighs: [],   // garantido como array
            swingLows: [],    // garantido como array
            currentBOS: 'NEUTRAL',
            htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity },
            price: 0,
            fundingRate: 0,
            oiDelta: 0,
            mvrv: null,
            macroBlackout: false,
            adx: 0,
            plusDI: 0,
            minusDI: 0,
            divergence: null,
            volumeAnomaly: null,
            vwap: 0,
        };

        let position = null;
        let trades = [];
        let equity = 10000;
        let highWaterMark = equity;

        // ===== FUNÇÃO UPDATE INDICADORES COM PROTEÇÃO =====
        function updateIndicators(candles) {
            try {
                if (!candles || candles.length < 14) {
                    logDebug('updateIndicators: candles insuficientes', candles?.length);
                    return;
                }
                const closes = candles.map(c => c.close);
                state.ema20_1h = calcEMA(closes, 20).slice(-1)[0] || closes[closes.length - 1];
                state.ema50_1h = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length - 1];
                state.atr_1h = calculateATR(candles, 14);
                state.atrHistory.push(state.atr_1h);
                if (state.atrHistory.length > 100) state.atrHistory.shift();

                let avgGain = 0, avgLoss = 0;
                for (let i = closes.length - 14; i < closes.length; i++) {
                    const diff = closes[i] - closes[i - 1];
                    if (diff > 0) avgGain += diff;
                    else avgLoss += Math.abs(diff);
                }
                avgGain /= 14;
                avgLoss /= 14;
                state.rsiState = { avgGain, avgLoss, rsi: avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)) };

                const adxData = calculateADX(candles);
                state.adx = adxData.adx || 0;
                state.plusDI = adxData.plusDI || 0;
                state.minusDI = adxData.minusDI || 0;

                let cumVol = 0, cumVal = 0;
                candles.forEach(c => { cumVol += c.volume; cumVal += c.close * c.volume; });
                state.vwap = cumVol > 0 ? cumVal / cumVol : closes[closes.length - 1];

                const volMA = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
                state.volumeAnomaly = candles[candles.length - 1].volume > volMA * 2.0 ? 'ALTO' : 'NORMAL';

                // Atualizar swings com proteção
                if (typeof updateSwingPoints === 'function') {
                    updateSwingPoints(state, candles);
                } else {
                    logDebug('updateSwingPoints não está definida, ignorando.');
                }

                // HTF structure
                if (state.candles4h && state.candles4h.length > 50 && typeof detectHTFStructure === 'function') {
                    const htf = detectHTFStructure(state, state.candles4h);
                    if (htf) state.htfStructure = htf;
                }
            } catch (error) {
                logDebug('ERRO em updateIndicators:', error.message);
                throw error; // relança para ser capturado no loop
            }
        }

        // ===== CHECK ENTRY =====
        function checkEntry(candle, index, allCandles) {
            try {
                let score = 50;
                if (state.ema20_1h > state.ema50_1h) score += 10;
                if (state.adx > 25) score += 10;
                if (state.rsiState.rsi > 50) score += 10;
                if (state.volumeAnomaly === 'ALTO') score += 10;
                if (state.htfStructure && state.htfStructure.bias === 'BULLISH') score += 10;

                let blockReason = null;
                if (state.adx < 25) blockReason = 'ADX < 25';
                if (state.macroBlackout) blockReason = 'Macro blackout';
                if (state.htfStructure && state.htfStructure.bias === 'BEARISH' && score > 50) blockReason = 'HTF 4H Bearish';
                if (state.fundingRate > 0.01) blockReason = 'Funding alto (longs caros)';

                const direction = score >= 70 ? 'LONG' : (score <= 30 ? 'SHORT' : null);
                return { score, direction, blockReason };
            } catch (error) {
                logDebug('ERRO em checkEntry:', error.message);
                return { score: 50, direction: null, blockReason: 'Erro interno' };
            }
        }

        // ===== LOOP PRINCIPAL =====
        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];
            state.candles1h.push(candle);
            if (state.candles1h.length > 200) state.candles1h.shift();

            // Atualizar funding e OI
            const fundingAtTime = fundingHist.find(f => f.time <= candle.time * 1000) || fundingHist[0];
            state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;

            const oiAtTime = oiHist.find(o => o.time <= candle.time * 1000) || oiHist[0];
            if (oiAtTime) {
                const oi24h = oiHist.find(o => o.time <= (candle.time - 86400) * 1000);
                state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
            }

            const mvrvAtTime = mvrvHist.find(m => m.time <= candle.time);
            state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;
            state.macroBlackout = false;

            // Atualizar indicadores (com proteção)
            if (state.candles1h.length >= 50) {
                try {
                    updateIndicators(state.candles1h);
                } catch (err) {
                    logDebug(`Erro ao atualizar indicadores no candle ${i}:`, err.message);
                    continue; // pula este candle
                }
            } else {
                continue;
            }

            // Gerenciar posição
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
                        position.trailingStop = Math.max(position.trailingStop, position.entryPrice + state.atr_1h * 0.1);
                    }
                } else { // SHORT
                    if (low <= position.tp2) { exitPrice = position.tp2; closed = true; reason = 'TP2'; }
                    else if (high >= position.trailingStop) { exitPrice = position.trailingStop; closed = true; reason = 'Trailing Stop'; }
                    else if (low <= position.tp1 && !position.partialTaken) {
                        position.partialTaken = true;
                        position.sizeRemaining = 0.5;
                        position.trailingStop = Math.min(position.trailingStop, position.entryPrice - state.atr_1h * 0.1);
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
                    position = null;
                } else {
                    if (position.type === 'LONG') {
                        const newLow = Math.min(...state.swingLows);
                        const newStop = newLow - state.atr_1h * 0.2;
                        if (newStop > position.trailingStop) position.trailingStop = newStop;
                    } else {
                        const newHigh = Math.max(...state.swingHighs);
                        const newStop = newHigh + state.atr_1h * 0.2;
                        if (newStop < position.trailingStop) position.trailingStop = newStop;
                    }
                }
            }

            // Verificar entrada
            if (!position) {
                const { score, direction, blockReason } = checkEntry(candle, i, filteredCandles);
                if (direction && !blockReason && score >= 70) {
                    const atr = state.atr_1h || (candle.close * 0.02);
                    const entry = candle.close;
                    let stop, tp1, tp2;
                    if (direction === 'LONG') {
                        stop = entry - atr * 1.5;
                        tp1 = entry + atr * 2;
                        tp2 = entry + atr * 4;
                    } else {
                        stop = entry + atr * 1.5;
                        tp1 = entry - atr * 2;
                        tp2 = entry - atr * 4;
                    }
                    position = {
                        type: direction,
                        entryPrice: entry,
                        stop: stop,
                        tp1: tp1,
                        tp2: tp2,
                        trailingStop: stop,
                        partialTaken: false,
                        sizeRemaining: 1,
                        entryTime: candle.time * 1000
                    };
                    trades.push({
                        entryTime: new Date(candle.time * 1000).toISOString(),
                        exitTime: null,
                        symbol,
                        direction,
                        entryPrice: entry,
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
        const annualizedReturn = totalPnlPct !== 0 && totalPnlPct !== undefined ? (Math.pow(1 + totalPnlPct / 100, 365 / days) - 1) * 100 : 0;

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

        logDebug('Backtest concluído!', summary);
        return { trades, summary };

    } catch (error) {
        logDebug('ERRO FATAL no backtest:', error.message);
        return { trades: [], summary: { error: error.message } };
    }
}
