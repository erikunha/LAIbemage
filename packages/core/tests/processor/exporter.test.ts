import { describe, expect, it } from 'vitest';
import { applyDateFormat, buildOutputName } from '../../src/processor/exporter.js';

const T = new Date('2024-06-15T12:00:00.000Z').getTime();

describe('buildOutputName', () => {
  it('produces the correct filename format', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC')).toBe(
      '001. Photo of kitchen dated 15-06-2024.jpeg',
    );
  });

  it('zero-pads sequence number to 3 digits', () => {
    expect(buildOutputName(42, 'bathroom', T, 'UTC')).toBe(
      '042. Photo of bathroom dated 15-06-2024.jpeg',
    );
  });

  it('replaces underscores with spaces in category name', () => {
    expect(buildOutputName(1, 'living_room', T, 'UTC')).toBe(
      '001. Photo of living room dated 15-06-2024.jpeg',
    );
  });

  it('falls back to "unknown" for an empty category', () => {
    expect(buildOutputName(1, '', T, 'UTC')).toBe('001. Photo of unknown dated 15-06-2024.jpeg');
  });

  it('strips forward slashes from category — no path traversal in output filename', () => {
    const name = buildOutputName(1, '../../etc/passwd', T, 'UTC');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    // The result is used as a single filename segment joined with path.join(),
    // so dots without a separator cannot cause traversal.
  });

  it('strips backslashes from category — no path traversal on Windows paths', () => {
    const name = buildOutputName(1, 'foo\\bar', T, 'UTC');
    expect(name).not.toContain('\\');
  });

  it('strips null bytes from category', () => {
    const name = buildOutputName(1, 'kitchen\x00evil', T, 'UTC');
    expect(name).not.toContain('\x00');
  });

  it('returns original-basename form when keepOriginalBasename is provided', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', '/some/path/IMG_0042.jpg')).toBe(
      'IMG_0042.jpeg',
    );
  });
});

describe('buildOutputName — filename template', () => {
  it('renders a custom template with {n}, {category}, {date}', () => {
    expect(buildOutputName(3, 'kitchen', T, 'UTC', undefined, '{n}_{category}_{date}')).toBe(
      '003_kitchen_15-06-2024.jpeg',
    );
  });

  it('renders {datetime} token with hours and minutes', () => {
    const result = buildOutputName(1, 'bathroom', T, 'UTC', undefined, '{n}_{datetime}');
    expect(result).toBe('001_15-06-2024_12-00.jpeg');
  });

  it('renders {description} as a slug from the LLM description', () => {
    const result = buildOutputName(
      1,
      'kitchen',
      T,
      'UTC',
      undefined,
      '{n}_{description}',
      'Water damage on ceiling',
    );
    expect(result).toBe('001_water-damage-on-ceiling.jpeg');
  });

  it('falls back to "no-description" when description is empty', () => {
    const result = buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{description}', '');
    expect(result).toBe('001_no-description.jpeg');
  });

  it('strips path-traversal characters from description slug', () => {
    const result = buildOutputName(
      1,
      'kitchen',
      T,
      'UTC',
      undefined,
      '{n}_{description}',
      '../evil/path',
    );
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    expect(result).not.toContain('..');
  });

  it('ignores the template and uses basename when keepOriginalBasename is provided', () => {
    const result = buildOutputName(1, 'kitchen', T, 'UTC', '/some/IMG_001.jpg', '{n}_{category}');
    expect(result).toBe('IMG_001.jpeg');
  });

  it('repeats {n} multiple times if the template has it twice', () => {
    const result = buildOutputName(7, 'kitchen', T, 'UTC', undefined, '{n}-copy-{n}');
    expect(result).toBe('007-copy-007.jpeg');
  });
});

describe('buildOutputName — {n:N} digit-width token', () => {
  it('{n:4} zero-pads to 4 digits', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n:4}_{category}')).toBe(
      '0001_kitchen.jpeg',
    );
  });

  it('{n:2} zero-pads to 2 digits', () => {
    expect(buildOutputName(5, 'kitchen', T, 'UTC', undefined, '{n:2}_{category}')).toBe(
      '05_kitchen.jpeg',
    );
  });

  it('{n:1} gives at least 1 digit (no leading zero for single digit)', () => {
    expect(buildOutputName(3, 'kitchen', T, 'UTC', undefined, '{n:1}')).toBe('3.jpeg');
  });

  it('{n:1} still pads when number exceeds width', () => {
    expect(buildOutputName(42, 'kitchen', T, 'UTC', undefined, '{n:1}')).toBe('42.jpeg');
  });

  it('{n:5} pads a 3-digit number to 5 digits', () => {
    expect(buildOutputName(123, 'kitchen', T, 'UTC', undefined, '{n:5}')).toBe('00123.jpeg');
  });

  it('bare {n} still pads to 3 (backward compat)', () => {
    expect(buildOutputName(7, 'kitchen', T, 'UTC', undefined, '{n}')).toBe('007.jpeg');
  });
});

