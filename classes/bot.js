const chalk = require('chalk')
const fs = require('fs')
const hash = require('object-hash')
const { concatMap, toArray } = require('rxjs/operators')
const { forkJoin, from, Subject, timer } = require('rxjs')

const Advisor = require('./advisor')
const Chart = require('./chart')
const Log = require('./log')
const Trade = require('./trade')
const UI = require('./ui')
const { calculateFunds, errorToString } = require('../helpers')
const { description, version } = require('../package.json')

class Bot {
  constructor (config) {
    this.advisors = {}
    this.charts = {}
    this.logs = []
    this.notifications = new Subject()
    this.trades = []
    this.initialize(config)
  }

  addAdvisor (advisorId) {
    return new Promise(async (resolve, reject) => {
      const advisorName = advisorId.charAt(0).toUpperCase() + advisorId.slice(1).toLowerCase()
      try {
        if (!fs.existsSync(`./advisors/${advisorId}.js`)) {
          return reject(new Error(`Advisor ${advisorName} doesn't exist`))
        }
        const advisorConfig = require(`../advisors/${advisorId}.js`)
        if (!(typeof advisorConfig === 'object') || Array.isArray(advisorConfig)) {
          return reject(new Error(`Advisor ${advisorName} not properly configured`))
        }
        const margin = parseFloat(advisorConfig.margin || 0)
        const sights = advisorConfig.sights || []
        if ((!(margin > 0) || margin > 100) || !Array.isArray(sights) || !sights.length) {
          return reject(new Error(`Advisor ${advisorName} not properly configured`))
        }
        const chartConfigs = await Advisor.getChartConfigs(sights)
        from(chartConfigs).pipe(
          concatMap((chartConfig) => new Promise(async (resolve, reject) => {
            const chartId = hash(chartConfig)
            if (this.charts[chartId]) {
              this.log({ level: 'info', message: `${this.charts[chartId].name} already loaded, skipping` })
              return resolve(chartId)
            }
            this.charts[chartId] = await Chart.initialize(chartId, chartConfig, {
              exchangeInfo: this.exchangeInfo,
              log: (event) => this.log(event),
              notifications: this.notifications,
              retrieveStream: (chartConfig) => this.provider.retrieveStream(chartConfig),
              show: (chartId) => this.show(chartId)
            })
            return resolve(chartId)
          })),
          toArray()
        ).subscribe((chartIds) => {
          const advisor = new Advisor(advisorName, chartIds, margin)
          this.advisors[advisorId] = advisor
          this.log({ level: 'success', message: `Advisor ${advisorName} running` })
          return resolve()
        })
      } catch (error) {
        error.message = `Advisor ${advisorName}: ${errorToString(error)}`
        return reject(error)
      }
    })
  }

  addProvider (providerId) {
    return new Promise(async (resolve, reject) => {
      const providerName = providerId.charAt(0).toUpperCase() + providerId.slice(1).toLowerCase()
      try {
        if (!fs.existsSync(`./providers/${providerId}/index.js`)) {
          return reject(new Error(`Provider ${providerName} doesn't exist`))
        }
        const Provider = require(`../providers/${providerId}`)
        this.provider = new Provider()
        this.exchangeInfo = await this.retrieveExchangeInfo()
        await this.updateFunds()
        this.log({ level: 'success', message: `Provider ${providerName} connected` })
        return resolve()
      } catch (error) {
        error.message = `Provider ${providerName}: ${errorToString(error)}`
        return reject(error)
      }
    })
  }

  analyzeChart ({ chartId, candles, isFinal }) {
    Object.keys(this.advisors).map(async (advisorId) => {
      const advisor = this.advisors[advisorId]
      if (advisor.chartIds.includes(chartId)) {
        const chart = this.charts[chartId]
        try {
          const advices = await Promise.all(advisor.analyze(candles, chart.config.strategies))
          from(advices.filter((advice) => advice)).pipe(
            concatMap((advice, index) => new Promise(async (resolve, reject) => {
              try {
                await this.digestAdvice({
                  advisorId,
                  chartId,
                  isFinal,
                  ...advice
                })
                return resolve()
              } catch (error) {
                this.log(error)
                return resolve()
              }
            }))
          ).subscribe()
        } catch (error) {
          this.log(error)
        }
      }
    })
  }

