// ============================================================
// bot_server.js – Robô de sinais 24/7 (Node.js)
// ============================================================

// ===== CONFIGURAÇÃO =====
const CONFIG = {
    TELEGRAM_TOKEN: '8670184440:AAFBfhFFTMnUWsgIFyRh0huBYbL-Q_vhT5k',
    TELEGRAM_CHAT_ID: '1137196768',
    ASSETS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    SIGNAL_COOLDOWN_MS: 300000,
    JSONBIN_MASTER_KEY: '$2a$10$mbH27dVmnT4JyX.5MAbxM.KknNujEyPzfTW1Z2LnkK7Ga6rXqUE4C',
    JSONBIN_BIN_ID: '6a4c4be6da38895dfe3841c9'
};

// ===== IMPORTS (Node.js 18+ tem fetch nativo) =====
import { writeFileSync, readFileSync, existsSync } from 'fs';

// ============================================================
// FUNÇÕES DO INDICADOR (copiadas do backtest_engine.js)
// ============================================================
const calcEMA = (data, period) => {
    if (!data || data.length === 0) return [];
    const result = [];
    const mult = 2 / (period + 1);
    let ema = data[0];
    result.push(ema);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * mult + ema;
        result.push(ema);
    }
    return result;
};

const calculateATR = (candles, period = 14, lookback = 100) => {
    const data = candles.slice(-Math.max(lookback, period + 1));
    if (data.length < period + 1) return 0;
    const tr = [];
    for (let i = 1; i < data.length; i++) {
        const high = data[i].high;
        const low = data[i].low;
        const prevClose = data[i - 1].close;
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
};

const calculateADX = (candles, period = 14, lookback = 50) => {
    const data = candles.slice(-Math.max(lookback, period * 2 + 1));
    if (data.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    const high = data.map(c => c.high);
    const low = data.map(c => c.low);
    const close = data.map(c => c.close);
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < data.length; i++) {
        const h = high[i], l = low[i], pc = close[i - 1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - high[i - 1];
        const down = low[i - 1] - l;
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let plus = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
    let minus = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
    const dxArr = [];
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        plus = (plus * (period - 1) + plusDM[i]) / period;
        minus = (minus * (period - 1) + minusDM[i]) / period;
        const plusDI = atr > 0 ? (plus / atr) * 100 : 0;
        const minusDI = atr > 0 ? (minus / atr) * 100 : 0;
        const sum = plusDI + minusDI;
        const dx = sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0;
        dxArr.push(dx);
    }
    let adx = 0;
    if (dxArr.length >= period) {
        const start = dxArr.length - period;
        let sum = 0;
        for (let i = start; i < dxArr.length; i++) sum += dxArr[i];
        adx = sum / period;
    } else if (dxArr.length > 0) adx = dxArr.reduce((a, b) => a + b, 0) / dxArr.length;
    const finalPlusDI = atr > 0 ? (plus / atr) * 100 : 0;
    const finalMinusDI = atr > 0 ? (minus / atr) * 100 : 0;
    return { adx, plusDI: finalPlusDI, minusDI: finalMinusDI };
};

const detectVolumeAnomaly = (candles, period = 20, threshold = 1.5) => {
    if (candles.length < period) return null;
    const volumes = candles.map(c => c.volume);
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const last = volumes[volumes.length - 1];
    const ratio = avg > 0 ? last / avg : 1;
    if (ratio > threshold) return { type: 'HIGH', ratio };
    if (ratio < 1 / threshold) return { type: 'LOW', ratio };
    return null;
};

const checkDerivativesFilter = (fundingRate, oiDelta) => {
    if (fundingRate > 0.0020) return { allow: false, reason: 'Funding extremamente positivo (>0.2%)' };
    if (fundingRate < -0.0020) return { allow: false, reason: 'Funding extremamente negativo (<-0.2%)' };
    if (Math.abs(oiDelta) > 20) return { allow: false, reason: 'OI Delta extremo (>20%)' };
    return { allow: true, reason: 'OK' };
};

const computeScore = (symbol, data, adxThreshold) => {
    if (!data) return { score: 50, direction: 'NEUTRAL', blockReason: 'Sem dados' };
    const base = 50;
    const mtfScore = data.mtfConfluence?.score || 0;
    const adxValue = typeof data.adx === 'object' ? (data.adx?.adx || 0) : (data.adx || 0);
    const rsi = data.rsi || 50;
    let score = base;
    if (mtfScore > 0) score += 15;
    else if (mtfScore < 0) score -= 15;
    if (adxValue > adxThreshold) {
        score += (mtfScore > 0 ? 10 : (mtfScore < 0 ? -10 : 0));
    }
    if (rsi > 75) score -= 15;
    if (rsi < 25) score += 15;
    let clamped = Math.max(0, Math.min(100, score));
    if (adxValue < adxThreshold) {
        clamped = Math.max(40, Math.min(60, clamped));
    }
    return {
        score: clamped,
        direction: clamped >= 60 ? 'LONG' : clamped <= 40 ? 'SHORT' : 'NEUTRAL',
        blockReason: adxValue < adxThreshold ? 'ADX baixo' : null
    };
};

// ============================================================
// FETCH FUNCTIONS (Node.js)
// ============================================================
const fetchWithRetry = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
};

const fetchHistoricalCandles = async (symbol, interval, limit = 200) => {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = await fetchWithRetry(url, 3);
        if (data && data.length > 0) {
            return data.map(k => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
        return [];
    } catch (e) { return []; }
};

const fetchHistoricalFunding = async (symbol) => {
    try {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
        const data = await fetchWithRetry(url, 3);
        if (data && data.length) return parseFloat(data[0].fundingRate);
        return 0;
    } catch { return 0; }
};

const fetchOpenInterest = async (symbol) => {
    try {
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`;
        const data = await fetchWithRetry(url, 3);
        if (data && data.length >= 2) {
            const prev = parseFloat(data[0].sumOpenInterest);
            const curr = parseFloat(data[1].sumOpenInterest);
            return { oi: curr, delta: prev > 0 ? ((curr - prev) / prev) * 100 : 0 };
        }
        return null;
    } catch { return null; }
};

const fetchMVRV = async () => {
    try {
        const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&page_size=1';
        const data = await fetchWithRetry(url, 3);
        const val = data?.data?.[0]?.CapMVRVCur;
        return val !== undefined && val !== null ? parseFloat(val) : null;
    } catch { return null; }
};

// ============================================================
// ARMAZENAMENTO LOCAL E JSONBin
// ============================================================
const SIGNALS_FILE = './signals.json';

function loadLocalSignals() {
    if (existsSync(SIGNALS_FILE)) {
        try {
            return JSON.parse(readFileSync(SIGNALS_FILE, 'utf8'));
        } catch { return []; }
    }
    return [];
}

function saveLocalSignals(signals) {
    try {
        writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(-100), null, 2));
    } catch (e) { /* ignore */ }
}

async function storeSignalToCloud(signalData) {
    try {
        const url = `https://api.jsonbin.io/v3/b/${CONFIG.JSONBIN_BIN_ID}`;
        const getResp = await fetch(url, {
            headers: { 'X-Master-Key': CONFIG.JSONBIN_MASTER_KEY }
        });
        if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
        const current = await getResp.json();
        let signals = current?.record?.signals || [];
        signals.push(signalData);
        if (signals.length > 100) signals = signals.slice(-100);
        const putResp = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': CONFIG.JSONBIN_MASTER_KEY
            },
            body: JSON.stringify({ signals })
        });
        if (!putResp.ok) throw new Error(`HTTP ${putResp.status}`);
        return true;
    } catch (e) {
        console.warn('❌ Falha ao armazenar no JSONBin:', e.message);
        return false;
    }
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        return resp.ok;
    } catch { return false; }
}

