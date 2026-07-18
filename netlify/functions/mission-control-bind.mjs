import { withLambda } from '@netlify/aws-lambda-compat';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('./lib/mission-control-bind-impl.cjs');

export default withLambda(handler);
