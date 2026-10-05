import fs from 'node:fs';
import crypto from 'node:crypto';
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export function writeJson(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export function args(argv = process.argv.slice(2)) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null || argv[i + 1].startsWith('--') || Object.hasOwn(result, argv[i].slice(2))) throw Error('Use unique --name value arguments');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