// ============================================================
// LÓGICA DE SINAL (versão servidor)
// ============================================================
const SCORE_MIN = 68;
const SCORE_MAX_SHORT = 32;
const ADX_MIN = 22;
const RR_MIN = 1.8;
const RETEST_DIST = 2.0;
const MAX_HOLD_HOURS = 72;
const STOP_LONG = 1.5;
const STOP_SHORT = 2.0;
const TP1_LONG = 2.0;
const TP1_SHORT = 1.5;
const TP2_DIST = 4.0;
const MVRV_DROP_PERCENT = 0.15;

async function checkSignal(symbol) {
    try {
        const now = Date.now();
        const startTime1h = now - 200 * 60 * 60 * 1000;
        const startTime4h = now - 200 * 4 * 60 * 60 * 1000;

        const [candles1h, candles4h, fundingRate, oiData, mvrv] = await Promise.all([
            fetchHistoricalCandles(symbol, '1h', 200),
            fetchHistoricalCandles(symbol, '4h', 200),
            fetchHistoricalFunding(symbol),
            fetchOpenInterest(symbol),
            fetchMVRV()
        ]);

        if (candles1h.length < 50) return null;

        const lastCandle = candles1h[candles1h.length - 1];
        const price = lastCandle.close;

        // Indicadores básicos
        const closes = candles1h.map(c => c.close);
        const ema50 = calcEMA(closes, 50).slice(-1)[0] || price;
        const atr = calculateATR(candles1h, 14);
        const adxData = calculateADX(candles1h);
        const adx = adxData.adx;

        // RSI
        let avgGain = 0, avgLoss = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) avgGain += diff;
            else avgLoss += Math.abs(diff);
        }
        avgGain /= 14;
        avgLoss /= 14;
        const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

        // VWAP (últimas 24h)
        const vwap = (() => {
            const last24 = candles1h.slice(-24);
            let sum = 0, vol = 0;
            for (const c of last24) {
                const typical = (c.high + c.low + c.close) / 3;
                sum += typical * c.volume;
                vol += c.volume;
            }
            return vol > 0 ? sum / vol : 0;
        })();

        // MTF Confluence (simplificado)
        const getMTF = (candles4h) => {
            if (candles4h.length < 20) return { score: 0, alinhado: false };
            const closes4 = candles4h.map(c => c.close);
            const ema20_4 = calcEMA(closes4, 20).slice(-1)[0] || closes4[closes4.length - 1];
            const ema50_4 = calcEMA(closes4, 50).slice(-1)[0] || closes4[closes4.length - 1];
            const last4 = closes4[closes4.length - 1];
            const isBull = ema20_4 > ema50_4 && last4 > ema20_4;
            const isBear = ema20_4 < ema50_4 && last4 < ema20_4;
            return { score: isBull ? 1 : (isBear ? -1 : 0), alinhado: isBull || isBear };
        };
        const mtf = getMTF(candles4h);

        // Score
        const scoreData = computeScore(symbol, { adx, rsi, mtfConfluence: mtf, oiDelta: oiData?.delta || 0 }, ADX_MIN);
        let score = scoreData.score;
        let direction = scoreData.direction;
        let blockReason = scoreData.blockReason;

        // Filtros direcionais
        if (direction === 'LONG' && score < SCORE_MIN) blockReason = `Score ${score} < ${SCORE_MIN}`;
        else if (direction === 'SHORT' && score > SCORE_MAX_SHORT) blockReason = `Score ${score} > ${SCORE_MAX_SHORT}`;

        // MVRV
        if (direction === 'SHORT' && mvrv !== null) {
            // Simula pico de 90 dias (usamos dados disponíveis)
            const mvrvDrop = mvrv > 2.5 ? (mvrv - 2.0) / mvrv : 0;
            if (mvrvDrop > MVRV_DROP_PERCENT) {
                blockReason = `MVRV caiu ${(mvrvDrop*100).toFixed(1)}% do pico`;
            }
        }

        // VWAP
        if (direction === 'LONG' && price < vwap) blockReason = 'Preço abaixo do VWAP';
        else if (direction === 'SHORT' && price > vwap) blockReason = 'Preço acima do VWAP';

        // Derivativos
        if (!blockReason) {
            const derivCheck = checkDerivativesFilter(fundingRate, oiData?.delta || 0);
            if (!derivCheck.allow) blockReason = derivCheck.reason;
        }

        // SMC (simplificado: BOS + Retest)
        if (!blockReason) {
            // Swing points simplificados
            const highs = candles1h.map(c => c.high);
            const lows = candles1h.map(c => c.low);
            const lastHigh = highs.slice(-5, -1).reduce((a, b) => Math.max(a, b), 0);
            const lastLow = lows.slice(-5, -1).reduce((a, b) => Math.min(a, b), Infinity);
            const isBreakHigh = price > lastHigh && lastHigh > 0;
            const isBreakLow = price < lastLow && lastLow < Infinity;

            const smcSetup = direction === 'LONG' ? isBreakHigh : (direction === 'SHORT' ? isBreakLow : false);
            const retestDist = atr > 0 ? (direction === 'LONG' ? (price - lastHigh) / atr : (lastLow - price) / atr) : 0;
            const retestConfirmed = retestDist < RETEST_DIST && retestDist > 0;

            if (!smcSetup) blockReason = 'Sem BOS';
            else if (!retestConfirmed) blockReason = 'Sem retest';
        }

        if (blockReason) {
            console.log(`[${symbol}] Bloqueado: ${blockReason}`);
            return null;
        }

        // R:R e parâmetros
        const volatilityAtr = atr * 1.5;
        let stop, tp1, tp2;
        if (direction === 'LONG') {
            stop = price - atr * STOP_LONG;
            tp1 = price + volatilityAtr * TP1_LONG;
            tp2 = price + volatilityAtr * TP2_DIST;
        } else {
            stop = price + atr * STOP_SHORT;
            tp1 = price - volatilityAtr * TP1_SHORT;
            tp2 = price - volatilityAtr * TP2_DIST;
        }

        const rr = direction === 'LONG' ? (tp1 - price) / (price - stop) : (price - tp1) / (stop - price);
        if (rr < RR_MIN) return null;

        return {
            direction,
            entryPrice: price,
            stop,
            tp1,
            tp2,
            rr,
            score,
            rationale: 'BOS + Retest (Servidor)'
        };

    } catch (e) {
        console.error(`Erro ao verificar ${symbol}:`, e.message);
        return null;
    }
}

