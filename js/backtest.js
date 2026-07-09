// ================================================================
// backtest.js – Sincronizado com o robô ao vivo (ROBOT_CONFIG)
// ================================================================

import * as indicadores from './js/indicadores.js';
import * as telegram from './js/telegram.js';
import * as banco from './js/banco_de_dados.js';
import { CONFIG } from './js/config.js';
import {
    fetchHistoricalCandles,
    fetchFundingRate,
    fetchOpenInterest,
    fetchMVRV,
    fetchOIDelta,
    fetchFearGreed
} from './js/dados_externos.js';

// ===== FUNÇÕES AUXILIARES (caso não estejam em indicadores.js) =====
function calcEMA(data, period) {
    const result = [];
    if (!data || data.length === 0) return result;
    const multiplier = 2 / (period + 1);
    let ema = data[0];
    result.push(ema);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
        result.push(ema);
    }
    return result;
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let tr = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const hl = high - low;
        const hc = Math.abs(high - prevClose);
        const lc = Math.abs(low - prevClose);
        tr.push(Math.max(hl, hc, lc));
    }
    if (tr.length === 0) return 0;
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
}

// ===== MTF Confluence HISTÓRICO =====
function getMTFAlignmentAtTime(candles1H, candles4H, currentTime) {
    const relevant1H = candles1H.filter(c => c.time <= currentTime).slice(-50);
    const relevant4H = candles4H.filter(c => c.time <= currentTime).slice(-50);
    if (relevant1H.length < 50 || relevant4H.length < 20) {
        return { alinhado: false, score: 0, directions: [] };
    }

    const dir = (candles) => {
        const closes = candles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        const last = closes[closes.length - 1];
        if (ema20.length === 0 || ema50.length === 0) return 'NEUTRO';
        const ema20Last = ema20[ema20.length - 1];
        const ema50Last = ema50[ema50.length - 1];
        if (ema20Last > ema50Last && last > ema20Last) return 'BULL';
        if (ema20Last < ema50Last && last < ema20Last) return 'BEAR';
        return 'NEUTRO';
    };

    const dir1H = dir(relevant1H);
    const dir4H = dir(relevant4H);
    const bulls = [dir1H, dir4H].filter(d => d === 'BULL').length;
    const bears = [dir1H, dir4H].filter(d => d === 'BEAR').length;

    return {
        directions: [{ tf: '1h', dir: dir1H }, { tf: '4h', dir: dir4H }],
        score: bulls - bears,
        alinhado: bulls === 2 || bears === 2
    };
}

