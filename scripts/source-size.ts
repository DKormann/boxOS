#!/usr/bin/env bun

/**
 * Transpile and minify every TypeScript file under src, then report the
 * resulting JavaScript sizes. No output files are written.
 */

type Runtime = {
  Transpiler: new (options: {
    loader: "ts";
    target: "bun";
    minifyWhitespace: boolean;
    minifySyntax: boolean;
    minifyIdentifiers: boolean;
  }) => { transform(source: string): Promise<string> };
  Glob: new (pattern: string) => {
    scan(options: { cwd: string; absolute?: boolean; onlyFiles?: boolean }): AsyncIterable<string>;
  };
  file(path: string): { text(): Promise<string> };
};

type TreeNode = {
  name: string;
  size: number;
  children?: Map<string, TreeNode>;
};

const runtime = Bun as unknown as Runtime;
const projectRoot = `${(import.meta as ImportMeta & { dir: string }).dir}/..`;
const sourceRoot = `${projectRoot}/src`;
const glob = new runtime.Glob("**/*.ts");
const paths = Array.fromAsync(
  glob.scan({ cwd: sourceRoot, onlyFiles: true }),
).then((files) => files.sort((a, b) => a.localeCompare(b)));

const transpiler = new runtime.Transpiler({
  loader: "ts",
  target: "bun",
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: true,
});

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`;
}

function addFile(root: TreeNode, path: string, size: number): void {
  const parts = path.split("/");
  let parent = root;

  for (const [index, part] of parts.entries()) {
    const isFile = index === parts.length - 1;
    parent.children ??= new Map();

    let node = parent.children.get(part);
    if (!node) {
      node = isFile
        ? { name: part, size }
        : { name: part, size: 0, children: new Map() };
      parent.children.set(part, node);
    }

    if (!isFile) node.size += size;
    parent = node;
  }

  root.size += size;
}

function printChildren(node: TreeNode, prefix = ""): void {
  const children = [...(node.children?.values() ?? [])].sort((a, b) => {
    const aIsDirectory = a.children !== undefined;
    const bIsDirectory = b.children !== undefined;
    return aIsDirectory === bIsDirectory
      ? a.name.localeCompare(b.name)
      : aIsDirectory ? -1 : 1;
  });

  children.forEach((child, index) => {
    const last = index === children.length - 1;
    const branch = last ? "└──" : "├──";
    const suffix = child.children ? "/" : "";
    console.log(`${prefix}${branch} ${child.name}${suffix}  ${formatBytes(child.size)}`);

    if (child.children) {
      printChildren(child, `${prefix}${last ? "    " : "│   "}`);
    }
  });
}

const files = await paths;
const results = await Promise.all(files.map(async (path) => {
  try {
    const source = await runtime.file(`${sourceRoot}/${path}`).text();
    const output = await transpiler.transform(source);
    return { path, size: new TextEncoder().encode(output).byteLength };
  } catch (error) {
    throw new Error(`Could not process src/${path}`, { cause: error });
  }
}));

const tree: TreeNode = { name: "src", size: 0, children: new Map() };
for (const result of results) addFile(tree, result.path, result.size);

console.log(`${tree.name}/  ${formatBytes(tree.size)}`);
printChildren(tree);
