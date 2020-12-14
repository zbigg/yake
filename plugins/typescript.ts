import * as ts from "typescript";

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
    let emitResult = program.emit();

    console.log("#after #emit", emitResult.emittedFiles);
    let allDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics);

    allDiagnostics.forEach(diagnostic => {
        if (diagnostic.file) {
            let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
            let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            console.log(`typescript: ${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
        } else {
            console.log("typescript: ", ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        }
    });

    console.log("yake/typescript: Emitted files", emitResult.emittedFiles);

    //   let exitCode = emitResult.emitSkipped ? 1 : 0;
    //   console.log(`Process exiting with code '${exitCode}'.`);
    //   process.exit(exitCode);
    oldProgram = program;
    return;
}
