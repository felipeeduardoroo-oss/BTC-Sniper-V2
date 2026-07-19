// js/backtest.js – Adaptador para o motor unificado v3.5.2
// ============================================================
// Importa o motor SMC+MTF v3.5.2 e funções de busca de dados
// ============================================================

import { CONFIG } from './config.js';
import { runBacktestEngine } from './smc_engine.js';
import {
    fetchHistoricalCandles,
    fetchHistoricalFunding,
    fetchHistoricalOI,
    fetchHistoricalMVRV
} from './dados_externos.js';

/**
 * Função principal de backtest – interface compatível com o site.
 * @param {string} symbol - Símbolo do ativo (ex: 'BTCUSDT')
 * @param {number} days - Número de dias para o backtest (máx 1000)
 * @param {object} options - Parâmetros do backtest (mesmos do v3.5.2)
 * @returns {Promise<{trades: Array, summary: object}>}
 */
export async function runBacktest(symbol = 'BTCUSDT', days = 30, options = {}) {
    // ===== 1. Configurar período =====
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;
    const startDateStr = new Date(startTime).toISOString().slice(0, 10);
    const endDateStr = new Date(endTime).toISOString().slice(0, 10);

    // ===== 2. Tenta buscar dados históricos =====
    let cachedData = {
        candles1h: [],
        candles4h: [],
        funding: [],
        oi: [],
        mvrv: []
    };

    try {
        console.log(`[Backtest] Buscando dados para ${symbol} (${days} dias)...`);
        const [c1h, c4h, funding, oi, mvrv] = await Promise.all([
            fetchHistoricalCandles(symbol, '1h', Math.min(800, days * 24 + 50)),
            fetchHistoricalCandles(symbol, '4h', Math.min(200, days * 6 + 50)),
            fetchHistoricalFunding(symbol, startTime, endTime),
            fetchHistoricalOI(symbol, startTime, endTime),
            fetchHistoricalMVRV(startDateStr, endDateStr)
        ]);
        cachedData.candles1h = c1h;
        cachedData.candles4h = c4h;
        cachedData.funding = funding;
        cachedData.oi = oi;
        cachedData.mvrv = mvrv;
        console.log(`[Backtest] Dados obtidos: 1h=${c1h.length}, 4h=${c4h.length}, funding=${funding.length}, OI=${oi.length}, MVRV=${mvrv.length}`);
    } catch (err) {
        console.warn('[Backtest] Erro ao buscar dados, usando dados vazios:', err.message);
        // Se não houver dados, o motor retornará erro por dados insuficientes.
    }

    // ===== 3. Executa o motor unificado =====
    const result = await runBacktestEngine(symbol, days, options, cachedData);
    return result;
}
