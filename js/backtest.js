// js/backtest.js
import { CONFIG } from './config.js';
import {
    fetchHistoricalCandles,
    fetchFundingRate,
    fetchOpenInterest,
    fetchMVRV,
    fetchMacroStatic,
    fetchWithRetry,
    getCurrentPrice,
    setCurrentPrice
} from './dados_externos.js';
import {
    calculateADX,
    calculateATR,
    calcEMA,
    detectRSIDivergence,
    updateSwingPoints,
    detectHTFStructure,
    checkDerivativesFilter,
    computeScore,
    isSafeToTrade,
    KellyPositionSize,
    generateTrailingStopParams,
    // outras que forem necessárias
} from './indicadores.js';

// Utilitário: agrupar candles por dia para MVRV e Macro
function groupByDay(candles) {
    const days = {};
    candles.forEach(c => {
        const date = new Date(c.time * 1000).toISOString().slice(0,10);
        if (!days[date]) days[date] = [];
        days[date].push(c);
    });
    return days;
}

// Buscar funding rate histórico (a cada 8h)
async function fetchHistoricalFunding(symbol, startTime, endTime) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    const data = await fetchWithRetry(url);
    return data.map(d => ({ time: d.fundingTime, rate: parseFloat(d.fundingRate) }));
}

// Buscar OI histórico (a cada 1h)
async function fetchHistoricalOI(symbol, startTime, endTime) {
    // Binance não tem histórico de OI por hora, mas podemos usar o endpoint de dados de openInterestHist com período 1h
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    const data = await fetchWithRetry(url);
    return data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) }));
}

