import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface UCClass {
    package: string;
    name: string;
    functions: string[];
    variables: string[];
}

let gamePath: string | undefined;
const globalUCClasses: Map<string, UCClass> = new Map();

export function activate(context: vscode.ExtensionContext) {
    console.log("[DEBUG] UnrealScript+ extension activated");

    // -------------------------
    // Load saved game path
    // -------------------------
    gamePath = context.workspaceState.get<string>("gamePath");
    if (gamePath) {
        console.log(`[DEBUG] Found saved game path: ${gamePath}`);
        scanGamePackages(gamePath);
        refreshAllOpenDocuments();
    }

    // -------------------------
    // Command to set game path
    // -------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('unrealscript.setGamePath', async () => {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                openLabel: "Select Unreal Engine 1 game folder"
            });
            if (!folderUri) return;

            gamePath = folderUri[0].fsPath;
            await context.workspaceState.update("gamePath", gamePath);

            console.log(`[DEBUG] Game path set to: ${gamePath}`);
            scanGamePackages(gamePath);

            refreshAllOpenDocuments();
        })
    );

    // -------------------------
    // Document Symbol Provider
    // -------------------------
    const symbolProvider: vscode.DocumentSymbolProvider = {
        provideDocumentSymbols(document: vscode.TextDocument) {
            const symbols: vscode.DocumentSymbol[] = [];
            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i).text;

                let match: RegExpExecArray | null;

                // Class
                match = /^\s*class\s+(\w+)/i.exec(line);
                if (match) {
                    symbols.push(new vscode.DocumentSymbol(
                        match[1],
                        "class",
                        vscode.SymbolKind.Class,
                        new vscode.Range(i, 0, i, line.length),
                        new vscode.Range(i, 0, i, line.length)
                    ));
                    continue;
                }

                // Function
                match = /^\s*function\s+(\w+)/i.exec(line);
                if (match) {
                    symbols.push(new vscode.DocumentSymbol(
                        match[1],
                        "function",
                        vscode.SymbolKind.Function,
                        new vscode.Range(i, 0, i, line.length),
                        new vscode.Range(i, 0, i, line.length)
                    ));
                    continue;
                }

                // State
                match = /^\s*state\s+(\w+)/i.exec(line);
                if (match) {
                    symbols.push(new vscode.DocumentSymbol(
                        match[1],
                        "state",
                        vscode.SymbolKind.Namespace,
                        new vscode.Range(i, 0, i, line.length),
                        new vscode.Range(i, 0, i, line.length)
                    ));
                }
            }
            return symbols;
        }
    };
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider({ language: "unrealscript" }, symbolProvider)
    );

    // -------------------------
    // Semantic Token Provider
    // -------------------------
    const tokenTypes = ['class', 'function', 'variable', 'parameter'];
    const tokenModifiers: string[] = [];
    const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

    class UE1SemanticTokenProvider implements vscode.DocumentSemanticTokensProvider {
        provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
            const builder = new vscode.SemanticTokensBuilder(legend);

            const classVariables: Set<string> = new Set();
            let currentFunctionVars: Set<string> = new Set();

            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i).text;

                // Class declaration with optional inheritance
                const matchClass = /^\s*class\s+(\w+)(?:\s+(extends|based\s+on)\s+(\w+))?/i.exec(line);
                if (matchClass) {
                    const className = matchClass[1];
                    const parentClass = matchClass[3];

                    // Highlight current class
                    const classIndex = matchClass.index! + matchClass[0].indexOf(className);
                    builder.push(i, classIndex, className.length, tokenTypes.indexOf('class'), 0);

                    // Highlight parent class
                    if (parentClass) {
                        const parentIndex = matchClass.index! + matchClass[0].indexOf(parentClass);
                        builder.push(i, parentIndex, parentClass.length, tokenTypes.indexOf('class'), 0);
                    }

                    currentFunctionVars.clear();
                    continue;
                }

                // Function declaration
                let match = /^\s*function\s+(\w+)/i.exec(line);
                if (match) {
                    const idx = line.indexOf(match[1]);
                    builder.push(i, idx, match[1].length, tokenTypes.indexOf('function'), 0);
                    currentFunctionVars.clear();
                    continue;
                }

                // Variable declaration
                match = /^\s*var\s+\w+\s+(\w+)/i.exec(line);
                if (match) {
                    const idx = line.indexOf(match[1]);
                    builder.push(i, idx, match[1].length, tokenTypes.indexOf('variable'), 0);
                    classVariables.add(match[1]);
                    currentFunctionVars.add(match[1]);
                    continue;
                }

                // Highlight references to known UC classes
                globalUCClasses.forEach((ucClass, name) => {
                    let idx = line.indexOf(name);
                    while (idx >= 0) {
                        builder.push(i, idx, name.length, tokenTypes.indexOf('class'), 0);
                        idx = line.indexOf(name, idx + 1);
                    }
                });

                // Variable usages
                const allVars = new Set([...classVariables, ...currentFunctionVars]);
                allVars.forEach(v => {
                    let idx = line.indexOf(v);
                    while (idx >= 0) {
                        builder.push(i, idx, v.length, tokenTypes.indexOf('variable'), 0);
                        idx = line.indexOf(v, idx + 1);
                    }
                });
            }

            return builder.build();
        }
    }
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: "unrealscript" },
            new UE1SemanticTokenProvider(),
            legend
        )
    );

    // -------------------------
    // Completion Provider
    // -------------------------
    const ue1Keywords = [
        "class","extends","function","event","state","defaultproperties",
        "if","else","while","for","foreach","switch","case","return","break","continue","until"
    ];

    const ue1Types = [
        "int","float","bool","byte","string","name","vector","rotator","array","struct","class"
    ];

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: "unrealscript" },
            {
                provideCompletionItems(document: vscode.TextDocument) {
                    const items: vscode.CompletionItem[] = [];

                    // Keywords
                    for (const kw of ue1Keywords)
                        items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));

                    // Types
                    for (const t of ue1Types)
                        items.push(new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter));

                    // Classes from UC scan
                    globalUCClasses.forEach((ucClass, name) => {
                        items.push(new vscode.CompletionItem(name, vscode.CompletionItemKind.Class));
                    });

                    return items;
                }
            },
            "." // trigger
        )
    );

    // -------------------------
    // Helper: Refresh open documents
    // -------------------------
    function refreshAllOpenDocuments() {
        vscode.workspace.textDocuments.forEach(doc => {
            vscode.languages.setTextDocumentLanguage(doc, doc.languageId); // simple hack to refresh tokens
        });
    }

    // -------------------------
    // Helper: Scan game packages
    // -------------------------
    function scanGamePackages(gameFolder: string) {
        console.log("[DEBUG] Scanning game packages in folder:", gameFolder);

        const packages = fs.readdirSync(gameFolder).filter(f => {
            return fs.statSync(path.join(gameFolder, f)).isDirectory();
        });

        console.log(`[DEBUG] Found packages: ${packages.join(", ")}`);

        globalUCClasses.clear();

        packages.forEach(pkg => {
            const pkgPath = path.join(gameFolder, pkg, "Classes");
            if (!fs.existsSync(pkgPath)) {
                // fallback: check root folder
                const rootPath = path.join(gameFolder, pkg);
                if (!fs.existsSync(rootPath)) {
                    console.log(`[DEBUG] Package folder does not exist: ${pkgPath}`);
                    return;
                }
            }

            const classesFolder = fs.existsSync(pkgPath) ? pkgPath : path.join(gameFolder, pkg);
            const ucFiles = fs.existsSync(classesFolder)
                ? fs.readdirSync(classesFolder).filter(f => f.endsWith(".uc"))
                : [];

            console.log(`[DEBUG] Scanning package "${pkg}" in folder "${classesFolder}", found ${ucFiles.length} UC files`);

            for (const file of ucFiles) {
                const fullPath = path.join(classesFolder, file);
                const content = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);

                let currentClass: UCClass | null = null;

                for (const line of content) {
                    let match: RegExpExecArray | null;

                    // Class declaration
                    match = /^\s*class\s+(\w+)/i.exec(line);
                    if (match) {
                        currentClass = {
                            package: pkg,
                            name: match[1],
                            functions: [],
                            variables: []
                        };
                        globalUCClasses.set(currentClass.name, currentClass);
                        console.log(`[DEBUG] Found class ${currentClass.name}`);
                        continue;
                    }

                    // Function
                    match = /^\s*function\s+(\w+)/i.exec(line);
                    if (match && currentClass) {
                        currentClass.functions.push(match[1]);
                        console.log(`[DEBUG]   Found function ${match[1]} in ${currentClass.name}`);
                        continue;
                    }

                    // Variable
                    match = /^\s*var\s+\w+\s+(\w+)/i.exec(line);
                    if (match && currentClass) {
                        currentClass.variables.push(match[1]);
                        console.log(`[DEBUG]   Found variable ${match[1]} in ${currentClass.name}`);
                        continue;
                    }
                }

                if (currentClass) {
                    console.log(`[DEBUG] Completed class ${currentClass.name} with ${currentClass.functions.length} functions and ${currentClass.variables.length} variables`);
                }
            }
        });

        console.log(`[DEBUG] Total classes found: ${globalUCClasses.size}`);
    }
}

export function deactivate() {}
