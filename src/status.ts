import * as vscode from "vscode";

import { configSection, getConfig } from "./config.js";
import { directoryScopeKey } from "./paths.js";

export const EXTENSION_ID = "monosans.djlint";

interface InUse {
  source: string;
  version: string;
}

export type Run = "format" | "lint";

interface MenuEntry {
  action?: string;
  command?: string;
  label: string;
}

const menuCommands = [
  "djlint.openSettings",
  "djlint.restart",
  "djlint.showLogs",
  "djlint.toggleLintOnType",
  "djlint.toggleLinting",
  "djlint.useAsFormatter",
];

function languages(): string[] {
  return [...(getConfig().get<readonly string[]>("formatLanguages") ?? [])];
}

function activeDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document && languages().includes(document.languageId) ? document : void 0;
}

function formatsWithDjlint(document: vscode.TextDocument): boolean {
  return (
    vscode.workspace.getConfiguration("editor", document).get<string>("defaultFormatter") ===
    EXTENSION_ID
  );
}

function lintingEntries(config: vscode.WorkspaceConfiguration, language: string): MenuEntry[] {
  if (!config.get<boolean>("enableLinting")) {
    return [
      {
        action: vscode.l10n.t("Turn on"),
        command: "djlint.toggleLinting",
        label: `$(circle-slash) ${vscode.l10n.t("Not linting {0}", language)}`,
      },
    ];
  }
  return [
    {
      action: vscode.l10n.t("Turn off"),
      command: "djlint.toggleLinting",
      label: `$(check) ${vscode.l10n.t("Linting {0}", language)}`,
    },
    config.get<boolean>("lintOnType")
      ? {
          action: vscode.l10n.t("Turn off"),
          command: "djlint.toggleLintOnType",
          label: `$(check) ${vscode.l10n.t("Linting while typing")}`,
        }
      : {
          action: vscode.l10n.t("Turn on"),
          command: "djlint.toggleLintOnType",
          label: `$(circle-slash) ${vscode.l10n.t("Not linting while typing")}`,
        },
  ];
}

function settingEntries(document: vscode.TextDocument): MenuEntry[] {
  const language = `\`${document.languageId}\``;
  return [
    ...lintingEntries(getConfig(document), language),
    formatsWithDjlint(document)
      ? { label: `$(check) ${vscode.l10n.t("Formatting {0}", language)}` }
      : {
          action: vscode.l10n.t("Use djLint"),
          command: "djlint.useAsFormatter",
          label: `$(circle-slash) ${vscode.l10n.t("Not formatting {0}", language)}`,
        },
  ];
}

function toolEntries(): MenuEntry[] {
  return [
    { command: "djlint.showLogs", label: `$(output) ${vscode.l10n.t("Show Logs")}` },
    { command: "djlint.restart", label: `$(debug-restart) ${vscode.l10n.t("Restart")}` },
    { command: "djlint.openSettings", label: `$(gear) ${vscode.l10n.t("Settings")}` },
  ];
}

