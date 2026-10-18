import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../page-title-boundary.test.ts'));
