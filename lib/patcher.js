import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const definitions = JSON.parse(fs.readFileSync(new URL('./patches.json', import.meta.url), 'utf8'));
const packageName = '@goodandready/dsh-subscriptions';
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const count = (text, part) => text.split(part).length - 1;

export function resolveTarget({ target, profileDir = process.env.DSH_PROFILE_DIR } = {}) {
  if (target) return fs.realpathSync(target);
  const bases = [profileDir, process.cwd(), path.dirname(fileURLToPath(import.meta.url))].filter(Boolean);
  for (const base of bases) {
    try {
      const require = createRequire(path.join(base, '__kimi_guard_resolve__.cjs'));
      return fs.realpathSync(path.dirname(require.resolve(`${packageName}/package.json`)));
    } catch { /* Try only known package resolution roots; do not search user directories. */ }
  }
  throw new Error('Subscriptions package not found. Pass --target /path/to/@goodandready/dsh-subscriptions or set DSH_PROFILE_DIR.');
}

function fileFor(root, relative) {
  const file = path.join(root, relative);
  const real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error(`Target escaped package root: ${relative}`);
  return real;
}

export function inspect(options = {}) {
  const root = resolveTarget(options);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== packageName) throw new Error(`Unexpected target package: ${pkg.name}`);
  const files = definitions.map(def => {
    const file = fileFor(root, def.file);
    const original = fs.readFileSync(file, 'utf8');
    const before = count(original, def.before), after = count(original, def.after);
    const state = before === 1 && after === 0 ? 'needs-patch' : before === 0 && after === 1 ? 'already-fixed' : 'unsupported';
    return { relative: def.file, file, state, beforeHash: digest(original), afterHash: digest(state === 'needs-patch' ? original.replace(def.before, def.after) : original), original, patched: state === 'needs-patch' ? original.replace(def.before, def.after) : original, mode: fs.statSync(file).mode & 0o777 };
  });
  return { root, package: pkg.name, version: pkg.version, compatible: files.every(f => f.state !== 'unsupported'), files };
}

export function summary(report) {
  return { root: report.root, package: report.package, version: report.version, compatible: report.compatible, files: report.files.map(({relative,state,beforeHash,afterHash}) => ({file:relative,state,beforeHash,afterHash})) };
}

function atomicWrite(file, bytes, mode = 0o600) {
  const temp = `${file}.kimi-guard-${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, bytes, {mode, flag:'wx'}); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function statePaths(root, options) {
  const base = options.backupDir || path.join(os.homedir(), '.dsh', 'state', 'kimi-channel-guard');
  const dir = path.join(path.resolve(base), digest(root).slice(0,24));
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  return {dir, lock:path.join(dir,'lock')};
}

function withLock(paths, fn) {
  try { fs.mkdirSync(paths.lock); } catch { throw new Error(`Another operation or stale lock exists: ${paths.lock}. Verify no operation is running before removing it.`); }
  try { return fn(); } finally { fs.rmdirSync(paths.lock); }
}

export function applyPatch(options = {}) {
  const initial = inspect(options);
  if (!initial.compatible) throw new Error('Unsupported source structure. No files changed; this release recognizes the 0.7.55 function shapes only.');
  if (initial.files.every(f => f.state === 'already-fixed')) return {...summary(initial), changed:false, restartRequired:false};
  const paths = statePaths(initial.root, options);
  return withLock(paths, () => {
    const report = inspect({...options,target:initial.root});
    if (!report.compatible) throw new Error('Target changed during preflight. No files changed.');
    const changed = report.files.filter(f => f.state === 'needs-patch');
    if (!changed.length) return {...summary(report),changed:false,restartRequired:false};
    const run = path.join(paths.dir, crypto.randomUUID());
    fs.mkdirSync(run, {mode:0o700});
    const receiptPath = path.join(run,'receipt.json');
    const receipt = {format:1,root:report.root,package:report.package,version:report.version,state:'prepared',createdAt:new Date().toISOString(),files:changed.map((f,i) => ({relative:f.relative,beforeHash:f.beforeHash,afterHash:f.afterHash,mode:f.mode,backup:`${i}.original`}))};
    changed.forEach((f,i) => fs.writeFileSync(path.join(run,`${i}.original`),f.original,{mode:0o600,flag:'wx'}));
    const save = () => atomicWrite(receiptPath, JSON.stringify(receipt,null,2)+'\n');
    save();
    const applied = [];
    try {
      for (const f of changed) {
        if (digest(fs.readFileSync(f.file)) !== f.beforeHash) throw new Error(`Concurrent edit: ${f.relative}`);
        atomicWrite(f.file,f.patched,f.mode); applied.push(f);
      }
      if (!inspect({target:report.root}).files.every(f => f.state === 'already-fixed')) throw new Error('Readback verification failed');
      receipt.state='applied'; save();
    } catch (error) {
      for (const f of applied.reverse()) {
        if (digest(fs.readFileSync(f.file)) !== f.afterHash) throw new Error(`Rollback stopped on concurrent edit; restore manually from ${receiptPath}: ${error.message}`);
        atomicWrite(f.file,f.original,f.mode);
      }
      receipt.state='rolled-back'; save(); throw error;
    }
    return {...summary(report),changed:true,restartRequired:true,receipt:receiptPath};
  });
}

export function restorePatch(receiptPath, options = {}) {
  receiptPath = fs.realpathSync(receiptPath);
  const receipt = JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  if (receipt.format !== 1 || receipt.package !== packageName || !Array.isArray(receipt.files) || !receipt.files.length) throw new Error('Invalid backup receipt');
  const root = resolveTarget({target:receipt.root});
  if (options.target && root !== resolveTarget({target:options.target})) throw new Error('Receipt belongs to another target');
  const paths = statePaths(root,options);
  return withLock(paths, () => {
    const rows = receipt.files.map(f => {
      if (!definitions.some(d => d.file === f.relative) || !/^\d+\.original$/.test(f.backup)) throw new Error('Invalid receipt path');
      const file = fileFor(root,f.relative), original=fs.readFileSync(path.join(path.dirname(receiptPath),f.backup));
      if (digest(original)!==f.beforeHash) throw new Error(`Backup digest mismatch: ${f.relative}`);
      const now=digest(fs.readFileSync(file));
      if (now!==f.afterHash && now!==f.beforeHash) throw new Error(`Target was edited or updated since patching: ${f.relative}. Restore stopped before writing.`);
      return {...f,file,original,now};
    });
    for (const f of rows) if (f.now!==f.beforeHash) atomicWrite(f.file,f.original,f.mode);
    receipt.state='restored'; atomicWrite(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    return {restored:true,root,restartRequired:rows.some(f=>f.now!==f.beforeHash)};
  });
}
