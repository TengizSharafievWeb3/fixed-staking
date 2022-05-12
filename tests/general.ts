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
  tokenBalance, vaultBalance, rewardBalance
} from './utils';

import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as fs from "fs";

chai.use(chaiAsPromised);


describe("general", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const provider = anchor.getProvider();
  const program = anchor.workspace.Staking as Program<Staking>;
  const spl_program = anchor.Spl.token();

  const pool = Keypair.generate();
  const authority = Keypair.generate();

  const rawdata = fs.readFileSync('tests/keys/mint.json');
  const keyData = JSON.parse(rawdata.toString());
  const mint = Keypair.fromSecretKey(new Uint8Array(keyData));

  const funder_token = Keypair.generate();

  const user_authority = Keypair.generate();

  before(async() => {
    await creatMintIfRequired(spl_program, mint, provider.wallet.publicKey);
    await createToken(spl_program, funder_token, mint.publicKey, provider.wallet.publicKey);
    await mintTo(spl_program, 1000_000_000_000, mint.publicKey, funder_token.publicKey, provider.wallet.publicKey);
  });

  it("Should initialize", async () => {
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

    //track cost of creating a pool
    const startLamports = await provider.connection.getBalance(provider.wallet.publicKey);

     await initializeProgram(program, pool, authority.publicKey,
      provider.wallet.publicKey, mint.publicKey, tiers);

    const endLamports = await provider.connection.getBalance(provider.wallet.publicKey);

    const costInLamports = startLamports - endLamports;
    console.log("Cost of creating a pool ", (costInLamports / web3.LAMPORTS_PER_SOL));


    const [vault, _nonce1] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("vault"), pool.publicKey.toBuffer()],
      program.programId
    );
    expect(await vaultBalance(spl_program, pool.publicKey, program.programId)).to.be.equal(0);

    const [rewardVault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );
    expect(await rewardBalance(spl_program, pool.publicKey, program.programId)).to.be.equal(0);

    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.authority).to.be.deep.equal(authority.publicKey);
    expect(poolAccount.paused).to.be.equal(false);
    expect(poolAccount.closed).to.be.equal(false);
    expect(poolAccount.vault).to.be.deep.equal(vault);
    expect(poolAccount.rewardVault).to.be.deep.equal(rewardVault);

    for (let idx = 0; idx < tiers.length; idx++) {
      expect(poolAccount.tiers[idx].supply).to.be.equal(tiers[idx].supply);
      expect(poolAccount.tiers[idx].slots).to.be.equal(tiers[idx].slots);
      expect(poolAccount.tiers[idx].stake.eq(tiers[idx].stake)).to.be.true;
      expect(poolAccount.tiers[idx].duration.eq(tiers[idx].duration)).to.be.true;
      expect(poolAccount.tiers[idx].reward.eq(tiers[idx].reward)).to.be.true;
    }
  });

  it("Should pause staking", async () => {
    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.false;

    await pause(program, pool.publicKey, authority);

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.true;
  });

  it ("Should NOT unpause with incorrect authority", async() => {
    await expect(program.methods.unpause()
      .accounts({
        pool: pool.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc()).to.be.rejected;
  })

  it ("Should NOT pause if already paused", async() => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.true;

    await expect(pause(program, pool.publicKey, authority)).to.be.rejected;
  })

  it ("Should unpause", async () => {
    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.true;

    await unpause(program, pool.publicKey, authority);

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.false;
  });

  it ("Should NOT pause with incorrect authority", async() => {
    await expect(program.methods.pause()
      .accounts({
        pool: pool.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc()).to.be.rejected;
  })

  it ("Should NOT unpause if not paused", async() => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.paused).to.be.false;

    await expect(unpause(program, pool.publicKey, authority)).to.be.rejected;
  })

  it("Should fund reward vault", async () => {
    const [rewardVault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(1000_000_000))
      .accounts({
        source: funder_token.publicKey,
        destination: rewardVault,
        authority: provider.wallet.publicKey,
      }).rpc();
  });

  it("Should close for new stakes", async () => {
    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;

    await close(program, pool.publicKey, authority);

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.true;
  });

  it("Should NOT close if already closed", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.true;

    await expect(close(program, pool.publicKey, authority)).to.be.rejected;
  });

  it("Should NOT open with invalid authority", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.true;

    await expect(open(program, pool.publicKey, provider.wallet)).to.be.rejected;
  })

  it("Should open for new stakes", async () => {
    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.true;

    await open(program, pool.publicKey, authority);

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;
  });

  it("Should NOT open if not closed", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;

    await expect(open(program, pool.publicKey, authority)).to.be.rejected;
  });

  it("Should NOT close if paused", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;
    expect(poolAccount.paused).to.be.false;

    await pause(program, pool.publicKey, authority);
    await expect(close(program, pool.publicKey, authority)).to.be.rejected;
    await unpause(program, pool.publicKey, authority);
  });

  it("Should NOT close with invalid authority", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;

    await expect(close(program, pool.publicKey, provider.wallet)).to.be.rejected;
  })

  it("Should NOT open if paused", async () => {
    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.closed).to.be.false;
    expect(poolAccount.paused).to.be.false;

    await close(program, pool.publicKey, authority);
    await pause(program, pool.publicKey, authority);
    await expect(open(program, pool.publicKey, authority)).to.be.rejected;
    await unpause(program, pool.publicKey, authority);
    await open(program, pool.publicKey, authority);
  });

  it("Should create user", async() => {
    await program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user_authority.publicKey
      })
      .preInstructions(
        [
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user_authority.publicKey
          })
        ]
      )
      .signers([user_authority])
      .rpc();

    const keys = await program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user_authority.publicKey
      })
      .pubkeys();

    const user = keys['user'];
    const userAccount = await program.account.user.fetch(user);

    expect(userAccount.pool).to.be.deep.equal(pool.publicKey);
    expect(userAccount.authority).to.be.deep.equal(user_authority.publicKey);
  });

  it("Should NOT create user if paused", async () => {
    const user = Keypair.generate();

    await pause(program, pool.publicKey, authority);
    await expect(program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey
      })
      .preInstructions(
        [
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user.publicKey
          })
        ]
      )
      .signers([user])
      .rpc()).to.be.rejectedWith(/Pool is paused/);
    await unpause(program, pool.publicKey, authority);
  });

  it("Should NOT create user if closed", async () => {
    const user = Keypair.generate();

    await close(program, pool.publicKey, authority);
    await expect(program.methods.createUser()
      .accounts({
        pool: pool.publicKey,
        authority: user.publicKey
      })
      .preInstructions(
        [
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user.publicKey
          })
        ]
      )
      .signers([user])
      .rpc()).to.be.rejectedWith(/Pool is closed for new staking/);
    await open(program, pool.publicKey, authority);
  });
});
