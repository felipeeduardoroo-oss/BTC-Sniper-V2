// historicos_sinais.js
import { getAlertLog, setAlertLog, getTradeStats, setTradeStats } from './banco_de_dados.js';

export function addAlert(symbol, type, score, price) {
    const log = getAlertLog();
    log.push({ ts: Date.now(), symbol, type, score, price });
    setAlertLog(log);
}

export function getAlerts() {
    return getAlertLog();
}

export function addTradeResult(isWin) {
    const stats = getTradeStats();
    if (isWin) stats.wins++;
    else stats.losses++;
    setTradeStats(stats);
}

export function getTradeStatsSummary() {
    return getTradeStats();
}

export function getWinrate() {
    const stats = getTradeStats();
    const total = stats.wins + stats.losses;
    return total > 0 ? (stats.wins / total) * 100 : 0;
}
