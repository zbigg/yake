import * as ts from "typescript";

//
// Scraped from first example of
//   https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
//
// TODO, there is better, file & watch oriented version
//  in `Incremental build support using the language services` chapter later in the doc
//

let oldProgram: any = undefined;
export async function compile(fileNames: string[], options: ts.CompilerOptions): Promise<void> {
    const configFileName = ts.findConfigFile(
        /*searchPath*/ "./",
        ts.sys.fileExists,
        "tsconfig.json"
    );
    if (!configFileName) {
        throw new Error("Could not find a valid 'tsconfig.json'.");
    }
    const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
    const compilerOptions = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        "./"
    );
    // undocumented, but otherwise `emitResult.emittedFiles` is empty
    compilerOptions.options.listEmittedFiles = true;

    let program = ts.createProgram(fileNames, compilerOptions.options, undefined, oldProgram);
    oldProgram = undefined;
    let emitResult = program.emit();

    // console.log("#after #emit", emitResult.emittedFiles);
    let allDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics);

    let failed = false;
    allDiagnostics.forEach(diagnostic => {
        if (diagnostic.file) {
            let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
            let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            const c = ts.DiagnosticCategory[diagnostic.category];
            if (diagnostic.category === ts.DiagnosticCategory.Error) {
                failed = true;
            }
            console.log(`typescript: ${c} ${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
        } else {
            console.log("typescript: ", ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        }
    });

    console.log("yake/typescript: Emitted files", emitResult.emittedFiles);
    if (failed) {
        throw new Error('compilation failed');
    }

    //   let exitCode = emitResult.emitSkipped ? 1 : 0;
    //   console.log(`Process exiting with code '${exitCode}'.`);
    //   process.exit(exitCode);
    oldProgram = program;

    return;
}
