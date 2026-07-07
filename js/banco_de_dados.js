// js/banco_de_dados.js
const STORAGE_KEY = 'tradeStats';

// ===== FUNÇÕES DE ESTATÍSTICAS =====
export function getTradeStats() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            return {
                wins: typeof parsed.wins === 'number' ? parsed.wins : 0,
                losses: typeof parsed.losses === 'number' ? parsed.losses : 0
            };
        }
    } catch (e) {
        // ignore
    }
    return { wins: 0, losses: 0 };
}

export function setTradeStats(stats) {
    try {
        const data = {
            wins: typeof stats.wins === 'number' ? stats.wins : 0,
            losses: typeof stats.losses === 'number' ? stats.losses : 0
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        // ignore
    }
}

// ===== FUNÇÕES AUXILIARES (usadas por telegram.js e outros) =====
export function getCurrentTimestamp() {
    return new Date().toLocaleString('pt-BR', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/Sao_Paulo'
    });
}

export function formatCurrency(value) {
    if (value === undefined || value === null || isNaN(value)) return '--';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