function escape(text: string): string {
  return text.replaceAll(/[\\`*_{}[\]()#+\-.!|<>~$]/gu, String.raw`\$&`);
}

export class DjlintStatus implements vscode.Disposable {
  readonly #item = vscode.window.createStatusBarItem(
    "djlint.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  readonly #inUse = new Map<string, InUse>();
  // What failed the last time it ran on a document.
  readonly #failed = new Map<string, Set<Run>>();
  readonly #subscriptions: vscode.Disposable[];

  constructor() {
    this.#item.name = "djLint";
    this.#item.command = "djlint.showMenu";
    this.#subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.#render();
      }),
      // A change of language mode reopens the document in the same editor.
      vscode.workspace.onDidOpenTextDocument(({ uri }) => {
        if (uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) {
          this.#render();
        }
      }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        this.#inUse.delete(uri.toString());
        this.#failed.delete(uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(configSection) ||
          e.affectsConfiguration("editor.defaultFormatter")
        ) {
          this.#render();
        }
      }),
    ];
    this.#render();
  }

  update(document: vscode.TextDocument, version: string, source: string): void {
    const inUse = { source, version };
    this.#inUse.set(document.uri.toString(), inUse);
    this.#inUse.set(directoryScopeKey(document), inUse);
    this.#render();
  }

  // Whether the last format or lint of a document worked.
  ran(document: vscode.TextDocument, run: Run, ok: boolean): void {
    const key = document.uri.toString();
    const failed = this.#failed.get(key);
    if (ok === !failed?.has(run)) {
      return;
    }
    if (!ok) {
      this.#failed.set(key, new Set(failed).add(run));
    } else if (failed?.size === 1) {
      this.#failed.delete(key);
    } else {
      failed?.delete(run);
    }
    this.#render();
  }

  clear(): void {
    this.#inUse.clear();
    this.#failed.clear();
    this.#render();
  }

  async showMenu(): Promise<void> {
    const document = activeDocument();
    const items: (vscode.QuickPickItem & { command: string })[] = [];
    for (const { action, command, label } of [
      ...(document ? settingEntries(document) : []),
      ...toolEntries(),
    ]) {
      if (command != null) {
        items.push({ command, description: action ?? "", label: label.replaceAll("`", "") });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: this.#item.text.replace("$(warning) ", ""),
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#item.dispose();
  }

  #render(): void {
    const document = activeDocument();
    if (!document) {
      this.#item.hide();
      return;
    }
    const inUse =
      this.#inUse.get(document.uri.toString()) ?? this.#inUse.get(directoryScopeKey(document));
    const name = inUse?.version ? `djLint ${inUse.version}` : "djLint";
    const failed = this.#failed.get(document.uri.toString());
    const failures = [
      ...(failed?.has("format") ? [vscode.l10n.t("Formatting this file failed.")] : []),
      ...(failed?.has("lint") ? [vscode.l10n.t("Linting this file failed.")] : []),
    ].join(" ");
    this.#item.text = failures ? `$(warning) ${name}` : name;
    // Screen readers would read the tooltip's markdown out.
    this.#item.accessibilityInformation = { label: failures ? `${name}. ${failures}` : name };
    this.#item.backgroundColor = failures
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : void 0;

    const tooltip = new vscode.MarkdownString(void 0, true);
    tooltip.isTrusted = { enabledCommands: menuCommands };
    tooltip.appendMarkdown(`**${escape(name)}**`);
    if (inUse?.source) {
      tooltip.appendMarkdown(`  \n${escape(inUse.source)}`);
    }
    if (failures) {
      tooltip.appendMarkdown(
        `\n\n$(warning) ${failures} [${vscode.l10n.t("Show Logs")}](command:djlint.showLogs)`,
      );
    }
    tooltip.appendMarkdown(
      `\n\n${settingEntries(document)
        .map(({ action, command, label }) =>
          command ? `${label} · [${action}](command:${command})` : label,
        )
        .join("  \n")}`,
    );
    tooltip.appendMarkdown(
      `\n\n${toolEntries()
        .map(({ command, label }) => `[${label}](command:${command})`)
        .join(" · ")}`,
    );
    this.#item.tooltip = tooltip;
    this.#item.show();
  }
}

// Written where the value comes from now, so a value of the workspace or folder can't hide it.
export async function updateForLanguage(
  document: vscode.TextDocument,
  section: string,
  key: string,
  value: unknown,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(section, document);
  const inspected = config.inspect(key);
  let target = vscode.ConfigurationTarget.Global;
  if (inspected?.workspaceFolderValue != null || inspected?.workspaceFolderLanguageValue != null) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (inspected?.workspaceValue != null || inspected?.workspaceLanguageValue != null) {
    target = vscode.ConfigurationTarget.Workspace;
  }
  await config.update(key, value, target, true);
}
