/**
 * Indexer configuration.
 *
 * Reads and validates environment variables required by the indexer,
 * including the Soroban network passphrase used for chain client setup
 * and transaction verification.
 */

/** Well-known Soroban network passphrases. */
export const KNOWN_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export type KnownNetwork = keyof typeof KNOWN_PASSPHRASES;

export interface IndexerConfig {
  sorobanNetworkPassphrase: string;
  horizonUrl: string;
}

/**
 * Load and validate indexer config from environment variables.
 * Warns to stderr when SOROBAN_NETWORK_PASSPHRASE is not a recognised value.
 */
export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const passphrase = env.SOROBAN_NETWORK_PASSPHRASE?.trim();

  if (!passphrase) {
    throw new Error(
      "Missing required environment variable: SOROBAN_NETWORK_PASSPHRASE\n" +
        `  Testnet : "${KNOWN_PASSPHRASES.testnet}"\n` +
        `  Mainnet : "${KNOWN_PASSPHRASES.mainnet}"`
    );
  }

  const isKnown = Object.values(KNOWN_PASSPHRASES).includes(
    passphrase as (typeof KNOWN_PASSPHRASES)[KnownNetwork]
  );

  if (!isKnown) {
    process.stderr.write(
      `[indexer/config] WARNING: SOROBAN_NETWORK_PASSPHRASE "${passphrase}" is not a known value.\n` +
        `  Expected one of:\n` +
        `    Testnet : "${KNOWN_PASSPHRASES.testnet}"\n` +
        `    Mainnet : "${KNOWN_PASSPHRASES.mainnet}"\n` +
        `  Proceeding, but chain reads/writes may fail or produce misleading data.\n`
    );
  }

  const horizonUrl =
    env.STELLAR_HORIZON_URL?.trim() || "https://horizon-testnet.stellar.org";

  return { sorobanNetworkPassphrase: passphrase, horizonUrl };
}
