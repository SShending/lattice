import { VaultRepository } from '../../../runtime/vault/repository.mjs';
import fs from 'node:fs/promises';

const [vaultRoot, stateRoot, readyPath] = process.argv.slice(2);
const repository = new VaultRepository(vaultRoot, { stateRoot });
await repository.initialize();
if (readyPath) await fs.writeFile(readyPath, 'locked\n');
process.stdout.write('locked\n');
setInterval(() => {}, 60_000);
