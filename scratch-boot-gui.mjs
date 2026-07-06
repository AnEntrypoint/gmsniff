import { createServer } from './src/server.js';
const { url } = await createServer({ port: 0, host: '127.0.0.1' });
process.stdout.write(url + '\n');
