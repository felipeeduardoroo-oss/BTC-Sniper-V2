// ============================================================
// backtest.js – Versão completa com correções e parâmetros UI
// ============================================================

// ----- FUNÇÕES AUXILIARES (independentes) -----

// Média Móvel Exponencial
function calcEMA(data, period) {
    const result = [];
    if (data.length === 0) return result;
    let ema = data[0];
    result.push(ema);
    const multiplier = 2 / (period + 1);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
        result.push(ema);
    }
    return result;
}

// Cálculo do RSI
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    const rsi = 100 - (100 / (1 + avgGain / (avgLoss || 0.001)));
    return rsi;
}

// Cálculo do ADX simplificado (apenas para diagnóstico)
function calculateADX(high, low, close, period = 14) {
    if (high.length < period + 1) return 20;
    let trSum = 0, dmPlusSum = 0, dmMinusSum = 0;
    for (let i = 1; i <= period; i++) {
        const h = high[i], l = low[i], c = close[i-1];
        const tr = Math.max(h - l, Math.abs(h - c), Math.abs(l - c));
        trSum += tr;
        const upMove = h - high[i-1];
        const downMove = low[i-1] - l;
        if (upMove > downMove && upMove > 0) dmPlusSum += upMove;
        else if (downMove > upMove && downMove > 0) dmMinusSum += downMove;
    }
    const atr = trSum / period;
    const diPlus = (dmPlusSum / period) / atr * 100;
    const diMinus = (dmMinusSum / period) / atr * 100;
    const dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
    return Math.min(60, dx); // cap para evitar valores extremos
}

// Busca candles na Binance (pública, gratuita)
async function fetchBinanceKlines(symbol, interval, startTime, endTime) {
    const limit = 500;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        return data.map(c => ({
            time: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
        }));
    } catch (e) {
        console.error('Erro ao buscar dados:', e);
        return [];
    }
}

// ----- MTF CONFLUENCE HISTÓRICO -----
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
        const e20 = ema20[ema20.length - 1];
        const e50 = ema50[ema50.length - 1];
        if (e20 > e50 && last > e20) return 'BULL';
        if (e20 < e50 && last < e20) return 'BEAR';
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

