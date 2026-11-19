import SftpClient from "ssh2-sftp-client";
import { decrypt } from "../../lib/crypto.server.ts";
import { logger } from "../../lib/logger.server.ts";

export interface SftpCredentials {
  host: string;
  port?: number;
  username: string;
  encryptedPassword?: string | null;
  encryptedPrivateKey?: string | null;
}

export interface SftpUploadResult {
  success: boolean;
  remotePath: string;
  bytesUploaded: number;
  error?: string;
}

/**
 * Uploads a feed CSV directly to the root directory of OpenAI's SFTP server.
 * Note: OpenAI requires files to be uploaded directly into the root directory (/)
 * without subdirectories; nested paths result in `invalid_sftp_directory_layout`.
 */
export async function uploadFeedViaSftp(
  credentials: SftpCredentials,
  csvContent: string,
  fileName: string = "catalog.csv"
): Promise<SftpUploadResult> {
  const client = new SftpClient();
  const remotePath = `/${fileName.replace(/^\/+/, "")}`;
  const buffer = Buffer.from(csvContent, "utf-8");

  try {
    const connectOptions: SftpClient.ConnectOptions = {
      host: credentials.host,
      port: credentials.port || 22,
      username: credentials.username,
      readyTimeout: 30000,
    };

    if (credentials.encryptedPrivateKey) {
      connectOptions.privateKey = decrypt(credentials.encryptedPrivateKey);
    } else if (credentials.encryptedPassword) {
      connectOptions.password = decrypt(credentials.encryptedPassword);
    } else {
      throw new Error("No password or private key provided for SFTP authentication.");
    }

    logger.info("Connecting to SFTP server", {
      host: credentials.host,
      port: connectOptions.port,
      username: credentials.username,
      remotePath,
    });

    await client.connect(connectOptions);

    await client.put(buffer, remotePath);

    logger.info("Successfully uploaded feed CSV via SFTP", {
      remotePath,
      bytesUploaded: buffer.length,
    });

    return {
      success: true,
      remotePath,
      bytesUploaded: buffer.length,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Failed to upload feed CSV via SFTP", { error: errorMessage, remotePath });
    return {
      success: false,
      remotePath,
      bytesUploaded: 0,
      error: errorMessage,
    };
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore disconnect errors
    }
  }
}
