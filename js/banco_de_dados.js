// js/banco_de_dados.js
// Gerencia as estatísticas de trades (winrate, total, etc.) com persistência no localStorage

const STORAGE_KEY = 'tradeStats';

// Estrutura padrão para evitar erros de campos undefined
const DEFAULT_STATS = {
    wins: 0,
    losses: 0,
    totalTrades: 0
};

/**
 * Recupera as estatísticas de trades salvas no localStorage.
 * @returns {Object} { wins: number, losses: number, totalTrades: number }
 */
export function getTradeStats() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            // Garante que todos os campos existam, mesmo se o JSON estiver corrompido
            return {
                wins: typeof parsed.wins === 'number' ? parsed.wins : 0,
                losses: typeof parsed.losses === 'number' ? parsed.losses : 0,
                totalTrades: typeof parsed.totalTrades === 'number' ? parsed.totalTrades : 0
            };
        }
    } catch (e) {
        console.warn('[Banco] Erro ao ler estatísticas:', e);
    }
    // Retorna o padrão se não houver dados ou der erro
    return { ...DEFAULT_STATS };
}

/**
 * Salva as estatísticas de trades no localStorage.
 * Atualiza automaticamente o campo `totalTrades` baseado em wins + losses.
 * @param {Object} stats - { wins: number, losses: number }
 */
export function setTradeStats(stats) {
    try {
        // Garante que wins e losses sejam números
        const wins = typeof stats.wins === 'number' ? stats.wins : 0;
        const losses = typeof stats.losses === 'number' ? stats.losses : 0;
        
        const data = {
            wins: wins,
            losses: losses,
            totalTrades: wins + losses
        };
        
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('[Banco] Erro ao salvar estatísticas:', e);
    }
}

/**
 * Reseta todas as estatísticas para zero.
 * Útil para testes ou reinício da carteira.
 * @returns {Object} Estatísticas resetadas { wins: 0, losses: 0, totalTrades: 0 }
 */
export function resetTradeStats() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('[Banco] Erro ao resetar estatísticas:', e);
    }
    return { ...DEFAULT_STATS };
}