  closeTrades () {
    return new Promise(async (resolve, reject) => {
      const trades = this.trades.filter((trade) => trade.isOpen)
      try {
        await Promise.all(trades.map((trade) => trade.close('expire')))
        return resolve()
      } catch (error) {
        return reject(error)
      }
    })
  }

  digestAdvice (advice) {
    return new Promise(async (resolve, reject) => {
      const { advisorId, chartId, isFinal, signal, strategy } = advice
      const advisor = this.advisors[advisorId]
      const chart = this.charts[chartId]
      const who = `${advisor.name}->${chart.name}->${strategy.name}`
      switch (signal) {
        case 'CLOSE LONG':
        case 'CLOSE SHORT': {
          const trade = this.trades.find((trade) => trade.advisorId === advisorId && trade.chartId === chartId && trade.who === who && trade.isOpen)
          if (trade && ((signal === 'CLOSE LONG' && trade.isLong) || (signal === 'CLOSE SHORT' && !trade.isLong))) {
            try {
              await trade.close('signal')
              return resolve()
            } catch (error) {
              return reject(error)
            }
          }
          break
        }
        case 'LONG':
        case 'SHORT': {
          if (isFinal) {
            const isLong = signal === 'LONG'
            const asset = isLong ? chart.info.quoteAsset : chart.info.baseAsset
            const longsSellingBackAsset = this.trades.filter((trade) => trade.isLong && trade.isOpen && this.charts[trade.chartId].info.baseAsset === asset)
            const shortsSellingBackAsset = this.trades.filter((trade) => !trade.isLong && trade.isOpen && this.charts[trade.chartId].info.quoteAsset === asset)
            const quantityLockedByTrades = longsSellingBackAsset.reduce((quantity, trade) => quantity + trade.quantity, 0) + shortsSellingBackAsset.reduce((quantity, trade) => quantity + trade.quantity, 0)
            const funds = ((this.funds[asset] && this.funds[asset].available) || 0) - quantityLockedByTrades
            const amount = funds * advisor.margin
            const quantity = await this.provider.clampQuantity(amount, chart.info, isLong)
            if (quantity > 0 && !this.trades.find((trade) => trade.advisorId === advisorId && trade.chartId === chartId && trade.isOpen)) {
              try {
                const trade = await Trade.initialize({
                  advisorId,
                  buy: (quantity, info) => new Promise(async (resolve, reject) => {
                    try {
                      const order = await this.provider.buy(quantity, info)
                      return resolve(order)
                    } catch (error) {
                      return reject(error)
                    }
                  }),
                  chartId,
                  exchangeInfo: this.exchangeInfo,
                  isLong,
                  log: (event) => this.log(event),
                  quantity,
                  sell: (quantity, info) => new Promise(async (resolve, reject) => {
                    try {
                      const order = this.provider.sell(quantity, info)
                      return resolve(order)
                    } catch (error) {
                      return reject(error)
                    }
                  }),
                  show: (chartId) => this.show(chartId),
                  signal,
                  strategy,
                  stream: chart.stream,
                  symbol: chart.config.symbol,
                  updateFunds: () => new Promise(async (resolve, reject) => {
                    try {
                      const funds = await this.updateFunds(true)
                      return resolve(funds)
                    } catch (error) {
                      return reject(error)
                    }
                  }),
                  who
                })
                this.trades.push(trade)
                return resolve()
              } catch (error) {
                return reject(error)
              }
            }
          }
          break
        }
        default: return resolve()
      }
    })
  }

