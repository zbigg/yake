import { TaskInstance, TaskRecipe } from "../index";
import { BuildTarget, ModuleInfo, Plugin, plugins, WorldBuilder } from "./protocol";
import { readJson } from "./utils";

export interface NpmPackageJson {
    name: string;
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, String>;
}

export interface NpmPackageInfo extends ModuleInfo {
    npmPackage: {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        scripts?: Record<string, String>;
    }
}

export function isNpmPackageModule(info: ModuleInfo): info is NpmPackageInfo {
    const v = info as Partial<NpmPackageInfo>;
    return typeof v.npmPackage === 'object' && v.npmPackage !== null;
}

export function npmScriptRecipe(packagePath: string, scriptName: string): TaskRecipe {
    return async function (this: TaskInstance) {
        // TODO: run npm script
        return { success: false }
    }
}

export class NpmPlugin implements Plugin {
    static instance = new NpmPlugin();

    async analyzeRoot(packageRoot: string, world: WorldBuilder): Promise<NpmPackageInfo[]> {
        const packageJson: Partial<NpmPackageJson> = await readJson(`${packageRoot}/package.json`);

        const module = world.module(packageRoot);

        if (typeof packageJson.scripts === 'object' && packageJson.scripts !== null) {
            for (const targetName of Object.keys(packageJson.scripts)) {
                // const command = packageJson.scripts[targetName];
                const target = world.task(module, targetName);
                target.withRecipe(npmScriptRecipe(packageRoot, targetName));
            }
        }

        if (Array.isArray(packageJson.workspaces)) {
            // analyze all found yarn workspaces
        }
        return [{
            path: packageRoot,
            type: "npm",
            npmPackage: packageJson as any as NpmPackageJson,
        }]
    }
}

plugins.push(NpmPlugin.instance);
