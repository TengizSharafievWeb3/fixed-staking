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

describe("one user staking with prod tier settings", () => {
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

  before(async () => {
    const funderToken = Keypair.generate();

    await creatMintIfRequired(spl_program, mint, provider.wallet.publicKey);
    await createToken(spl_program, funderToken, mint.publicKey, provider.wallet.publicKey);
    await mintTo(spl_program, 1_000_000_000, mint.publicKey, funderToken.publicKey, provider.wallet.publicKey);

    const tiers = [
      {
        supply: 500,
        slots: 500,
        stake: new BN(500_000_000),
        duration: new BN(30*24*60*60),
        reward: new BN(333_000_000),
      },
      {
        supply: 1000,
        slots: 1000,
        stake: new BN(1000_000_000),
        duration: new BN(60*24*60*60),
        reward: new BN(1000_000_000),
      },
      {
        supply: 1500,
        slots: 1500,
        stake: new BN(1500_000_000),
        duration: new BN(90*24*60*60),
        reward: new BN(1500_000_000),
      }
    ];

    await initializeProgram(program, pool, authority.publicKey,
      provider.wallet.publicKey, mint.publicKey, tiers);

    const [rewardVault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(1_000_000_000))
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
        ]
      )
      .rpc();

    await mintToATA(spl_program, user.publicKey, new BN(3_000_000_000), mint.publicKey, provider.wallet.publicKey);
  });

  it("Should stake, claim, unstake", async () => {
    const ata = await getATA(user.publicKey, mint.publicKey);

    const ataBefore = await tokenBalance(spl_program, ata);

    // Stake 5
    let tx = await program.methods.stake({tier500: {}})
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
      .rpc({commitment: 'confirmed'});

    const ataBegin = await tokenBalance(spl_program, ata);
    expect(ataBefore - ataBegin).to.be.equal(500_000_000);

    const start = await blockTimeFromTx(provider, tx);
    let staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('staking');
    expect(staking.stakes[0].staking.lastClaimed.toNumber()).to.be.equal(start);

    // Claim some amount
    await waitUntilblockTime(provider, start + 5);
    tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc({commitment: 'confirmed'});

    const middle = await blockTimeFromTx(provider, tx);
    staking = await stakingAccount(program, pool.publicKey, user.publicKey);
    expect(staking.stakes[0]).to.have.property('staking');
    expect(staking.stakes[0].staking.lastClaimed.toNumber()).to.be.equal(middle);

    const ataMiddle = await tokenBalance(spl_program, ata);

    const duration = new BN(30*24*60*60);
    const totalReward = new BN(333_000_000);
    const timePassed = new BN(middle - start);
    const expectedReward = totalReward.mul(timePassed).div(duration);

    expect(ataMiddle - ataBegin).to.be.equal(expectedReward.toNumber());
  });

});