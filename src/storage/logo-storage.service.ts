import { Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Private local storage, never mounted as an Express static directory. */
@Injectable()
export class LogoStorage {
  private readonly root: string;
  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('UPLOADS_DIR')?.trim() || join(process.cwd(), 'uploads'));
  }

  private id(value: string) {
    if (!uuid.test(value)) throw new ServiceUnavailableException('Identitas penyimpanan logo tidak valid.');
    return value;
  }
  private async directory(workspaceId: string, create = false): Promise<string | null> {
    const folder = join(this.root, 'branding', this.id(workspaceId));
    for (const path of [this.root, join(this.root, 'branding'), folder]) {
      if (create) await mkdir(path, {recursive: true, mode: 0o700});
      try {
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe logo directory');
      } catch (error) {if (absent(error) && !create) return null; throw error;}
    }
    return folder;
  }
  async write(workspaceId: string, bytes: Buffer): Promise<string> {
    if (!bytes.length || bytes.length > MAX_LOGO_BYTES) throw new Error('Invalid normalized logo size');
    const folder = await this.directory(workspaceId, true);
    const key = randomUUID();
    const path = join(folder!, `${key}.png`);
    try {await writeFile(path, bytes, {flag: 'wx', mode: 0o600});}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await unlink(path).catch(() => undefined); // Remove a partial write on ENOSPC.
      }
      throw error;
    }
    return key;
  }
  async read(workspaceId: string, key: string): Promise<Buffer> {
    this.id(key);
    const folder = await this.directory(workspaceId);
    if (!folder) throw new Error('Logo missing');
    const file = await open(join(folder, `${key}.png`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.size > MAX_LOGO_BYTES) throw new Error('Invalid stored logo');
      return await file.readFile();
    } finally {await file.close();}
  }
  async remove(workspaceId: string, key: string): Promise<void> {
    this.id(key);
    const folder = await this.directory(workspaceId);
    if (!folder) return;
    await unlink(join(folder, `${key}.png`)).catch(error => {if (!absent(error)) throw error;});
  }
  /** Bounded erasure, including orphaned replacements, for account deletion. */
  async purgeWorkspace(workspaceId: string): Promise<boolean> {
    const folder = await this.directory(workspaceId);
    if (!folder) return true;
    const entries = await readdir(folder, {withFileTypes: true});
    if (entries.some(entry => !entry.isFile() || !entry.name.endsWith('.png') || !uuid.test(entry.name.slice(0, -4)))) {
      throw new Error('Unexpected entry in private logo directory');
    }
    for (const entry of entries.slice(0, 200)) await this.remove(workspaceId, entry.name.slice(0, -4));
    if (entries.length > 200) return false;
    try {await rmdir(folder); return true;}
    catch (error) {
      if (absent(error)) return true;
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
      throw error;
    }
  }
}

@Module({providers: [LogoStorage], exports: [LogoStorage]})
export class LogoStorageModule {}
