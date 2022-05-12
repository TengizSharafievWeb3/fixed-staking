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

import {expect, use} from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as fs from "fs";

chai.use(chaiAsPromised);

describe("free user and pool", () => {
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

  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();

  async function rewardRequirements() {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    return poolAccount.metrics.rewardRequirements.toNumber();
  }

  async function rewardPaid() {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    return poolAccount.metrics.rewardPaid.toNumber();
  }

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
        duration: new BN(2),
        reward: new BN(5_000_000),
      },
      {
        supply: 3,
        slots: 3,
        stake: new BN(10_000_000),
        duration: new BN(3),
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
            toPubkey: user1.publicKey
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

    await mintToATA(spl_program, user1.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
    await mintToATA(spl_program, user2.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
    await mintToATA(spl_program, user3.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
  });

  it("Should free user if there is no staking", async() => {
    await program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
      }).signers([user1]).rpc({commitment:'confirmed'});

    let staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('none');

    await close(program, pool.publicKey, authority);

    const [user1staking, _nonce1] = await PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc();

    staking = await program.account.user.fetchNullable(user1staking);
    expect(staking).to.be.null;
    expect(await rewardRequirements() - await rewardPaid()).to.be.equal(0);

    await open(program, pool.publicKey, authority);
  });

  it("Should NOT free user if paused", async() => {
    await program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
      }).signers([user1]).rpc({commitment:'confirmed'});

    let staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('none');

    await close(program, pool.publicKey, authority);
    await pause(program, pool.publicKey, authority);

    const [user1staking, _nonce1] = await PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await expect(program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc()).to.be.rejectedWith(/Pool is paused/);

    await unpause(program, pool.publicKey, authority);
    await open(program, pool.publicKey, authority);
  });

  it("Should NOT free user if open", async () => {
    const [user1staking, _nonce1] = await PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await expect(program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc()).to.be.rejectedWith(/PoolHasToBeClosed/);
  });

  it("Should NOT free user with active stake or pending reward", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const tx = await program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        from: ata,
      }).signers([user1]).rpc();

    await close(program, pool.publicKey, authority);

    const [user1staking, _nonce1] = await PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await expect(program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc()).to.be.rejectedWith(/UserHasActiveStakes/);

    const blockTime = await blockTimeFromTx(provider, tx);
    await waitUntilblockTime(provider, blockTime + 2);

    await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc();

    await expect(program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc()).to.be.rejectedWith(/UserHasActiveStakes/);

    await program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc();

    await program.methods.freeUser()
      .accounts({
        pool: pool.publicKey,
        user: user1staking,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc();

    expect(await rewardRequirements() - await rewardPaid()).to.be.equal(0);

    await open(program, pool.publicKey, authority);
  });

  it("Should NOT free pool if open", async () => {
    await expect(
      program.methods.freePool()
        .accounts({
          pool: pool.publicKey,
          authority: authority.publicKey,
          receiver: provider.wallet.publicKey,
        }).signers([authority]).rpc()
    ).to.be.rejectedWith(/PoolHasToBeClosed/);
  });

  it("Should NOT free pool if paused", async() => {
    await close(program, pool.publicKey, authority);
    await pause(program, pool.publicKey, authority);

    await expect(
      program.methods.freePool()
        .accounts({
          pool: pool.publicKey,
          authority: authority.publicKey,
          receiver: provider.wallet.publicKey,
        }).signers([authority]).rpc()
    ).to.be.rejectedWith(/Pool is paused/);

    await unpause(program, pool.publicKey, authority);
    await open(program, pool.publicKey, authority);
  });

  it("Should NOT free pool if any active stakes", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const tx = await program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
      })
      .postInstructions([
        await program.methods.stake({tier500:{}})
          .accounts({
            pool: pool.publicKey,
            authority: user1.publicKey,
            from: ata,
          }).instruction()
      ])
      .signers([user1]).rpc();

    await close(program, pool.publicKey, authority);

    await expect(
      program.methods.freePool()
        .accounts({
          pool: pool.publicKey,
          authority: authority.publicKey,
          receiver: provider.wallet.publicKey,
        }).signers([authority]).rpc()
    ).to.be.rejectedWith(/UserHasActiveStakes/);

    const blockTime = await blockTimeFromTx(provider, tx);
    await waitUntilblockTime(provider, blockTime + 2);

    await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc();

    await expect(
      program.methods.freePool()
        .accounts({
          pool: pool.publicKey,
          authority: authority.publicKey,
          receiver: provider.wallet.publicKey,
        }).signers([authority]).rpc()
    ).to.be.rejectedWith(/UserHasActiveStakes/);

    const [user1staking, _nonce1] = await PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).postInstructions(
        [
          await program.methods.freeUser()
            .accounts({
              pool: pool.publicKey,
              user: user1staking,
              authority: authority.publicKey,
              receiver: provider.wallet.publicKey,
            }).instruction()
        ]
      )
      .signers([user1, authority]).rpc();

    expect(await rewardRequirements() - await rewardPaid()).to.be.equal(0);

    await open(program, pool.publicKey, authority);
  });

  it("Should NOT free pool if vaults are not empty", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const [rewardVault, _nonce] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    const [vault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("vault"), pool.publicKey.toBuffer()],
      program.programId
    );

    expect(await tokenBalance(spl_program, rewardVault)).to.be.gt(0);

    await close(program, pool.publicKey, authority);

    await expect(
      program.methods.freePool()
        .accounts({
          pool: pool.publicKey,
          authority: authority.publicKey,
          receiver: provider.wallet.publicKey,
        }).signers([authority]).rpc()
    ).to.be.rejectedWith(/AmountMustBeZero/);

    expect(await rewardRequirements() - await rewardPaid()).to.be.equal(0);

    await program.methods.withdrawExtra()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        to: ata,
      }).signers([authority])
      .rpc({commitment:'confirmed'});

    expect(await tokenBalance(spl_program, rewardVault)).to.be.equal(0);
    expect(await tokenBalance(spl_program, vault)).to.be.equal(0);

    await program.methods.freePool()
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
        receiver: provider.wallet.publicKey,
      }).signers([authority]).rpc();

    const poolAccount = await program.account.pool.fetchNullable(pool.publicKey);
    expect(poolAccount).to.be.null;

  });
});