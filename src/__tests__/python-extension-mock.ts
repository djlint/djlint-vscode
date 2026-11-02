// `@vscode/python-extension` is CommonJS and require()s `vscode`, which the
// alias cannot reach from node_modules. This is its whole runtime surface, for
// vi.mock("@vscode/python-extension", async () => import(...)).
import { extensions } from "./vscode-stub.js";

export const PVSC_EXTENSION_ID = "ms-python.python";

interface ExtensionLike {
  activate: () => Promise<unknown>;
  exports: unknown;
  isActive: boolean;
}

export const PythonExtension = {
  api: async (): Promise<unknown> => {
    const extension = extensions.getExtension(PVSC_EXTENSION_ID) as ExtensionLike | undefined;
    if (extension === void 0) {
      throw new Error("Python extension is not installed or is disabled");
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    return extension.exports;
  },
};
