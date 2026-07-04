// banco_de_dados.js
import { CONFIG } from './config.js';

// ===== Armazenamento genérico =====
export function setData(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch(e) { /* ignore */ }
}

export function getData(key, maxAge = CONFIG.CACHE_TTL_MS) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp < maxAge) return parsed.data;
        return null;
    } catch(e) { return null; }
}

export function removeData(key) {
    localStorage.removeItem(key);
}

// ===== Dados específicos =====
export function getCachedMarketData() {
    return getData('marketData');
}

export function setCachedMarketData(data) {
    setData('marketData', data);
}

// ===== Histórico de sinais (será usado pelo módulo historicos_sinais) =====
export function getAlertLog() {
    return getData('alertLog') || [];
}

export function setAlertLog(log) {
    setData('alertLog', log.slice(-50));
}

export function getTradeStats() {
    return getData('tradeStats') || { wins: 0, losses: 0, totalPNL: 0 };
}

export function setTradeStats(stats) {
    setData('tradeStats', stats);
}

// ===== Timestamp atual =====
export function getCurrentTimestamp() {
    const now = new Date();
    return now.toLocaleString('pt-BR', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'America/Sao_Paulo'
    });
}
