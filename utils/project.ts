import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectPackage {
    name: string;
    version: string;
}

export interface ApplicationInfoPayload {
    php_version?: string;
    laravel_version?: string;
    database_engine?: string;
    packages: ProjectPackage[];
    models: string[];
}

async function tryExec(file: string, args: string[], cwd: string) {
    try {
        return await execFileAsync(file, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    } catch {
        return undefined;
    }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return undefined;
    }
}

export function majorLine(version: string | undefined): string | undefined {
    if (!version) return undefined;
    const match = version.match(/(\d{1,3})/);
    return match ? `${match[1]}.x` : undefined;
}

export function normalizeVersion(version: string | undefined): string | undefined {
    if (!version) return undefined;
    const trimmed = version.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/^v/, "");
}

export async function getComposerPackages(cwd: string): Promise<ProjectPackage[]> {
    const shown = await tryExec("composer", ["show", "--format=json"], cwd);
    if (shown?.stdout) {
        try {
            const parsed = JSON.parse(shown.stdout) as { installed?: Array<{ name?: string; version?: string }> };
            const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
            return installed
                .filter((pkg) => pkg.name && pkg.version)
                .map((pkg) => ({ name: pkg.name!, version: normalizeVersion(pkg.version) ?? pkg.version! }));
        } catch {
            // fall through
        }
    }

    const composerJson = await readJsonFile<Record<string, Record<string, string>>>(join(cwd, "composer.json"));
    if (!composerJson) return [];

    return Object.entries({ ...(composerJson.require ?? {}), ...(composerJson["require-dev"] ?? {}) })
        .filter(([name]) => name !== "php")
        .map(([name, version]) => ({ name, version }));
}

export async function getNpmPackages(cwd: string): Promise<ProjectPackage[]> {
    const packageJson = await readJsonFile<Record<string, Record<string, string>>>(join(cwd, "package.json"));
    if (!packageJson) return [];

    return Object.entries({ ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) }).map(
        ([name, version]) => ({ name, version }),
    );
}

export async function getProjectPackages(cwd: string): Promise<ProjectPackage[]> {
    const all = [...(await getComposerPackages(cwd)), ...(await getNpmPackages(cwd))];
    const seen = new Set<string>();
    return all.filter((pkg) => {
        if (seen.has(pkg.name)) return false;
        seen.add(pkg.name);
        return true;
    });
}

export async function getPhpVersion(cwd: string): Promise<string | undefined> {
    const result = await tryExec("php", ["-r", "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"], cwd);
    return result?.stdout?.trim() || undefined;
}

export async function getArtisanAbout(cwd: string): Promise<Record<string, unknown> | undefined> {
    const result = await tryExec("php", ["artisan", "about", "--json"], cwd);
    if (!result?.stdout) return undefined;
    try {
        return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

export async function getLaravelVersion(cwd: string): Promise<string | undefined> {
    const about = await getArtisanAbout(cwd);
    const candidates = [about?.laravel_version, about?.laravel, about?.application_version];
    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    const packages = await getComposerPackages(cwd);
    return packages.find((pkg) => pkg.name === "laravel/framework")?.version;
}

export async function getDatabaseEngine(cwd: string): Promise<string | undefined> {
    const about = await getArtisanAbout(cwd);
    const direct = about?.database_engine;
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    const environment = about?.environment as Record<string, unknown> | undefined;
    const database = about?.database as Record<string, unknown> | undefined;
    const config = about?.config as Record<string, unknown> | undefined;
    const candidates = [
        environment?.database,
        database?.default,
        database?.driver,
        config?.database,
    ];

    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    return undefined;
}

export async function discoverModels(cwd: string): Promise<string[]> {
    const result = await tryExec(
        "rg",
        [
            "-l",
            "extends\\s+(?:\\\\?Illuminate\\\\Database\\\\Eloquent\\\\Model|Model)",
            "app",
            "--glob",
            "*.php",
        ],
        cwd,
    );

    if (!result?.stdout) return [];

    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
}

export async function collectApplicationInfo(cwd: string): Promise<ApplicationInfoPayload> {
    const [phpVersion, laravelVersion, databaseEngine, packages, models] = await Promise.all([
        getPhpVersion(cwd),
        getLaravelVersion(cwd),
        getDatabaseEngine(cwd),
        getProjectPackages(cwd),
        discoverModels(cwd),
    ]);

    return {
        php_version: phpVersion,
        laravel_version: laravelVersion,
        database_engine: databaseEngine,
        packages,
        models,
    };
}

export async function resolveLaravelAppPath(baseCwd: string, input?: string): Promise<string> {
    const normalizedInput = input?.trim().replace(/^@/, "");
    const candidate = resolve(baseCwd, normalizedInput || ".");

    try {
        const [composerJsonStats, artisanStats] = await Promise.all([
            stat(join(candidate, "composer.json")),
            stat(join(candidate, "artisan")),
        ]);

        if (!composerJsonStats.isFile() || !artisanStats.isFile()) {
            throw new Error();
        }

        return candidate;
    } catch {
        throw new Error(
            `Invalid Laravel app path: ${input ?? "."}. Expected a directory containing composer.json and artisan.`,
        );
    }
}

export function toRelativeAppPath(baseCwd: string, appPath: string): string {
    const rel = relative(baseCwd, appPath);
    return rel || ".";
}

export function toSearchDocPackages(packages: ProjectPackage[], filter?: string[]): Array<{ name: string; version: string }> {
    const allowed = filter?.length ? new Set(filter) : undefined;

    return packages
        .filter((pkg) => !allowed || allowed.has(pkg.name))
        .map((pkg) => {
            const version = majorLine(pkg.version) ?? "1.x";
            return { name: pkg.name, version };
        })
        .filter((pkg, index, arr) => arr.findIndex((candidate) => candidate.name === pkg.name) === index);
}
