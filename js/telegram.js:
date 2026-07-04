// telegram.js
import { CONFIG } from './config.js';
import { getCurrentTimestamp } from './banco_de_dados.js';

let telegramStatus = 'online';

export async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        telegramStatus = resp.ok ? 'online' : 'offline';
        updateTelegramUI();
        return resp.ok;
    } catch (e) {
        telegramStatus = 'offline';
        updateTelegramUI();
        return false;
    }
}

export async function sendTradeAlert(symbol, signalType, score, price, stop, targets, rationale, riskPct, blockReason) {
    const dir = signalType.toUpperCase();
    const emoji = signalType === 'long' ? '🟢' : '🔴';
    let msg = `${emoji} <b>SINAL ${dir} - ${symbol}</b>\n`;
    msg += `Score: ${score}/100 | Risco Alocado: ${riskPct.toFixed(1)}%\n`;
    if (blockReason) msg += `⚠️ Filtro(s) bloqueado(s): ${blockReason}\n`;
    msg += `Preço: $${price.toFixed(2)}\nStop: $${stop.toFixed(2)}\n`;
    msg += `Alvos:\n  TP1: $${targets[0].price.toFixed(2)} (R:R ${targets[0].rr.toFixed(1)})\n  TP2: $${targets[1].price.toFixed(2)} (R:R ${targets[1].rr.toFixed(1)})\n`;
    msg += `Estrutura: ${rationale}\n⏰ ${getCurrentTimestamp()}`;
    return sendTelegramAlert(msg);
}

export function getTelegramStatus() { return telegramStatus; }

function updateTelegramUI() {
    const dot = document.getElementById('telegram-status-dot');
    const badge = document.getElementById('telegram-badge');
    const statusText = document.getElementById('telegram-status-text');
    if (dot) dot.className = 'telegram-status ' + (telegramStatus === 'online' ? 'online' : 'offline');
    if (badge) badge.className = 'telegram-badge ' + (telegramStatus === 'online' ? '' : 'error');
    if (statusText) statusText.textContent = telegramStatus === 'online' ? '🟢 Conectado' : '🔴 Desconectado';
}