  async handleKeyPress (key) {
    switch (key) {
      case 'a': {
        const advisorIds = Object.keys(this.advisors)
        if (advisorIds.length) {
          const index = advisorIds.findIndex((advisorId) => advisorId === this.currentAdvisor)
          const nextAdvisor = index + 1 < advisorIds.length ? advisorIds[index + 1] : advisorIds[0]
          this.switchAdvisor(nextAdvisor)
          this.currentMode = 'c'
          this.show(this.currentChart)
        }
        break
      }
      case 'c':
      case 'x': {
        if (this.currentMode === 'c' || this.currentMode === 'z') {
          const chartIds = Object.keys(this.charts).filter((chartId) => this.advisors[this.currentAdvisor].chartIds.includes(chartId) && this.charts[chartId].enabled)
          const index = chartIds.findIndex((chartId) => chartId === this.currentChart)
          if (key === 'c') {
            const nextChart = index + 1 < chartIds.length ? chartIds[index + 1] : chartIds[0]
            this.currentChart = nextChart
          } else {
            const prevChart = index - 1 < 0 ? chartIds[chartIds.length - 1] : chartIds[index - 1]
            this.currentChart = prevChart
          }
        }
        this.currentMode = 'c'
        this.show(this.currentChart)
        break
      }
      case 'd': {
        switch (this.currentMode) {
          case 'd1': {
            this.currentMode = 'd2'
            break
          }
          case 'd2': {
            this.currentMode = 'd3'
            break
          }
          default: this.currentMode = 'd1'
        }
        this.show()
        break
      }
      case 'f': {
        if (this.currentMode === 'f') {
          try {
            this.funds = await this.retrieveFunds(true)
          } catch (error) {
            this.log(error)
          }
        } else {
          this.currentMode = 'f'
        }
        this.show()
        break
      }
      case 'l': {
        if (this.currentMode === 'l') {
          if (this.logs.length - (this.readMore || 0) > Math.ceil(this.ui.screen.rows * 0.8) - 1) {
            if (!this.readMore) {
              this.readMore = 0
            }
            this.readMore++
          }
        } else {
          this.currentMode = 'l'
          delete this.readMore
        }
        this.show()
        break
      }
      case 'q': {
        this.currentMode = 'q'
        this.quitting = true
        this.show()
        break
      }
      case 't': {
        if (this.trades.length) {
          if (this.currentMode === 't') {
            if (this.trades.length - (this.readMore || 0) > Math.ceil(this.ui.screen.rows * 0.8) - 1) {
              if (!this.readMore) {
                this.readMore = 0
              }
              this.readMore++
            }
          } else {
            this.currentMode = 't'
            delete this.readMore
          }
          this.show()
        }
        break
      }
      case 'v': {
        if (this.currentMode === 'c' || this.currentMode === 'z') {
          const trade = this.trades.find((trade) => trade.advisorId === this.currentAdvisor && trade.chartId === this.currentChart && trade.isOpen)
          if (trade) {
            this.currentMode = 'v'
            this.show()
          }
        }
        break
      }
      case 'y': {
        if (this.quitting) {
          try {
            const hadOpenTrades = !!this.trades.filter((trade) => trade.isOpen).length
            await this.closeTrades()
            if (hadOpenTrades) {
              await new Promise((resolve, reject) => {
                this.log({ level: 'info', message: 'Exiting…' })
                timer(2000).subscribe(() => resolve())
              })
            }
            process.exit()
          } catch (error) {
            this.log(error)
          }
        }
        break
      }
      case 'z': {
        const trades = this.trades.filter((trade) => trade.isOpen)
        if (trades.length) {
          const tradeIndex = trades.findIndex((trade) => trade.advisorId === this.currentAdvisor && trade.chartId === this.currentChart)
          this.currentAdvisor = trades[(this.currentMode === 'z' && tradeIndex > 0 ? tradeIndex : trades.length) - 1].advisorId
          this.currentChart = trades[(this.currentMode === 'z' && tradeIndex > 0 ? tradeIndex : trades.length) - 1].chartId
          this.currentMode = 'z'
          this.show(this.currentChart)
        }
        break
      }
    }
    if (this.quitting && this.currentMode !== 'q') {
      delete this.quitting
    }
  }

