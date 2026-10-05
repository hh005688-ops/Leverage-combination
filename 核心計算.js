/**
 * 四維系統 - 投資組合量化計算與 Beta 回寫主程式
 */
function updatePortfolioMetrics() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targetSheets = ['組合A', '組合B', '組合C'];
  var benchmarkSymbol = '^GSPC'; // S&P 500 大盤基準

  // 1. 取得大盤歷史數據與時間戳對照
  var benchmarkData = { timestamps: [], prices: [] };
  try {
    benchmarkData = fetchHistoricalPricesWithTimestamps(benchmarkSymbol, 250);
  } catch (e) {
    Logger.log('大盤基準抓取失敗: ' + e.message);
    SpreadsheetApp.getUi().alert('大盤基準抓取失敗: ' + e.message);
    return;
  }

  if (benchmarkData.prices.length === 0) {
    SpreadsheetApp.getUi().alert('無法取得大盤基準數據，終止計算。');
    return;
  }

  // 2. 逐一處理各組合分頁
  targetSheets.forEach(function(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    try {
      processSinglePortfolio(sheet, benchmarkData);
    } catch (err) {
      Logger.log('處理分頁 [' + sheetName + '] 時發生錯誤: ' + err.message);
    }
  });

  SpreadsheetApp.getUi().alert('投資組合指標與 Beta 計算完成！');
}

/**
 * 處理單一組合分頁的資料讀取、計算與回寫
 */
function processSinglePortfolio(sheet, benchmarkData) {
  var startRow = 3;
  var maxRows = 20; 
  var range = sheet.getRange(startRow, 1, maxRows, 7);
  var values = range.getValues();

  var updatedBetas = [];
  var weightedBetaSum = 0;
  var totalWeight = 0;
  var validAssetCount = 0;

  // 正式迴圈運算（過濾掉空白代號行）
  for (var i = 0; i < values.length; i++) {
    var symbol = String(values[i][0]).trim();
    var weight = Number(values[i][5]) || 0; // F欄: 權重
    var itemBeta = Number(values[i][6]) || 1.0; // G欄: 預設 Beta

    if (symbol !== '') {
      try {
        var stockData = fetchHistoricalPricesWithTimestamps(symbol, 250);
        if (stockData && stockData.prices.length > 1) {
          // 依據日期對齊計算真實 Beta
          itemBeta = calculateAlignedBeta(stockData, benchmarkData);
        }
      } catch (e) {
        Logger.log('標的 [' + symbol + '] Beta 計算失敗，保留原值: ' + e.message);
      }

      weightedBetaSum += weight * itemBeta;
      totalWeight += weight;
      validAssetCount++;
    }

    updatedBetas.push([itemBeta]);
  }

  // 3. 批次寫回 Beta 欄位（G 欄）
  if (updatedBetas.length > 0) {
    sheet.getRange(startRow, 7, updatedBetas.length, 1).setValues(updatedBetas);
  }
}

/**
 * 取得歷史收盤價與對應的時間戳（解決日期錯位問題）
 */
function fetchHistoricalPricesWithTimestamps(symbol, days) {
  var formattedSymbol = symbol;
  if (/^\d{4,5}$/.test(formattedSymbol)) {
    formattedSymbol = formattedSymbol + '.TW';
  }

  var period2 = Math.floor(Date.now() / 1000);
  var period1 = period2 - (days * 86400 * 1.5);
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(formattedSymbol) + '?period1=' + period1 + '&period2=' + period2 + '&interval=1d';

  try {
    var options = {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };

    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());
    
    if (result.chart && result.chart.result && result.chart.result.length > 0) {
      var resObj = result.chart.result[0];
      var timestamps = resObj.timestamp || [];
      var quotes = resObj.indicators.quote[0].close || [];

      var validTimestamps = [];
      var validPrices = [];

      for (var i = 0; i < timestamps.length; i++) {
        var p = Number(quotes[i]);
        if (!isNaN(p) && p !== null) {
          validTimestamps.push(timestamps[i]);
          validPrices.push(p);
        }
      }
      return { timestamps: validTimestamps, prices: validPrices };
    } else {
      throw new Error('查無數據或代號錯誤');
    }
  } catch (error) {
    throw new Error('無法取得 [' + symbol + '] 歷史數據: ' + error.message);
  }
}

/**
 * 依據 Unix Timestamp 精準對齊日期後計算 Beta
 */
function calculateAlignedBeta(stockData, benchmarkData) {
  var stockMap = new Map();
  for (var i = 0; i < stockData.timestamps.length; i++) {
    stockMap.set(stockData.timestamps[i], stockData.prices[i]);
  }

  var alignedStockPrices = [];
  var alignedBenchPrices = [];

  for (var j = 0; j < benchmarkData.timestamps.length; j++) {
    var t = benchmarkData.timestamps[j];
    if (stockMap.has(t)) {
      alignedBenchPrices.push(benchmarkData.prices[j]);
      alignedStockPrices.push(stockMap.get(t));
    }
  }

  if (alignedStockPrices.length < 10) return 1.0;

  var stockReturns = calculateReturns(alignedStockPrices);
  var benchReturns = calculateReturns(alignedBenchPrices);

  var cov = covariance(stockReturns, benchReturns);
  var varBench = variance(benchReturns);

  if (varBench === 0) return 1.0;
  
  var beta = cov / varBench;
  return Number(beta.toFixed(3)) || 1.0;
}

function calculateReturns(prices) {
  var returns = [];
  for (var i = 1; i < prices.length; i++) {
    var prev = Number(prices[i - 1]) || 1;
    var curr = Number(prices[i]) || prev;
    returns.push((curr - prev) / prev);
  }
  return returns;
}

function covariance(arr1, arr2) {
  var n = Math.min(arr1.length, arr2.length);
  if (n <= 1) return 0;
  var mean1 = arr1.reduce(function(a, b) { return a + b; }, 0) / n;
  var mean2 = arr2.reduce(function(a, b) { return a + b; }, 0) / n;
  var sum = 0;
  for (var i = 0; i < n; i++) {
    sum += (arr1[i] - mean1) * (arr2[i] - mean2);
  }
  return sum / (n - 1);
}

function variance(arr) {
  var n = arr.length;
  if (n <= 1) return 0;
  var mean = arr.reduce(function(a, b) { return a + b; }, 0) / n;
  var sum = 0;
  for (var i = 0; i < n; i++) {
    sum += Math.pow(arr[i] - mean, 2);
  }
  return sum / (n - 1);
}