// ===== FUNÇÃO UNIFICADA DE BOS E RETEST (mesma do robô) =====
function checkBOSAndRetest(state, direction, retestDistPct) {
    const recentHighs = (state.swingHighs || []).slice(-3);
    const recentLows = (state.swingLows || []).slice(-3);

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

// ===== FUNÇÃO PRINCIPAL =====
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    console.log('[Backtest] Iniciando com opções:', options);

    // --- 1. Usar parâmetros do ROBOT_CONFIG (se disponíveis) ou fallback ---
    const config = window.ROBOT_CONFIG || {
        scoreMin: 60,
        scoreMaxShort: 30,
        adxMin: 10,
        rrMin: 0.1,
        requireBOS: false,
        requireRetest: false,
        requireMTF: false,
        requireEMARetest: false,
        retestDistPct: 0.008,
    };

    // Mescla com as opções passadas (prioridade para as opções)
    const params = {
        scoreMin: options.scoreMin ?? config.scoreMin,
        scoreMaxShort: options.scoreMaxShort ?? config.scoreMaxShort,
        adxMin: options.adxMin ?? config.adxMin,
        rrMin: options.rrMin ?? config.rrMin,
        requireBOS: options.requireBOS ?? config.requireBOS,
        requireRetest: options.requireRetest ?? config.requireRetest,
        requireMTF: options.requireMTF ?? config.requireMTF,
        requireEMARetest: options.requireEMARetest ?? config.requireEMARetest,
        retestDistPct: options.retestDistPct ?? config.retestDistPct,
    };

    console.log('[Backtest] Parâmetros finais:', params);

    // --- 2. Coletar dados históricos ---
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    let candles15m, candles1H, candles4H;
    try {
        [candles15m, candles1H, candles4H] = await Promise.all([
            fetchHistoricalCandles(symbol, '15m', startTime, endTime),
            fetchHistoricalCandles(symbol, '1h', startTime, endTime),
            fetchHistoricalCandles(symbol, '4h', startTime, endTime),
        ]);
    } catch (e) {
        console.error('[Backtest] Erro ao buscar dados:', e);
        return { trades: [], summary: { error: 'Falha ao buscar dados históricos' } };
    }

    if (!candles15m || candles15m.length < 100) {
        return { trades: [], summary: { error: 'Dados insuficientes (menos de 100 candles)' } };
    }

    // --- 3. Preparar state (simula assetsData) ---
    const state = {
        price: 0,
        candles1H: candles1H,
        candles4H: candles4H,
        candles1D: [],
        swingHighs: [],
        swingLows: [],
        htfStructure: { bias: 'NEUTRAL', lastSwingHigh: 0, lastSwingLow: Infinity },
        fundingRate: 0,
        oiDelta: 0,
        mvrv: null,
        fearGreedData: null,
        adx: 0,
        volumeAnomaly: null,
        macroBlackout: false,
        vwap: 0,
        divergence: null,
        mtfConfluence: null,
        atr_1H: 0,
        atrHistory: [],
    };

    // --- 4. Variáveis de backtest ---
    let equity = 10000;
    let position = null;
    const trades = [];
    const equityCurve = [equity];
    const blockStats = {};
    let alertCooldown = 0;

    // --- 5. Loop principal (a partir do índice 50 para ter dados suficientes) ---
    for (let i = 50; i < candles15m.length; i++) {
        const candle = candles15m[i];
        const slice = candles15m.slice(0, i + 1);
        const closes = slice.map(c => c.close);
        const highs = slice.map(c => c.high);
        const lows = slice.map(c => c.low);
        const volumes = slice.map(c => c.volume);

        // Atualiza estado com dados atuais
        state.price = closes[closes.length - 1];
        state.atr_1H = calculateATR(slice, 14);
        state.atrHistory.push(state.atr_1H);
        if (state.atrHistory.length > 200) state.atrHistory.shift();

        // Calcula ADX
        const adxData = indicadores.calculateADX(slice);
        state.adx = adxData.adx;

        // Divergência RSI
        let rsiValues = [];
        let avgGain = 0, avgLoss = 0;
        if (closes.length > 14) {
            for (let j = 1; j < closes.length; j++) {
                const diff = closes[j] - closes[j - 1];
                const gain = diff > 0 ? diff : 0;
                const loss = diff < 0 ? Math.abs(diff) : 0;
                if (j === 1) { avgGain = gain; avgLoss = loss; } else {
                    avgGain = (avgGain * 13 + gain) / 14;
                    avgLoss = (avgLoss * 13 + loss) / 14;
                }
                const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
                rsiValues.push(rsi);
            }
        }
        state.divergence = indicadores.detectRSIDivergence(slice, rsiValues);

        // VWAP (24h)
        const last24Candles = slice.slice(-24);
        state.vwap = indicadores.calculateVWAP(last24Candles);

        // MTF Confluence HISTÓRICO
        state.mtfConfluence = getMTFAlignmentAtTime(candles1H, candles4H, candle.time);

        // Swing Points (para BOS/retest)
        indicadores.updateSwingPoints(state);

        // Macro blackout (simulação com dados históricos? usar função)
        // Para histórico, assumimos que não há blackout (ou podemos ignorar)
        state.macroBlackout = false;

        // On-chain e funding não estão disponíveis historicamente via API, mas podemos buscar valores fixos ou médios
        // Para simplificar, usamos fundingRate = 0 e mvrv = 1 (neutro)
        // Mas podemos buscar funding médio ou usar o último valor conhecido
        if (i === 50) {
            try {
                const funding = await fetchFundingRate(symbol);
                state.fundingRate = funding?.rate || 0;
                const oi = await fetchOIDelta(symbol);
                state.oiDelta = oi?.delta || 0;
                const mvrv = await fetchMVRV();
                state.mvrv = mvrv;
                const fg = await fetchFearGreed();
                state.fearGreedData = fg;
            } catch (e) {
                // fallback
            }
        }

        // --- 5.1 Calcular Score (usando computeScore + calculateConfidenceScore) ---
        const assetsData = {};
        // Criar um objeto assetsData com apenas este símbolo para computeScore
        assetsData[symbol] = state;
        const liqMap = { [symbol]: { longs: 0, shorts: 0 } };

        const scoreData = indicadores.computeScore(symbol, assetsData, liqMap);
        const mtfAligned = params.requireMTF ? (state.mtfConfluence?.alinhado || false) : true;

        const confidence = indicadores.calculateConfidenceScore({
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

        // --- 5.2 Aplicar filtros ---
        const primaryDirection = (score >= params.scoreMin) ? 'LONG' : (score <= params.scoreMaxShort ? 'SHORT' : null);

        if (primaryDirection === 'LONG' && state.price < state.vwap && !blockReason) {
            blockReason = 'Preço abaixo do VWAP';
        } else if (primaryDirection === 'SHORT' && state.price > state.vwap && !blockReason) {
            blockReason = 'Preço acima do VWAP';
        }

        // ADX
        if (state.adx < params.adxMin && !blockReason) {
            blockReason = `ADX < ${params.adxMin} (lateral)`;
        }

        // MTF alinhado (se exigido)
        if (params.requireMTF) {
            if (primaryDirection === 'LONG' && state.htfStructure.bias === 'BEARISH' && !blockReason) {
                blockReason = 'HTF 4H Bearish';
            }
            if (primaryDirection === 'SHORT' && state.htfStructure.bias === 'BULLISH' && !blockReason) {
                blockReason = 'HTF 4H Bullish';
            }
        }

        // Derivativos (funding e OI)
        if (!blockReason) {
            const derivCheck = indicadores.checkDerivativesFilter(state.fundingRate, state.oiDelta);
            if (!derivCheck.allow) blockReason = derivCheck.reason;
        }

        // BOS e Retest (usando a mesma função do robô)
        const structure = checkBOSAndRetest(state, primaryDirection, params.retestDistPct);
        const smcSetup = structure.bos;
        let retestConfirmed = structure.retest;

        // Fallback EMA20 (se habilitado)
        if (!retestConfirmed && params.requireEMARetest) {
            const ema20 = calcEMA(closes, 20).slice(-1)[0] || state.price;
            const emaDist = Math.abs(state.price - ema20) / ema20;
            retestConfirmed = emaDist < 0.005;
        }

        const bosRequired = params.requireBOS;
        const retestRequired = params.requireRetest;
        const bosPassed = bosRequired ? smcSetup : true;
        const retestPassed = retestRequired ? retestConfirmed : true;
        const structureOk = bosPassed && retestPassed;

        if (!structureOk && !blockReason) {
            blockReason = bosRequired ? 'Sem BOS' : (retestRequired ? 'Sem retest' : 'Estrutura não OK');
        }

        // ---- Registrar blockStats (para diagnóstico) ----
        const reasonKey = blockReason || (primaryDirection !== null ? 'passou_filtros' : 'score_neutro');
        blockStats[reasonKey] = (blockStats[reasonKey] || 0) + 1;

        // --- 5.3 Lógica de entrada ---
        if (!position && !blockReason && primaryDirection !== null) {
            const entryPrice = state.price;
            const atr = state.atr_1H || (entryPrice * 0.02);
            let stop, tp1, tp2, tp3;

            if (primaryDirection === 'LONG') {
                stop = entryPrice - atr * 1.5;
                tp1 = entryPrice + atr * 2;
                tp2 = entryPrice + atr * 4;
                tp3 = entryPrice + atr * 6;
            } else {
                stop = entryPrice + atr * 1.5;
                tp1 = entryPrice - atr * 2;
                tp2 = entryPrice - atr * 4;
                tp3 = entryPrice - atr * 6;
            }

            const rr1 = primaryDirection === 'LONG' ? (tp1 - entryPrice) / (entryPrice - stop) : (entryPrice - tp1) / (stop - entryPrice);
            if (rr1 < params.rrMin) {
                // Não entra por R:R baixo
                blockReason = `R:R ${rr1.toFixed(2)} < ${params.rrMin}`;
                blockStats[blockReason] = (blockStats[blockReason] || 0) + 1;
                continue;
            }

            // Entra
            position = {
                type: primaryDirection,
                entry: entryPrice,
                stop: stop,
                tp1: tp1,
                tp2: tp2,
                tp3: tp3,
                highSinceEntry: entryPrice,
                lowSinceEntry: entryPrice,
                movedToBE: false,
                trailingStop: stop,
                partialTaken: false,
                sizeRemaining: 1,
                realizedPNL: 0,
                entryTime: candle.time,
            };

            trades.push({
                entryTime: new Date(candle.time).toISOString(),
                symbol: symbol,
                direction: primaryDirection,
                entryPrice: entryPrice,
                stopLoss: stop,
                takeProfit1: tp1,
                exitPrice: null,
                reason: null,
                pnlPct: null,
                durationHours: null,
                exitTime: null,
            });
        }

        // --- 5.4 Lógica de saída ---
        if (position) {
            const currentPrice = state.price;
            const atr = state.atr_1H || (position.entry * 0.02);

            // Atualiza extremos
            if (currentPrice > position.highSinceEntry) position.highSinceEntry = currentPrice;
            if (currentPrice < position.lowSinceEntry) position.lowSinceEntry = currentPrice;

            // Trailing stop adaptativo (baseado em swing points)
            if (position.type === 'LONG') {
                const recentLows = state.swingLows.slice(-3);
                if (recentLows.length > 0) {
                    const lastSwingLow = Math.min(...recentLows);
                    let newTrail = lastSwingLow - (atr * 0.2);
                    if (state.atrHistory.length > 20) {
                        const avgATR = state.atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
                        if (atr > avgATR * 1.5) newTrail -= atr * 0.1;
                        else if (atr < avgATR * 0.7) newTrail += atr * 0.1;
                    }
                    if (newTrail > position.trailingStop) {
                        position.trailingStop = newTrail;
                        position.movedToBE = true;
                    }
                }
            } else { // SHORT
                const recentHighs = state.swingHighs.slice(-3);
                if (recentHighs.length > 0) {
                    const lastSwingHigh = Math.max(...recentHighs);
                    let newTrail = lastSwingHigh + (atr * 0.2);
                    if (state.atrHistory.length > 20) {
                        const avgATR = state.atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
                        if (atr > avgATR * 1.5) newTrail += atr * 0.1;
                        else if (atr < avgATR * 0.7) newTrail -= atr * 0.1;
                    }
                    if (newTrail < position.trailingStop || position.trailingStop === 0) {
                        position.trailingStop = newTrail;
                        position.movedToBE = true;
                    }
                }
            }

            // Verifica TP1 parcial
            if (!position.partialTaken) {
                if (position.type === 'LONG' && currentPrice >= position.tp1) {
                    position.partialTaken = true;
                    position.sizeRemaining = 0.5;
                    position.realizedPNL = (position.tp1 - position.entry) * 0.5;
                    position.trailingStop = position.entry + (atr * 0.1);
                    position.movedToBE = true;
                } else if (position.type === 'SHORT' && currentPrice <= position.tp1) {
                    position.partialTaken = true;
                    position.sizeRemaining = 0.5;
                    position.realizedPNL = (position.entry - position.tp1) * 0.5;
                    position.trailingStop = position.entry - (atr * 0.1);
                    position.movedToBE = true;
                }
            }

            // Verifica stop ou take (TP2 ou TP3)
            let exitPrice = null;
            let exitReason = null;

            if (position.type === 'LONG') {
                if (currentPrice >= position.tp2) {
                    exitPrice = currentPrice;
                    exitReason = 'TP2 (100%)';
                } else if (currentPrice <= position.trailingStop) {
                    exitPrice = currentPrice;
                    exitReason = position.movedToBE ? 'Trailing Stop (BE+)' : 'Stop Loss';
                }
            } else { // SHORT
                if (currentPrice <= position.tp2) {
                    exitPrice = currentPrice;
                    exitReason = 'TP2 (100%)';
                } else if (currentPrice >= position.trailingStop) {
                    exitPrice = currentPrice;
                    exitReason = position.movedToBE ? 'Trailing Stop (BE-)' : 'Stop Loss';
                }
            }

            if (exitPrice !== null) {
                // Calcula P&L
                const pnl = (exitPrice - position.entry) * (position.type === 'LONG' ? 1 : -1) / position.entry * equity;
                equity += pnl;
                const pnlPct = ((exitPrice - position.entry) / position.entry) * (position.type === 'LONG' ? 1 : -1) * 100;

                // Atualiza último trade
                const lastTrade = trades[trades.length - 1];
                if (lastTrade) {
                    lastTrade.exitPrice = exitPrice;
                    lastTrade.reason = exitReason;
                    lastTrade.pnlPct = pnlPct;
                    lastTrade.exitTime = new Date(candle.time).toISOString();
                    const durationMs = candle.time - position.entryTime;
                    lastTrade.durationHours = durationMs / (1000 * 60 * 60);
                }

                // Reseta posição
                position = null;
                equityCurve.push(equity);
            }
        }
    }

    // --- 6. Resultados ---
    const totalTrades = trades.length;
    const winTrades = trades.filter(t => t.pnlPct !== null && t.pnlPct > 0).length;
    const winrate = totalTrades > 0 ? (winTrades / totalTrades * 100) : 0;
    const totalPnlUsd = equity - 10000;
    const totalPnlPct = (totalPnlUsd / 10000) * 100;

    // Drawdown
    let maxDrawdown = 0;
    let peak = equityCurve[0];
    for (let val of equityCurve) {
        if (val > peak) peak = val;
        const dd = (peak - val) / peak * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Profit Factor
    let grossProfit = 0, grossLoss = 0;
    trades.forEach(t => {
        if (t.pnlPct !== null && t.pnlPct > 0) grossProfit += t.pnlPct;
        else if (t.pnlPct !== null && t.pnlPct < 0) grossLoss += Math.abs(t.pnlPct);
    });
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

    // Annualized Return (assumindo que o período são 30 dias)
    const annualizedReturn = (Math.pow(1 + totalPnlPct / 100, 365 / days) - 1) * 100;

    const summary = {
        totalTrades,
        winrate,
        totalPnlUsd,
        totalPnlPct,
        maxDrawdown,
        profitFactor,
        annualizedReturn,
        finalEquity: equity,
        blockStats,
        error: null,
    };

    console.log('[Backtest] Concluído:', summary);

    return { trades, summary };
}
