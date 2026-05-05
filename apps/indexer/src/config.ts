export type { IndexerConfig } from "../../../packages/shared/src/config.js";

export const KNOWN_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

type Env = Record<string, string | undefined>;

export interface IndexerConfig {
  sorobanNetworkPassphrase: string;
  horizonUrl: string;
}

export function loadIndexerConfig(env: Env = process.env): IndexerConfig {
  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"];

  if (!passphrase || passphrase.trim() === "") {
    throw new Error(
      "Missing required environment variable: SOROBAN_NETWORK_PASSPHRASE"
    );
  }

  const known = Object.values(KNOWN_PASSPHRASES) as string[];
  if (!known.includes(passphrase)) {
    process.stderr.write(
      `WARNING: SOROBAN_NETWORK_PASSPHRASE "${passphrase}" is not a known network passphrase\n`
    );
  }

  const horizonUrl =
    env["STELLAR_HORIZON_URL"] ??
    (passphrase === KNOWN_PASSPHRASES.mainnet
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  return { sorobanNetworkPassphrase: passphrase, horizonUrl };
}
