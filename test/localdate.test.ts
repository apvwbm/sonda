import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidTimeZone, toLocalDate } from '../src/lib/localdate.ts';

const MADRID = 'Europe/Madrid';

describe('toLocalDate', () => {
  describe('the case that justifies the column', () => {
    it('23:30 UTC is already the next day in Madrid', () => {
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', MADRID), '2026-09-06');
    });

    it('00:30 UTC is still the same day in Madrid', () => {
      assert.equal(toLocalDate('2026-09-05T00:30:00Z', MADRID), '2026-09-05');
    });

    it('the same instant written with an offset gives the same day', () => {
      assert.equal(
        toLocalDate('2026-09-06T01:30:00+02:00', MADRID),
        toLocalDate('2026-09-05T23:30:00Z', MADRID),
      );
    });
  });

  describe('October DST change in Madrid (2026-10-25, 03:00 CEST -> 02:00 CET)', () => {
    it('before the change, 22:30 UTC is already the 25th (CEST, +2)', () => {
      assert.equal(toLocalDate('2026-10-24T22:30:00Z', MADRID), '2026-10-25');
    });

    it('after the change, 22:30 UTC is still the 25th (CET, +1)', () => {
      // Exactly 24 hours later and the same local date: the offset shrank by an
      // hour along the way. When this breaks, the bug is one nobody sees.
      assert.equal(toLocalDate('2026-10-25T22:30:00Z', MADRID), '2026-10-25');
    });

    it('the ambiguous hour (02:30 local, twice) lands on the same day both times', () => {
      assert.equal(toLocalDate('2026-10-25T00:30:00Z', MADRID), '2026-10-25'); // CEST
      assert.equal(toLocalDate('2026-10-25T01:30:00Z', MADRID), '2026-10-25'); // CET
    });

    it('rolls over to the 26th an hour later than it would have before', () => {
      assert.equal(toLocalDate('2026-10-25T23:30:00Z', MADRID), '2026-10-26');
    });
  });

  describe('March DST change in Madrid (2026-03-29, 02:00 CET -> 03:00 CEST)', () => {
    it('23:30 UTC on the 28th is already the 29th (CET, +1)', () => {
      assert.equal(toLocalDate('2026-03-28T23:30:00Z', MADRID), '2026-03-29');
    });

    it('the spring-forward jump does not change the day', () => {
      assert.equal(toLocalDate('2026-03-29T00:59:00Z', MADRID), '2026-03-29'); // 01:59 CET
      assert.equal(toLocalDate('2026-03-29T01:00:00Z', MADRID), '2026-03-29'); // 03:00 CEST
    });
  });

  describe('offsets that are not whole hours', () => {
    it('Asia/Kolkata (+05:30) rolls over at 18:30 UTC', () => {
      assert.equal(toLocalDate('2026-09-05T18:29:59Z', 'Asia/Kolkata'), '2026-09-05');
      assert.equal(toLocalDate('2026-09-05T18:30:00Z', 'Asia/Kolkata'), '2026-09-06');
    });

    it('Pacific/Chatham (+12:45) rolls over at 11:15 UTC', () => {
      assert.equal(toLocalDate('2026-09-05T11:14:00Z', 'Pacific/Chatham'), '2026-09-05');
      assert.equal(toLocalDate('2026-09-05T11:15:00Z', 'Pacific/Chatham'), '2026-09-06');
    });
  });

  describe('extremes of the offset range', () => {
    it('Pacific/Kiritimati (+14) runs a day ahead of UTC', () => {
      assert.equal(toLocalDate('2026-09-05T10:00:00Z', 'Pacific/Kiritimati'), '2026-09-06');
    });

    it('Pacific/Niue (-11) runs a day behind UTC', () => {
      assert.equal(toLocalDate('2026-09-05T10:00:00Z', 'Pacific/Niue'), '2026-09-04');
    });

    it('UTC returns the date part unchanged', () => {
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', 'UTC'), '2026-09-05');
    });
  });

  describe('output format', () => {
    it('pads month and day to two digits', () => {
      assert.equal(toLocalDate('2026-01-02T12:00:00Z', MADRID), '2026-01-02');
    });

    it('crosses the year boundary correctly', () => {
      assert.equal(toLocalDate('2026-12-31T23:30:00Z', MADRID), '2027-01-01');
    });

    it('accepts omitted seconds and fractional seconds', () => {
      assert.equal(toLocalDate('2026-09-05T23:30Z', MADRID), '2026-09-06');
      assert.equal(toLocalDate('2026-09-05T23:30:00.123Z', MADRID), '2026-09-06');
    });

    it('is deterministic across calls, so the cached formatter stays clean', () => {
      const first = toLocalDate('2026-09-05T23:30:00Z', MADRID);
      toLocalDate('2026-09-05T23:30:00Z', 'Asia/Kolkata');
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', MADRID), first);
    });
  });

  describe('invalid input must fail rather than return some date', () => {
    it('rejects a time zone that does not exist', () => {
      assert.throws(() => toLocalDate('2026-09-05T23:30:00Z', 'Mars/Olympus'), {
        name: 'RangeError',
        message: /Mars\/Olympus/,
      });
    });

    it('rejects an empty time zone', () => {
      assert.throws(() => toLocalDate('2026-09-05T23:30:00Z', ''), RangeError);
    });

    it('rejects an instant with no zone designator', () => {
      // The dangerous one: Date would take it as the server's local time.
      assert.throws(() => toLocalDate('2026-09-05T23:30:00', MADRID), {
        name: 'RangeError',
        message: /explicit zone/,
      });
    });

    it('rejects a date with no time', () => {
      assert.throws(() => toLocalDate('2026-09-05', MADRID), RangeError);
    });

    it('rejects text that is not a date', () => {
      assert.throws(() => toLocalDate('yesterday afternoon', MADRID), RangeError);
      assert.throws(() => toLocalDate('', MADRID), RangeError);
    });

    it('rejects days that do not exist instead of overflowing into the next month', () => {
      // new Date('2026-02-30') silently returns March 2nd. Without this guard
      // the observation would be filed under a day nobody asked for.
      for (const impossible of [
        '2026-02-30T12:00:00Z',
        '2026-02-29T12:00:00Z', // 2026 is not a leap year
        '2026-04-31T12:00:00Z',
        '2026-06-31T12:00:00Z',
      ]) {
        assert.throws(
          () => toLocalDate(impossible, MADRID),
          { name: 'RangeError', message: /is not a real date/ },
          impossible,
        );
      }
    });

    it('accepts February 29th in a leap year', () => {
      assert.equal(toLocalDate('2024-02-29T12:00:00Z', MADRID), '2024-02-29');
    });

    it('rejects out-of-range month, day and hour', () => {
      for (const outOfRange of [
        '2026-13-01T12:00:00Z',
        '2026-00-10T12:00:00Z',
        '2026-09-00T12:00:00Z',
        '2026-09-05T25:00:00Z',
        '2026-09-05T23:61:00Z',
      ]) {
        assert.throws(() => toLocalDate(outOfRange, MADRID), RangeError, outOfRange);
      }
    });
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    for (const tz of ['Europe/Madrid', 'UTC', 'Asia/Kolkata', 'Pacific/Chatham']) {
      assert.equal(isValidTimeZone(tz), true, tz);
    }
  });

  it('rejects everything else', () => {
    for (const tz of ['Mars/Olympus', '', 'CEST', 'Europe/Madridd']) {
      assert.equal(isValidTimeZone(tz), false, JSON.stringify(tz));
    }
  });
});
