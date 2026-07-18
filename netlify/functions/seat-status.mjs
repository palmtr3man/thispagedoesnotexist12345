import { withLambda } from '@netlify/aws-lambda-compat';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('./lib/seat-status-impl.cjs');

export default withLambda(handler);
