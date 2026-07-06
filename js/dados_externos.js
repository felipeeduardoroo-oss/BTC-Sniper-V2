// ============================================================
// NOVAS FUNÇÕES PARA OS INDICADORES SOLICITADOS
// ============================================================

/**
 * 1. SOPR e aSOPR (via bitcoin-data.com)
 *    O endpoint /api/v1/sopr retorna SOPR e aSOPR no mesmo objeto.
 *    Para aSOPR 7D, calculamos a média móvel simples localmente.
 */
export const fetchSOPR = async () => {
  const cacheKey = 'sopr_data';
  const cached = getCachedData(cacheKey, 300000); // 5 minutos
  if (cached && !cached.stale) return cached;

  try {
    const url = 'https://bitcoin-data.com/api/v1/sopr';
    const data = await fetchWithRetry(url, {}, 2);
    if (data?.data?.sopr !== undefined) {
      const sopr = parseFloat(data.data.sopr);
      const asopr = parseFloat(data.data.asopr); // aSOPR (ajustado)
      const result = { sopr, asopr };
      setCachedData(cacheKey, result);
      return result;
    }
    return null;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 2. Realized Price (BTC) – bitcoin-data.com
 */
export const fetchRealizedPrice = async () => {
  const cacheKey = 'realized_price';
  const cached = getCachedData(cacheKey, 300000);
  if (cached && !cached.stale) return cached;

  try {
    const url = 'https://bitcoin-data.com/api/v1/realized-price';
    const data = await fetchWithRetry(url, {}, 2);
    if (data?.data?.realizedPrice !== undefined) {
      const price = parseFloat(data.data.realizedPrice);
      setCachedData(cacheKey, price);
      return price;
    }
    return null;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 3. ETF Flows (BTC e ETH) – Farside Investors via scraping de página HTML
 *    Como não há API oficial, fazemos fetch do HTML e extraímos o valor mais recente.
 *    Este é um fallback; idealmente usaríamos um wrapper como "farside-data" npm.
 */
export const fetchETFData = async () => {
  const cacheKey = 'etf_flows';
  const cached = getCachedData(cacheKey, 300000);
  if (cached && !cached.stale) return cached;

  try {
    // BTC ETF Flows
    const btcUrl = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';
    const btcHtml = await fetchWithRetry(btcUrl, {}, 2);
    // Extração simples: procura pela última linha da tabela com classe "total"
    const btcMatch = btcHtml.match(/>Total</i); // simplificado; em produção usar regex melhor
    let btcFlow = 0;
    if (btcMatch) {
      // Captura o valor da célula seguinte (ex: "+123.4M" ou "-56.7M")
      const valMatch = btcHtml.substring(btcMatch.index).match(/([+-]?\d+\.?\d*)(M|B)/);
      if (valMatch) {
        const num = parseFloat(valMatch[1]);
        const mult = valMatch[2] === 'B' ? 1000 : 1;
        btcFlow = num * mult;
      }
    }

    // ETH ETF Flows
    const ethUrl = 'https://farside.co.uk/ethereum-etf-flow-all-data/';
    const ethHtml = await fetchWithRetry(ethUrl, {}, 2);
    let ethFlow = 0;
    const ethMatch = ethHtml.match(/>Total</i);
    if (ethMatch) {
      const valMatch = ethHtml.substring(ethMatch.index).match(/([+-]?\d+\.?\d*)(M|B)/);
      if (valMatch) {
        const num = parseFloat(valMatch[1]);
        const mult = valMatch[2] === 'B' ? 1000 : 1;
        ethFlow = num * mult;
      }
    }

    const result = { btcFlow, ethFlow };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 4. Exchange Netflow – indisponível em API gratuita.
 *    Mantém retorno null para exibir "INDISPONÍVEL".
 */
export const fetchExchangeNetflow = async () => {
  console.warn('[ExchangeNetflow] sem fonte gratuita confiável — retornando null');
  return null;
};

/**
 * 5. Funding Rate (atual) – Binance Futures (já existente, mas mantemos)
 *    A função fetchFundingRate já existe; vamos apenas reutilizá-la.
 *    (Ela retorna { rate, interpretacao })
 */

/**
 * 6. Open Interest (BTC) – Binance Futures
 *    Já temos fetchOpenInterest, que retorna { oi, delta }.
 *    Para delta 24h, calculamos localmente em updateExternalData.
 */

/**
 * 7. OI Delta (24h) – calculado localmente a partir do histórico
 *    Vamos adicionar função que busca OI atual e OI de 24h atrás.
 */
export const fetchOIDelta = async (symbol = 'BTCUSDT') => {
  const cacheKey = `oi_delta_${symbol}`;
  const cached = getCachedData(cacheKey, 60000); // 1 minuto
  if (cached && !cached.stale) return cached;

  try {
    // Busca OI atual (último ponto)
    const currData = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=1`);
    const currOi = currData?.length ? parseFloat(currData[0].sumOpenInterest) : 0;

    // Busca OI de 24h atrás (96 períodos de 15min)
    const histData = await fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=97`);
    if (histData?.length >= 97) {
      const pastOi = parseFloat(histData[histData.length - 97].sumOpenInterest);
      const delta = pastOi > 0 ? ((currOi - pastOi) / pastOi) * 100 : 0;
      const result = { oi: currOi, delta };
      setCachedData(cacheKey, result);
      return result;
    }
    return null;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 8. Basis (Perp vs Spot) – Binance
 *    Usa premiumIndex para perp e spot ticker.
 */
export const fetchBasis = async (symbol = 'BTCUSDT') => {
  const cacheKey = `basis_${symbol}`;
  const cached = getCachedData(cacheKey, 60000);
  if (cached && !cached.stale) return cached;

  try {
    const [perp, spot] = await Promise.all([
      fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
    ]);
    if (perp?.markPrice && spot?.price) {
      const mark = parseFloat(perp.markPrice);
      const spotPrice = parseFloat(spot.price);
      const basis = ((mark - spotPrice) / spotPrice) * 100;
      setCachedData(cacheKey, basis);
      return basis;
    }
    return null;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 9. BTC Put/Call Ratio – Deribit
 */
export const fetchPutCallRatio = async () => {
  const cacheKey = 'pcr';
  const cached = getCachedData(cacheKey, 60000);
  if (cached && !cached.stale) return cached;

  try {
    const data = await fetchWithRetry('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
    let putVolume = 0, callVolume = 0;
    data?.result?.forEach(item => {
      if (item.option_type === 'put') putVolume += item.volume || 0;
      if (item.option_type === 'call') callVolume += item.volume || 0;
    });
    const ratio = callVolume > 0 ? putVolume / callVolume : 0;
    setCachedData(cacheKey, ratio);
    return ratio;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 10. BTC Hashrate – mempool.space
 */
export const fetchHashrate = async () => {
  const cacheKey = 'hashrate';
  const cached = getCachedData(cacheKey, 300000);
  if (cached && !cached.stale) return cached;

  try {
    const data = await fetchWithRetry('https://mempool.space/api/v1/mining/hashrate/1d', {}, 2);
    if (data?.avgHashrate) {
      const hashrate = parseFloat(data.avgHashrate); // em TH/s
      setCachedData(cacheKey, hashrate);
      return hashrate;
    }
    return null;
  } catch (e) {
    if (cached) return cached;
    return null;
  }
};

/**
 * 11. Miner Outflow – indisponível em API gratuita.
 */
export const fetchMinerOutflow = async () => {
  console.warn('[MinerOutflow] sem fonte gratuita confiável — retornando null');
  return null;
};
