import type { Database } from "bun:sqlite"
import { publishBox, publishPage, publishTextBlob } from "../../src/operations/operations.ts"
import { grantsBox } from "./boxes/grants.ts"
import { messagesBox } from "./boxes/messages.ts"
import { profilesBox } from "./boxes/profiles.ts"

export type StartupDeployment = Readonly<{
  defaultCssBlobId: string
  grantsBoxId: string
  profilesBoxId: string
  accountsPageId: string
  profilePageId: string
  messagesBoxId: string
  socialPageId: string
}>

function record(database: Database, name: string, kind: "blob" | "box" | "page", id: string): void {
  database.query(
    `INSERT INTO startup_deployments (name, kind, id, deployed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, id = excluded.id,
       deployed_at = excluded.deployed_at`,
  ).run(name, kind, id, Date.now())
}

async function pageSource(name: string, values: Record<string, string>): Promise<string> {
  let source = await Bun.file(new URL(`./pages/${name}.html`, import.meta.url)).text()
  for (const [key, value] of Object.entries(values)) source = source.replaceAll(`{{${key}}}`, value)
  if (/{{[A-Z_]+}}/.test(source)) throw new Error(`Unresolved placeholder in ${name}.html`)
  return source
}

/** Publish the content-addressed examples and record their current stable names. */
export async function deployStartupExamples(database: Database): Promise<StartupDeployment> {
  const defaultCssBlobId = await publishTextBlob(
    database,
    await Bun.file(new URL("./default.css", import.meta.url)).text(),
    "text/css; charset=utf-8",
  )
  record(database, "default.css", "blob", defaultCssBlobId)

  const grantsBoxId = await publishBox(database, grantsBox)
  record(database, "accounts.grants", "box", grantsBoxId)

  const profilesBoxId = await publishBox(database, profilesBox(grantsBoxId))
  record(database, "accounts.profiles", "box", profilesBoxId)

  const messagesBoxId = await publishBox(database, messagesBox(grantsBoxId))
  record(database, "social.messages", "box", messagesBoxId)

  const accountsBlobId = await publishTextBlob(
    database,
    await pageSource("accounts", {
      DEFAULT_CSS: defaultCssBlobId,
      GRANTS_BOX: grantsBoxId,
      PROFILES_BOX: profilesBoxId,
    }),
    "text/html; charset=utf-8",
  )
  const accountsPageId = await publishPage(database, accountsBlobId)
  record(database, "accounts.page", "page", accountsPageId)

  const profileBlobId = await publishTextBlob(
    database,
    await pageSource("profile", {
      ACCOUNTS_PAGE: accountsPageId,
      DEFAULT_CSS: defaultCssBlobId,
      GRANTS_BOX: grantsBoxId,
      PROFILES_BOX: profilesBoxId,
    }),
    "text/html; charset=utf-8",
  )
  const profilePageId = await publishPage(database, profileBlobId)
  record(database, "profile.page", "page", profilePageId)

  const socialBlobId = await publishTextBlob(
    database,
    await pageSource("social", {
      ACCOUNTS_PAGE: accountsPageId,
      DEFAULT_CSS: defaultCssBlobId,
      GRANTS_BOX: grantsBoxId,
      MESSAGES_BOX: messagesBoxId,
      PROFILES_BOX: profilesBoxId,
    }),
    "text/html; charset=utf-8",
  )
  const socialPageId = await publishPage(database, socialBlobId)
  record(database, "social.page", "page", socialPageId)

  database.query(
    `DELETE FROM startup_deployments
     WHERE name LIKE 'accounts.%'
       AND name NOT IN ('accounts.grants', 'accounts.profiles', 'accounts.page')`,
  ).run()

  return {
    defaultCssBlobId,
    grantsBoxId,
    profilesBoxId,
    accountsPageId,
    profilePageId,
    messagesBoxId,
    socialPageId,
  }
}
