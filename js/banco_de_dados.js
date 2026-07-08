// js/banco_de_dados.js – Gerenciamento de banco de dados local (localStorage)

const DB_KEYS = {
    ALERTS: 'btc_sniper_alerts',
    SIGNALS: 'btc_sniper_signals',
    TRADES: 'btc_sniper_trades'
};

// ===== TIMESTAMP =====
export function getCurrentTimestamp() {
    const now = new Date();
    return now.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// ===== ALERTAS (TELEGRAM) =====
export function setAlertLog(alertData) {
    try {
        const logs = getAlertLog();
        logs.unshift({ ...alertData, timestamp: getCurrentTimestamp() });
        // Mantém apenas os últimos 100 alertas
        if (logs.length > 100) logs.length = 100;
        localStorage.setItem(DB_KEYS.ALERTS, JSON.stringify(logs));
    } catch (e) {
        console.error('[DB] Erro ao salvar alerta:', e);
    }
}

export function getAlertLog() {
    try {
        const raw = localStorage.getItem(DB_KEYS.ALERTS);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        console.error('[DB] Erro ao ler alertas:', e);
        return [];
    }
}

// ===== HISTÓRICO DE SINAIS =====
export function saveSignal(signalData) {
    try {
        const signals = getSignals();
        signals.unshift({ ...signalData, timestamp: getCurrentTimestamp() });
        // Mantém apenas os últimos 500 sinais
        if (signals.length > 500) signals.length = 500;
        localStorage.setItem(DB_KEYS.SIGNALS, JSON.stringify(signals));
    } catch (e) {
        console.error('[DB] Erro ao salvar sinal:', e);
    }
}

export function getSignals() {
    try {
        const raw = localStorage.getItem(DB_KEYS.SIGNALS);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        console.error('[DB] Erro ao ler sinais:', e);
        return [];
    }
}

export function clearSignals() {
    try {
        localStorage.removeItem(DB_KEYS.SIGNALS);
    } catch (e) {
        console.error('[DB] Erro ao limpar sinais:', e);
    }
}

// ===== TRADES (BACKTEST / LIVE) =====
export function saveTrade(tradeData) {
    try {
        const trades = getTrades();
        trades.unshift({ ...tradeData, timestamp: getCurrentTimestamp() });
        if (trades.length > 1000) trades.length = 1000;
        localStorage.setItem(DB_KEYS.TRADES, JSON.stringify(trades));
    } catch (e) {
        console.error('[DB] Erro ao salvar trade:', e);
    }
}

export function getTrades() {
    try {
        const raw = localStorage.getItem(DB_KEYS.TRADES);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        console.error('[DB] Erro ao ler trades:', e);
        return [];
    }
}

export function clearTrades() {
    try {
        localStorage.removeItem(DB_KEYS.TRADES);
    } catch (e) {
        console.error('[DB] Erro ao limpar trades:', e);
    }
}