// ----- FUNÇÃO PRINCIPAL DE BACKTEST -----
async function runBacktest() {
    const resultsDiv = document.getElementById('backtest-results');
    resultsDiv.innerHTML = '⏳ Carregando dados...';

    // 1. LER PARÂMETROS DO PAINEL
    const paramScore = parseInt(document.getElementById('param-score').value);
    const paramADX = parseInt(document.getElementById('param-adx').value);
    const paramRetest = parseFloat(document.getElementById('param-retest').value) / 100;
    const paramRR = parseFloat(document.getElementById('param-rr').value);
    const paramEmaRetest = parseFloat(document.getElementById('param-ema').value) / 100;
    const paramMTF = document.getElementById('param-mtf').checked;

    const symbol = 'BTCUSDT';
    const endTime = Date.now();
    const startTime = endTime - 30 * 24 * 60 * 60 * 1000;

    // 2. BUSCAR DADOS HISTÓRICOS
    try {
        var candles15m = await fetchBinanceKlines(symbol, '15m', startTime, endTime);
        var candles1H  = await fetchBinanceKlines(symbol, '1h', startTime, endTime);
        var candles4H  = await fetchBinanceKlines(symbol, '4h', startTime, endTime);
    } catch (e) {
        resultsDiv.innerHTML = '❌ Erro ao buscar dados da Binance.';
        return;
    }

    if (candles15m.length < 100) {
        resultsDiv.innerHTML = '❌ Dados insuficientes (menos de 100 candles).';
        return;
    }

    // 3. VARIÁVEIS DE ESTADO
    let equity = 10000;
    let position = null;
    const trades = [];
    const equityCurve = [equity];
    const blockStats = {};

    // 4. LOOP PRINCIPAL (itera sobre cada candle de 15m)
    for (let i = 50; i < candles15m.length; i++) {
        const candle = candles15m[i];
        const slice = candles15m.slice(0, i + 1);
        const closes = slice.map(c => c.close);
        const highs = slice.map(c => c.high);
        const lows = slice.map(c => c.low);
        const volumes = slice.map(c => c.volume);

        const currentPrice = closes[closes.length - 1];

        // Indicadores
        const adx = calculateADX(highs, lows, closes, 14);
        const rsi = calculateRSI(closes, 14);
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        const ema20Last = ema20.length > 0 ? ema20[ema20.length - 1] : currentPrice;
        const ema50Last = ema50.length > 0 ? ema50[ema50.length - 1] : currentPrice;

        // MTF Confluence HISTÓRICO
        const mtf = getMTFAlignmentAtTime(candles1H, candles4H, candle.time);

        // Score de confiança (exemplo – adapte à sua lógica)
        let score = 0;
        if (adx > paramADX) score += 25;
        if (rsi > 55 && rsi < 75) score += 20;
        if (mtf.alinhado) score += 30;
        if (currentPrice > ema20Last) score += 15;
        if (currentPrice > ema50Last) score += 10;
        // Cap
        score = Math.min(100, score);

        // Se MTF obrigatório e não alinhado, reduz score
        if (paramMTF && !mtf.alinhado && score > 40) {
            score = 40;
        }

        // Direção primária baseada no score
        let primaryDirection = 'NEUTRO';
        if (score >= paramScore) {
            primaryDirection = score > 55 ? 'COMPRA' : 'VENDA';
        }

        // ----- FILTROS -----
        let blockReason = null;

        // ADX
        if (adx < paramADX) blockReason = 'ADX_baixo';

        // Retest de nível estrutural (exemplo: suporte/resistência recente)
        const periodLookback = 20;
        const recentHigh = Math.max(...highs.slice(-periodLookback));
        const recentLow = Math.min(...lows.slice(-periodLookback));
        const retestOk = (currentPrice >= recentLow && currentPrice <= recentLow * (1 + paramRetest)) ||
                         (currentPrice <= recentHigh && currentPrice >= recentHigh * (1 - paramRetest));

        // Retest da EMA20
        const emaRetestOk = Math.abs(currentPrice - ema20Last) / ema20Last <= paramEmaRetest;

        // R:R (exemplo fixo: stop 2%, take 4%)
        const stopPct = 0.02;
        const takePct = 0.04;
        const stopLoss = currentPrice * (1 - stopPct);
        const takeProfit = currentPrice * (1 + takePct);
        const rr = (takeProfit - currentPrice) / (currentPrice - stopLoss);
        const rrOk = rr >= paramRR;

        // SMC Setup (BOS confirmado) – simulação: verifica se houve quebra de estrutura
        const prevCandle = candles15m[i-1];
        const bosOk = (currentPrice > prevCandle.high) || (currentPrice < prevCandle.low);

        // Aplicar bloqueios
        if (!blockReason && primaryDirection === 'NEUTRO') blockReason = 'score_neutro';
        if (!blockReason && !retestOk) blockReason = 'sem_retest';
        if (!blockReason && !emaRetestOk) blockReason = 'sem_ema_retest';
        if (!blockReason && !rrOk) blockReason = 'rr_baixo';
        if (!blockReason && !bosOk) blockReason = 'sem_BOS';

        // Registrar estatística de bloqueio
        const reasonKey = blockReason || (primaryDirection !== 'NEUTRO' ? 'passou_filtros' : 'score_neutro');
        blockStats[reasonKey] = (blockStats[reasonKey] || 0) + 1;

        // ----- LÓGICA DE ENTRADA -----
        if (!position && !blockReason && primaryDirection !== 'NEUTRO') {
            const direction = primaryDirection;
            const entryPrice = currentPrice;
            const stop = entryPrice * (1 - (direction === 'COMPRA' ? stopPct : -stopPct));
            const take = entryPrice * (1 + (direction === 'COMPRA' ? takePct : -takePct));
            position = {
                entry: entryPrice,
                direction: direction,
                stopLoss: stop,
                takeProfit: take,
                highSinceEntry: entryPrice,
                lowSinceEntry: entryPrice,
                entryTime: candle.time
            };
        }

        // ----- LÓGICA DE SAÍDA -----
        if (position) {
            if (currentPrice > position.highSinceEntry) position.highSinceEntry = currentPrice;
            if (currentPrice < position.lowSinceEntry) position.lowSinceEntry = currentPrice;

            let exitPrice = null;
            let exitReason = '';
            if (position.direction === 'COMPRA') {
                if (currentPrice <= position.stopLoss) { exitPrice = currentPrice; exitReason = 'STOP'; }
                else if (currentPrice >= position.takeProfit) { exitPrice = currentPrice; exitReason = 'TAKE'; }
            } else {
                if (currentPrice >= position.stopLoss) { exitPrice = currentPrice; exitReason = 'STOP'; }
                else if (currentPrice <= position.takeProfit) { exitPrice = currentPrice; exitReason = 'TAKE'; }
            }

            if (exitPrice !== null) {
                const pnl = (exitPrice - position.entry) * (position.direction === 'COMPRA' ? 1 : -1) / position.entry * equity;
                equity += pnl;
                trades.push({
                    entry: position.entry,
                    exit: exitPrice,
                    direction: position.direction,
                    pnl: pnl,
                    exitReason: exitReason,
                    entryTime: position.entryTime,
                    exitTime: candle.time
                });
                position = null;
                equityCurve.push(equity);
            }
        }
    }

    // 5. ESTATÍSTICAS FINAIS
    const totalTrades = trades.length;
    const winTrades = trades.filter(t => t.pnl > 0).length;
    const winrate = totalTrades > 0 ? (winTrades / totalTrades * 100) : 0;
    const totalPnL = equity - 10000;
    const totalPnLPercent = (totalPnL / 10000 * 100);

    // Drawdown máximo (simplificado)
    let maxDrawdown = 0;
    let peak = equityCurve[0];
    for (const val of equityCurve) {
        if (val > peak) peak = val;
        const dd = (peak - val) / peak * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // 6. EXIBIR RESULTADOS
    resultsDiv.innerHTML = `
        <h3>📊 Resultado do Backtest (30 dias)</h3>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:10px 0;">
            <div class="metric"><span class="label">Trades</span><div class="value">${totalTrades}</div></div>
            <div class="metric"><span class="label">Winrate</span><div class="value">${winrate.toFixed(2)}%</div></div>
            <div class="metric"><span class="label">PnL Total</span><div class="value" style="color:${totalPnL>=0?'#0ecb81':'#f6465d'}">${totalPnL.toFixed(2)} USDT</div></div>
            <div class="metric"><span class="label">Retorno %</span><div class="value" style="color:${totalPnLPercent>=0?'#0ecb81':'#f6465d'}">${totalPnLPercent.toFixed(2)}%</div></div>
            <div class="metric"><span class="label">Drawdown Máx.</span><div class="value">${maxDrawdown.toFixed(2)}%</div></div>
        </div>
        <details>
            <summary>🔍 Diagnóstico de Filtros (blockStats)</summary>
            <pre>${JSON.stringify(blockStats, null, 2)}</pre>
        </details>
        <details>
            <summary>📋 Lista de Trades</summary>
            <pre>${JSON.stringify(trades, null, 2)}</pre>
        </details>
        <p style="color:#888;font-size:12px;margin-top:10px;">
            Parâmetros usados: Score≥${paramScore}, ADX≥${paramADX}, Retest≤${(paramRetest*100).toFixed(1)}%, R:R≥${paramRR}, EMA Retest≤${(paramEmaRetest*100).toFixed(1)}%, MTF Obrigatório=${paramMTF?'Sim':'Não'}
        </p>
    `;

    console.log('Backtest concluído:', { totalTrades, winrate, totalPnL, blockStats });
}

// (Opcional) Exportar para uso externo
if (typeof module !== 'undefined') module.exports = { runBacktest };
