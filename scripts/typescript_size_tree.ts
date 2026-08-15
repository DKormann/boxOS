import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"

type FileNode = {
  kind: "file"
  name: string
  path: string
  size: number
  baselineSize: number
}

type DirectoryNode = {
  kind: "directory"
  name: string
  path: string
  children: TreeNode[]
  size: number
  baselineSize: number
}

type TreeNode = FileNode | DirectoryNode

const ignoredDirectories = new Set([
  ".git",
  "build",
  "coverage",
  "database",
  "dist",
  "node_modules",
  "tmp",
])

const scriptRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "")

function parseArguments() {
  const args = process.argv.slice(2)
  let compareRef: string | undefined
  let rootArgument: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument == "--compare") {
      compareRef = args[++index]
      if (!compareRef) throw new Error("--compare requires a Git revision")
    } else if (argument == "--help" || argument == "-h") {
      console.log("Usage: bun scripts/typescript_size_tree.ts [root] [--compare <git-ref>]")
      process.exit(0)
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`)
    } else if (rootArgument) {
      throw new Error("Only one root directory may be provided")
    } else {
      rootArgument = argument
    }
  }

  return { compareRef, rootPath: resolve(rootArgument ?? scriptRoot) }
}

async function scanDirectory(path: string, name: string): Promise<DirectoryNode | null> {
  const entryNames = (await readdir(path)).sort((a, b) => a.localeCompare(b))
  const directories: DirectoryNode[] = []
  const files: FileNode[] = []

  for (const entryName of entryNames) {
    const entryPath = join(path, entryName)
    const entry = await stat(entryPath)

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entryName)) continue
      const directory = await scanDirectory(entryPath, entryName)
      if (directory) directories.push(directory)
    } else if (entry.isFile() && entryName.endsWith(".ts")) {
      files.push({
        kind: "file",
        name: entryName,
        path: entryPath,
        size: 0,
        baselineSize: 0,
      })
    }
  }

  const children: TreeNode[] = [...directories, ...files]
  if (children.length == 0) return null
  return { kind: "directory", name, path, children, size: 0, baselineSize: 0 }
}

function collectFiles(node: DirectoryNode): FileNode[] {
  return node.children.flatMap(child =>
    child.kind == "file" ? [child] : collectFiles(child)
  )
}

function sumSizes(node: DirectoryNode): number {
  node.size = node.children.reduce(
    (total, child) => total + (child.kind == "file" ? child.size : sumSizes(child)),
    0,
  )
  return node.size
}

async function measureTree(rootPath: string, rootName: string): Promise<DirectoryNode> {
  const tree = await scanDirectory(rootPath, rootName)
  if (!tree) return {
    kind: "directory",
    name: rootName,
    path: rootPath,
    children: [],
    size: 0,
    baselineSize: 0,
  }

  const temporaryDirectory = join(
    process.env.TMPDIR ?? "/tmp",
    `etindi-typescript-size-${crypto.randomUUID()}`,
  )
  await mkdir(temporaryDirectory, { recursive: true })

  try {
    const bun = Bun.which("bun") ?? "bun"
    for (const [index, file] of collectFiles(tree).entries()) {
      const outputPath = join(temporaryDirectory, `${index}.js`)
      const result = Bun.spawnSync({
        cmd: [
          bun,
          "build",
          file.path,
          "--no-bundle",
          "--minify",
          "--target=bun",
          `--outfile=${outputPath}`,
        ],
        stdout: "ignore",
        stderr: "pipe",
      })

      if (result.exitCode != 0) {
        const details = result.stderr?.toString().trim()
        throw new Error(`Could not transpile ${file.path}${details ? `:\n${details}` : ""}`)
      }
      file.size = (await readFile(outputPath, "utf8")).length
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  sumSizes(tree)
  return tree
}

function formatSize(characters: number): string {
  return `${characters.toLocaleString("en-US")} B`
}

function treeLines(node: DirectoryNode): string[] {
  const lines = [`${node.name}/ — ${formatSize(node.size)}`]

  function append(directory: DirectoryNode, prefix: string) {
    directory.children.forEach((child, index) => {
      const last = index == directory.children.length - 1
      const branch = last ? "└── " : "├── "
      const label = `${child.name}${child.kind == "directory" ? "/" : ""}`
      lines.push(`${prefix}${branch}${label} — ${formatSize(child.size)}`)
      if (child.kind == "directory") append(child, prefix + (last ? "    " : "│   "))
    })
  }

  append(node, "")
  return lines
}

function fileSizes(tree: DirectoryNode): Map<string, number> {
  const sizes = new Map<string, number>()

  function collect(directory: DirectoryNode, prefix: string) {
    for (const child of directory.children) {
      const childPath = prefix ? `${prefix}/${child.name}` : child.name
      if (child.kind == "file") sizes.set(childPath, child.size)
      else collect(child, childPath)
    }
  }

  collect(tree, "")
  return sizes
}

function comparisonTree(
  name: string,
  currentTree: DirectoryNode,
  baselineTree: DirectoryNode,
): DirectoryNode {
  const root: DirectoryNode = {
    kind: "directory",
    name,
    path: "",
    children: [],
    size: 0,
    baselineSize: 0,
  }
  const directories = new Map<string, DirectoryNode>([["", root]])
  const currentSizes = fileSizes(currentTree)
  const baselineSizes = fileSizes(baselineTree)
  const paths = [...new Set([...currentSizes.keys(), ...baselineSizes.keys()])].sort()

  for (const filePath of paths) {
    const parts = filePath.split("/")
    const fileName = parts.pop()!
    let directoryPath = ""
    let directory = root

    for (const part of parts) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part
      let childDirectory = directories.get(directoryPath)
      if (!childDirectory) {
        childDirectory = {
          kind: "directory",
          name: part,
          path: directoryPath,
          children: [],
          size: 0,
          baselineSize: 0,
        }
        directories.set(directoryPath, childDirectory)
        directory.children.push(childDirectory)
      }
      directory = childDirectory
    }

    directory.children.push({
      kind: "file",
      name: fileName,
      path: filePath,
      size: currentSizes.get(filePath) ?? 0,
      baselineSize: baselineSizes.get(filePath) ?? 0,
    })
  }

  function sumAndSort(directory: DirectoryNode) {
    for (const child of directory.children) {
      if (child.kind == "directory") sumAndSort(child)
      directory.size += child.size
      directory.baselineSize += child.baselineSize
    }
    directory.children.sort((left, right) => {
      const leftDelta = left.size - left.baselineSize
      const rightDelta = right.size - right.baselineSize
      return Math.abs(rightDelta) - Math.abs(leftDelta)
        || rightDelta - leftDelta
        || left.name.localeCompare(right.name)
    })
  }

  sumAndSort(root)
  return root
}

const useColor = Boolean((process as unknown as { stdout?: { isTTY?: boolean } }).stdout?.isTTY)
  && process.env.NO_COLOR == null

function formatDelta(delta: number): string {
  if (delta == 0) return ""
  const text = delta > 0
    ? `+ ${delta.toLocaleString("en-US")}`
    : `− ${Math.abs(delta).toLocaleString("en-US")}`
  if (!useColor) return ` ${text}`
  const color = delta > 0 ? "\x1b[31m" : "\x1b[32m"
  return ` ${color}${text}\x1b[0m`
}

function comparisonLines(node: DirectoryNode): string[] {
  const value = (child: TreeNode) =>
    `${formatSize(child.size)}${formatDelta(child.size - child.baselineSize)}`
  const lines = [`${node.name}/ — ${value(node)}`]

  function append(directory: DirectoryNode, prefix: string) {
    directory.children.forEach((child, index) => {
      const last = index == directory.children.length - 1
      const branch = last ? "└── " : "├── "
      const label = `${child.name}${child.kind == "directory" ? "/" : ""}`
      lines.push(`${prefix}${branch}${label} — ${value(child)}`)
      if (child.kind == "directory") append(child, prefix + (last ? "    " : "│   "))
    })
  }

  append(node, "")
  return lines
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode != 0) {
    const details = result.stderr?.toString().trim()
    throw new Error(`${command.join(" ")} failed${details ? `:\n${details}` : ""}`)
  }
  return result.stdout?.toString().trim() ?? ""
}

const { compareRef, rootPath } = parseArguments()
const rootName = basename(rootPath)
const currentTree = await measureTree(rootPath, rootName)

console.log("Minified standalone JavaScript length (Bun target, no bundling)\n")

if (!compareRef) {
  console.log(treeLines(currentTree).join("\n"))
  process.exit(0)
}

const repositoryRoot = resolve(run(["git", "rev-parse", "--show-toplevel"], scriptRoot))
const relativeRoot = relative(repositoryRoot, rootPath)
if (relativeRoot == ".." || relativeRoot.startsWith(`..${process.platform == "win32" ? "\\" : "/"}`)) {
  throw new Error("The comparison root must be inside the Git repository")
}

const comparisonDirectory = join(
  process.env.TMPDIR ?? "/tmp",
  `etindi-typescript-comparison-${crypto.randomUUID()}`,
)
const archivePath = join(comparisonDirectory, "baseline.tar")
const extractedPath = join(comparisonDirectory, "baseline")
await mkdir(extractedPath, { recursive: true })

let baselineTree: DirectoryNode
try {
  const commit = run(
    ["git", "rev-parse", "--verify", "--end-of-options", `${compareRef}^{commit}`],
    repositoryRoot,
  )
  run(["git", "archive", "--format=tar", `--output=${archivePath}`, commit], repositoryRoot)
  run(["tar", "-xf", archivePath, "-C", extractedPath], repositoryRoot)
  const baselineRoot = relativeRoot ? join(extractedPath, relativeRoot) : extractedPath
  try {
    baselineTree = await measureTree(baselineRoot, rootName)
  } catch (error) {
    if ((error as { code?: string }).code != "ENOENT") throw error
    baselineTree = {
      kind: "directory",
      name: rootName,
      path: baselineRoot,
      children: [],
      size: 0,
      baselineSize: 0,
    }
  }
} finally {
  await rm(comparisonDirectory, { recursive: true, force: true })
}

console.log(`Compared with ${compareRef}; current size followed by delta\n`)
console.log(comparisonLines(comparisonTree(rootName, currentTree, baselineTree)).join("\n"))
