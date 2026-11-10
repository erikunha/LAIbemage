import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, logger } from '../../src/utils/logger.js';

// Spy on the console methods used by each log level
const consoleSpy = {
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
};

afterEach(() => {
  // Reset to defaults after each test so state does not leak
  configureLogger({ quiet: false, verbose: false });
  vi.clearAllMocks();
});

describe('logger — normal mode', () => {
  it('info writes to console.log', () => {
    logger.info('hello info');
    expect(consoleSpy.log).toHaveBeenCalledOnce();
  });

  it('success writes to console.log', () => {
    logger.success('hello success');
    expect(consoleSpy.log).toHaveBeenCalledOnce();
  });

  it('warn writes to console.warn', () => {
    logger.warn('hello warn');
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
  });

  it('error writes to console.error', () => {
    logger.error('hello error');
    expect(consoleSpy.error).toHaveBeenCalledOnce();
  });

  it('verbose/debug is suppressed by default', () => {
    logger.verbose('debug message');
    expect(consoleSpy.log).not.toHaveBeenCalled();
  });
});

describe('logger — quiet mode', () => {
  it('suppresses info in quiet mode', () => {
    configureLogger({ quiet: true });
    logger.info('should be silent');
    expect(consoleSpy.log).not.toHaveBeenCalled();
  });

  it('suppresses warn in quiet mode', () => {
    configureLogger({ quiet: true });
    logger.warn('should be silent');
    expect(consoleSpy.warn).not.toHaveBeenCalled();
  });

  it('still emits error in quiet mode', () => {
    configureLogger({ quiet: true });
    logger.error('critical error');
    expect(consoleSpy.error).toHaveBeenCalledOnce();
  });
});

describe('logger — verbose mode', () => {
  it('emits verbose/debug messages when verbose is true', () => {
    configureLogger({ verbose: true });
    logger.verbose('debug detail');
    expect(consoleSpy.log).toHaveBeenCalledOnce();
  });
});

describe('logger — JSON mode', () => {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  afterEach(() => {
    configureLogger({ quiet: false, verbose: false, jsonMode: false });
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
  });

  it('writes JSON lines to stdout for info', () => {
    configureLogger({ jsonMode: true });
    logger.info('json info');
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const line = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as { level: string; msg: string; ts: number };
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('json info');
    expect(typeof parsed.ts).toBe('number');
  });

  it('writes JSON lines to stderr for warn', () => {
    configureLogger({ jsonMode: true });
    logger.warn('json warn');
    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as { level: string; msg: string };
    expect(parsed.level).toBe('warn');
  });

  it('writes JSON lines to stderr for error', () => {
    configureLogger({ jsonMode: true });
    logger.error('json error');
    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as { level: string; msg: string };
    expect(parsed.level).toBe('error');
  });

  it('still suppresses debug logs in JSON mode unless verbose', () => {
    configureLogger({ jsonMode: true });
    logger.verbose('silent');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
