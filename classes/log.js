const beep = require('beepbeep')
const chalk = require('chalk')
const figures = require('figures')
const { format } = require('date-fns')

const { errorToString } = require('../helpers')

class Log {
  constructor (event) {
    const isError = event instanceof Error
    this.date = new Date()
    this.level = isError ? 'error' : event.level
    this.message = isError ? errorToString(event) : event.message
    if (isError) {
      this.stack = event.stack
    }
    switch (this.level) {
      case 'error': {
        beep(2)
        break
      }
      case 'long':
      case 'short': {
        beep()
        break
      }
    }
  }

  toString (avoidBlack = false) {
    const getIcon = level => {
      switch (level) {
        case 'closeExpire':
          return chalk.blue(figures.play)
        case 'closeSignal':
          return chalk.yellow(figures.play)
        case 'closeStop':
          return chalk.red(figures.play)
        case 'closeTarget':
          return chalk.green(figures.play)
        case 'error':
          return chalk.red(figures.bullet)
        case 'info':
          return chalk.white(figures.bullet)
        case 'long':
          return chalk.cyan(figures.arrowUp)
        case 'short':
          return chalk.magenta(figures.arrowDown)
        case 'silent':
          return chalk.gray(figures.bullet)
        case 'success':
          return chalk.green(figures.bullet)
        case 'warning':
          return chalk.yellow(figures.bullet)
      }
    }
    let message = this.message
    if (this.level === 'long' || this.level === 'short') {
      message = message.replace(/(.*)#avoidBlack(.*)#/g, (message, string, who) => string + (avoidBlack ? chalk.white(who) : chalk.black(who)))
    }
    return `${getIcon(this.level)} ${chalk[avoidBlack ? 'white' : 'black'](format(this.date, 'dd-MMM-yy HH:mm:ss'))} ${chalk.white(message)}`
  }
}

module.exports = Log
