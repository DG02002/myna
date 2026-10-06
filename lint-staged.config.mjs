import { existsSync } from "node:fs"
import { relative, sep } from "node:path"

const sourceFilePattern = /\.(?:c|m)?[jt]sx?$/

// Mirrors the ignorePatterns in .oxlintrc.json and .oxfmtrc.json: passing
// explicit paths to those tools bypasses config ignores, so vendored and
// generated trees must be filtered out here too.
const ignoredPathPattern =
  /(?:^|\/)(?:\.agents|\.repos|tools\/oxlint\/anti-slop|src\/components\/ui|src\/routeTree\.gen\.ts|worker-configuration\.d\.ts)(?:\/|$)/

const getRelativePath = (absolutePath) =>
  relative(process.cwd(), absolutePath).split(sep).join("/")

const getExistingFilePaths = (filePaths, filePattern) =>
  filePaths.filter((filePath) => {
    if (!existsSync(filePath)) {
      return false
    }

    const relativePath = getRelativePath(filePath)

    return (
      !ignoredPathPattern.test(relativePath) && filePattern.test(relativePath)
    )
  })

const quoteShellArgument = (filePath) =>
  `'${filePath.replaceAll("'", "'\\''")}'`

const getFileArguments = (filePaths) =>
  filePaths.map(quoteShellArgument).join(" ")

const jsonFilePattern = /(?:^|\/)(?:package|knip)\.json$/

const markdownFilePattern = /\.(?:md|mdx)$/

export default {
  "*": (stagedFilePaths) => {
    const sourceFilePaths = getExistingFilePaths(
      stagedFilePaths,
      sourceFilePattern
    )

    const jsonFilePaths = getExistingFilePaths(stagedFilePaths, jsonFilePattern)

    const markdownFilePaths = getExistingFilePaths(
      stagedFilePaths,
      markdownFilePattern
    )

    const commands = []

    if (sourceFilePaths.length > 0) {
      const fileArguments = getFileArguments(sourceFilePaths)
      commands.push(
        `oxfmt --no-error-on-unmatched-pattern ${fileArguments}`,
        `oxlint --no-error-on-unmatched-pattern ${fileArguments}`
      )
    }

    if (jsonFilePaths.length > 0) {
      const fileArguments = getFileArguments(jsonFilePaths)
      commands.push(`oxfmt --no-error-on-unmatched-pattern ${fileArguments}`)
    }

    if (markdownFilePaths.length > 0) {
      const fileArguments = getFileArguments(markdownFilePaths)
      commands.push(`markdownlint-cli2 --no-globs --fix ${fileArguments}`)
    }

    return commands
  },
}