describe('buildOutputName — {date:FORMAT} custom date token', () => {
  it('{date:YYYY-MM-DD} renders ISO date', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{date:YYYY-MM-DD}')).toBe(
      '001_2024-06-15.jpeg',
    );
  });

  it('{date:DD/MM/YYYY} renders European format', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{date:DD/MM/YYYY}')).toBe(
      '001_15/06/2024.jpeg',
    );
  });

  it('{date:MM-DD-YY} renders US short format', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{date:MM-DD-YY}')).toBe(
      '001_06-15-24.jpeg',
    );
  });

  it('{date:YYYY} renders year only', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{date:YYYY}')).toBe(
      '001_2024.jpeg',
    );
  });

  it('{date:D-M-YYYY} renders without zero-padding', () => {
    // T = 2024-06-15 → D=15, M=6
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{date:D-M-YYYY}')).toBe(
      '15-6-2024.jpeg',
    );
  });

  it('bare {date} still renders DD-MM-YYYY (backward compat)', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{date}')).toBe('15-06-2024.jpeg');
  });
});

describe('buildOutputName — {datetime:FORMAT} custom datetime token', () => {
  it('{datetime:YYYY-MM-DD_HH-mm} renders ISO-like datetime', () => {
    expect(
      buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{n}_{datetime:YYYY-MM-DD_HH-mm}'),
    ).toBe('001_2024-06-15_12-00.jpeg');
  });

  it('{datetime:HH:mm} renders time only', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{datetime:HH:mm}')).toBe(
      '12:00.jpeg',
    );
  });

  it('{datetime:YYYY/MM/DD HH-mm-ss} renders full timestamp', () => {
    expect(
      buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{datetime:YYYY/MM/DD HH-mm-ss}'),
    ).toBe('2024/06/15 12-00-00.jpeg');
  });

  it('bare {datetime} still renders DD-MM-YYYY_HH-MM (backward compat)', () => {
    expect(buildOutputName(1, 'kitchen', T, 'UTC', undefined, '{datetime}')).toBe(
      '15-06-2024_12-00.jpeg',
    );
  });
});

describe('applyDateFormat', () => {
  const d = new Date(2024, 5, 15, 9, 5, 3); // 2024-06-15 09:05:03 local

  it('YYYY → 4-digit year', () => expect(applyDateFormat(d, 'YYYY')).toBe('2024'));
  it('YY → 2-digit year', () => expect(applyDateFormat(d, 'YY')).toBe('24'));
  it('MM → zero-padded month', () => expect(applyDateFormat(d, 'MM')).toBe('06'));
  it('M → unpadded month', () => expect(applyDateFormat(d, 'M')).toBe('6'));
  it('DD → zero-padded day', () => expect(applyDateFormat(d, 'DD')).toBe('15'));
  it('D → unpadded day', () => expect(applyDateFormat(d, 'D')).toBe('15'));
  it('HH → zero-padded hour', () => expect(applyDateFormat(d, 'HH')).toBe('09'));
  it('H → unpadded hour', () => expect(applyDateFormat(d, 'H')).toBe('9'));
  it('mm → zero-padded minute', () => expect(applyDateFormat(d, 'mm')).toBe('05'));
  it('m → unpadded minute', () => expect(applyDateFormat(d, 'm')).toBe('5'));
  it('ss → zero-padded second', () => expect(applyDateFormat(d, 'ss')).toBe('03'));
  it('s → unpadded second', () => expect(applyDateFormat(d, 's')).toBe('3'));

  it('YYYY-MM-DD', () => expect(applyDateFormat(d, 'YYYY-MM-DD')).toBe('2024-06-15'));
  it('DD.MM.YYYY', () => expect(applyDateFormat(d, 'DD.MM.YYYY')).toBe('15.06.2024'));
  it('YYYY-MM-DD HH:mm:ss', () =>
    expect(applyDateFormat(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2024-06-15 09:05:03'));
  it('MM/DD/YY', () => expect(applyDateFormat(d, 'MM/DD/YY')).toBe('06/15/24'));

  it('YYYY does not get re-processed by YY replacement', () =>
    expect(applyDateFormat(d, 'YYYY/YY')).toBe('2024/24'));
  it('MM does not get re-processed by M replacement', () =>
    expect(applyDateFormat(d, 'MM/M')).toBe('06/6'));
});
