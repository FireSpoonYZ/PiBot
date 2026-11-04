import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export class JsonlQueueStore {
    path;
    isItem;
    constructor(path, isItem) {
        this.path = path;
        this.isItem = isItem;
    }
    async count() {
        try {
            return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).length;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return 0;
            throw error;
        }
    }
    async append(items) {
        if (items.length === 0)
            return;
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    }
    async readStrict() {
        const parsed = await this.readTolerant();
        if (parsed.malformedLines.length > 0) {
            throw new Error(`Malformed queue file ${this.path}: ${parsed.malformedLines.length} invalid line(s)`);
        }
        return parsed.jobs;
    }
    async readTolerant() {
        try {
            const text = await readFile(this.path, "utf8");
            const jobs = [];
            const malformedLines = [];
            for (const line of text.split("\n").filter(Boolean)) {
                try {
                    const parsed = JSON.parse(line);
                    if (this.isItem(parsed))
                        jobs.push(parsed);
                    else
                        malformedLines.push(line);
                }
                catch {
                    malformedLines.push(line);
                }
            }
            return { jobs, malformedLines };
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return { jobs: [], malformedLines: [] };
            }
            throw error;
        }
    }
    async summarize() {
        try {
            const text = await readFile(this.path, "utf8");
            let valid = 0;
            let malformed = 0;
            for (const line of text.split("\n").filter(Boolean)) {
                try {
                    const parsed = JSON.parse(line);
                    if (this.isItem(parsed))
                        valid += 1;
                    else
                        malformed += 1;
                }
                catch {
                    malformed += 1;
                }
            }
            return { path: this.path, valid, malformed, error: null };
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return { path: this.path, valid: 0, malformed: 0, error: null };
            }
            return {
                path: this.path,
                valid: 0,
                malformed: 0,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async replace(items) {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""), "utf8");
        await rename(tmp, this.path);
    }
}
