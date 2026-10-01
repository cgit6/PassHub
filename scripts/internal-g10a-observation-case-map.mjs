import { CATEGORY_CASE_CODES } from './internal-g10a-evidence.mjs';

const PHASES = Object.freeze(['test:g10a:unit', 'test:g10a:socket', 'test:g10a:integration']);

// This is intentionally a private, source-controlled allowlist.  A reporter
// must see every entry for its phase exactly once; it never derives case IDs
// from Jest titles.  Paths are Jest's compiled `dist` paths, not source paths.
//
const CASES = [
  ['G10A_SOCKET_PATH', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-socket-path.test.js', 'G10a A11.2 private runtime-control socket path is private and creates only a missing direct child directory at 0700'],
  ['G10A_SOCKET_LISTENER', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-socket-listener.test.js', 'G10a A11.3a private AF_UNIX control listener lifecycle is private, creates a 0600 socket, invokes only its transport callback, and closes idempotently'],
  ['G10A_SOCKET_FRAMING', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-socket-framing.test.js', 'G10a A11.3b AF_UNIX control framing adapter waits for client EOF, then writes exactly one bounded NDJSON response and closes'],
  ['G10A_SOCKET_PROTOCOL', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-protocol.test.js', 'G10a A11.1 runtime control protocol core keeps the protocol private and free of net/fs/socket dependencies'],
  ['G10A_SOCKET_SERVICE', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-socket-service.test.js', 'G10a A11.4 private runtime-control service composition wires trusted control, strict AF_UNIX listener, framing, and protocol without public export'],
  ['G10A_SOCKET_CLI', 'test:g10a:socket', 'dist/test/socket/g10a-runtime-control-cli.test.js', 'G10a private control CLI sends exactly one EOF-delimited request and returns a strict successful response unchanged'],
  ['G10A_SOCKET_WATCHDOG', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-socket-service.test.js', 'G10a A11.4 private runtime-control service composition aborts a controllable LOGS_READ after the two-second processing watchdog without a late response'],
  ['G10A_ROTATION_FILE_STORE', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-file-store.test.js', 'G10a A10.4 private runtime log file store is private and initializes a fresh 0700 directory plus a 0600 active file'],
  ['G10A_ROTATION_ARCHIVE', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-file-store.test.js', 'G10a A10.4 private runtime log file store rotates sparse archives in fixed .4 delete, descending rename, active-to-.1 order'],
  ['G10A_ROTATION_READER', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-reader.test.js', 'G10a A10.5 private runtime log reader takes an oldest-to-active snapshot, filters one operation, and returns the latest bounded records chronologically'],
  ['G10A_ROTATION_HEALTH', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-health-blackbox.test.js', 'G10a A10.3 runtime log health black-box behavior a real driver failure updates only fresh logging snapshots; a cached snapshot and hold semantics remain intact'],
  ['G10A_ROTATION_SINK', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-sink.test.js', 'G10a A10.2 private bounded runtime log sink flush succeeds when idle and never waits longer than the configured <=2 second bound'],
  ['G10A_CONTROL_STATUS', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-live-counters.test.js', 'G10a STATUS reads blocked/unknown writer and actual registry UNKNOWN through nominal internal metrics'],
  ['G10A_CONTROL_HOLD_RELEASE', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control.test.js', 'G10a A1 runtime identity/control core hold/release transition increments revision and supports manual+maintenance phases'],
  ['G10A_CONTROL_DRAIN', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control.test.js', 'G10a A1 runtime identity/control core drain waits for both issued persistence and active query leases before becoming DRAINED'],
  ['G10A_CONTROL_REPLAY', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control.test.js', 'G10a A1 runtime identity/control core replays exact last mutation and conflicts on same request id with changed payload'],
  ['G10A_CONTROL_LIVE_COUNTERS', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-live-counters.test.js', 'STATUS, HOLD and RELEASE only consume the pushed cache; the nominal source cannot be rebound'],
  ['G10A_CONTROL_LOG_PRODUCERS', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-control-log-producers.test.js', 'G10a D184 control log producers writes only attributable protocol control lifecycle records to the real runtime.log and never duplicates an exact replay'],
  ['G10A_MONGO_DRIVER_MONITORING', 'test:g10a:integration', 'dist/test/integration/g10a-driver-log-mongo.test.js', 'G10a true MongoDB driver command monitoring attributes real insert/find command lifecycle to writer and read identities without command payloads'],
  ['G10A_MONGO_HTTP_MANAGEMENT', 'test:g10a:integration', 'dist/test/integration/g10a-driver-log-mongo.test.js', 'G10a true MongoDB driver command monitoring closes one true HTTP G07→G08→G04b management path and a true query path under the same G10 owner'],
  ['G10A_MONGO_QUERY_DRAIN', 'test:g10a:integration', 'dist/test/integration/g10a-driver-log-mongo.test.js', 'G10a true MongoDB driver command monitoring DRAIN waits for a query that already reached G09 native Mongo work, then keeps the maintenance veto'],
  ['G10A_MONGO_RECOGNITION_RETRY', 'test:g10a:integration', 'dist/test/integration/g10a-recognition-http-mongo.test.js', 'G10a true HTTP/Mongo recognition retry provenance existing-only joins then canonically replays under maintenance without a second registration or Mongo Event'],
  ['G10A_SECRET_LOG_SCHEMA', 'test:g10a:unit', 'dist/test/unit/g10a-runtime-log-schema.test.js', 'G10a A10.1 private runtime log schema fails closed on hostile values passed directly to encode, without invoking getters or toJSON'],
  ['G10A_SECRET_LOG_REDACTION', 'test:g10a:integration', 'dist/test/integration/g10a-driver-log-mongo.test.js', 'G10a true MongoDB driver command monitoring G10A_SECRET_LOG_REDACTION excludes a unique driver-payload canary from raw logs and real LOGS_READ while retaining driver allowlist fields'],
  ['G10A_SECRET_EVIDENCE_BOUNDARY', 'test:g10a:unit', 'dist/test/unit/g10a-evidence.test.js', 'G10a private evidence boundary writes only the closed safe artifact set with reproducible provenance hashes'],
  ['G10A_SECRET_CONTROL_PROTOCOL', 'test:g10a:socket', 'dist/test/socket/g10a-runtime-control-cli.test.js', 'G10a private control CLI does not leak local invalid request bytes and uses closed protocol failure'],
];

const allowlist = new Set(Object.values(CATEGORY_CASE_CODES).flat());
const seenIds = new Set();
const seenObservations = new Set();

export const G10A_EVIDENCE_CASE_MAP = Object.freeze(CASES.map(([id, phase, testFilePath, fullName]) => {
  if (!allowlist.has(id) || !PHASES.includes(phase) || typeof testFilePath !== 'string' || typeof fullName !== 'string' || fullName.length === 0) {
    throw new Error('G10a observation map is invalid');
  }
  const observationKey = `${phase}\u0000${testFilePath}\u0000${fullName}`;
  if (seenIds.has(id) || seenObservations.has(observationKey)) throw new Error('G10a observation map is ambiguous');
  seenIds.add(id);
  seenObservations.add(observationKey);
  return Object.freeze({ id, phase, testFilePath, fullName });
}));
