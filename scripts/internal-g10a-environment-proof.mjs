const FORMAT = 'passhub.g10a.environment-proof.v1';
export const G10A_ENVIRONMENT_PROOF_PREFIX = 'G10A_ENVIRONMENT_PROOF=';

const EXPECTED_NODE_VERSION = '24.21.0';
const EXPECTED_MONGO_VERSION = '8.0.32';
const EXPECTED_REPLICA_SET = 'rs0';

/**
 * Collect the minimal facts needed to prove the integration environment while
 * its containers are still live.  Capture output is deliberately consumed
 * here and reduced to this closed, non-secret summary; callers never receive
 * a URI, command reply, container id, or raw stdout.
 */
export async function collectG10aEnvironmentProof({ captureCommand, nodeImage, compose } = {}) {
  if (typeof captureCommand !== 'function') throw new TypeError('G10a environment proof requires a command capture seam');
  if (typeof nodeImage !== 'string' || nodeImage.length === 0) throw new TypeError('G10a environment proof requires a pinned Node image');
  if (!Array.isArray(compose) || compose.some((value) => typeof value !== 'string' || value.length === 0)) throw new TypeError('G10a environment proof requires a compose command');

  const node = await captureCommand('docker', ['run', '--rm', '--network', 'host', nodeImage, 'node', '--version']);
  if (!isSuccessfulCapture(node) || !isExactNodeVersion(node.stdout)) throw new Error('G10a environment proof could not verify Node 24.21.0');

  const mongo = await captureCommand('docker', [
    ...compose,
    'exec', '-T', 'mongo-g04b', 'mongosh', '--quiet', '--port', '27029', '--eval',
    "const build = db.adminCommand({ buildInfo: 1 }); const hello = db.adminCommand({ hello: 1 }); print(JSON.stringify({ version: build.version, setName: hello.setName, isWritablePrimary: hello.isWritablePrimary }));",
  ]);
  if (!isSuccessfulCapture(mongo)) throw new Error('G10a environment proof could not verify MongoDB 8.0.32 rs0 primary');
  const mongoFacts = parseMongoFacts(mongo.stdout);
  if (mongoFacts === undefined || mongoFacts.version !== EXPECTED_MONGO_VERSION || mongoFacts.setName !== EXPECTED_REPLICA_SET || mongoFacts.isWritablePrimary !== true) {
    throw new Error('G10a environment proof could not verify MongoDB 8.0.32 rs0 primary');
  }

  return freezeProof({
    format: FORMAT,
    nodeVersion: EXPECTED_NODE_VERSION,
    mongoVersion: EXPECTED_MONGO_VERSION,
    replicaSet: EXPECTED_REPLICA_SET,
    writablePrimary: true,
  });
}

export function parseG10aEnvironmentProofFromOutput(output) {
  if (typeof output !== 'string') return undefined;
  const lines = output.split(/\r?\n/u).filter((line) => line.startsWith(G10A_ENVIRONMENT_PROOF_PREFIX));
  if (lines.length !== 1) return undefined;
  const encoded = lines[0].slice(G10A_ENVIRONMENT_PROOF_PREFIX.length);
  try {
    return freezeProof(JSON.parse(encoded));
  } catch {
    return undefined;
  }
}

export function writeG10aEnvironmentProof(proof, write = (line) => process.stdout.write(line)) {
  const safe = freezeProof(proof);
  write(`${G10A_ENVIRONMENT_PROOF_PREFIX}${JSON.stringify(safe)}\n`);
}

export function assertG10aEnvironmentProof(proof) {
  return freezeProof(proof);
}

function isSuccessfulCapture(value) {
  return value !== null && typeof value === 'object' && value.code === 0 && typeof value.stdout === 'string';
}

function isExactNodeVersion(value) {
  return /^v24\.21\.0\r?\n?$/u.test(value);
}

function parseMongoFacts(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value.trim());
    if (!isExactPlainObject(parsed, ['version', 'setName', 'isWritablePrimary'])) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function freezeProof(value) {
  if (!isExactPlainObject(value, ['format', 'nodeVersion', 'mongoVersion', 'replicaSet', 'writablePrimary'])) throw new Error('G10a environment proof is invalid');
  if (value.format !== FORMAT || value.nodeVersion !== EXPECTED_NODE_VERSION || value.mongoVersion !== EXPECTED_MONGO_VERSION || value.replicaSet !== EXPECTED_REPLICA_SET || value.writablePrimary !== true) {
    throw new Error('G10a environment proof is invalid');
  }
  return Object.freeze({
    format: FORMAT,
    nodeVersion: EXPECTED_NODE_VERSION,
    mongoVersion: EXPECTED_MONGO_VERSION,
    replicaSet: EXPECTED_REPLICA_SET,
    writablePrimary: true,
  });
}

function isExactPlainObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
