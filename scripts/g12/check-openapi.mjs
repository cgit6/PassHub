import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const specPath = resolve(root, 'docs/openapi.json');
const demoPath = resolve(root, 'docs/demo/g12b-curl.md');
if (!existsSync(specPath) || !existsSync(demoPath)) throw new Error('G12B_DOCUMENT_MISSING');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (spec.openapi !== '3.0.3' || spec.info?.title !== 'PassHub Visitor Access API') throw new Error('G12B_OPENAPI_METADATA_INVALID');
const expected = new Set(['/auth/login', '/qualifications', '/qualifications/inside', '/qualifications/{qualificationId}', '/qualifications/{qualificationId}/revoke', '/recognition/attempts', '/events', '/events/{eventId}']);
const actual = new Set(Object.keys(spec.paths ?? {}));
if (actual.size !== expected.size || [...expected].some((path) => !actual.has(path))) throw new Error(`G12B_PATH_SET_INVALID:${[...actual].join(',')}`);
if (Object.keys(spec.paths).some((path) => path.startsWith('/internal'))) throw new Error('G12B_INTERNAL_ROUTE_EXPOSED');
if (!spec.components?.securitySchemes?.humanBearer || !spec.components?.securitySchemes?.sourceCredential) throw new Error('G12B_SECURITY_SCHEMES_MISSING');
const demo = readFileSync(demoPath, 'utf8');
for (const path of ['/qualifications', '/recognition/attempts', '/qualifications/inside', '/events']) if (!demo.includes(path)) throw new Error(`G12B_DEMO_ROUTE_MISSING:${path}`);
if (/curl[^\n]*\/internal|curl[^\n]*reset|curl[^\n]*claim|BEGIN .*PRIVATE KEY/u.test(demo)) throw new Error('G12B_DEMO_SECRET_OR_MAINTENANCE_LEAK');
process.stdout.write(`${JSON.stringify({ gate: 'G12b', status: 'PASS', paths: actual.size, demo: 'curl', internalRoutes: 0 })}\n`);