  async initialize (config) {
    try {
      if (!(typeof config === 'object') || Array.isArray(config)) {
        throw new Error('Bot not properly configured')
      }
      let { advisors: advisorIds = [], provider: providerId = '' } = config
      if (typeof providerId !== 'string' || !providerId.length) {
        throw new Error('Provider not properly configured')
      }
      await this.addProvider(providerId)
      this.notifications.subscribe((notification) => this.processNotification(notification))
      if (!Array.isArray(advisorIds)) {
        this.log(new Error('Advisors not properly configured'))
        advisorIds = []
      }
      forkJoin(from(advisorIds).pipe(
        concatMap((advisorId, index) => new Promise(async (resolve, reject) => {
          try {
            if (typeof advisorId !== 'string' || !advisorId.length) {
              throw new Error(`Advisor #${index + 1} not properly configured`)
            }
            await this.addAdvisor(advisorId)
            return resolve()
          } catch (error) {
            this.log(error)
            return resolve()
          }
        }))
      )).subscribe(async () => {
        await new Promise((resolve, reject) => {
          this.log({ level: 'info', message: 'Launching…' })
          timer(1000).subscribe(() => resolve())
        })
        this.ui = new UI({
          bindings: {
            a: () => this.handleKeyPress('a'), // Next advisor
            c: () => this.handleKeyPress('c'), // Show chart / next chart
            d: () => this.handleKeyPress('d'), // Show chart data
            f: () => this.handleKeyPress('f'), // Show funds
            l: () => this.handleKeyPress('l'), // Show logs
            q: () => this.handleKeyPress('q'), // Quit
            t: () => this.handleKeyPress('t'), // Show trades
            v: () => this.handleKeyPress('v'), // View trade details
            x: () => this.handleKeyPress('x'), // Show chart / previous chart
            y: () => this.handleKeyPress('y'), // Yes
            z: () => this.handleKeyPress('z') // Cycle charts with open trades
          },
          getEstimatedValue: () => Object.keys(this.funds).reduce((estimatedValue, asset) => {
            if (this.funds[asset].dollarPrice) {
              return estimatedValue + this.funds[asset].dollarPrice
            }
            return estimatedValue
          }, 0),
          handleResize: () => {
            delete this.readMore
            this.show(this.currentChart)
          },
          title: `${description} v${version}`
        })
        const advisorIdsLoaded = Object.keys(this.advisors)
        this.log({ level: 'warning', message: `Do ${chalk.inverse('NOT')} use or share this software without explicit authorization from ${chalk.underline('lropero@gmail.com')}` })
        this.log({ level: advisorIdsLoaded.length ? 'success' : 'warning', message: advisorIdsLoaded.length ? `Advisors running:${advisorIdsLoaded.map((advisorId) => ' ' + this.advisors[advisorId].name)}` : 'No advisors running' })
        this.log({ level: 'silent', message: '--- FINISHED INITIALIZATION ---' })
        this.show()
      })
      timer(1000 * 60 * 30).subscribe(() => this.updateTimer())
    } catch (error) {
      this.log(error)
      process.exit()
    }
  }

  log (event) {
    const log = new Log(event)
    if (this.ui && log.level !== 'silent') {
      this.ui.log(log.toString())
    } else if (!this.ui) {
      console.log(log.toString(true))
    }
    this.logs.push(log)
    while (this.logs.length > 2000) {
      this.logs.shift()
    }
    if (this.currentMode === 'l') {
      if (this.readMore) {
        this.readMore++
      }
      this.show()
    }
  }

  processNotification (notification) {
    const { payload, type } = notification
    switch (type) {
      case 'candlesReady': return this.analyzeChart(payload)
      case 'chartReset': return this.resubscribeTradesToNewStream(payload)
    }
  }

  resubscribeTradesToNewStream ({ chartId, stream }) {
    const trades = this.trades.filter((trade) => trade.chartId === chartId && trade.isOpen)
    trades.map((trade) => trade.resubscribe(stream))
  }

