import fs from 'node:fs';
import path from 'node:path';
/** Synchronous bounded writes serialize stdout/stderr and rotation without queued buffers. */
export class RotatingLog {
    constructor(readonly file: string, readonly limit = 10 * 1024 * 1024) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
    write(chunk: Buffer | string): void {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < data.length) {
            let size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
            if (size >= this.limit) {
                fs.rmSync(`${this.file}.3`, { force: true });
                for (let i = 2; i >= 1; i--)
                    if (fs.existsSync(`${this.file}.${i}`))
                        fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
                fs.renameSync(this.file, `${this.file}.1`);
                size = 0;
            }
            const n = Math.min(data.length - offset, this.limit - size);
            fs.appendFileSync(this.file, data.subarray(offset, offset + n), { mode: 0o600 });
            offset += n;
        }
    }
}
/** Read at most 2 MB per file, even when an adopted log is unbounded. */
export function tailLogs(files: string[], lines: number): string[] {
    return files.flatMap(file => {
        let fd: number | undefined;
        try {
            fd = fs.openSync(file, 'r');
            const size = fs.fstatSync(fd).size;
            const start = Math.max(0, size - 2 * 1024 * 1024), buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            const text = buf.toString('utf8');
            if (!text)
                return [];
            return (start ? text.slice(text.indexOf('\n') + 1) : text).replace(/\n$/, '').split('\n');
        }
        catch {
            return [];
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }).slice(-lines);
}
