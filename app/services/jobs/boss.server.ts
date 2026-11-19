import { PgBoss } from "pg-boss";
import { logger } from "../../lib/logger.server.ts";

let bossInstance: PgBoss | null = null;
let isStarted = false;

/**
 * Returns the singleton instance of PgBoss configured with the PostgreSQL database.
 */
export function getBoss(): PgBoss {
  if (!bossInstance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required to initialize pg-boss.");
    }

    bossInstance = new PgBoss({
      connectionString,
      schema: "pgboss",
    });

    bossInstance.on("error", (error: unknown) => {
      logger.error("pg-boss encountered an error", { error: String(error) });
    });
  }

  return bossInstance;
}

/**
 * Starts the pg-boss background worker manager.
 */
export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  if (!isStarted) {
    await boss.start();
    isStarted = true;
    logger.info("pg-boss background job worker started successfully");
  }
  return boss;
}

/**
 * Gracefully stops the pg-boss manager on process termination.
 */
export async function stopBoss(): Promise<void> {
  if (bossInstance && isStarted) {
    await bossInstance.stop({ graceful: true });
    isStarted = false;
    logger.info("pg-boss stopped gracefully");
  }
}
