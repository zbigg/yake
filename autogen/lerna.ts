import { ModuleInfo, Plugin, plugins, WorldBuilder } from "./protocol";

import * as debugCtor from "debug";
import { NpmPlugin } from "./npm";
import { captureCommand, asyncCollect  } from "./utils";
import { promises as fs } from "fs";

const debug = debugCtor("jsMake:lerna");

export class LernaPlugin implements Plugin {
    static instance = new LernaPlugin();
    async analyzeRoot(root: string, world: WorldBuilder): Promise<ModuleInfo[]> {
        const isLernaWorkspace = await (fs.access(`${root}/lerna.json`).then(() => true).catch(() => false));
        if (!isLernaWorkspace) {
            return [];
        }

        const lernaAllFolders = await this.lernaLsPackages(root);
        return asyncCollect(lernaAllFolders.map(dir => this.lernaAnalyzePackage(dir, world)));
    }

    private async lernaLsPackages(root: string): Promise<string[]> {
        const output = await captureCommand("lerna", ["exec", "pwd"], { cwd: root });
        return output.stdout.split("\n").map(s => s.trim()).filter(s => Boolean(s));
    }

    private async lernaAnalyzePackage(packageRoot: string, world: WorldBuilder): Promise<ModuleInfo> {
        debug("package", packageRoot);

        return (await NpmPlugin.instance.analyzeRoot(packageRoot, world))[0];
    }
}

plugins.push(LernaPlugin.instance);
