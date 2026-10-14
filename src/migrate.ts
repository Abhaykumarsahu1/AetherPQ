import { BrowserProvider, ContractFactory } from "ethers";
import artifact from "./contracts/SmartWallet.json";

export const VERIFIER = "0x9F4F96730Cd883bA1f1C917b1dd102C29ba82C38";
export const DEMO_BLOB = "0x2849461245e7E496adFC95f92A8B684A36A805Ee";
const SEPOLIA_HEX = "0xaa36a7";
const BLOB_SIZE = 20545;

export async function migrate(
  scannedAddress: string,
  say: (s: string) => void,
  blob: string = DEMO_BLOB,
) {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found. Install it and reload.");

  say("Connecting to MetaMask...");
  await new BrowserProvider(eth).send("eth_requestAccounts", []);
  await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });

  const provider = new BrowserProvider(eth); // re-create after the chain switch
  const signer = await provider.getSigner();
  const owner = await signer.getAddress();

  if (scannedAddress && owner.toLowerCase() !== scannedAddress.toLowerCase()) {
    const ok = confirm(
      `MetaMask account (${owner}) differs from the scanned address.\n` +
      `The new wallet will be owned by the MetaMask account. Continue?`,
    );
    if (!ok) throw new Error("Cancelled.");
  }

  say("Checking the ML-DSA key blob on-chain...");
  const code = await provider.getCode(blob);
  if ((code.length - 2) / 2 !== BLOB_SIZE) throw new Error("Key blob has the wrong size; not deploying.");

  say("Deploying your hybrid wallet. Confirm in MetaMask...");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const wallet = await factory.deploy(owner, VERIFIER, blob, { gasLimit: 12_000_000n });
  const receipt = await wallet.deploymentTransaction()!.wait();

  return {
    wallet: await wallet.getAddress(),
    tx: receipt!.hash,
    gasUsed: receipt!.gasUsed.toString(),
  };
}