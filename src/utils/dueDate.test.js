const { parseDueDate } = require('./dueDate');

describe('parseDueDate', () => {
  const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

  it('returns null when the due date is missing', () => {
    const result = parseDueDate(undefined, fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBeNull();
  });

  it('returns null when the due date is explicitly null', () => {
    const result = parseDueDate(null, fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBeNull();
  });

  it('rejects non-string values', () => {
    const result = parseDueDate(12345, fixedNow);
    expect(result.error).toBe('Due date must be a string');
  });

  it('rejects a date without an explicit timezone', () => {
    const result = parseDueDate('2099-08-30T10:00:00', fixedNow);
    expect(result.error).toContain('explicit timezone');
  });

  it('rejects an impossible calendar date', () => {
    const result = parseDueDate('2099-02-30T00:00:00Z', fixedNow);
    expect(result.error).toBe('Due date is not a valid calendar date');
  });

  it('rejects an invalid month', () => {
    const result = parseDueDate('2099-13-01T00:00:00Z', fixedNow);
    expect(result.error).toContain('out-of-range');
  });

  it('rejects an out-of-range time', () => {
    const result = parseDueDate('2099-08-30T25:00:00Z', fixedNow);
    expect(result.error).toContain('out-of-range');
  });

  it('normalizes a UTC input', () => {
    const result = parseDueDate('2099-08-30T10:00:00Z', fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2099-08-30T10:00:00.000Z');
  });

  it('normalizes a positive offset to UTC', () => {
    const result = parseDueDate('2099-08-30T10:00:00+02:00', fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2099-08-30T08:00:00.000Z');
  });

  it('normalizes a negative offset to UTC', () => {
    const result = parseDueDate('2099-08-30T10:00:00-05:00', fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2099-08-30T15:00:00.000Z');
  });

  it('handles fractional seconds', () => {
    const result = parseDueDate('2099-08-30T10:00:00.5Z', fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2099-08-30T10:00:00.500Z');
  });

  it('handles a DST spring-forward gap with an explicit offset', () => {
    const result = parseDueDate('2027-03-14T02:30:00-05:00', fixedNow);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2027-03-14T07:30:00.000Z');
  });

  it('distinguishes a DST fall-back duplicate hour by offset', () => {
    const first = parseDueDate('2027-11-07T01:30:00-04:00', fixedNow);
    const second = parseDueDate('2027-11-07T01:30:00-05:00', fixedNow);

    expect(first.dueDateUTC).toBe('2027-11-07T05:30:00.000Z');
    expect(second.dueDateUTC).toBe('2027-11-07T06:30:00.000Z');
  });

  it('rejects a past due date', () => {
    const now = Date.parse('2099-01-01T00:00:00.000Z');
    const result = parseDueDate('2098-12-31T23:59:59.999Z', now);
    expect(result.error).toBe('Due date must be in the future');
  });

  it('rejects a due date exactly at the boundary', () => {
    const now = Date.parse('2099-01-01T00:00:00.000Z');
    const result = parseDueDate('2099-01-01T00:00:00.000Z', now);
    expect(result.error).toBe('Due date must be in the future');
  });

  it('accepts a due date one millisecond after the boundary', () => {
    const now = Date.parse('2099-01-01T00:00:00.000Z');
    const result = parseDueDate('2099-01-01T00:00:00.001Z', now);
    expect(result.error).toBeNull();
    expect(result.dueDateUTC).toBe('2099-01-01T00:00:00.001Z');
  });
});
