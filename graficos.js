// graficos.js
import { COLORS } from './config.js';

// Chart.js instances
let scoreChart = null;
let etfChart = null;
let macroChart = null;
let scenariosChart = null;
let allocationChart = null;
let whaleChart = null;
let candleCharts = {};

// ===== Inicializar gráficos =====
export function initCharts() {
    // Score History
    const ctxScore = document.getElementById('chart_score_history')?.getContext('2d');
    if (ctxScore) {
        scoreChart = new Chart(ctxScore, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'BTC Score', data: [], borderColor: COLORS.blue, borderWidth: 2, fill: false, tension: 0.4, pointRadius: 0 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { min: 0, max: 100, ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    x: { ticks: { color: COLORS.textMuted, maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.06)' } }
                }
            }
        });
    }

    // ETF Flows
    const ctx1 = document.getElementById('chart_etf_flows')?.getContext('2d');
    if (ctx1) {
        etfChart = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: ['22 JUN', '23 JUN', '24 JUN', '25 JUN', '26 JUN', '27 JUN', '28 JUN'],
                datasets: [
                    { label: 'BTC ETF Flow (ref)', data: [-120, -85, -155, -92, -138, -165, -445], backgroundColor: 'rgba(233,69,96,0.6)', borderColor: 'rgb(233,69,96)', borderWidth: 2 },
                    { label: 'ETH ETF Flow (ref)', data: [-8, -12, -15, -10, -18, -20, -12.85], backgroundColor: 'rgba(0,180,216,0.4)', borderColor: 'rgb(0,180,216)', borderWidth: 2 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: COLORS.textLight } }, title: { display: true, text: 'ETF Flows (referência)', color: COLORS.textLight } },
                scales: {
                    y: { ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    x: { ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } }
                }
            }
        });
    }

    // Macro Rates
    const ctx2 = document.getElementById('chart_macro_rates')?.getContext('2d');
    if (ctx2) {
        macroChart = new Chart(ctx2, {
            type: 'line',
            data: {
                labels: ['17 JUN', '19 JUN', '21 JUN', '23 JUN', '25 JUN', '27 JUN', '28 JUN'],
                datasets: [
                    { label: 'DXY (ref)', data: [100.8, 100.95, 101.15, 101.28, 101.32, 101.35, 101.37], borderColor: 'rgb(233,69,96)', borderWidth: 2, tension: 0.4, yAxisID: 'y' },
                    { label: 'US10Y (ref)', data: [4.32, 4.30, 4.29, 4.28, 4.27, 4.28, 4.28], borderColor: 'rgb(255,214,10)', borderWidth: 2, tension: 0.4, yAxisID: 'y1' }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: COLORS.textLight } }, title: { display: true, text: 'Macro (referência)', color: COLORS.textLight } },
                scales: {
                    y: { position: 'left', ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    y1: { position: 'right', ticks: { color: COLORS.textMuted }, grid: { drawOnChartArea: false } },
                    x: { ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } }
                }
            }
        });
    }

    // Scenarios
    const ctx3 = document.getElementById('chart_scenarios')?.getContext('2d');
    if (ctx3) {
        scenariosChart = new Chart(ctx3, {
            type: 'doughnut',
            data: { labels: ['Bounce Tático', 'Markdown Estendido', 'Reversal Estrutural'], datasets: [{ data: [35, 45, 20], backgroundColor: ['rgba(255,214,10,0.6)', 'rgba(233,69,96,0.6)', 'rgba(0,217,142,0.6)'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: COLORS.textLight } } } }
        });
    }

    // Allocation
    const ctx4 = document.getElementById('chart_allocation')?.getContext('2d');
    if (ctx4) {
        allocationChart = new Chart(ctx4, {
            type: 'pie',
            data: { labels: ['BTC (25%)', 'ETH (10%)', 'Stablecoins (65%)'], datasets: [{ data: [25, 10, 65], backgroundColor: ['rgba(0,180,216,0.6)', 'rgba(255,214,10,0.6)', 'rgba(0,217,142,0.6)'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: COLORS.textLight } } } }
        });
    }

    // Whale Flow
    const ctxW = document.getElementById('chart_whale_flow')?.getContext('2d');
    if (ctxW) {
        whaleChart = new Chart(ctxW, {
            type: 'bar',
            data: {
                labels: ['BTC', 'ETH'],
                datasets: [
                    { label: 'Acumulação (ref)', data: [700, 0], backgroundColor: 'rgba(0,217,142,0.7)', borderColor: 'rgb(0,217,142)', borderWidth: 2 },
                    { label: 'Distribuição (ref)', data: [0, 27.4], backgroundColor: 'rgba(233,69,96,0.7)', borderColor: 'rgb(233,69,96)', borderWidth: 2 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: COLORS.textLight } }, title: { display: true, text: 'Fluxo de Baleias (referência)', color: COLORS.textLight } },
                scales: {
                    y: { ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: 'Volume (USD M)', color: COLORS.textLight } },
                    x: { ticks: { color: COLORS.textMuted }, grid: { color: 'rgba(255,255,255,0.06)' } }
                }
            }
        });
    }

    return { scoreChart, etfChart, macroChart, scenariosChart, allocationChart, whaleChart };
}

