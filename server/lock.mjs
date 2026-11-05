import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** SQLite's OS file lock is released on crash; no stale-PID deletion race. */
export async function acquireDataLock(directory) {
  const file=join(directory,'.instance.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {const info=await lstat(file+suffix);if(info.isSymbolicLink()||!info.isFile()||info.nlink>1)throw Object.assign(new Error('实例锁或边车文件路径不安全。'),{status:403,code:'UNSAFE_DATA_DIR'});}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  let lock;
  try {
    lock=new DatabaseSync(file);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY);');
  } catch(e) {
    try{lock?.close();}catch{}
    if(e.errcode===5||e.errcode===6||/locked|busy/i.test(e.message))throw Object.assign(new Error('这个数据目录已被另一实例占用。请先关闭该实例。'),{status:409,code:'DATA_LOCKED'});
    throw e;
  }
  let released=false;
  return async()=>{if(released)return;released=true;try{lock.exec('ROLLBACK');}finally{lock.close();}};
}