// ============================================================
// LOOP PRINCIPAL
// ============================================================
let lastSignalTime = {};

async function runCycle() {
    console.log(`[${new Date().toISOString()}] 🔍 Verificando sinais...`);
    for (const symbol of CONFIG.ASSETS) {
        const now = Date.now();
        if (now - (lastSignalTime[symbol] || 0) < CONFIG.SIGNAL_COOLDOWN_MS) continue;

        const signal = await checkSignal(symbol);
        if (signal) {
            console.log(`✅ Sinal ${signal.direction} em ${symbol} (Score: ${signal.score})`);

            // Prepara dados para armazenamento
            const signalData = {
                symbol,
                direction: signal.direction,
                entryPrice: signal.entryPrice,
                stop: signal.stop,
                tp1: signal.tp1,
                tp2: signal.tp2,
                rr: signal.rr,
                score: signal.score,
                rationale: signal.rationale,
                timestamp: Date.now(),
                source: 'bot_server'
            };

            // Armazena localmente
            const localSignals = loadLocalSignals();
            localSignals.push(signalData);
            saveLocalSignals(localSignals);

            // Armazena no JSONBin (nuvem)
            await storeSignalToCloud(signalData);

            // Envia Telegram
            const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
            let msg = `${emoji} <b>SINAL ${signal.direction} - ${symbol}</b>\n`;
            msg += `Score: ${signal.score}/100\n`;
            msg += `Preço: $${signal.entryPrice.toFixed(2)}\n`;
            msg += `Stop: $${signal.stop.toFixed(2)}\n`;
            const rr1 = signal.direction === 'LONG' ? (signal.tp1 - signal.entryPrice) / (signal.entryPrice - signal.stop) : (signal.entryPrice - signal.tp1) / (signal.stop - signal.entryPrice);
            const rr2 = signal.direction === 'LONG' ? (signal.tp2 - signal.entryPrice) / (signal.entryPrice - signal.stop) : (signal.entryPrice - signal.tp2) / (signal.stop - signal.entryPrice);
            msg += `Alvos:\n  TP1: $${signal.tp1.toFixed(2)} (R:R ${rr1.toFixed(1)})\n  TP2: $${signal.tp2.toFixed(2)} (R:R ${rr2.toFixed(1)})\n`;
            msg += `Estrutura: ${signal.rationale}\n⏰ ${new Date().toLocaleString('pt-BR')}`;
            await sendTelegramAlert(msg);

            lastSignalTime[symbol] = now;
        }
    }
    console.log(`[${new Date().toISOString()}] ⏳ Próxima verificação em 15 minutos.`);
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
console.log('🚀 Robô de Sinais 24/7 iniciado...');
runCycle(); // executa imediatamente
setInterval(runCycle, 15 * 60 * 1000); // a cada 15 min

// Tratamento de erros para manter o processo vivo
process.on('uncaughtException', (err) => {
    console.error('❌ Erro não tratado:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('❌ Rejeição não tratada:', err);
});
