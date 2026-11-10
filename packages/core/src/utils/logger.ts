import chalk from 'chalk';

let _quiet = false;
let _verbose = false;
let _jsonMode = false;

export function configureLogger(options: {
  quiet?: boolean;
  verbose?: boolean;
  jsonMode?: boolean;
}): void {
  _quiet = options.quiet ?? false;
  _verbose = options.verbose ?? false;
  _jsonMode = options.jsonMode ?? false;
}

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string): void {
  if (_quiet && level !== 'error') return;
  if (level === 'debug' && !_verbose) return;

  if (_jsonMode) {
    const entry = JSON.stringify({ level, msg: message, ts: Date.now() });
    if (level === 'error' || level === 'warn') {
      process.stderr.write(entry + '\n');
    } else {
      process.stdout.write(entry + '\n');
    }
    return;
  }

  switch (level) {
    case 'info':
      console.log(chalk.cyan(message));
      break;
    case 'success':
      console.log(chalk.green(message));
      break;
    case 'warn':
      console.warn(chalk.yellow(message));
      break;
    case 'error':
      console.error(chalk.red(message));
      break;
    case 'debug':
      console.log(chalk.gray(message));
      break;
  }
}

export const logger = {
  info: (msg: string) => log('info', msg),
  success: (msg: string) => log('success', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
  /** Only printed when --verbose is active */
  verbose: (msg: string) => log('debug', msg),
  /** Always printed regardless of --quiet (for structural output like tables) */
  raw: (msg: string) => console.log(msg),
};
