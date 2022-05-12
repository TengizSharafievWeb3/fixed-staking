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

describe("one user staking", () => {
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

  before(async() => {
    const funderToken = Keypair.generate();

    await creatMintIfRequired(spl_program, mint, provider.wallet.publicKey);
    await createToken(spl_program, funderToken, mint.publicKey, provider.wallet.publicKey);
    await mintTo(spl_program, 1_000_000_000, mint.publicKey, funderToken.publicKey, provider.wallet.publicKey);

    const tiers = [
      {
        supply: 2,
        slots: 2,
        stake: new BN(5_000_000),
        duration: new BN(5),
        reward: new BN(5_000_000),
      },
      {
        supply: 2,
        slots: 2,
        stake: new BN(10_000_000),
        duration: new BN(10),
        reward: new BN(10_000_000),
      },
      {
        supply: 2,
        slots: 2,
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

    await spl_program.methods.transfer(new BN(1000_000_000))
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

  it("Should stake, claim, unstake one tier", async () => {
    const ata = await getATA(user.publicKey, mint.publicKey);

    const ataBefore = await tokenBalance(spl_program, ata);

    // Stake 5
    let tx = await program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        from: ata,
      })
      .preInstructions(
        [
          await program.methods.createUser()
            .accounts({
              pool: pool.publicKey,
              authority: user.publicKey,
            }).instruction()
        ]
      )
      .signers([user])
      .rpc({commitment:'confirmed'});

    const ataBegin = await tokenBalance(spl_program, ata);
    expect(ataBefore - ataBegin).to.be.equal(5_000_000);

    const start = await blockTimeFromTx(provider, tx);
    let staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('staking');
    expect(staking.stakes[0].staking.lastClaimed.toNumber()).to.be.equal(start);

    // Claim some amount
    await waitUntilblockTime(provider, start + 2);
    tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment:'confirmed'});

    const middle = await blockTimeFromTx(provider, tx);
    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('staking');
    expect(staking.stakes[0].staking.lastClaimed.toNumber()).to.be.equal(middle);

    const ataMiddle = await tokenBalance(spl_program, ata);
    expect(ataMiddle - ataBegin).to.be.equal(1_000_000 * (middle - start));

    // Wait until the end of locked period
    await waitUntilblockTime(provider, start + 6);
    await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment:'confirmed'});

    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('ready');

    const ataEnd = await tokenBalance(spl_program, ata);
    expect(ataEnd - ataBegin).to.be.equal(5_000_000);

    // Unstake
    await program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment:'confirmed'});

    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('used');

    const ataAfter = await tokenBalance(spl_program, ata);
    expect(ataAfter - ataBefore).to.be.equal(5_000_000);

  });

  it("Should stake, claim, unstake multiple tiers", async () => {
    const ata = await getATA(user.publicKey, mint.publicKey);
    const ataBefore = await tokenBalance(spl_program, ata);

    // Stake 10 and 15
    let tx = await program.methods.stake({tier1000:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        from: ata,
      })
      .postInstructions(
        [
          await program.methods.stake({tier1500:{}})
            .accounts({
              pool: pool.publicKey,
              authority: user.publicKey,
              from: ata,
            }).instruction()
        ]
      )
      .signers([user])
      .rpc({commitment:'confirmed'});

    const start = await blockTimeFromTx(provider, tx);
    let staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[1]).to.have.property('staking');
    expect(staking.stakes[1].staking.lastClaimed.toNumber()).to.be.equal(start);
    expect(staking.stakes[1].staking.lockedUntil.toNumber()).to.be.equal(start + 10);
    expect(staking.stakes[2]).to.have.property('staking');
    expect(staking.stakes[2].staking.lastClaimed.toNumber()).to.be.equal(start);
    expect(staking.stakes[2].staking.lockedUntil.toNumber()).to.be.equal(start + 15);

    const ataStake = await tokenBalance(spl_program, ata);
    expect(ataBefore - ataStake).to.be.equal(25_000_000);

    // Wait some time and claim
    await waitUntilblockTime(provider, start + 7);
    tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment:'confirmed'});

    const middle1 = await blockTimeFromTx(provider, tx);
    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[1]).to.have.property('staking');
    expect(staking.stakes[1].staking.lastClaimed.toNumber()).to.be.equal(middle1);
    expect(staking.stakes[2]).to.have.property('staking');
    expect(staking.stakes[2].staking.lastClaimed.toNumber()).to.be.equal(middle1);

    const ataClaim1 = await tokenBalance(spl_program, ata);
    expect(ataClaim1 - ataStake).to.be.equal(2_000_000 * (middle1 - start));

    // Wait between stakes lock periods
    await waitUntilblockTime(provider, start + 13);
    tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment:'confirmed'});

    const middle2 = await blockTimeFromTx(provider, tx);
    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[1]).to.have.property('ready');
    expect(staking.stakes[2]).to.have.property('staking');
    expect(staking.stakes[2].staking.lastClaimed.toNumber()).to.be.equal(middle2);

    const ataClaim2 = await tokenBalance(spl_program, ata);
    expect(ataClaim2 - ataStake).to.be.equal(10_000_000 + 1_000_000 * (middle2 - start));

    // Wait until longest lock period, claim and unstake
    await waitUntilblockTime(provider, start + 16);
    tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).postInstructions(
        [
          await program.methods.unstake({tier1000:{}})
            .accounts({
              pool: pool.publicKey,
              authority: user.publicKey,
              to: ata,
            }).instruction(),
          await program.methods.unstake({tier1500:{}})
            .accounts({
              pool: pool.publicKey,
              authority: user.publicKey,
              to: ata,
            }).instruction(),
        ]
      )
      .signers([user]).rpc({commitment:'confirmed'});

    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[1]).to.have.property('used');
    expect(staking.stakes[2]).to.have.property('used');

    const ataEnd = await tokenBalance(spl_program, ata);
    expect(ataEnd - ataBefore).to.be.equal(25_000_000);
  });

  it("Should NOT stake if no available slots", async () => {
    const ata = await getATA(user2.publicKey, mint.publicKey);

    await program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user2.publicKey,
        from: ata,
      })
      .preInstructions(
        [
          await program.methods.createUser()
            .accounts({
              pool: pool.publicKey,
              authority: user2.publicKey,
            }).instruction()
        ]
      )
      .signers([user2])
      .rpc({commitment:'confirmed'});

    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.tiers[0].slots).to.be.equal(0);

    const ata3 = await getATA(user3.publicKey, mint.publicKey);
    await expect(
      program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user3.publicKey,
        from: ata3,
      })
      .preInstructions(
        [
          await program.methods.createUser()
            .accounts({
              pool: pool.publicKey,
              authority: user3.publicKey,
            }).instruction()
        ]
      )
      .signers([user3])
      .rpc({commitment:'confirmed'})
    ).to.be.rejectedWith(/There is no available slot in this tier/);

  });
});