// Obter MVRV diário (via CoinMetrics)
async function fetchHistoricalMVRV(startDate, endDate) {
    // Usar a função fetchMVRV já existente, mas ela só retorna o último. 
    // Para histórico, usamos a API de timeseries com parâmetros.
    const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=${startDate}&end_time=${endDate}&page_size=100`;
    const data = await fetchWithRetry(url);
    return data.data.map(d => ({ time: new Date(d.time).getTime()/1000, value: parseFloat(d.CapMVRVCur) }));
}

// Função principal de backtest
export async function runBacktest(symbol = 'BTCUSDT', days = 30) {
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    console.log(`[Backtest] Iniciando simulação para ${symbol} de ${new Date(startTime).toISOString()} a ${new Date(endTime).toISOString()}`);

    // 1. Buscar dados históricos
    const [candles1h, candles4h, fundingHist, oiHist, mvrvHist, macroData] = await Promise.all([
        fetchHistoricalCandles(symbol, '1h', 800), // mais que o necessário
        fetchHistoricalCandles(symbol, '4h', 200),
        fetchHistoricalFunding(symbol, startTime, endTime),
        fetchHistoricalOI(symbol, startTime, endTime),
        fetchHistoricalMVRV(startTime, endTime),
        fetchMacroStatic() // Macro é diário, pegamos o valor estático para todo o período (ou poderíamos buscar histórico, mas é complexo)
    ]);

    // Filtrar candles pelo período
    const filteredCandles = candles1h.filter(c => c.time >= startTime/1000 && c.time <= endTime/1000);
    if (filteredCandles.length === 0) {
        console.error('Nenhum candle encontrado no período.');
        return { trades: [], summary: { error: 'Sem dados' } };
    }

    // 2. Preparar estruturas para simulação
    let state = {
        candles1h: [],
        candles4h: [],
        ema20_1h: 0,
        ema50_1h: 0,
        ema200_4h: 0,
        rsiState: { avgGain: 0, avgLoss: 0, rsi: 50 },
        atr_1h: 0,
        atrHistory: [],
        swingHighs: [],
        swingLows: [],
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
        // ... outros que sejam usados
    };

    let position = null; // { entryPrice, type, stop, tp1, tp2, trailingStop, partialTaken, entryTime, size }
    let trades = [];
    let equity = 10000; // carteira inicial
    let highWaterMark = equity;

    // Função para calcular indicadores a partir de candles acumulados
    function updateIndicators(candles) {
        if (candles.length < 14) return;
        const closes = candles.map(c => c.close);
        // EMA 20 e 50
        state.ema20_1h = calcEMA(closes, 20).slice(-1)[0] || closes[closes.length-1];
        state.ema50_1h = calcEMA(closes, 50).slice(-1)[0] || closes[closes.length-1];
        // ATR
        state.atr_1h = calculateATR(candles, 14);
        state.atrHistory.push(state.atr_1h);
        if (state.atrHistory.length > 100) state.atrHistory.shift();
        // RSI
        // (usar updateStatefulRSI ou recalcular)
        let avgGain = 0, avgLoss = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i-1];
            if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
        }
        avgGain /= 14; avgLoss /= 14;
        state.rsiState = { avgGain, avgLoss, rsi: avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain/avgLoss)) };
        // ADX
        const adxData = calculateADX(candles);
        state.adx = adxData.adx;
        state.plusDI = adxData.plusDI;
        state.minusDI = adxData.minusDI;
        // Divergência
        const rsiValues = []; // precisamos recalcular RSI para cada candle, mas para simplificar usamos o RSI atual
        // Não faremos divergência no backtest para simplificar.
        state.divergence = null;
        // VWAP
        let cumVol = 0, cumVal = 0;
        candles.forEach(c => { cumVol += c.volume; cumVal += c.close * c.volume; });
        state.vwap = cumVol > 0 ? cumVal / cumVol : closes[closes.length-1];
        // Volume anômalo
        const volMA = candles.slice(-20).reduce((s,c) => s + c.volume, 0) / 20;
        state.volumeAnomaly = candles[candles.length-1].volume > volMA * 2.0 ? 'ALTO' : 'NORMAL';
        // Swings e BOS
        updateSwingPoints(state, candles);
        // HTF structure (usando candles 4h)
        if (state.candles4h.length > 50) {
            state.htfStructure = detectHTFStructure(state, state.candles4h);
        }
        // Funding e OI (são passados de fora)
    }

    // Função para verificar condições de entrada (baseado no score e vetos)
    function checkEntry(candle, index, allCandles) {
        // Preparar dados para computeScore (precisamos de um objeto assetsData simulado)
        const simData = {
            price: candle.close,
            candles1H: allCandles.slice(0, index+1),
            candles4H: state.candles4h,
            ema50_1H: state.ema50_1H,
            ema200_4H: state.ema200_4H,
            rsi_1H: state.rsiState.rsi,
            atr_1H: state.atr_1h,
            atrHistory: state.atrHistory,
            swingHighs: state.swingHighs,
            swingLows: state.swingLows,
            currentBOS: state.currentBOS,
            mtfConfluence: { alinhado: true, score: 0 }, // simplificar
            adx: state.adx,
            plusDI: state.plusDI,
            minusDI: state.minusDI,
            divergence: state.divergence,
            volumeAnomaly: state.volumeAnomaly,
            macroBlackout: state.macroBlackout,
            vwap: state.vwap,
            htfStructure: state.htfStructure,
            fundingRate: state.fundingRate,
            oiDelta: state.oiDelta,
            mvrv: state.mvrv,
        };
        // Precisamos de computeScore, mas ele espera assetsData e liqMap. Vamos criar uma versão simplificada.
        // Como é complexo, vou reimplementar a lógica de score diretamente aqui.
        // Vou usar a função computeScore se ela for adaptável, ou copiar a lógica.
        // Para não alongar, vou assumir que computeScore pode ser chamada com um objeto que tenha os campos necessários.
        // Mas como a função computeScore usa assetsData[symbol] e liqMap, precisamos adaptar.
        // Vou criar uma função auxiliar local que calcula o score baseado nos indicadores.
        // (Na prática, você pode refatorar computeScore para aceitar um objeto de dados)
        // Para este exemplo, vou usar uma versão simplificada:
        let score = 50;
        // Exemplo: se EMA20 > EMA50 e ADX > 25, score += 20
        if (state.ema20_1h > state.ema50_1h) score += 10;
        if (state.adx > 25) score += 10;
        if (state.rsiState.rsi > 50) score += 10;
        if (state.volumeAnomaly === 'ALTO') score += 10;
        if (state.htfStructure.bias === 'BULLISH') score += 10;
        // ... etc.
        // Vetos
        let blockReason = null;
        if (state.adx < 25) blockReason = 'ADX < 25';
        if (state.macroBlackout) blockReason = 'Macro blackout';
        if (state.htfStructure.bias === 'BEARISH' && score > 50) blockReason = 'HTF 4H Bearish';
        if (state.fundingRate > 0.01) blockReason = 'Funding alto (longs caros)';
        // ... outros vetos
        const direction = score >= 70 ? 'LONG' : (score <= 30 ? 'SHORT' : null);
        return { score, direction, blockReason };
    }

    // Percorrer candles
    for (let i = 0; i < filteredCandles.length; i++) {
        const candle = filteredCandles[i];
        // Atualizar estado com candles acumulados
        state.candles1h.push(candle);
        if (state.candles1h.length > 200) state.candles1h.shift();
        // Atualizar candles 4h (simplificado: pegar os últimos 4h)
        // Vamos manter uma lista de candles4h separada, mas para simplicidade, usamos o array global
        // Atualizar OI e funding (usando os históricos)
        // Encontrar funding rate mais próximo
        const fundingAtTime = fundingHist.find(f => f.time <= candle.time*1000) || fundingHist[0];
        state.fundingRate = fundingAtTime ? fundingAtTime.rate : 0;
        // OI delta: calcular a partir do OI histórico
        const oiAtTime = oiHist.find(o => o.time <= candle.time*1000) || oiHist[0];
        if (oiAtTime) {
            // Calcular delta em relação a 24h atrás
            const oi24h = oiHist.find(o => o.time <= (candle.time - 86400)*1000);
            state.oiDelta = oi24h ? ((oiAtTime.oi - oi24h.oi) / oi24h.oi * 100) : 0;
        }
        // MVRV (diário)
        const mvrvAtTime = mvrvHist.find(m => m.time <= candle.time);
        state.mvrv = mvrvAtTime ? mvrvAtTime.value : null;
        // Macro blackout (usando dados estáticos, mas poderíamos buscar histórico)
        // Para simplicidade, consideramos false.
        state.macroBlackout = false;

        // Atualizar indicadores com os candles acumulados
        if (state.candles1h.length >= 50) {
            updateIndicators(state.candles1h);
        } else {
            continue; // não temos dados suficientes
        }

        // Gerenciar posição aberta
        if (position) {
            // Verificar se atingiu stop ou tp
            const high = candle.high;
            const low = candle.low;
            let closed = false;
            let exitPrice = 0;
            let reason = '';
            // Verificar TP1, TP2, Stop
            if (position.type === 'LONG') {
                if (high >= position.tp2) {
                    exitPrice = position.tp2;
                    closed = true;
                    reason = 'TP2';
                } else if (low <= position.trailingStop) {
                    exitPrice = position.trailingStop;
                    closed = true;
                    reason = 'Trailing Stop';
                } else if (high >= position.tp1 && !position.partialTaken) {
                    // parcial
                    position.partialTaken = true;
                    position.sizeRemaining = 0.5;
                    // ajustar trailing
                    position.trailingStop = Math.max(position.trailingStop, position.entryPrice + state.atr_1h * 0.1);
                }
            } else { // SHORT
                if (low <= position.tp2) {
                    exitPrice = position.tp2;
                    closed = true;
                    reason = 'TP2';
                } else if (high >= position.trailingStop) {
                    exitPrice = position.trailingStop;
                    closed = true;
                    reason = 'Trailing Stop';
                } else if (low <= position.tp1 && !position.partialTaken) {
                    position.partialTaken = true;
                    position.sizeRemaining = 0.5;
                    position.trailingStop = Math.min(position.trailingStop, position.entryPrice - state.atr_1h * 0.1);
                }
            }
            if (closed) {
                // Calcular P&L
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
                    durationHours: ((candle.time - position.entryTime/1000) / 3600).toFixed(1),
                    reason
                });
                position = null;
            } else {
                // Atualizar trailing stop com novos swings
                if (position.type === 'LONG') {
                    const newLow = Math.min(...state.swingLows);
                    const newStop = newLow - state.atr_1h * 0.2;
                    if (newStop > position.trailingStop) {
                        position.trailingStop = newStop;
                    }
                } else {
                    const newHigh = Math.max(...state.swingHighs);
                    const newStop = newHigh + state.atr_1h * 0.2;
                    if (newStop < position.trailingStop) {
                        position.trailingStop = newStop;
                    }
                }
            }
        }

        // Verificar entrada (se não houver posição)
        if (!position) {
            const { score, direction, blockReason } = checkEntry(candle, i, filteredCandles);
            if (direction && !blockReason && score >= 70) {
                // Abrir posição
                const atr = state.atr_1h;
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
                // Registrar entrada parcial na tabela (será completada no fechamento)
                // Vamos armazenar temporariamente
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

    // Fechar posição remanescente no final
    if (position) {
        const lastCandle = filteredCandles[filteredCandles.length-1];
        const exitPrice = lastCandle.close;
        const pnlPct = position.type === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        const pnlUsd = equity * (pnlPct / 100) * position.sizeRemaining;
        equity += pnlUsd;
        // Atualizar último trade (que estava aberto)
        const lastTrade = trades[trades.length-1];
        if (lastTrade && lastTrade.exitTime === null) {
            lastTrade.exitTime = new Date(lastCandle.time * 1000).toISOString();
            lastTrade.exitPrice = exitPrice;
            lastTrade.pnlPct = (pnlPct * position.sizeRemaining).toFixed(2);
            lastTrade.pnlUsd = pnlUsd.toFixed(2);
            lastTrade.durationHours = ((lastCandle.time - position.entryTime/1000) / 3600).toFixed(1);
            lastTrade.reason = 'Fechamento forçado';
        }
        position = null;
    }

    // Calcular estatísticas
    const closedTrades = trades.filter(t => t.exitTime !== null);
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter(t => parseFloat(t.pnlPct) > 0).length;
    const losses = totalTrades - wins;
    const winrate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const totalPnlPct = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlPct), 0);
    const totalPnlUsd = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnlUsd), 0);
    const avgWin = wins > 0 ? closedTrades.filter(t => parseFloat(t.pnlPct) > 0).reduce((s,t) => s + parseFloat(t.pnlPct),0) / wins : 0;
    const avgLoss = losses > 0 ? closedTrades.filter(t => parseFloat(t.pnlPct) < 0).reduce((s,t) => s + parseFloat(t.pnlPct),0) / losses : 0;
    const profitFactor = avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)) : 0;
    const maxDrawdown = ((highWaterMark - equity) / highWaterMark * 100);
    const annualizedReturn = totalPnlPct !== 0 ? (Math.pow(1 + totalPnlPct/100, 365/days) - 1) * 100 : 0;

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

    return { trades, summary };
}
