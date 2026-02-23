import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying SignetIdentity with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  const SignetIdentity = await ethers.getContractFactory("SignetIdentity");
  const contract = await SignetIdentity.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("SignetIdentity deployed to:", address);
  console.log("");
  console.log("To verify on BaseScan:");
  console.log(`  npx hardhat verify --network baseSepolia ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
