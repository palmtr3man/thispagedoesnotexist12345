import { withLambda } from '@netlify/aws-lambda-compat';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('./lib/manual-alignment-loop-impl.cjs');

export default withLambda(handler);