  retrieveExchangeInfo () {
    return new Promise(async (resolve, reject) => {
      try {
        const exchangeInfo = await this.provider.retrieveExchangeInfo()
        return resolve(exchangeInfo)
      } catch (error) {
        return reject(error)
      }
    })
  }

  retrieveFunds (updatePrices = false) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.prices || updatePrices) {
          this.prices = await this.provider.retrievePrices()
        }
        const balance = await this.provider.retrieveBalance()
        const funds = calculateFunds(balance, this.prices)
        return resolve(funds)
      } catch (error) {
        return reject(error)
      }
    })
  }

  show (chartId) {
    if (this.ui) {
      if (!this.currentAdvisor) {
        const advisorIds = Object.keys(this.advisors)
        if (advisorIds.length) {
          this.switchAdvisor(Object.keys(this.advisors)[0])
          if (this.currentChart) {
            chartId = this.currentChart
          }
        }
      }
      if (!this.currentMode) {
        this.currentMode = 'c'
      }
      if (this.currentMode === 'c' && !this.currentChart) {
        this.currentMode = 'f'
      }
      switch (this.currentMode) {
        case 'c':
        case 'z': {
          if (this.currentChart && chartId && this.currentChart === chartId) {
            const trade = this.trades.find((trade) => trade.advisorId === this.currentAdvisor && trade.chartId === this.currentChart && trade.isOpen)
            this.ui.renderChart(this.advisors[this.currentAdvisor], this.charts[this.currentChart], trade)
          }
          break
        }
        case 'd1': return this.ui.renderData(this.charts[this.currentChart], 1)
        case 'd2': return this.ui.renderData(this.charts[this.currentChart], 2)
        case 'd3': return this.ui.renderData(this.charts[this.currentChart], 3)
        case 'f': {
          if (!chartId && this.funds && Object.keys(this.funds).length) {
            this.ui.renderFunds(this.funds)
          }
          break
        }
        case 'l': return this.ui.renderLogs(this.logs.slice((Math.ceil(this.ui.screen.rows * 0.8) - 1 + (this.readMore || 0)) * -1))
        case 'q': return !chartId && this.ui.renderQuit()
        case 't': return this.ui.renderTrades(this.trades.slice((Math.ceil(this.ui.screen.rows * 0.8) - 1 + (this.readMore || 0)) * -1))
        case 'v': return this.ui.renderTrade(this.trades.find((trade) => trade.advisorId === this.currentAdvisor && trade.chartId === this.currentChart))
      }
    }
  }

  switchAdvisor (advisorId) {
    delete this.currentChart
    this.currentAdvisor = advisorId
    const chartIds = Object.keys(this.charts).filter((chartId) => this.advisors[this.currentAdvisor].chartIds.includes(chartId) && this.charts[chartId].enabled)
    if (chartIds.length) {
      this.currentChart = chartIds[0]
    }
  }

  updateFunds (updatePrices = false) {
    return new Promise(async (resolve, reject) => {
      try {
        this.funds = await this.retrieveFunds(updatePrices)
        if (this.currentMode === 'f') {
          this.show()
        }
        return resolve(this.funds)
      } catch (error) {
        return reject(error)
      }
    })
  }

  async updateTimer () {
    try {
      this.exchangeInfo = await this.retrieveExchangeInfo()
      Object.keys(this.charts).map((chartId) => {
        this.charts[chartId].updateInfo(this.exchangeInfo)
      })
      this.trades.filter((trade) => trade.isOpen).map((trade) => {
        trade.updateInfo(this.exchangeInfo)
      })
      await this.updateFunds(true)
      this.log({ level: 'silent', message: 'Server info updated' })
      timer(1000 * 60 * 30).subscribe(() => this.updateTimer())
    } catch (error) {
      timer(1000 * 60).subscribe(() => this.updateTimer())
      error.message = `updateTimer(): ${errorToString(error)}`
      this.log(error)
    }
  }
}

module.exports = Bot
