#!/usr/bin/env node
import { inspect, summary, applyPatch, restorePatch } from '../lib/patcher.js';
const args=process.argv.slice(2), command=args.shift() || 'check';
const options={}; let receipt;
try {
  while(args.length) {
    const key=args.shift();
    if (!['--target','--profile-dir','--backup-dir','--receipt'].includes(key) || !args.length) throw new Error(`Unknown or incomplete option: ${key}`);
    const value=args.shift();
    if(key==='--receipt') receipt=value;
    else options[{'--target':'target','--profile-dir':'profileDir','--backup-dir':'backupDir'}[key]]=value;
  }
  let result;
  if(command==='check') { result=summary(inspect(options)); if(!result.compatible) process.exitCode=2; }
  else if(command==='apply') result=applyPatch(options);
  else if(command==='restore' && receipt) result=restorePatch(receipt,options);
  else throw new Error('Usage: dsh-kimi-channel-guard check|apply [--target PACKAGE_DIR] [--profile-dir PROFILE_DIR] [--backup-dir DIR]; restore --receipt FILE');
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(`[kimi-channel-guard] ${error.message}`); process.exitCode=1; }
