import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

// Automatically detect test runners (node:test, vitest, or NODE_ENV=test)
const isTest =
  process.env.NODE_ENV === "test" ||
  process.execArgv.some((arg) => arg.includes("--test")) ||
  process.argv.some((arg) => arg.includes("--test"));

if (isTest) {
  const testUrl = process.env.DATABASE_URL_TEST;
  const prodUrl = process.env.DATABASE_URL;

  if (!testUrl || !testUrl.trim()) {
    throw new Error(
      "Test DB Safety Violation: DATABASE_URL_TEST is missing. Tests must never run against production."
    );
  }
  if (testUrl.trim() === prodUrl?.trim()) {
    throw new Error(
      "Test DB Safety Violation: DATABASE_URL_TEST equals DATABASE_URL. Tests must run against an isolated test database."
    );
  }

  // Parse DB name from URL path
  let dbName = "";
  try {
    const parsed = new URL(testUrl);
    dbName = parsed.pathname.replace(/^\//, "").split("?")[0].toLowerCase();
  } catch {
    dbName = testUrl.split("/").pop()?.split("?")[0].toLowerCase() || "";
  }

  if (!dbName.includes("test")) {
    throw new Error(
      `Test DB Safety Violation: DATABASE_URL_TEST database name "${dbName}" does not contain "test". Refusing to run tests against non-test database.`
    );
  }
}

const databaseUrl = isTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({
      datasources: databaseUrl ? { db: { url: databaseUrl } } : undefined,
    });
  }
}

const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    datasources: databaseUrl ? { db: { url: databaseUrl } } : undefined,
  });

export default prisma;
