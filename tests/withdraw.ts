import * as anchor from "@project-serum/anchor";
import { PublicKey, Keypair } from '@solana/web3.js';
import { Program, web3, BN } from "@project-serum/anchor";
import { Staking } from "../target/types/staking";
import {
  initializeProgram,
  pause,
  unpause,
  open,
  close,
  creatMintIfRequired,
  createToken,
  mintTo,
  mintToATA, tokenBalance, stakingAccount, waitUntilblockTime, blockTimeFromTx, vaultBalance, rewardBalance, getATA
} from './utils';

import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as fs from "fs";

chai.use(chaiAsPromised);

describe("withdraw", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(
    anchor.AnchorProvider.local(
      "http://localhost:8899",
      {commitment: "confirmed", preflightCommitment: "confirmed"})
  );

  const provider = anchor.getProvider();

  const program = anchor.workspace.Staking as Program<Staking>;
  const spl_program = anchor.Spl.token();

  const pool = Keypair.generate();
  const authority = Keypair.generate();

  const rawdata = fs.readFileSync('tests/keys/mint.json');
  const keyData = JSON.parse(rawdata.toString());
  const mint = Keypair.fromSecretKey(new Uint8Array(keyData));

  const user = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();

  before(async () => {
    const funderToken = Keypair.generate();

    await creatMintIfRequired(spl_program, mint, provider.wallet.publicKey);
    await createToken(spl_program, funderToken, mint.publicKey, provider.wallet.publicKey);
    await mintTo(spl_program, 1_000_000_000, mint.publicKey, funderToken.publicKey, provider.wallet.publicKey);

    const tiers = [
      {
        supply: 3,
        slots: 3,
        stake: new BN(5_000_000),
        duration: new BN(5),
        reward: new BN(5_000_000),
      },
      {
        supply: 3,
        slots: 3,
        stake: new BN(10_000_000),
        duration: new BN(10),
        reward: new BN(10_000_000),
      },
      {
        supply: 3,
        slots: 3,
        stake: new BN(15_000_000),
        duration: new BN(15),
        reward: new BN(15_000_000),
      },
    ];

    await initializeProgram(program, pool, authority.publicKey,
      provider.wallet.publicKey, mint.publicKey, tiers);

    const [rewardVault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(90_000_000))
      .accounts({
        source: funderToken.publicKey,
        destination: rewardVault,
        authority: provider.wallet.publicKey,
      })
      .postInstructions(
        [
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user.publicKey
          }),
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user2.publicKey
          }),
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user3.publicKey
          })
        ]
      )
      .rpc();

    await mintToATA(spl_program, user.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
    await mintToATA(spl_program, user2.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
    await mintToATA(spl_program, user3.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
  });

  it("Should NOT withdraw if pool isn't closed", async () => {
    const ata = mintToATA(spl_program, authority.publicKey, new BN(1), mint.publicKey, provider.wallet.publicKey);

    await expect(
      program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: ata,
      }).signers([authority])
      .rpc()
    ).to.be.rejected;
  });

  it("Should withdraw all", async () => {
    const ata = await getATA(authority.publicKey, mint.publicKey);

    await close(program, pool.publicKey, authority);

    await program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: ata,
      }).signers([authority])
      .rpc();

    await open(program, pool.publicKey, authority);

    expect(await tokenBalance(spl_program, ata)).to.be.equal(90_000_001);
  });

  it("Should withdraw only extra", async () => {
    const funderAta = await getATA(authority.publicKey, mint.publicKey);

    const [rewardVault, _nonce] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(90_000_000))
      .accounts({
        source: funderAta,
        destination: rewardVault,
        authority: authority.publicKey,
      }).signers([authority]).rpc();

    const userAta = await getATA(user.publicKey, mint.publicKey);
    await program.methods.stake({tier1000:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        from: userAta,
      }).signers([user])
      .preInstructions([
        await program.methods.createUser()
          .accounts({
            pool: pool.publicKey,
            authority: user.publicKey
          }).instruction()
      ])
      .rpc();

    await close(program, pool.publicKey, authority);

    await program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: funderAta,
      }).signers([authority])
      .rpc();

    await open(program, pool.publicKey, authority);

    expect(await tokenBalance(spl_program, funderAta)).to.be.equal(80_000_001);
  });

  it("Should NOT withdraw if paused", async() => {
    const funderAta = await getATA(authority.publicKey, mint.publicKey);

    await close(program, pool.publicKey, authority);
    await pause(program, pool.publicKey, authority);

    await expect(program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: funderAta,
      }).signers([authority])
      .rpc()).to.be.rejectedWith(/Pool is paused/);

    await unpause(program, pool.publicKey, authority);
    await open(program, pool.publicKey, authority);
  });

  it("Should NOT withdraw if no extra funds", async() => {
    const funderAta = await getATA(authority.publicKey, mint.publicKey);

    const [rewardVault, _nonce] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(10_000_000))
      .accounts({
        source: funderAta,
        destination: rewardVault,
        authority: authority.publicKey,
      }).signers([authority]).rpc();

    const userAta = await getATA(user.publicKey, mint.publicKey);
    await program.methods.stake({tier1500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        from: userAta,
      }).signers([user])
      .rpc();

    await close(program, pool.publicKey, authority);

    await expect(program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: funderAta,
      }).signers([authority])
      .rpc()).to.be.rejectedWith(/Only extra \(total - required\) withdraw allowed/)

    await open(program, pool.publicKey, authority);
  });
});