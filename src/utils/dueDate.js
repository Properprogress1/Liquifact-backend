/**
 * Strict due-date parser that requires an explicit timezone, rejects
 * impossible calendar values, and normalizes the result to UTC.
 *
 * This prevents silent coercion between client and worker clocks.
 */

// The regex is anchored and bounded; quantifiers are fixed-width, so it is safe.
// eslint-disable-next-line security/detect-unsafe-regex
const ISO_DATE_REGEX = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<ms>\d{1,3}))?(?<offset>Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Determines whether a year is a leap year in the Gregorian calendar.
 *
 * @param {number} year - The year to evaluate.
 * @returns {boolean} True when the year is a leap year.
 */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Returns the maximum valid day for the given month and year.
 *
 * @param {number} year - The full year.
 * @param {number} month - One-based month (1-12).
 * @returns {number} The number of days in that month.
 */
function getDaysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return DAYS_IN_MONTH[month - 1];
}

/**
 * Parses an ISO 8601 due date with an explicit offset or 'Z' and returns the
 * normalized UTC value. Missing values are allowed; malformed or ambiguous
 * values are rejected with a stable error message.
 *
 * @param {string | null | undefined} value - The raw due date from the client.
 * @param {number} [now=Date.now()] - Reference time used to reject past dates.
 * @returns {{ dueDateUTC: string | null, error: string | null }} The normalized
 *   UTC ISO 8601 string, or a field-level error message.
 */
function parseDueDate(value, now = Date.now()) {
  if (value === undefined || value === null) {
    return { dueDateUTC: null, error: null };
  }

  if (typeof value !== 'string') {
    return { dueDateUTC: null, error: 'Due date must be a string' };
  }

  const match = ISO_DATE_REGEX.exec(value);

  if (!match) {
    return {
      dueDateUTC: null,
      error:
        'Due date must be an ISO 8601 string with an explicit timezone or Z (e.g. 2026-08-30T10:00:00Z)',
    };
  }

  const groups = match.groups;

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second);
  const ms = groups.ms ? Number(groups.ms.padEnd(3, '0')) : 0;

  if (
    month < 1 ||
    month > 12 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    ms < 0 ||
    ms > 999
  ) {
    return { dueDateUTC: null, error: 'Due date contains an out-of-range value' };
  }

  if (day < 1 || day > getDaysInMonth(year, month)) {
    return { dueDateUTC: null, error: 'Due date is not a valid calendar date' };
  }

  let offsetMinutes = 0;

  if (groups.offset !== 'Z') {
    const sign = groups.offset[0] === '+' ? 1 : -1;
    const [offsetHours, offsetMins] = groups.offset
      .slice(1)
      .split(':')
      .map(Number);

    if (offsetHours > 23 || offsetMins > 59) {
      return { dueDateUTC: null, error: 'Due date has an invalid timezone offset' };
    }

    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;

  if (Number.isNaN(timestamp)) {
    return { dueDateUTC: null, error: 'Due date could not be normalized to UTC' };
  }

  if (timestamp <= now) {
    return { dueDateUTC: null, error: 'Due date must be in the future' };
  }

  return { dueDateUTC: new Date(timestamp).toISOString(), error: null };
}

module.exports = {
  parseDueDate,
};
