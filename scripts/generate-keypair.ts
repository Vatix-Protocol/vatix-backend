import { Keypair } from "@stellar/stellar-sdk";

const keypair = Keypair.random();

console.log("\nGenerated Stellar Keypair:");
console.log("========================");
console.log("Secret Key:", keypair.secret());
console.log("Public Key:", keypair.publicKey());
console.log("\nAdd this to your .env file:");
console.log(`ORACLE_SECRET_KEY=${keypair.secret()}`);
