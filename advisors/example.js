module.exports = {
  sights: [
    {
      symbol: 'BTCUSDT',
      timeframe: '1m',
      strategies: {
        'vsa': {
          margin: '10%',
          params: [120, 50, 25, 10, 20, 0.7],
          profitTarget: '2%',
          stopLoss: '1%',
          timeToLive: '30m'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '3m',
      strategies: {
        'vsa': {
          margin: '10%',
          params: [60, 50, 25, 10, 20, 0.7],
          profitTarget: '2%',
          stopLoss: '1%',
          timeToLive: '1h'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '5m',
      strategies: {
        'tazv': {
          margin: '10%',
          params: [5],
          paramsIndicators: [30, 10],
          profitTarget: '1%',
          stopLoss: '1%'
        },
        'vsa': {
          margin: '20%',
          params: [60, 50, 25, 10, 20, 0.7],
          profitTarget: '2%',
          stopLoss: '1%',
          timeToLive: '1h'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      strategies: {
        'vsa': {
          margin: '30%',
          params: [100, 50, 25, 10, 20, 0.6],
          profitTarget: '3%',
          stopLoss: '2%',
          timeToLive: '2h'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      strategies: {
        'vsa': {
          margin: '50%',
          params: [100, 50, 25, 10, 20, 0.6],
          profitTarget: '5%',
          stopLoss: '2%',
          timeToLive: '4h'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '6h',
      strategies: {
        'vsa': {
          margin: '50%',
          params: [100, 50, 25, 10, 20, 0.5],
          profitTarget: '5%',
          stopLoss: '2%',
          timeToLive: '1d'
        }
      }
    },
    {
      symbol: 'BTCUSDT',
      timeframe: '1d',
      strategies: {
        'vsa': {
          margin: '80%',
          params: [100, 50, 25, 10, 20, 0.5],
          profitTarget: '5%',
          stopLoss: '2%'
        }
      }
    },
    {
      symbol: 'ETHBTC',
      timeframe: '5m',
      strategies: {
        'vsa': {
          margin: '20%',
          params: [60, 50, 25, 10, 20, 0.7],
          profitTarget: '2%',
          stopLoss: '1%',
          timeToLive: '1h'
        }
      }
    }
  ]
}
