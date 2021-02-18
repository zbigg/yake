
import * as debugCtor from "debug";
import { BuildTarget, ModuleInfo, plugins, WorldBuilder } from "./protocol";
import { asyncCollectFlat } from "./utils";

import { makeTask, TaskBuilder } from "../index";
import "./lerna";
import "./npm";

const debug = debugCtor("jsMake");

interface ModuleBuilder {
    moduleInfo: ModuleInfo;
    taskBuilders: Map<string, TaskBuilder>;
}
class JsMakeWorldBuilder implements WorldBuilder {
    modules = new Map<string, ModuleBuilder>();

    module(root: string): ModuleBuilder {
        const t = this.modules.get(root);
        if (t) {
            return t;
        } else {
            const t: ModuleBuilder = {
                moduleInfo: {
                    path: root,
                    type: "unknown",
                    targets: new Map<string, BuildTarget>(),
                    sourceFiles: [],
                },
                taskBuilders: new Map();
            }
            this.modules.set(root, t);
            return t;
        }
    }

    task(module: ModuleBuilder, name: string) {
        const t = module.taskBuilders.get(name);
        if (t) {
            return t;
        } else {
            const t = makeTask();
            module.taskBuilders.set(name, t);
            return t;
        }
    }

}
async function listModules(root: string, world: WorldBuilder): Promise<ModuleInfo[]> {
    const modules = await asyncCollectFlat(plugins.map(p => p.analyzeRoot(root, world)));
    return modules;
}

async function main(args: string[]) {
    const root = args.length > 0 ? args[0] : process.cwd();
    debug("main#root", root);
    const world = new JsMakeWorldBuilder();
    const modules = await listModules(root, world);
    console.log("->", modules.map(m => m.path))
}


main(process.argv.slice(2))
    .catch(error => {
        console.error("jsMake: uncaught exception", error);
        process.exit(2);
    })
