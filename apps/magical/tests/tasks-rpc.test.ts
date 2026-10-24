import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  CALENDAR_ORIGIN,
  TASKS_SYNC_URL,
  sapisidHash,
  tasksReadBody,
  tasksSyncHeaders,
} from '../src/tasks-rpc.js';

describe('sapisidHash', () => {
  it('signs the Gaia ID, the timestamp, the cookie and the origin', () => {
    const gaia = '100000000000000000001';
    const timestamp = 1791730860;
    const sapisid = 'sapisid-cookie-value';
    const expected = crypto
      .createHash('sha1')
      .update(`${gaia} ${timestamp} ${sapisid} ${CALENDAR_ORIGIN}`)
      .digest('hex');

    expect(sapisidHash(gaia, sapisid, timestamp)).toBe(`SAPISIDHASH ${timestamp}_${expected}_u`);
  });

  it('pins the preimage, which is what the endpoint rejects when it is wrong', () => {
    // The Gaia ID is in front. The older `<timestamp> <sapisid> <origin>` form this RPC
    // does not accept, and a hash that omits it answers 401 however well formed the rest
    // of the request is.
    expect(sapisidHash('100000000000000000001', 'A'.repeat(34), 1791730860)).toBe(
      'SAPISIDHASH 1791730860_79853e29029738477683d3ff54d2ff375d3dc206_u',
    );
  });
});

describe('tasksSyncHeaders', () => {
  const auth = {
    partition: 'persist:test',
    gaiaId: '100000000000000000001',
    accountIndex: 2,
    apiKey: 'page_api_key',
  };

  it('carries the origin, the account index and the API key', () => {
    const headers = tasksSyncHeaders(auth, 'sapisid', 1791730860);
    expect(headers['Origin']).toBe(CALENDAR_ORIGIN);
    expect(headers['X-Goog-AuthUser']).toBe('2');
    expect(headers['X-Goog-Api-Key']).toBe('page_api_key');
    expect(headers['Content-Type']).toBe('application/json+protobuf');
    expect(headers['Authorization']).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);
  });

  it('omits the API key until the page has been read', () => {
    const headers = tasksSyncHeaders({ ...auth, apiKey: undefined }, 'sapisid', 1791730860);
    expect(headers['X-Goog-Api-Key']).toBeUndefined();
  });
});

describe('tasksReadBody', () => {
  it('keys the read by the Gaia ID', () => {
    expect(JSON.stringify(tasksReadBody('111'))).toContain('"111"');
  });

  it('names the one RPC both the read and the write post to', () => {
    expect(TASKS_SYNC_URL).toContain('TasksApiService/Sync');
  });
});