// ===== Atualizar Score Chart =====
export function updateScoreChart(history) {
    if (!scoreChart) return;
    const btcHist = history.filter(s => s.symbol === 'BTCUSDT').slice(-50);
    scoreChart.data.labels = btcHist.map(s => s.time);
    scoreChart.data.datasets[0].data = btcHist.map(s => s.score);
    scoreChart.update('none');
}

// ===== Atualizar Cenários =====
export function updateScenarios(score) {
    if (!scenariosChart) return;
    let bounce = 20, markdown = 20, reversal = 20;
    if (score >= 70) { bounce = 50; markdown = 15; reversal = 35; }
    else if (score <= 30) { bounce = 15; markdown = 50; reversal = 35; }
    else { bounce = 30; markdown = 30; reversal = 40; }
    scenariosChart.data.datasets[0].data = [bounce, markdown, reversal];
    scenariosChart.update();
}

// ===== Atualizar Alocação =====
export function updateAllocation(atrPct) {
    if (!allocationChart) return;
    let btcAlloc = 25, ethAlloc = 10, stableAlloc = 65;
    if (atrPct < 1.5) { btcAlloc = 40; ethAlloc = 20; stableAlloc = 40; }
    else if (atrPct > 3.0) { btcAlloc = 15; ethAlloc = 5; stableAlloc = 80; }
    allocationChart.data.datasets[0].data = [btcAlloc, ethAlloc, stableAlloc];
    allocationChart.update();
}

// ===== Lightweight Charts (candles) =====
export function initCandleChart(containerId, color = '#00e896') {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth, height: 220,
        layout: { background: { color: '#0f1117' }, textColor: '#6b7280' },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        priceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addCandlestickSeries({
        upColor: color, downColor: '#ff4d6d', borderDownColor: '#ff4d6d', borderUpColor: color, wickDownColor: '#ff4d6d', wickUpColor: color,
    });
    return { chart, candleSeries };
}

export function updateCandle(chartObj, candle) {
    if (!chartObj) return;
    chartObj.candleSeries.update({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
    });
}

export function setCandleData(chartObj, candles) {
    if (!chartObj) return;
    chartObj.candleSeries.setData(candles);
    chartObj.chart.timeScale().fitContent();
}

export function resizeCandle(chartObj, containerId) {
    if (!chartObj) return;
    const container = document.getElementById(containerId);
    if (container) {
        chartObj.chart.resize(container.clientWidth, 220);
        chartObj.chart.timeScale().fitContent();
    }
}

export function getChart(id) {
    return Chart.getChart(id);
}
