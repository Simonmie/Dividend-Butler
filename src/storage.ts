import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State } from './model';
import { validateState } from './validation';

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
export class Store {
  readonly file: string;
  constructor(readonly directory: string) { this.file = join(directory, 'ledger.json'); }
  async read(): Promise<State> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      validateState(parsed); return parsed;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyState();
      throw new Error('账本无法读取或校验失败；原文件未改动，请通过“恢复本地备份”恢复有效备份');
    }
  }
  async transaction(change: (state: State) => void | Promise<void>, expected?: number, recover = false): Promise<State> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, 'ledger.lock');
    const token = randomUUID();
    const deadline = Date.now() + 8000;
    let locked = false;
    while (!locked) {
      try {
        const lock = await fs.open(lockPath, 'wx', 0o600);
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, token, time: Date.now() })); }
        finally { await lock.close(); }
        locked = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        try {
          const text = await fs.readFile(lockPath, 'utf8');
          const owner = JSON.parse(text) as { pid: number; time: number };
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (e) { alive = errorCode(e) !== 'ESRCH'; }
          if (!alive && Date.now() - owner.time > 1000 && await fs.readFile(lockPath, 'utf8') === text) await fs.unlink(lockPath);
        } catch { /* A lock may still be being created or have just been released. */ }
        if (Date.now() >= deadline) throw new Error('另一窗口正在保存，请稍后重试；未覆盖任何数据');
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    }
    try {
      let current: State;
      try { current = await this.read(); }
      catch (error) {
        if (!recover) throw error;
        await fs.copyFile(this.file, join(this.directory, `ledger.corrupt-${Date.now()}.json`));
        try {
          const backup: unknown = JSON.parse(await fs.readFile(join(this.directory, 'ledger.backup.json'), 'utf8'));
          validateState(backup); current = backup;
        } catch { current = emptyState(); }
      }
      if (expected !== undefined && current.revision !== expected) throw new Error('其他窗口已更新账本，请等待面板刷新后重新操作');
      const state = structuredClone(current);
      await change(state);
      state.revision = current.revision + 1; state.saved = new Date().toISOString();
      validateState(state);
      await this.write(state, current);
      return state;
    } finally {
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token: string };
        if (owner.token === token) await fs.unlink(lockPath);
      } catch { /* Preserve another process's lock. */ }
    }
  }
  async restore(input: unknown): Promise<State> {
    validateState(input);
    // Only an explicit, validated restore may recover a corrupt primary; preserve its bytes first.
    return this.transaction(state => {
      Object.assign(state, structuredClone(input));
      state.settings.online = false;
    }, undefined, true);
  }
  private async write(state: State, old: State): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      const backupTemporary = `${this.file}.${randomUUID()}.backup.tmp`;
      await fs.writeFile(backupTemporary, JSON.stringify(old), { mode: 0o600 });
      await fs.rename(backupTemporary, join(this.directory, 'ledger.backup.json'));
      await fs.rename(temporary, this.file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
